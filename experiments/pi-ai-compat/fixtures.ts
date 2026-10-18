import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import type { ProviderEvent, ProviderProtocol, StreamChatInput } from '../../src/shared/types'
import { streamChatWithPi } from './adapter'

export const protocols: ProviderProtocol[] = ['openai', 'anthropic', 'openai-responses']
export const tool = { name: 'report_connection', description: '报告连接状态', parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } }
export type Scenario = 'text' | 'tool' | 'multi-tool' | 'bad-json-tool' | 'partial-json-tool' | 'array-tool' | 'unknown-tool' | 'mixed-invalid' | 'missing-terminal' | 'missing-finish' | 'wrong-tool-finish' | 'tool-without-calls' | 'truncated' | 'truncated-tool' | 'upstream-error' | 'malformed-json' | 'invalid-content-type' | 'unknown-stop' | 'hang' | 'http-error' | 'missing-block-stop' | 'missing-start' | 'final-only-tool' | 'queued-status' | 'missing-status' | 'redirect'
export interface CapturedRequest { url: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }
export interface Observation { events: ProviderEvent[]; error: { code: string; message: string } | null; usage?: unknown; stopReason?: string }
export const makeInput = (protocol: ProviderProtocol, baseUrl: string): StreamChatInput => ({
  provider: { id: 'fixture', name: 'Local fixture', protocol, model: 'test-model', baseUrl: `${baseUrl}/proxy/v1/`, apiKey: 'fixture-key', customHeaders: { 'X-Fixture': 'her' } },
  system: '你是 Her。', messages: [{ role: 'user', content: '请记住我喜欢茶。' }], tools: [tool], signal: new AbortController().signal,
})
const sse = (data: unknown, event?: string) => `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`
const openai = (delta: unknown, reason: string | null = null, usage?: unknown) => sse({ id: 'chat_1', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta, finish_reason: reason }], ...(usage ? { usage } : {}) })
const anthropic = (type: string, fields: Record<string, unknown> = {}) => sse({ type, ...fields }, type)
const responses = (type: string, fields: Record<string, unknown> = {}) => sse({ type, ...fields }, type)

export function fixtureWire(protocol: ProviderProtocol, scenario: Scenario): string {
  if (scenario === 'malformed-json') return 'data: {broken\n\n'
  if (scenario === 'upstream-error') return sse({ type: 'error', error: { type: 'invalid_request_error', message: 'fixture error' } }, 'error')
  const toolScenario = ['tool', 'multi-tool', 'bad-json-tool', 'partial-json-tool', 'array-tool', 'unknown-tool', 'mixed-invalid', 'wrong-tool-finish', 'truncated-tool', 'missing-block-stop', 'final-only-tool'].includes(scenario)
  const args = scenario === 'bad-json-tool' ? '{"ok":trueoops}' : scenario === 'partial-json-tool' ? '{"ok":' : scenario === 'array-tool' ? '[]' : '{"ok":true}'
  const calls = toolScenario ? [{ id: 'call_1', name: scenario === 'unknown-tool' ? 'not_allowed' : tool.name, args }] : []
  if (scenario === 'multi-tool' || scenario === 'mixed-invalid') calls.push({ id: 'call_2', name: tool.name, args: scenario === 'mixed-invalid' ? '{"ok":' : '{"ok":false}' })
  const truncated = scenario === 'truncated' || scenario === 'truncated-tool'
  const reason = scenario === 'missing-finish' ? null : truncated ? 'length' : scenario === 'unknown-stop' ? 'mystery' : (toolScenario && scenario !== 'wrong-tool-finish') || scenario === 'tool-without-calls' ? 'tool_calls' : 'stop'
  if (protocol === 'openai') {
    const content = calls.length ? calls.map((call, index) => openai({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: call.args } }] })).join('') : openai({ role: 'assistant', content: '你好🌙' })
    return content + (scenario === 'hang' ? '' : openai({}, reason, { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 })) + (scenario === 'missing-terminal' || scenario === 'hang' ? '' : sse('[DONE]'))
  }
  if (protocol === 'anthropic') {
    const start = anthropic('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'test-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 11, output_tokens: 1 } } })
    const content = calls.length ? calls.map((call, index) => anthropic('content_block_start', { index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } }) + anthropic('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: call.args } }) + anthropic('content_block_stop', { index })).join('') : anthropic('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) + anthropic('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '你好🌙' } }) + anthropic('content_block_stop', { index: 0 })
    const stop = reason === 'length' ? 'max_tokens' : reason === 'tool_calls' ? 'tool_use' : reason === 'stop' ? 'end_turn' : reason
    return (scenario === 'missing-start' ? '' : start) + (scenario === 'missing-block-stop' ? content.replace(/event: content_block_stop\ndata: .*?\n\n/g, '') : content) + (scenario === 'hang' ? '' : anthropic('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } })) + (scenario === 'missing-terminal' || scenario === 'hang' ? '' : anthropic('message_stop'))
  }
  const output = calls.length ? calls.map(call => ({ type: 'function_call', id: `fc_${call.id}`, call_id: call.id, name: call.name, arguments: call.args, status: 'completed' })) : [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '你好🌙', annotations: [] }] }]
  let wire = responses('response.created', { response: { id: 'resp_1', status: 'in_progress', output: [], model: 'test-model' } })
  if (calls.length) {
    calls.forEach((call, index) => {
      wire += responses('response.output_item.added', { output_index: index, item: { ...output[index], arguments: '', status: 'in_progress' } })
      wire += responses('response.function_call_arguments.delta', { item_id: `fc_${call.id}`, output_index: index, delta: call.args })
      wire += responses('response.function_call_arguments.done', { item_id: `fc_${call.id}`, output_index: index, arguments: call.args })
      wire += responses('response.output_item.done', { output_index: index, item: output[index] })
    })
  } else {
    wire += responses('response.output_item.added', { output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] } })
    wire += responses('response.content_part.added', { output_index: 0, content_index: 0, item_id: 'msg_1', part: { type: 'output_text', text: '', annotations: [] } })
    wire += responses('response.output_text.delta', { output_index: 0, content_index: 0, item_id: 'msg_1', delta: '你好🌙' })
    wire += responses('response.output_text.done', { output_index: 0, content_index: 0, item_id: 'msg_1', text: '你好🌙' })
    wire += responses('response.output_item.done', { output_index: 0, item: output[0] })
  }
  if (scenario === 'missing-terminal' || scenario === 'hang') return wire
  const status = truncated ? 'incomplete' : scenario === 'unknown-stop' ? 'mystery' : scenario === 'queued-status' ? 'queued' : 'completed'
  return (scenario === 'final-only-tool' ? '' : wire) + responses('response.completed', { response: { id: 'resp_1', ...(scenario === 'missing-status' ? {} : { status }), output, model: 'test-model', ...(truncated ? { incomplete_details: { reason: 'max_output_tokens' } } : {}), usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16 } } })
}

export async function startFixtureServer(protocol: ProviderProtocol, scenario: Scenario | Scenario[] = 'text', options: { byteChunks?: boolean; status?: number } = {}) {
  const requests: CapturedRequest[] = []
  const responsesInFlight = new Set<ServerResponse>()
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const current = Array.isArray(scenario) ? scenario[Math.min(requests.length, scenario.length - 1)] : scenario
    requests.push({ url: request.url ?? '', headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') })
    responsesInFlight.add(response)
    response.on('close', () => responsesInFlight.delete(response))
    if (current === 'redirect' && request.url !== '/fixture-final') { response.writeHead(302, { location: '/fixture-final' }); response.end(); return }
    response.writeHead(options.status ?? (current === 'http-error' ? 401 : 200), { 'content-type': current === 'invalid-content-type' ? 'application/json' : 'text/event-stream' })
    if (current === 'http-error') { response.end(JSON.stringify({ error: { message: 'fixture unauthorized synthetic_secret_marker' } })); return }
    const bytes = Buffer.from(fixtureWire(protocol, current))
    if (options.byteChunks) {
      for (const byte of bytes) { if (response.destroyed) break; response.write(Buffer.from([byte])); await new Promise<void>(resolve => setImmediate(resolve)) }
    } else response.write(bytes)
    if (current !== 'hang') response.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No fixture address')
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests, close: () => new Promise<void>(resolve => { for (const response of responsesInFlight) response.destroy(); server.closeAllConnections(); server.close(() => resolve()) }) }
}

export async function collectStream(input: StreamChatInput, stream: (input: StreamChatInput) => AsyncIterable<ProviderEvent>): Promise<Observation> {
  const events: ProviderEvent[] = []
  try { for await (const event of stream(input)) events.push(event); return { events, error: null } }
  catch (error) { return { events, error: { code: (error as { code?: string }).code ?? 'unknown', message: error instanceof Error ? error.message : String(error) } } }
}
export async function collectPi(input: StreamChatInput): Promise<Observation> {
  let final: { usage?: unknown; stopReason?: string } = {}
  const result = await collectStream(input, request => streamChatWithPi(request, { onFinal: message => { final = { usage: message.usage, stopReason: message.stopReason } } }))
  return { ...result, ...final }
}
