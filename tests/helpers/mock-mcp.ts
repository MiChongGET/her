import { createServer, type ServerResponse } from 'node:http'
import { createInterface } from 'node:readline'

export interface MockOptions { catalogChange?: 'none' | 'schema'; validImage?: boolean; callDelay?: number; invalidStdout?: boolean; duplicate?: boolean; schema?: string; initDelay?: number; authStatus?: number; token?: string; holdOpen?: boolean; outputs?: Record<string, { schema: Record<string, unknown>; value: Record<string, unknown> }> }
interface Request { id?: number | string; method: string; params?: Record<string, any> }
function protocol(options: MockOptions, notify: (message: unknown) => void, close: () => void) {
  const requests: Request[] = []
  let changed = false
  const tool = (name: string) => ({ name, description: 'Mock tool', inputSchema: { $schema: options.schema ?? 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { value: { type: changed && options.catalogChange === 'schema' ? 'string' : 'integer' } }, additionalProperties: false }, annotations: { readOnlyHint: true }, ...(options.outputs?.[name] ? { outputSchema: options.outputs[name].schema } : {}) })
  const handle = async (request: Request): Promise<unknown> => {
    requests.push(request)
    if (request.id === undefined) return undefined
    let result: unknown
    if (request.method === 'initialize') {
      await new Promise(resolve => setTimeout(resolve, options.initDelay ?? 0))
      result = { protocolVersion: '2025-11-25', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'local-test', version: '1' } }
    } else if (request.method === 'tools/list') {
      result = request.params?.cursor ? { tools: [tool(options.duplicate ? 'echo' : 'other.name')] } : { tools: [tool(changed && options.catalogChange === undefined ? 'new-tool' : 'echo')], nextCursor: 'second' }
    } else if (request.method === 'tools/call') {
      if (options.callDelay) await new Promise(resolve => setTimeout(resolve, options.callDelay))
      const name = request.params?.name
      if (options.outputs?.[name]) result = { content: [{ type: 'text', text: 'returned' }], structuredContent: options.outputs[name].value }
      else if (name === 'echo') {
        const value = request.params?.arguments?.value
        if (value === 1) result = { content: [{ type: 'text', text: 'hello' }, { type: 'image', mimeType: 'image/png', data: options.validImage ? 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=' : Buffer.from('image-data').toString('base64') }, { type: 'resource_link', uri: 'file:///private/never-read', name: 'unread' }], structuredContent: { count: 7 }, _meta: { source: 'mock' } }
        else if (value === 2) result = { content: [{ type: 'text', text: 'failed' }], isError: true }
        else if (value === 3) result = { content: [{ type: 'future_custom', data: 'unknown' }] }
        else if (value === 4) { changed = true; notify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); result = { content: [{ type: 'text', text: 'changed' }] } }
        else if (value === 5) return new Promise(() => {})
        else if (value === 6) { close(); return new Promise(() => {}) }
        else if (value === 7 || value === 8) result = { content: [{ type: 'image', mimeType: 'image/png', data: Buffer.alloc(10 * 1024 * 1024 + (value === 8 ? 1 : 0), 42).toString('base64') }] }
        else result = { content: [{ type: 'text', text: String(requests.filter(r => r.method === 'tools/call').length) }] }
      } else result = { content: [{ type: 'text', text: 'other' }] }
    } else if (request.method === 'ping') result = {}
    else return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unsupported' } }
    return { jsonrpc: '2.0', id: request.id, result }
  }
  return { handle, requests }
}

export async function startMockHttp(options: MockOptions = {}) {
  const streams = new Set<ServerResponse>()
  const core = protocol(options, message => { for (const stream of streams) stream.write(`data: ${JSON.stringify(message)}\n\n`) }, () => { for (const stream of streams) stream.destroy(); server.closeAllConnections() })
  const server = createServer(async (req, res) => {
    if (options.authStatus || (options.token && req.headers.authorization !== options.token)) { res.writeHead(options.authStatus ?? 401); res.end('secret error ' + options.token); return }
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); streams.add(res); req.on('close', () => streams.delete(res)); return }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    let body = ''; for await (const chunk of req) body += chunk
    const response = await core.handle(JSON.parse(body))
    if (response === undefined) { res.writeHead(202); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(response))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`, requests: core.requests, close: async () => { for (const stream of streams) stream.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}

if (process.argv[2] === '--stdio') {
  const options: MockOptions = JSON.parse(process.argv[3] ?? '{}')
  const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + '\n')
  const core = protocol(options, send, () => process.exit(0))
  if (options.holdOpen) { setInterval(() => {}, 1000); process.on('SIGTERM', () => {}) }
  if (options.invalidStdout) { process.stderr.write(('secret=' + (process.env.TOKEN ?? '') + '\n').repeat(1000)); process.stdout.write('not-json\n') }
  createInterface({ input: process.stdin }).on('line', async line => { const response = await core.handle(JSON.parse(line)); if (response !== undefined) send(response) })
}
