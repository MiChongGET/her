import type { AnyModelMessage, ProviderProtocol } from '../../shared/types'
import { normalizeToolResult } from '../tools/results'
import { modelToolResultText } from '../tools/result-format'

type Json = Record<string, unknown>

export class MessageFormatError extends Error {
  readonly code = 'image_unavailable'
  constructor() { super('图片资料无法读取或格式不受支持，本次未将图片发送给模型。') }
}

function imageBlock(protocol: ProviderProtocol, mimeType: string, data: string): Json {
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType) || !data) throw new MessageFormatError()
  if (protocol === 'openai') return { type: 'image_url', image_url: { url: `data:${mimeType};base64,${data}` } }
  if (protocol === 'openai-responses') return { type: 'input_image', image_url: `data:${mimeType};base64,${data}`, detail: 'auto' }
  return { type: 'image', source: { type: 'base64', media_type: mimeType, data } }
}

export async function formatModelMessages(
  protocol: ProviderProtocol,
  messages: AnyModelMessage[],
  loadImage: (id: string) => Promise<Uint8Array>
): Promise<unknown[]> {
  const result: Json[] = []
  let pendingImages: Json[] = []
  const flushImages = () => { result.push(...pendingImages); pendingImages = [] }
  for (const message of messages) {
    if (message.role === 'tool') {
      const normalized = normalizeToolResult(message.content)
      const text = modelToolResultText(normalized)
      const images: Json[] = []
      for (const block of normalized.content) {
        if (block.type !== 'image') continue
        let bytes: Uint8Array
        try { bytes = await loadImage(block.artifactId) } catch { throw new MessageFormatError() }
        if (!bytes.byteLength || bytes.byteLength > 10 * 1024 * 1024) throw new MessageFormatError()
        images.push(imageBlock(protocol, block.mimeType, Buffer.from(bytes).toString('base64')))
      }
      const content = images.length ? [...(text ? [{ type: protocol === 'openai-responses' ? 'input_text' : 'text', text }] : []), ...images] : text
      if (protocol === 'openai') {
        result.push({ role: 'tool', tool_call_id: message.tool_call_id, content: text })
        if (images.length) pendingImages.push({ role: 'user', content: [{ type: 'text', text: `Tool images; call_id=${message.tool_call_id}` }, ...images] })
      } else if (protocol === 'openai-responses') {
        result.push({ type: 'function_call_output', call_id: message.tool_call_id, output: content })
      } else {
        const block = { type: 'tool_result', tool_use_id: message.tool_call_id, content, ...(normalized.isError ? { is_error: true } : {}) }
        const last = result.at(-1)
        if (last?.role === 'user' && Array.isArray(last.content) && last.content.every((item: Json) => item.type === 'tool_result')) last.content.push(block)
        else result.push({ role: 'user', content: [block] })
      }
      continue
    }
    // Chat Completions requires every result in the batch before user images.
    flushImages()
    if ('tool_calls' in message) {
      if (protocol === 'openai') result.push({ role: message.role, content: message.content, tool_calls: message.tool_calls })
      else if (protocol === 'anthropic') result.push({ role: 'assistant', content: [
        ...(message.content ? [{ type: 'text', text: message.content }] : []),
        ...message.tool_calls.map(call => ({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) }))
      ] })
      else result.push(
        ...(message.content ? [{ role: 'assistant', content: message.content }] : []),
        ...message.tool_calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments }))
      )
    } else result.push({ role: message.role, content: typeof message.content === 'string' ? message.content : message.content.map(block => block.type === 'text'
      ? { type: protocol === 'openai-responses' ? (message.role === 'assistant' ? 'output_text' : 'input_text') : 'text', text: block.text }
      : imageBlock(protocol, block.source.media_type, block.source.data)) })
  }
  flushImages()
  return result
}
