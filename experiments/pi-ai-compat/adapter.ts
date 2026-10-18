import { normalizeContext, type AssistantMessage, type ImageContent, type Message, type Model, type Tool, type Usage } from '@earendil-works/pi-ai'
import { stream as openaiStream } from '@earendil-works/pi-ai/api/openai-completions'
import { stream as responsesStream } from '@earendil-works/pi-ai/api/openai-responses'
import { stream as anthropicStream } from '@earendil-works/pi-ai/api/anthropic-messages'
import type { ProviderEvent, StreamChatInput } from '../../src/shared/types'

export class PiAdapterError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'PiAdapterError' }
}

export interface AdapterOptions {
  onFinal?: (message: AssistantMessage) => void
  onWireEvent?: (event: unknown) => void
  onPayload?: (payload: unknown) => void
  timeoutMs?: number
}

const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } })
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Experiment only: translates public types and completed results, without reparsing the SSE wire. */
export async function* streamChatWithPi(input: StreamChatInput, observe: AdapterOptions = {}): AsyncGenerator<ProviderEvent> {
  if (input.signal.aborted) throw new PiAdapterError('cancelled', '请求已取消。')
  const api = input.provider.protocol === 'openai' ? 'openai-completions' : input.provider.protocol === 'anthropic' ? 'anthropic-messages' : 'openai-responses'
  const base = {
    id: input.provider.model, name: input.provider.model, provider: `her-${input.provider.id}`,
    baseUrl: input.provider.baseUrl.replace(/\/+$/, ''), reasoning: false, input: ['text', 'image'] as Array<'text' | 'image'>,
    contextWindow: 2_000_000, maxTokens: 262144,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
  const messages: Message[] = input.messages.map((message): Message => {
    if (message.role === 'tool') {
      const call = input.messages.flatMap(item => item.role === 'assistant' && 'tool_calls' in item ? item.tool_calls : []).find(item => item.id === message.tool_call_id)
      return { role: 'toolResult', toolCallId: message.tool_call_id, toolName: call?.function.name ?? '', content: [{ type: 'text', text: message.content }], isError: false, timestamp: 0 }
    }
    const text = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : (message.content ?? []).map(item => item.type === 'text' ? item : ({ type: 'image', data: item.source.data, mimeType: item.source.media_type } satisfies ImageContent))
    if (message.role === 'user') return { role: 'user', content: text, timestamp: 0 }
    return {
      role: 'assistant', content: [
        ...text.filter((item): item is { type: 'text'; text: string } => item.type === 'text'),
        ...('tool_calls' in message ? message.tool_calls.map(call => ({ type: 'toolCall' as const, id: call.id, name: call.function.name, arguments: JSON.parse(call.function.arguments) })) : []),
      ], api, provider: base.provider, model: base.id, timestamp: 0, usage: emptyUsage(),
      stopReason: 'tool_calls' in message ? 'toolUse' : 'stop',
    }
  })
  const context = normalizeContext({ systemPrompt: input.system, messages, tools: input.tools as Tool[] | undefined })
  const options = {
    apiKey: input.provider.apiKey, headers: input.provider.customHeaders, signal: input.signal,
    maxTokens: input.provider.maxOutputTokens, maxRetries: 0, timeoutMs: observe.timeoutMs ?? 5000, cacheRetention: 'none' as const,
    onPayload: (payload: unknown) => { observe.onPayload?.(payload) },
    onProviderStreamEvent: (event: unknown) => { observe.onWireEvent?.(event) },
  }
  const stream = input.provider.protocol === 'openai'
    ? openaiStream({ ...base, api: 'openai-completions', compat: { maxTokensField: 'max_tokens', supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false } } satisfies Model<'openai-completions'>, context, { ...options, toolChoice: input.forceTool ? { type: 'function', function: { name: input.forceTool } } : undefined })
    : input.provider.protocol === 'anthropic'
      ? anthropicStream({ ...base, api: 'anthropic-messages' } satisfies Model<'anthropic-messages'>, context, { ...options, toolChoice: input.forceTool ? { type: 'tool', name: input.forceTool } : undefined })
      : responsesStream({ ...base, api: 'openai-responses' } satisfies Model<'openai-responses'>, context, { ...options, toolChoice: input.forceTool ? { type: 'function', name: input.forceTool } : undefined })

  for await (const event of stream) {
    if (input.signal.aborted) throw new PiAdapterError('cancelled', '请求已取消。')
    if (event.type === 'text_delta' && event.delta) yield { type: 'text', text: event.delta }
  }
  const final = await stream.result()
  observe.onFinal?.(final)
  if (input.signal.aborted || final.stopReason === 'aborted') throw new PiAdapterError('cancelled', '请求已取消。')
  if (final.stopReason === 'error') throw new PiAdapterError('pi_error', final.errorMessage ?? 'Pi request failed')
  if (final.stopReason === 'length') throw new PiAdapterError('truncated', '回答达到输出限制。')
  if (final.stopReason !== 'stop' && final.stopReason !== 'toolUse') throw new PiAdapterError('invalid_stream', `Unexpected Pi stop reason: ${final.stopReason}`)
  // Keep Her's whole-batch validation. Pi has already parsed/repaired argument strings here.
  const calls = final.content.filter(item => item.type === 'toolCall')
  if (calls.length && final.stopReason !== 'toolUse') throw new PiAdapterError('invalid_tool', '工具调用未确认完成。')
  if (!calls.length && final.stopReason === 'toolUse') throw new PiAdapterError('invalid_stream', '缺少工具调用。')
  if (calls.some(call => !call.id || !input.tools?.some(tool => tool.name === call.name) || !object(call.arguments))) throw new PiAdapterError('invalid_tool', '工具名称或参数无效。')
  for (const call of calls) yield { type: 'tool', id: call.id, name: call.name, arguments: call.arguments }
  yield { type: 'done' }
}
