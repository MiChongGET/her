import { createHash, randomUUID } from 'node:crypto'
import { synchronousJsonSchemaValidator } from './schema'
import type { ActionAssessment, ToolResult } from '../../shared/types'
import type { ToolDefinition, ToolExecutor, ToolExecutionContext, ToolRegistrationOptions, ToolRegistry } from './types'
import { normalizeToolResult } from './results'
import { ApprovalError } from './approval'
import { abortable } from './abort'

interface RegisteredTool {
  definition: ToolDefinition
  executor: ToolExecutor
  options: ToolRegistrationOptions
  identity: string
  validate: ReturnType<typeof synchronousJsonSchemaValidator.getValidator>
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}'
  return JSON.stringify(value)
}
const failure = (text: string): ToolResult => ({ isError: true, content: [{ type: 'text', text }] })

export class SimpleToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>()

  register(definition: ToolDefinition, executor: ToolExecutor, options: ToolRegistrationOptions = {}): void {
    const copy = structuredClone(definition)
    this.tools.set(definition.name, { definition: copy, executor, options: { ...options }, identity: randomUUID(), validate: synchronousJsonSchemaValidator.getValidator(copy.parameters) })
  }

  has(name: string): boolean { return this.tools.has(name) }
  unregister(name: string): void { this.tools.delete(name) }
  getDefinitions(): ToolDefinition[] { return this.snapshot().getDefinitions() }
  getRevisions(): Record<string, string> { return this.snapshot().getRevisions() }

  snapshot(): ToolRegistry {
    const entries = new Map([...this.tools].filter(([, tool]) => tool.options.isAvailable?.() !== false))
    const snapshot: ToolRegistry = {
      snapshot: () => snapshot,
      getDefinitions: () => [...entries.values()].map(tool => structuredClone(tool.definition)),
      getRevisions: () => Object.fromEntries([...entries].map(([name, tool]) => [name, `${tool.identity}:${tool.options.revision ?? ''}`])),
      execute: (name, args, context) => this.invoke(entries.get(name), name, args, context)
    }
    return snapshot
  }

  execute(name: string, args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    return this.snapshot().execute(name, args, context)
  }

  private async invoke(tool: RegisteredTool | undefined, name: string, args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    context.signal.throwIfAborted()
    if (!tool) return failure(`Unknown tool: ${name}`)
    const validation = tool.validate(args)
    if (!validation.valid) return failure(`Invalid tool arguments: ${validation.errorMessage}`)
    const original = canonical(args)
    // The executor receives a separate copy; asynchronous model/adapter mutation cannot alter approved arguments.
    const dispatchArgs = structuredClone(args)
    const assessment: ActionAssessment = tool.options.assess
      ? await abortable(tool.options.assess(structuredClone(args), context), context.signal)
      : { effect: 'unknown', target: name, summary: `执行工具 ${name}，参数：${JSON.stringify(dispatchArgs)}` }
    const assessmentIdentity = canonical(assessment)
    const valid = () => this.tools.get(name) === tool && tool.options.isAvailable?.() !== false &&
      context.validateRuntime?.() !== false && canonical(args) === original && canonical(assessment) === assessmentIdentity &&
      (!assessment.observationId || tool.options.validateObservation?.(assessment, context) === true)
    if (!valid()) throw new ApprovalError('工具配置或动作参数已失效。')
    const trustedInteraction = assessment.effect === 'interact' && !!assessment.observationId && tool.options.validateObservation?.(assessment, context) === true
    const checked = { ...context, observationValidated: trustedInteraction, approvalBinding: {
      revision: createHash('sha256').update(canonical({ run: context.runId, call: context.callId, identity: tool.identity, revision: tool.options.revision, args: original, assessment })).digest('hex'),
      validate: valid,
      allowAllOperations: tool.options.allowAllOperations === true,
      ...(tool.options.conversationApprovalScope ? { conversationScope: { id: tool.options.conversationApprovalScope,
        validate: () => this.tools.get(name) === tool && tool.options.isAvailable?.() !== false } } : {})
    } }
    if (context.authorize) await context.authorize(assessment, checked)
    else if (assessment.effect !== 'read' && !trustedInteraction && !checked.approvalBinding.allowAllOperations) throw new ApprovalError('这个动作需要用户确认。')
    // An interact assessment without live observation must use the same explicit approval gate as unknown actions.
    if (!checked.approvalBinding.validate()) throw new ApprovalError('工具配置或动作参数已失效。')
    context.signal.throwIfAborted()
    context.onAttempt?.()
    if (!tool.options.deferDispatch) context.onDispatch?.(assessment)
    const controller = new AbortController()
    const signal = AbortSignal.any([context.signal, controller.signal])
    const timer = setTimeout(() => controller.abort(new Error('工具执行超时，结果可能未知。')), tool.options.timeoutMs ?? 60_000)
    try {
      return normalizeToolResult(await abortable(tool.executor(dispatchArgs, { ...context, signal,
        markDispatched: phase => {
          signal.throwIfAborted()
          if (this.tools.get(name) !== tool || tool.options.isAvailable?.() === false || context.validateRuntime?.() === false) throw new ApprovalError('工具运行态已失效。')
          context.onDispatch?.(assessment, phase)
        },
        completePreflight: () => { signal.throwIfAborted(); context.onPreflightComplete?.() }
      }), signal))
    } catch (error) {
      context.signal.throwIfAborted()
      return failure(`Tool execution failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally { clearTimeout(timer) }
  }
}

export function createDefaultRegistry(): SimpleToolRegistry {
  const registry = new SimpleToolRegistry()

  registry.register(
    {
      name: 'get_current_time',
      description: 'Get the current date and time',
      parameters: {
        type: 'object',
        properties: {
          timezone: {
            type: 'string',
            description: 'Optional IANA timezone (e.g. "Asia/Shanghai"). Defaults to system timezone.'
          }
        }
      },
    },
    async (args) => {
      const now = new Date()
      const options: Intl.DateTimeFormatOptions = {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZone: args.timezone as string | undefined,
      }
      return { content: [{ type: 'text', text: now.toLocaleString('zh-CN', options) }] }
    },
    { assess: async () => ({ effect: 'read', target: 'system:clock', summary: '查看当前时间' }) }
  )

  return registry
}
