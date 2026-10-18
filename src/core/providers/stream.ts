import { formatModelMessages, MessageFormatError } from './message-format'
import type { ProviderEvent, StreamChatInput } from '../../shared/types'
import { readSse, type SseEvent } from './sse'

export class ProviderError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'ProviderError'
  }
}

type Json = Record<string, unknown>
type PendingTool = { id: string; name: string; json: string }

function object(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function invalidStream(): never {
  throw new ProviderError('invalid_stream', '服务返回了无法识别的流式数据，请检查所选协议和服务兼容性。')
}

function incomplete(): never {
  throw new ProviderError('incomplete_stream', '服务响应提前中断，已收到的内容可能不完整。请重试。')
}

function parseEvent(data: string): Json {
  try {
    const value: unknown = JSON.parse(data)
    if (object(value)) return value
  } catch { /* Report a safe error without upstream data. */ }
  return invalidStream()
}

function completedTools(tools: Iterable<PendingTool>, input: StreamChatInput): ProviderEvent[] {
  return [...tools].map((tool) => {
    let args: unknown
    try { args = JSON.parse(tool.json) } catch { args = null }
    if (!tool.id || !tool.name || !object(args) || !input.tools?.some((allowed) => allowed.name === tool.name)) {
      throw new ProviderError('invalid_tool', '服务返回的工具名称或参数无效，未执行工具。')
    }
    return { type: 'tool', id: tool.id, name: tool.name, arguments: args }
  })
}

async function* openaiStream(events: AsyncIterable<SseEvent>, input: StreamChatInput): AsyncGenerator<ProviderEvent> {
  const tools = new Map<number, PendingTool>()
  let finish: string | null = null
  for await (const event of events) {
    if (event.data === '[DONE]') {
      if (!finish) incomplete()
      if (tools.size > 0 && finish !== 'tool_calls') throw new ProviderError('invalid_tool', '服务未确认工具调用完成，未执行工具。')
      if (finish === 'tool_calls' && tools.size === 0) invalidStream()
      for (const tool of completedTools(tools.values(), input)) yield tool
      yield { type: 'done' }
      return
    }
    const chunk = parseEvent(event.data)
    if (chunk.error || event.event === 'error') throw new ProviderError('upstream_error', '服务在生成过程中返回错误，请检查服务状态、模型和鉴权配置后重试。')
    if (!Array.isArray(chunk.choices)) invalidStream()
    for (const choice of chunk.choices) {
      if (!object(choice)) invalidStream()
      if (choice.index !== 0) continue
      if (!object(choice.delta)) invalidStream()
      const delta = choice.delta
      if (typeof delta.content === 'string' && delta.content) yield { type: 'text', text: delta.content }
      if (delta.tool_calls !== undefined) {
        if (!Array.isArray(delta.tool_calls) || finish) invalidStream()
        for (const call of delta.tool_calls) {
          if (!object(call) || !Number.isInteger(call.index) || Number(call.index) < 0 || !object(call.function)) invalidStream()
          const index = Number(call.index)
          const tool = tools.get(index) ?? { id: '', name: '', json: '' }
          if (typeof call.id === 'string') tool.id += call.id
          if (typeof call.function.name === 'string') tool.name += call.function.name
          if (typeof call.function.arguments === 'string') tool.json += call.function.arguments
          tools.set(index, tool)
        }
      }
      if (choice.finish_reason != null) {
        if (choice.finish_reason === 'length') throw new ProviderError('truncated', '回答达到服务的输出长度限制，内容不完整。请重试或缩短请求。')
        if (choice.finish_reason === 'content_filter') throw new ProviderError('blocked', '服务的内容策略终止了回答。')
        if (choice.finish_reason !== 'stop' && choice.finish_reason !== 'tool_calls') invalidStream()
        finish = choice.finish_reason
      }
    }
  }
  incomplete()
}

async function* anthropicStream(events: AsyncIterable<SseEvent>, input: StreamChatInput): AsyncGenerator<ProviderEvent> {
  const tools = new Map<number, PendingTool>()
  const blocks = new Map<number, string>()
  const openBlocks = new Set<number>()
  let started = false
  let finish: string | null = null
  for await (const event of events) {
    const chunk = parseEvent(event.data)
    if (chunk.type === 'error' || event.event === 'error') throw new ProviderError('upstream_error', '服务在生成过程中返回错误，请检查服务状态、模型和鉴权配置后重试。')
    switch (chunk.type) {
      case 'message_start':
        if (started) invalidStream()
        started = true
        break
      case 'content_block_start': {
        if (!started || !Number.isInteger(chunk.index) || !object(chunk.content_block)) invalidStream()
        const index = Number(chunk.index)
        const block = chunk.content_block
        if (blocks.has(index) || typeof block.type !== 'string') invalidStream()
        blocks.set(index, block.type)
        openBlocks.add(index)
        if (block.type === 'tool_use') {
          if (typeof block.id !== 'string' || typeof block.name !== 'string' || !object(block.input)) invalidStream()
          tools.set(index, { id: block.id, name: block.name, json: Object.keys(block.input).length ? JSON.stringify(block.input) : '' })
        } else if (block.type === 'text' && typeof block.text === 'string' && block.text) yield { type: 'text', text: block.text }
        break
      }
      case 'content_block_delta': {
        const index = Number(chunk.index)
        if (!openBlocks.has(index) || !object(chunk.delta)) invalidStream()
        const delta = chunk.delta
        if (delta.type === 'text_delta') {
          if (blocks.get(index) !== 'text' || typeof delta.text !== 'string') invalidStream()
          if (delta.text) yield { type: 'text', text: delta.text }
        } else if (delta.type === 'input_json_delta') {
          const tool = tools.get(index)
          if (!tool || typeof delta.partial_json !== 'string') invalidStream()
          tool.json += delta.partial_json
        }
        break
      }
      case 'content_block_stop': {
        const index = Number(chunk.index)
        if (!openBlocks.delete(index)) invalidStream()
        const tool = tools.get(index)
        if (tool && !tool.json) tool.json = '{}'
        break
      }
      case 'message_delta': {
        if (!object(chunk.delta)) invalidStream()
        const reason = chunk.delta.stop_reason
        if (reason === 'max_tokens' || reason === 'model_context_window_exceeded') throw new ProviderError('truncated', '回答达到服务的输出长度限制，内容不完整。请重试或缩短请求。')
        if (reason != null) {
          if (reason !== 'end_turn' && reason !== 'stop_sequence' && reason !== 'tool_use') invalidStream()
          finish = reason
        }
        break
      }
      case 'message_stop':
        if (!started || !finish || openBlocks.size > 0) incomplete()
        if (tools.size > 0 && finish !== 'tool_use') throw new ProviderError('invalid_tool', '服务未确认工具调用完成，未执行工具。')
        if (finish === 'tool_use' && tools.size === 0) invalidStream()
        for (const tool of completedTools(tools.values(), input)) yield tool
        yield { type: 'done' }
        return
    }
  }
  incomplete()
}

async function* responsesStream(events: AsyncIterable<SseEvent>, input: StreamChatInput): AsyncGenerator<ProviderEvent> {
  const tools: PendingTool[] = []
  let completed = false
  for await (const event of events) {
    const eventType = event.event || 'message'
    const chunk = parseEvent(event.data)
    if (eventType === 'error' || chunk.type === 'error') throw new ProviderError('upstream_error', '服务在生成过程中返回错误，请检查服务状态、模型和鉴权配置后重试。')
    const dataType = chunk.type ?? eventType
    switch (dataType) {
      case 'response.output_text.delta': {
        const delta = chunk.delta
        if (typeof delta !== 'string') invalidStream()
        if (delta) yield { type: 'text', text: delta }
        break
      }
      case 'response.failed':
        throw new ProviderError('upstream_error', '服务在生成过程中返回错误，请检查服务状态、模型和鉴权配置后重试。')
      case 'response.completed': {
        if (!object(chunk.response)) invalidStream()
        const resp = chunk.response
        const status = resp.status
        if (status === 'failed') throw new ProviderError('upstream_failed', '服务标记生成失败，请检查服务状态、模型和鉴权配置后重试。')
        if (status === 'cancelled') throw new ProviderError('upstream_cancelled', '服务取消了生成，请重试。')
        if (status === 'incomplete') throw new ProviderError('upstream_incomplete', '服务标记生成不完整，已收到的内容可能被截断。请重试。')
        if (status !== 'completed') invalidStream()
        const output = resp.output
        if (Array.isArray(output)) {
          for (const item of output) {
            if (!object(item)) continue
            if (item.type === 'function_call') {
              const id = typeof item.call_id === 'string' ? item.call_id : ''
              const name = typeof item.name === 'string' ? item.name : ''
              const args = item.arguments
              const json = typeof args === 'string' ? args : object(args) ? JSON.stringify(args) : ''
              if (id && name && json && !tools.some(t => t.id === id)) tools.push({ id, name, json })
            }
          }
        }
        completed = true
        break
      }
      default:
        break
    }
  }
  if (!completed) incomplete()
  for (const tool of completedTools(tools, input)) yield tool
  yield { type: 'done' }
}

function hasImages(input: StreamChatInput): boolean {
  return input.messages.some(message => message.content !== null && typeof message.content !== 'string' &&
    (Array.isArray(message.content) ? message.content : message.content.content).some(block => block.type === 'image'))
}

async function requestDetails(input: StreamChatInput): Promise<{ url: URL; headers: Headers; body: Json }> {
  const { provider } = input
  if (provider.multimodal === false && hasImages(input)) throw new ProviderError('vision_unavailable', '当前模型未启用视觉能力，尚未读取图片；请切换支持图片的模型后继续。')
  if (provider.protocol !== 'openai' && provider.protocol !== 'anthropic' && provider.protocol !== 'openai-responses') {
    throw new ProviderError('invalid_protocol', '未知的服务协议，请检查配置。')
  }
  let url: URL
  try {
    url = new URL(provider.baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error()
  } catch { throw new ProviderError('invalid_url', '服务地址无效，请填写包含 API 路径前缀的 HTTP 或 HTTPS 地址。') }
  const suffix = provider.protocol === 'openai' ? '/chat/completions' : provider.protocol === 'anthropic' ? '/messages' : '/responses'
  url.pathname = url.pathname.replace(/\/+$/, '') + suffix
  url.hash = ''
  const headers = new Headers({ 'content-type': 'application/json', accept: 'text/event-stream' })
  const body: Json = { model: provider.model, stream: true }
  const messages = await formatModelMessages(provider.protocol, input.messages, input.loadImage ?? (async () => { throw new MessageFormatError() }))
  if (provider.protocol === 'openai') {
    if (provider.apiKey) headers.set('authorization', `Bearer ${provider.apiKey}`)
    body.messages = [{ role: 'system', content: input.system }, ...messages]
    if (provider.maxOutputTokens !== undefined) body.max_tokens = provider.maxOutputTokens
    if (input.tools?.length) body.tools = input.tools.map((tool) => ({ type: 'function', function: tool }))
    if (input.forceTool) body.tool_choice = { type: 'function', function: { name: input.forceTool } }
  } else if (provider.protocol === 'anthropic') {
    if (provider.apiKey) headers.set('x-api-key', provider.apiKey)
    headers.set('anthropic-version', '2023-06-01')
    body.system = input.system
    body.messages = messages
    body.max_tokens = provider.maxOutputTokens ?? 262144
    if (input.tools?.length) body.tools = input.tools.map(({ name, description, parameters }) => ({ name, description, input_schema: parameters }))
    if (input.forceTool) body.tool_choice = { type: 'tool', name: input.forceTool }
  } else {
    if (provider.apiKey) headers.set('authorization', `Bearer ${provider.apiKey}`)
    body.instructions = input.system
    body.input = messages
    if (provider.maxOutputTokens !== undefined) body.max_output_tokens = provider.maxOutputTokens
    if (input.tools?.length) body.tools = input.tools.map(({ name, description, parameters }) => ({ type: 'function', name, description, parameters }))
    if (input.forceTool) body.tool_choice = { type: 'function', name: input.forceTool }
  }
  for (const [name, value] of Object.entries(provider.customHeaders)) headers.set(name, value)
  return { url, headers, body }
}

export async function* streamChat(input: StreamChatInput): AsyncGenerator<ProviderEvent> {
  if (input.signal.aborted) throw new ProviderError('cancelled', '请求已取消。')
  const controller = new AbortController()
  const cancel = () => controller.abort()
  input.signal.addEventListener('abort', cancel, { once: true })
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const beginRead = () => { timer = setTimeout(() => { timedOut = true; controller.abort() }, 60_000) }
  const endRead = () => clearTimeout(timer)
  try {
    const { url, headers, body } = await requestDetails(input)
    controller.signal.throwIfAborted()
    input.beforeDispatch?.()
    beginRead()
    let response: Response
    try { response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal, redirect: 'error' }) } finally { endRead() }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      const detail = response.status === 401 ? '鉴权失败，请检查密钥。' : response.status === 403 ? '服务拒绝访问，请检查权限。' : response.status === 404 ? '服务路径或模型不存在，请检查配置。' : response.status === 429 ? '请求过于频繁，请稍后重试。' : '请检查服务状态和配置后重试。'
      throw new ProviderError(`http_${response.status}`, `服务返回 HTTP ${response.status}：${detail}${hasImages(input) ? ' 图片请求未成功，尚未确认页面读取；若模型不支持图片，请切换视觉模型后继续。' : ''}`)
    }
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
      await response.body?.cancel().catch(() => {})
      invalidStream()
    }
    const events = readSse(response.body, controller.signal, beginRead, endRead)
    const parsed = input.provider.protocol === 'openai' ? openaiStream(events, input)
      : input.provider.protocol === 'anthropic' ? anthropicStream(events, input)
      : responsesStream(events, input)
    for await (const event of parsed) {
      controller.signal.throwIfAborted()
      yield event
    }
  } catch (error) {
    if (input.signal.aborted) throw new ProviderError('cancelled', '请求已取消。')
    if (timedOut) throw new ProviderError('timeout', '服务响应超时，请检查网络和服务状态后重试。')
    if (error instanceof ProviderError) {
      if (hasImages(input) && !error.message.includes('尚未')) throw new ProviderError(error.code, error.message + ' 图片读取尚未确认；若当前模型拒绝图片，请切换视觉模型后继续。')
      throw error
    }
    if (error instanceof MessageFormatError) throw new ProviderError(error.code, error.message)
    throw new ProviderError('connection_error', '服务连接失败，请检查地址、网络和重定向配置后重试。')
  } finally {
    endRead()
    input.signal.removeEventListener('abort', cancel)
    controller.abort()
  }
}
