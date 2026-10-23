import { Type } from 'typebox'
import type { ToolDefinition as PiToolDefinition } from '@earendil-works/pi-coding-agent'
import type { FileSources, ToolResult } from '../../shared/types'
import { modelToolResultText } from './result-format'
import type { ToolExecutionContext, ToolRegistry } from './types'

export type GateContext = Omit<ToolExecutionContext, 'callId' | 'signal'> & {
  signal: AbortSignal
  /** Told which files a tool result was derived from, so the host can record the dependency. */
  onSources?: (callId: string, sources: FileSources) => void
  /** Loads a stored tool image for a model that can see; without it, or on failure, the model gets a text placeholder. */
  readImage?: (artifactId: string, context: ToolExecutionContext) => Promise<Uint8Array>
}

type PiContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

async function toPiContent(result: ToolResult, context: GateContext, executionContext: ToolExecutionContext): Promise<PiContent[]> {
  const text = modelToolResultText(result)
  const content: PiContent[] = text ? [{ type: 'text', text }] : []
  for (const part of result.content) {
    if (part.type !== 'image') continue
    if (context.modelSupportsVision && context.readImage) {
      try { content.push({ type: 'image', data: Buffer.from(await context.readImage(part.artifactId, executionContext)).toString('base64'), mimeType: part.mimeType }) }
      catch { content.push({ type: 'text', text: `[图片 ${part.artifactId} 无法读取]` }) }
    } else content.push({ type: 'text', text: `[图片 ${part.artifactId}]` })
  }
  return content
}

const textOf = (content: PiContent[]) => content.map(part => part.type === 'text' ? part.text : '').filter(Boolean).join('\n')

/**
 * Exposes a registry snapshot to Pi. Every call re-enters the registry, which re-validates
 * arguments against Her's schema and fails closed unless `context.authorize` allows the action.
 * Tool names Pi remembers from history grant nothing: only names in the snapshot are executable.
 */
export function createGatedTools(registry: ToolRegistry, context: GateContext): PiToolDefinition[] {
  return registry.getDefinitions().map(definition => ({
    name: definition.name, label: definition.name, description: definition.description,
    parameters: Type.Unsafe<Record<string, unknown>>(definition.parameters),
    executionMode: 'sequential' as const,
    async execute(callId: string, params: Record<string, unknown>, signal: AbortSignal | undefined) {
      const executionContext = { ...context, callId, signal: signal ? AbortSignal.any([context.signal, signal]) : context.signal }
      const result = await registry.execute(definition.name, params, executionContext)
      if (result.fileSources) context.onSources?.(callId, result.fileSources)
      const content = await toPiContent(result, context, executionContext)
      // Pi marks a tool call as failed only when execute throws.
      if (result.isError) throw new Error(textOf(content) || '工具执行失败。')
      return { content, details: { herResult: result } }
    }
  }))
}
