import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FixtureRequest {
  path: string
  body: Record<string, unknown>
  headers: IncomingMessage['headers']
}

export interface FixtureReply { text?: string; toolCall?: { name: string; arguments: Record<string, unknown> }; delayMs?: number }
export async function startMockProvider(options: { reply?: (body: Record<string, unknown>) => FixtureReply } = {}) {
  const requests: FixtureRequest[] = []
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk.toString()
    const body = JSON.parse(raw) as Record<string, unknown>
    requests.push({ path: request.url ?? '', body, headers: request.headers })
    if (body.model === 'error-model') {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'fixture authentication failure' } }))
      return
    }
    const anthropic = request.url?.endsWith('/messages')
    const responses = request.url?.endsWith('/responses')
    if (!anthropic && !responses && !request.url?.endsWith('/chat/completions')) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    if (options.reply) {
      const reply = options.reply(body)
      if (reply.delayMs) await new Promise<void>(resolve => { const timer = setTimeout(resolve, reply.delayMs); response.once('close', () => { clearTimeout(timer); resolve() }) })
      if (response.destroyed) return
      const call = reply.toolCall
      const id = 'fixture-call-' + requests.length
      const push = (value: unknown, event?: string) => response.write((event ? 'event: ' + event + '\n' : '') + 'data: ' + JSON.stringify(value) + '\n\n')
      if (anthropic) {
        push({ type: 'message_start', message: { id, role: 'assistant', content: [], model: body.model, stop_reason: null } }, 'message_start')
        push({ type: 'content_block_start', index: 0, content_block: call ? { type: 'tool_use', id, name: call.name, input: {} } : { type: 'text', text: '' } }, 'content_block_start')
        push({ type: 'content_block_delta', index: 0, delta: call ? { type: 'input_json_delta', partial_json: JSON.stringify(call.arguments) } : { type: 'text_delta', text: reply.text ?? '' } }, 'content_block_delta')
        push({ type: 'content_block_stop', index: 0 }, 'content_block_stop')
        push({ type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn' } }, 'message_delta')
        push({ type: 'message_stop' }, 'message_stop')
      } else if (responses) {
        push({ type: 'response.created' }, 'response.created')
        if (!call) push({ type: 'response.output_text.delta', delta: reply.text ?? '' }, 'response.output_text.delta')
        push({ type: 'response.completed', response: { status: 'completed', output: call ? [{ type: 'function_call', call_id: id, name: call.name, arguments: JSON.stringify(call.arguments) }] : [] } }, 'response.completed')
      } else {
        push({ choices: [{ index: 0, delta: call ? { tool_calls: [{ index: 0, id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content: reply.text ?? '' }, finish_reason: null }] })
        push({ choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] })
        response.write('data: [DONE]\n\n')
      }
      response.end()
      return
    }
    const messages = (body.messages ?? body.input) as { content: string }[]
    const slow = JSON.stringify(messages.at(-1)?.content ?? '').includes('慢一点')
    const choice = body.tool_choice as { name?: string; function?: { name?: string } } | undefined
    const tool = choice?.name === 'report_connection' || choice?.function?.name === 'report_connection'
    const push = (value: unknown, event?: string) => {
      response.write((event ? 'event: ' + event + '\n' : '') + 'data: ' + JSON.stringify(value) + '\n\n')
    }
    const pause = (ms: number) => new Promise<void>(resolve => {
      const timer = setTimeout(resolve, ms)
      response.once('close', () => { clearTimeout(timer); resolve() })
    })
    if (anthropic) {
      push({ type: 'message_start', message: { id: 'fixture-message', role: 'assistant', content: [], model: body.model, stop_reason: null } }, 'message_start')
      if (tool) {
        push({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'fixture-tool', name: 'report_connection', input: {} } }, 'content_block_start')
        push({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"ok":' } }, 'content_block_delta')
        push({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'true}' } }, 'content_block_delta')
      } else {
        push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'content_block_start')
        push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '我在，' } }, 'content_block_delta')
        await pause(slow ? 8000 : 70)
        if (response.destroyed) return
        push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '慢慢说。' } }, 'content_block_delta')
      }
      push({ type: 'content_block_stop', index: 0 }, 'content_block_stop')
      push({ type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null } }, 'message_delta')
      push({ type: 'message_stop' }, 'message_stop')
    } else if (responses) {
      push({ type: 'response.created' }, 'response.created')
      if (tool) {
        push({ type: 'response.output_text.delta', delta: '我在，慢慢说。' }, 'response.output_text.delta')
        const output = [{ type: 'function_call', call_id: 'fixture-tool', name: 'report_connection', arguments: '{"ok":true}' }]
        push({ type: 'response.completed', response: { status: 'completed', output } }, 'response.completed')
      } else {
        push({ type: 'response.output_text.delta', delta: '我在，' }, 'response.output_text.delta')
        await pause(slow ? 8000 : 70)
        if (response.destroyed) return
        push({ type: 'response.output_text.delta', delta: '慢慢说。' }, 'response.output_text.delta')
        push({ type: 'response.completed', response: { status: 'completed', output: [] } }, 'response.completed')
      }
    } else {
      if (tool) {
        push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'fixture-tool', type: 'function', function: { name: 'report_connection', arguments: '{"ok":' } }] }, finish_reason: null }] })
        push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'true}' } }] }, finish_reason: null }] })
      } else {
        push({ choices: [{ index: 0, delta: { content: '我在，' }, finish_reason: null }] })
        await pause(slow ? 8000 : 70)
        if (response.destroyed) return
        push({ choices: [{ index: 0, delta: { content: '慢慢说。' }, finish_reason: null }] })
      }
      push({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })
      response.write('data: [DONE]\n\n')
    }
    response.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: 'http://127.0.0.1:' + port + '/proxy/v1',
    requests,
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  }
}
