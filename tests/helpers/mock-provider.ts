import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FixtureRequest {
  path: string
  body: Record<string, unknown>
  headers: IncomingMessage['headers']
}

export interface FixtureReply { text?: string; toolCall?: { name: string; arguments: Record<string, unknown> }; delayMs?: number }
export async function startMockProvider(options: { reply?: (body: Record<string, unknown>) => FixtureReply; beforeReply?: () => Promise<void> } = {}) {
  const requests: FixtureRequest[] = []
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk.toString()
    const body = JSON.parse(raw) as Record<string, unknown>
    const path = new URL(request.url ?? '/', 'http://fixture').pathname
    requests.push({ path, body, headers: request.headers })
    if (body.model === 'error-model') {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'fixture authentication failure' } }))
      return
    }
    const anthropic = path.endsWith('/messages')
    const responses = path.endsWith('/responses')
    if (!anthropic && !responses && !path.endsWith('/chat/completions')) { response.writeHead(404).end(); return }
    await options.beforeReply?.()
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const pause = (ms: number) => new Promise<void>(resolve => {
      const timer = setTimeout(resolve, ms)
      response.once('close', () => { clearTimeout(timer); resolve() })
    })
    const choice = body.tool_choice as { name?: string; function?: { name?: string } } | undefined
    const forcedTool = choice?.name === 'report_connection' || choice?.function?.name === 'report_connection'
    const reply = options.reply?.(body) ?? (forcedTool ? { toolCall: { name: 'report_connection', arguments: { ok: true } } } : { text: '我在，慢慢说。' })
    if (reply.delayMs) await pause(reply.delayMs)
    if (response.destroyed) return
    const call = reply.toolCall
    const id = 'fixture-call-' + requests.length
    const push = (value: unknown, event?: string) => response.write((event ? 'event: ' + event + '\n' : '') + 'data: ' + JSON.stringify(value) + '\n\n')
    const messages = (body.messages ?? body.input) as { content: unknown }[]
    const slow = JSON.stringify(messages.at(-1)?.content ?? '').includes('慢一点')
    const text = reply.text ?? ''
    const first = options.reply ? text : '我在，'
    const rest = options.reply ? '' : '慢慢说。'
    if (anthropic) {
      push({ type: 'message_start', message: { id, type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, usage: { input_tokens: 11, output_tokens: 0 } } }, 'message_start')
      push({ type: 'content_block_start', index: 0, content_block: call ? { type: 'tool_use', id, name: call.name, input: {} } : { type: 'text', text: '' } }, 'content_block_start')
      push({ type: 'content_block_delta', index: 0, delta: call ? { type: 'input_json_delta', partial_json: JSON.stringify(call.arguments) } : { type: 'text_delta', text: first } }, 'content_block_delta')
      if (!call && rest) {
        await pause(slow ? 8000 : 70)
        if (response.destroyed) return
        push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: rest } }, 'content_block_delta')
      }
      push({ type: 'content_block_stop', index: 0 }, 'content_block_stop')
      push({ type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } }, 'message_delta')
      push({ type: 'message_stop' }, 'message_stop')
    } else if (responses) {
      const item = call ? { type: 'function_call', id, call_id: id, name: call.name, arguments: JSON.stringify(call.arguments), status: 'completed' }
        : { type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
      push({ type: 'response.created', response: { id, status: 'in_progress' } })
      push({ type: 'response.output_item.added', output_index: 0, item: call ? { ...item, arguments: '' } : { ...item, content: [] } })
      if (call) push({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: id, delta: JSON.stringify(call.arguments) })
      else {
        push({ type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: id, part: { type: 'output_text', text: '', annotations: [] } })
        push({ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: id, delta: first })
        if (rest) {
          await pause(slow ? 8000 : 70)
          if (response.destroyed) return
          push({ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: id, delta: rest })
        }
      }
      push({ type: 'response.output_item.done', output_index: 0, item })
      push({ type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 11, output_tokens: 5 } } })
    } else {
      push({ choices: [{ index: 0, delta: call ? { tool_calls: [{ index: 0, id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content: first }, finish_reason: null }] })
      if (!call && rest) {
        await pause(slow ? 8000 : 70)
        if (response.destroyed) return
        push({ choices: [{ index: 0, delta: { content: rest }, finish_reason: null }] })
      }
      push({ choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 5 } })
      response.write('data: [DONE]\n\n')
    }
    response.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return { baseUrl: 'http://127.0.0.1:' + port + '/proxy/v1', requests, async close() {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  } }
}
