import { normalizeToolResult } from './results'
import type { ToolMessage, ToolResult } from '../../shared/types'

export interface CollectedToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export function buildToolResultMessages(
  calls: CollectedToolCall[],
  results: Map<string, string | ToolResult>
): ToolMessage[] {
  return calls.map(call => ({
    role: 'tool',
    tool_call_id: call.id,
    content: results.get(call.id) ?? '(no result)'
  }))
}

export function buildAssistantMessageWithTools(
  content: string,
  calls: CollectedToolCall[]
): { role: 'assistant'; content: string | null; tool_calls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] } {
  return {
    role: 'assistant',
    content: content || null,
    tool_calls: calls.map(call => ({
      id: call.id,
      type: 'function',
      function: {
        name: call.name,
        arguments: JSON.stringify(call.arguments)
      }
    }))
  }
}

const MODEL_TEXT_LIMIT = 30_000
const TRUNCATION_MARKER = '\n[tool result truncated]'

// Only action context is promoted from private metadata to model-visible data.
function modelToolResultBody(result: ToolResult): string {
  const parts = result.isError ? ['[tool error]'] : []
  for (const key of ['snapshot', 'coordinate_context']) {
    if (result.meta?.[key] !== undefined) parts.push(`${key}: ${JSON.stringify(result.meta[key])}`)
  }
  for (const block of result.content) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'resource_link') parts.push(`Resource: ${block.name} (${block.uri})`)
  }
  if (result.structuredContent) parts.push(`Structured result: ${JSON.stringify(result.structuredContent)}`)
  return parts.join('\n')
}

/** Page producers must budget the complete serialized body before advancing their cursor. */
export function fitsModelToolResult(result: ToolResult): boolean {
  return modelToolResultBody(result).length + (result.truncated ? TRUNCATION_MARKER.length : 0) <= MODEL_TEXT_LIMIT
}

export function modelToolResultText(value: string | ToolResult): string {
  const result = normalizeToolResult(value)
  const text = modelToolResultBody(result)
  if (result.truncated || text.length > MODEL_TEXT_LIMIT) {
    return text.slice(0, MODEL_TEXT_LIMIT - TRUNCATION_MARKER.length) + TRUNCATION_MARKER
  }
  return text
}
