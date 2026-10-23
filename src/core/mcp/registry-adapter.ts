import { createHash } from 'node:crypto'
import type { Tool } from '@modelcontextprotocol/client'
import type { ActionAssessment, ToolResult } from '../../shared/types'
import { SimpleToolRegistry } from '../tools/registry'
import type { ToolDefinition, ToolExecutionContext, ToolExecutor, ToolRegistrationOptions } from '../tools/types'

// Host-owned preset policy. Server annotations never supply these permissions.
export interface McpServicePolicy {
  conversationApprovalScope?: string
  privateDocumentConversion?: boolean
  deferDispatch?: boolean
  allowedTools?: readonly string[]
  parameters?: (toolName: string, schema: Record<string, unknown>) => Record<string, unknown>
  execute?: (toolName: string, args: Record<string, unknown>, context: ToolExecutionContext,
    dispatch: (name: string, args: Record<string, unknown>, phase?: 'preflight' | 'action') => Promise<ToolResult>) => Promise<ToolResult>
  describeAction?: (toolName: string, args: Record<string, unknown>, context: ToolExecutionContext) => ReturnType<NonNullable<ToolRegistrationOptions['describeAction']>>
  assess?: (toolName: string, args: Record<string, unknown>, context: ToolExecutionContext) => Promise<ActionAssessment>
  validateObservation?: ToolRegistrationOptions['validateObservation']
  resources?: (toolName: string, args: Record<string, unknown>, assessment: ActionAssessment) => string[]
  timeoutMs?: 60000 | 120000
}

export function mcpToolName(serviceId: string, toolName: string): string {
  return 'mcp_' + createHash('sha256').update(JSON.stringify([serviceId, toolName])).digest('hex').slice(0, 60)
}

export class McpRegistryAdapter {
  private readonly names = new Map<string, string>()
  constructor(private readonly registry: SimpleToolRegistry, private readonly serviceName: string) {}

  register(serviceId: string, revision: number, tools: Tool[], policy: McpServicePolicy,
    available: () => boolean, executor: (toolName: string) => ToolExecutor, _legacyAllowAllOperations = false): void {
    const seen = new Set<string>()
    const existing = new Set<string>()
    const entries: { name: string; remote: string; definition: ToolDefinition }[] = []
    for (const tool of tools) {
      if (seen.has(tool.name)) throw new Error('MCP 服务返回重复工具名称。')
      seen.add(tool.name)
      if (policy.allowedTools && !policy.allowedTools.includes(tool.name)) continue
      const name = mcpToolName(serviceId, tool.name)
      if (existing.has(name) || this.registry.has(name)) throw new Error('MCP 工具名称冲突。')
      existing.add(name)
      entries.push({ name, remote: tool.name, definition: { name, description: tool.description ?? tool.name, parameters: policy.parameters?.(tool.name, tool.inputSchema) ?? tool.inputSchema } })
    }
    try {
      for (const entry of entries) {
        this.registry.register(entry.definition, executor(entry.remote), {
          conversationApprovalScope: policy.conversationApprovalScope,
          describeAction: policy.describeAction ? (args, context) => policy.describeAction!(entry.remote, args, context) : undefined,
          deferDispatch: policy.deferDispatch, revision: String(revision), isAvailable: available, timeoutMs: policy.timeoutMs,
          assess: policy.assess ? (args, context) => policy.assess!(entry.remote, args, context)
            : async args => ({ effect: 'unknown', target: entry.name, displayTarget: `${this.serviceName} / ${entry.remote}`, summary: `调用 ${this.serviceName} 的 ${entry.remote}，参数：${JSON.stringify(args)}` }),
          validateObservation: policy.validateObservation,
          // Unless a preset names finer keys, a mutation holds its whole service so two conversations never drive one server at once.
          resources: (args, assessment) => policy.resources ? policy.resources(entry.remote, args, assessment) : assessment.effect === 'read' ? [] : [`mcp:${serviceId}`]
        })
        this.names.set(entry.remote, entry.name)
      }
    } catch (error) { this.clear(); throw error }
  }

  name(remote: string): string | undefined { return this.names.get(remote) }
  definitions(): ToolDefinition[] {
    const names = new Set(this.names.values())
    return this.registry.getDefinitions().filter(tool => names.has(tool.name))
  }
  clear(): void { for (const name of this.names.values()) this.registry.unregister(name); this.names.clear() }
}
