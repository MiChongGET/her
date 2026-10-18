import { createServer, type RequestListener, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderError, streamChat } from '../src/core/providers/stream'
import type { ProviderEvent, ProviderProtocol, StreamChatInput } from '../src/shared/types'

const tool = { name: 'report_connection', description: 'Report connection', parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } }
const servers: Server[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
})

function input(protocol: ProviderProtocol = 'openai'): StreamChatInput {
  return {
    provider: { id: 'p1', name: 'Local', protocol, baseUrl: 'https://example.test/proxy/v1/', model: 'test-model', apiKey: 'key-secret', customHeaders: { 'X-Proxy-Secret': 'header-secret' } },
    system: '你是 Her。', messages: [{ role: 'user', content: '你好' }], signal: new AbortController().signal
  }
}

function openai(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({ id: 'chat_1', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
}

function anthropic(type: string, fields: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`
}

const start = () => anthropic('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'test-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
const textStart = () => anthropic('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
const textDelta = (text: string) => anthropic('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })
const blockStop = (index = 0) => anthropic('content_block_stop', { index })
const stopReason = (reason: string) => anthropic('message_delta', { delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 3 } })
const messageStop = () => anthropic('message_stop')
const completeText = (protocol: ProviderProtocol, text = '你好🌙') => protocol === 'openai'
  ? openai({ role: 'assistant', content: text }) + openai({}, 'stop') + 'data: [DONE]\n\n'
  : protocol === 'anthropic'
    ? start() + textStart() + textDelta(text) + blockStop() + stopReason('end_turn') + messageStop()
    : responses('response.output_text.delta', { delta: text }) + responses('response.completed', { response: { status: 'completed', output: [] } })

function responses(type: string, fields: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`
}

function fixtureResponse(wire: string): Response {
  const bytes = new TextEncoder().encode(wire)
  let offset = 0
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) controller.close()
      else controller.enqueue(bytes.slice(offset, ++offset))
    }
  }), { headers: { 'content-type': 'text/event-stream' } })
}

function wireResponse(wire: string): void {
  vi.stubGlobal('fetch', async () => fixtureResponse(wire))
}

async function collect(request: StreamChatInput): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = []
  for await (const event of streamChat(request)) events.push(event)
  return events
}

async function observe(request: StreamChatInput): Promise<{ events: ProviderEvent[]; error: unknown }> {
  const events: ProviderEvent[] = []
  try {
    for await (const event of streamChat(request)) events.push(event)
  } catch (error) { return { events, error } }
  return { events, error: null }
}

async function serve(handler: RequestListener): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  return `http://127.0.0.1:${address.port}`
}

describe('provider requests and streaming', () => {
  it.each(['openai', 'anthropic'] as const)('%s preserves the API prefix and sends its own authentication/body', async (protocol) => {
    let received: { url?: string; headers?: Record<string, unknown>; body?: Record<string, unknown> } = {}
    const baseUrl = await serve(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      received = { url: request.url, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(completeText(protocol))
    })
    const request = input(protocol)
    request.provider.baseUrl = `${baseUrl}/proxy/v1/`
    expect(await collect(request)).toEqual([{ type: 'text', text: '你好🌙' }, { type: 'done' }])
    expect(received.url).toBe(protocol === 'openai' ? '/proxy/v1/chat/completions' : '/proxy/v1/messages')
    expect(received.headers?.['x-proxy-secret']).toBe('header-secret')
    expect(received.headers?.[protocol === 'openai' ? 'authorization' : 'x-api-key']).toBe(protocol === 'openai' ? 'Bearer key-secret' : 'key-secret')
    expect(received.body).toMatchObject({ model: 'test-model', stream: true })
    expect(received.body?.tools).toBeUndefined()
    expect(received.body?.tool_choice).toBeUndefined()
    if (protocol === 'openai') expect(received.body?.messages).toEqual([{ role: 'system', content: '你是 Her。' }, { role: 'user', content: '你好' }])
    else {
      expect(received.headers?.['anthropic-version']).toBe('2023-06-01')
      expect(received.body?.system).toBe('你是 Her。')
      expect(received.body?.messages).toEqual([{ role: 'user', content: '你好' }])
      expect(received.body?.max_tokens).toBe(262144)
    }
  })

  it('sends the configured maximum output tokens to Anthropic and falls back to 262144', async () => {
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)))
      return fixtureResponse(completeText('anthropic'))
    })
    const configured = input('anthropic')
    configured.provider.maxOutputTokens = 8192
    await collect(configured)
    await collect(input('anthropic'))
    expect(bodies.map((body) => body.max_tokens)).toEqual([8192, 262144])
  })

  it('adds no output limit to OpenAI-compatible or Responses requests unless one is supplied', async () => {
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)))
      return fixtureResponse(completeText(bodies.length % 2 ? 'openai' : 'openai-responses'))
    })
    await collect(input('openai'))
    await collect(input('openai-responses'))
    for (const body of bodies) {
      expect(body).not.toHaveProperty('max_tokens')
      expect(body).not.toHaveProperty('max_output_tokens')
    }
  })

  it('sends max_tokens to OpenAI-compatible and max_output_tokens to Responses when a limit is supplied', async () => {
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)))
      return fixtureResponse(completeText(bodies.length === 1 ? 'openai' : 'openai-responses'))
    })
    for (const protocol of ['openai', 'openai-responses'] as const) {
      const request = input(protocol)
      request.provider.maxOutputTokens = 1_000_000
      await collect(request)
    }
    expect(bodies[0]).toMatchObject({ max_tokens: 1_000_000 })
    expect(bodies[0]).not.toHaveProperty('max_output_tokens')
    expect(bodies[1]).toMatchObject({ max_output_tokens: 1_000_000 })
    expect(bodies[1]).not.toHaveProperty('max_tokens')
  })

  it.each(['openai', 'anthropic'] as const)('%s decodes UTF-8 and CRLF SSE split into individual bytes', async (protocol) => {
    wireResponse(': keepalive\r\n\r\n' + completeText(protocol).replaceAll('\n', '\r\n'))
    expect(await collect(input(protocol))).toEqual([{ type: 'text', text: '你好🌙' }, { type: 'done' }])
  })

  it('supports multiline SSE data and a final event without a blank line', async () => {
    wireResponse('data: {"choices": [\ndata: {"index": 0, "delta": {"content": "Hi"}, "finish_reason": null}]}\n\n' + openai({}, 'stop') + 'data: [DONE]\n')
    expect(await collect(input())).toEqual([{ type: 'text', text: 'Hi' }, { type: 'done' }])
  })

  it.each(['openai', 'anthropic'] as const)('%s omits empty API keys and supports case-insensitive header overrides', async (protocol) => {
    let headers = new Headers()
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      headers = new Headers(init.headers)
      return fixtureResponse(completeText(protocol))
    })
    const request = input(protocol)
    request.provider.apiKey = ''
    request.provider.customHeaders = { 'Anthropic-Version': 'custom-version', 'X-Gateway-Token': 'gateway-secret' }
    await collect(request)
    expect(headers.has('authorization')).toBe(false)
    expect(headers.has('x-api-key')).toBe(false)
    expect(headers.get('x-gateway-token')).toBe('gateway-secret')
    if (protocol === 'anthropic') expect(headers.get('anthropic-version')).toBe('custom-version')
  })

  it.each(['openai', 'anthropic'] as const)('%s maps tool schemas and forces the probe using its protocol', async (protocol) => {
    let body: Record<string, unknown> = {}
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body))
      return fixtureResponse(completeText(protocol))
    })
    await collect({ ...input(protocol), tools: [tool], forceTool: 'report_connection' })
    expect(body.tools).toEqual(protocol === 'openai'
      ? [{ type: 'function', function: { name: 'report_connection', description: 'Report connection', parameters: tool.parameters } }]
      : [{ name: 'report_connection', description: 'Report connection', input_schema: tool.parameters }])
    expect(body.tool_choice).toEqual(protocol === 'openai' ? { type: 'function', function: { name: 'report_connection' } } : { type: 'tool', name: 'report_connection' })
  })

  it.each(['openai', 'anthropic', 'openai-responses'] as const)('%s sends the tool call and its result back in its own message shape', async (protocol) => {
    let body: Record<string, unknown> = {}
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body))
      return fixtureResponse(completeText(protocol))
    })
    const calls = [
      { id: 'c1', type: 'function' as const, function: { name: 'report_connection', arguments: '{"ok":true}' } },
      { id: 'c2', type: 'function' as const, function: { name: 'report_connection', arguments: '{"ok":false}' } }
    ]
    await collect({
      ...input(protocol), tools: [tool],
      messages: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '稍等', tool_calls: calls },
        { role: 'tool', tool_call_id: 'c1', content: 'r1' },
        { role: 'tool', tool_call_id: 'c2', content: 'r2' }
      ]
    })
    const expected = {
      openai: [
        { role: 'system', content: '你是 Her。' },
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '稍等', tool_calls: calls },
        { role: 'tool', tool_call_id: 'c1', content: 'r1' },
        { role: 'tool', tool_call_id: 'c2', content: 'r2' }
      ],
      anthropic: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: [
          { type: 'text', text: '稍等' },
          { type: 'tool_use', id: 'c1', name: 'report_connection', input: { ok: true } },
          { type: 'tool_use', id: 'c2', name: 'report_connection', input: { ok: false } }
        ] },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'c1', content: 'r1' },
          { type: 'tool_result', tool_use_id: 'c2', content: 'r2' }
        ] }
      ],
      'openai-responses': [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '稍等' },
        { type: 'function_call', call_id: 'c1', name: 'report_connection', arguments: '{"ok":true}' },
        { type: 'function_call', call_id: 'c2', name: 'report_connection', arguments: '{"ok":false}' },
        { type: 'function_call_output', call_id: 'c1', output: 'r1' },
        { type: 'function_call_output', call_id: 'c2', output: 'r2' }
      ]
    }[protocol]
    expect(body[protocol === 'openai-responses' ? 'input' : 'messages']).toEqual(expected)
  })

  it('emits OpenAI tools only after valid arguments, tool_calls finish and DONE', async () => {
    wireResponse(openai({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'report_connection', arguments: '{"ok":' } }] })
      + openai({ tool_calls: [{ index: 0, function: { arguments: 'true}' } }] }) + openai({}, 'tool_calls') + 'data: [DONE]\n\n')
    expect(await collect({ ...input(), tools: [tool] })).toEqual([{ type: 'tool', id: 'call_1', name: 'report_connection', arguments: { ok: true } }, { type: 'done' }])
  })

  it('emits Claude tool_use only after block stop, tool_use reason and message_stop', async () => {
    wireResponse(start() + anthropic('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'report_connection', input: {} } })
      + anthropic('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"ok":' } })
      + anthropic('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: 'true}' } })
      + blockStop() + stopReason('tool_use') + messageStop())
    expect(await collect({ ...input('anthropic'), tools: [tool] })).toEqual([{ type: 'tool', id: 'toolu_1', name: 'report_connection', arguments: { ok: true } }, { type: 'done' }])
  })

  it.each(['{"ok":', 'null', '[]'])('rejects invalid OpenAI tool arguments %s without any tool event', async (argumentsText) => {
    wireResponse(openai({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'report_connection', arguments: argumentsText } }] }) + openai({}, 'tool_calls') + 'data: [DONE]\n\n')
    const result = await observe({ ...input(), tools: [tool] })
    expect(result.events).toEqual([])
    expect(result.error).toMatchObject({ code: 'invalid_tool' })
  })

  it.each(['openai', 'anthropic'] as const)('%s never emits a tool or done when complete JSON lacks the message termination', async (protocol) => {
    wireResponse(protocol === 'openai'
      ? openai({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'report_connection', arguments: '{"ok":true}' } }] }) + openai({}, 'tool_calls')
      : start() + anthropic('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'report_connection', input: { ok: true } } }) + blockStop() + stopReason('tool_use'))
    const result = await observe({ ...input(protocol), tools: [tool] })
    expect(result.events).toEqual([])
    expect(result.error).toMatchObject({ code: 'incomplete_stream' })
  })

  it('rejects Claude tool_use without its block stop', async () => {
    wireResponse(start() + anthropic('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'report_connection', input: { ok: true } } }) + stopReason('tool_use') + messageStop())
    const result = await observe({ ...input('anthropic'), tools: [tool] })
    expect(result.events).toEqual([])
    expect(result.error).toMatchObject({ code: 'incomplete_stream' })
  })

  it.each(['{"ok":', 'null', '[]'])('rejects invalid Claude tool JSON %s without any tool event', async (partialJson) => {
    wireResponse(start() + anthropic('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'report_connection', input: {} } })
      + anthropic('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: partialJson } }) + blockStop() + stopReason('tool_use') + messageStop())
    const result = await observe({ ...input('anthropic'), tools: [tool] })
    expect(result.events).toEqual([])
    expect(result.error).toMatchObject({ code: 'invalid_tool' })
  })

  it('validates every tool before emitting any tool in a multi-call response', async () => {
    wireResponse(openai({ tool_calls: [
      { index: 0, id: 'call_1', type: 'function', function: { name: 'report_connection', arguments: '{"ok":true}' } },
      { index: 1, id: 'call_2', type: 'function', function: { name: 'report_connection', arguments: '{"ok":' } }
    ] }) + openai({}, 'tool_calls') + 'data: [DONE]\n\n')
    const result = await observe({ ...input(), tools: [tool] })
    expect(result.events).toEqual([])
    expect(result.error).toMatchObject({ code: 'invalid_tool' })
  })

  it.each(['openai', 'anthropic'] as const)('%s rejects a tool when the final reason only confirms text completion', async (protocol) => {
    wireResponse(protocol === 'openai'
      ? openai({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'report_connection', arguments: '{"ok":true}' } }] }) + openai({}, 'stop') + 'data: [DONE]\n\n'
      : start() + anthropic('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'report_connection', input: { ok: true } } }) + blockStop() + stopReason('end_turn') + messageStop())
    const result = await observe({ ...input(protocol), tools: [tool] })
    expect(result.events).toEqual([])
    expect(result.error).toMatchObject({ code: 'invalid_tool' })
  })

  it('rejects malformed SSE JSON without echoing raw upstream content', async () => {
    wireResponse('data: {secret:key-secret header-secret}\n\n')
    const result = await observe(input())
    expect(result.events).toEqual([])
    expect(result.error).toMatchObject({ code: 'invalid_stream' })
    expect(String(result.error)).not.toMatch(/key-secret|header-secret/)
  })

  it.each(['openai', 'anthropic'] as const)('%s retains text but reports a truncated stream', async (protocol) => {
    wireResponse(protocol === 'openai' ? openai({ content: '部分' }) : start() + textStart() + textDelta('部分'))
    const result = await observe(input(protocol))
    expect(result.events).toEqual([{ type: 'text', text: '部分' }])
    expect(result.error).toMatchObject({ code: 'incomplete_stream' })
  })

  it.each(['openai', 'anthropic'] as const)('%s reports token truncation without done', async (protocol) => {
    wireResponse(protocol === 'openai' ? openai({ content: '部分' }) + openai({}, 'length') + 'data: [DONE]\n\n' : start() + textStart() + textDelta('部分') + blockStop() + stopReason('max_tokens') + messageStop())
    const result = await observe(input(protocol))
    expect(result.events).toEqual([{ type: 'text', text: '部分' }])
    expect(result.error).toMatchObject({ code: 'truncated' })
  })

  it.each(['openai', 'anthropic'] as const)('%s surfaces midstream errors without leaking upstream secrets', async (protocol) => {
    wireResponse(protocol === 'openai' ? openai({ content: '部分' }) + 'data: {"error":{"message":"key-secret header-secret","code":"bad_key"}}\n\n' : start() + textStart() + textDelta('部分') + anthropic('error', { error: { type: 'overloaded_error', message: 'key-secret header-secret' } }))
    const result = await observe(input(protocol))
    expect(result.events).toEqual([{ type: 'text', text: '部分' }])
    expect(result.error).toBeInstanceOf(ProviderError)
    expect(result.error).toMatchObject({ code: 'upstream_error' })
    expect(String(result.error)).not.toMatch(/key-secret|header-secret/)
  })

  it('reports HTTP authentication errors without echoing their body', async () => {
    const baseUrl = await serve((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end('{"error":"key-secret header-secret"}')
    })
    const request = input()
    request.provider.baseUrl = `${baseUrl}/v1`
    const result = await observe(request)
    expect(result.error).toMatchObject({ code: 'http_401' })
    expect(String(result.error)).toMatch(/401|鉴权|密钥/)
    expect(String(result.error)).not.toMatch(/key-secret|header-secret/)
  })

  it('does not follow redirects carrying credentials to another endpoint', async () => {
    let redirected = false
    const target = await serve((_request, response) => { redirected = true; response.end(completeText('openai')) })
    const baseUrl = await serve((_request, response) => {
      response.writeHead(307, { location: `${target}/steal` })
      response.end()
    })
    const request = input()
    request.provider.baseUrl = `${baseUrl}/v1`
    const result = await observe(request)
    expect(result.error).toBeInstanceOf(ProviderError)
    expect(result.events).toEqual([])
    expect(redirected).toBe(false)
  })

  it('cancels a pending real HTTP read and never emits done', async () => {
    const baseUrl = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(openai({ content: '部分' }))
    })
    const controller = new AbortController()
    const request = input()
    request.provider.baseUrl = `${baseUrl}/v1`
    request.signal = controller.signal
    const generator = streamChat(request)
    expect(await generator.next()).toMatchObject({ value: { type: 'text', text: '部分' }, done: false })
    const next = generator.next()
    controller.abort()
    await expect(next).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('rejects a pre-aborted request before starting fetch', async () => {
    const controller = new AbortController()
    controller.abort()
    let started = false
    vi.stubGlobal('fetch', () => { started = true; throw new Error('Unexpected fetch') })
    await expect(collect({ ...input(), signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' })
    expect(started).toBe(false)
  })

  it('honors cancellation before emitting already buffered completion', async () => {
    vi.stubGlobal('fetch', async () => new Response(completeText('openai'), { headers: { 'content-type': 'text/event-stream' } }))
    const controller = new AbortController()
    const generator = streamChat({ ...input(), signal: controller.signal })
    expect(await generator.next()).toMatchObject({ value: { type: 'text', text: '你好🌙' } })
    controller.abort()
    await expect(generator.next()).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('times out a stalled body after preserving text and cancels the reader', async () => {
    vi.useFakeTimers()
    let cancelled = false
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(openai({ content: '部分' }))) },
      cancel() { cancelled = true }
    }), { headers: { 'content-type': 'text/event-stream' } }))
    const result = observe(input())
    await vi.advanceTimersByTimeAsync(60_001)
    expect(await result).toMatchObject({ events: [{ type: 'text', text: '部分' }], error: { code: 'timeout' } })
    expect(cancelled).toBe(true)
  })

  it('times out stalled response headers with a safe Chinese error', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))
    const result = observe(input())
    await vi.advanceTimersByTimeAsync(60_001)
    expect((await result).error).toMatchObject({ code: 'timeout' })
    expect(String((await result).error)).toMatch(/超时/)
  })
})

describe('OpenAI Responses protocol', () => {
  it('sends the OpenAI Responses request format and appends /responses to the URL', async () => {
    let received: { url?: string; headers?: Record<string, unknown>; body?: Record<string, unknown> } = {}
    const baseUrl = await serve(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      received = { url: request.url, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(completeText('openai-responses'))
    })
    const request = input('openai-responses')
    request.provider.baseUrl = `${baseUrl}/proxy/v1/`
    expect(await collect(request)).toEqual([{ type: 'text', text: '你好🌙' }, { type: 'done' }])
    expect(received.url).toBe('/proxy/v1/responses')
    expect(received.headers?.['authorization']).toBe('Bearer key-secret')
    expect(received.headers?.['x-proxy-secret']).toBe('header-secret')
    expect(received.body).toMatchObject({ model: 'test-model', stream: true, instructions: '你是 Her。', input: [{ role: 'user', content: '你好' }] })
    expect(received.body).not.toHaveProperty('messages')
    expect(received.body).not.toHaveProperty('system')
    expect(received.body).not.toHaveProperty('max_tokens')
    expect(received.body).not.toHaveProperty('max_output_tokens')
  })

  it('maps tool schemas with type: function wrapper and sends tool_choice', async () => {
    let body: Record<string, unknown> = {}
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body))
      return fixtureResponse(completeText('openai-responses'))
    })
    await collect({ ...input('openai-responses'), tools: [tool], forceTool: 'report_connection' })
    expect(body.tools).toEqual([{ type: 'function', name: 'report_connection', description: 'Report connection', parameters: tool.parameters }])
    expect(body.tool_choice).toEqual({ type: 'function', name: 'report_connection' })
  })

  it('emits text from response.output_text.delta and completes on response.completed with status completed', async () => {
    wireResponse(responses('response.created', { id: 'resp_1' })
      + responses('response.in_progress')
      + responses('response.output_text.delta', { delta: '你好' })
      + responses('response.output_text.delta', { delta: '🌙' })
      + responses('response.completed', { response: { status: 'completed', output: [] } }))
    expect(await collect(input('openai-responses'))).toEqual([{ type: 'text', text: '你好' }, { type: 'text', text: '🌙' }, { type: 'done' }])
  })

  it('emits tools from output array in response.completed and deduplicates by call_id', async () => {
    wireResponse(responses('response.completed', {
      response: {
        status: 'completed',
        output: [
          { type: 'function_call', call_id: 'call_1', name: 'report_connection', arguments: '{"ok":true}' },
          { type: 'function_call', call_id: 'call_2', name: 'report_connection', arguments: { ok: false } },
          { type: 'function_call', call_id: 'call_1', name: 'report_connection', arguments: '{"ok":true}' }
        ]
      }
    }))
    expect(await collect({ ...input('openai-responses'), tools: [tool] })).toEqual([
      { type: 'tool', id: 'call_1', name: 'report_connection', arguments: { ok: true } },
      { type: 'tool', id: 'call_2', name: 'report_connection', arguments: { ok: false } },
      { type: 'done' }
    ])
  })

  it('ignores output items with missing call_id, name, or arguments', async () => {
    wireResponse(responses('response.completed', {
      response: {
        status: 'completed',
        output: [
          { type: 'function_call', name: 'report_connection', arguments: '{"ok":true}' },
          { type: 'function_call', call_id: 'call_2', arguments: '{"ok":true}' },
          { type: 'function_call', call_id: 'call_3', name: 'report_connection' },
          { type: 'function_call', call_id: 'call_4', name: 'report_connection', arguments: '{"ok":true}' }
        ]
      }
    }))
    expect(await collect({ ...input('openai-responses'), tools: [tool] })).toEqual([
      { type: 'tool', id: 'call_4', name: 'report_connection', arguments: { ok: true } },
      { type: 'done' }
    ])
  })

  it('rejects invalid tool arguments without emitting any tool event', async () => {
    wireResponse(responses('response.completed', {
      response: {
        status: 'completed',
        output: [
          { type: 'function_call', call_id: 'call_1', name: 'report_connection', arguments: '{"ok":' }
        ]
      }
    }))
    const result = await observe({ ...input('openai-responses'), tools: [tool] })
    expect(result.events).toEqual([])
    expect(result.error).toMatchObject({ code: 'invalid_tool' })
  })

  it('reports upstream failure status without done', async () => {
    wireResponse(responses('response.output_text.delta', { delta: '部分' })
      + responses('response.completed', { response: { status: 'failed' } }))
    const result = await observe(input('openai-responses'))
    expect(result.events).toEqual([{ type: 'text', text: '部分' }])
    expect(result.error).toMatchObject({ code: 'upstream_failed' })
  })

  it('reports upstream cancelled status without done', async () => {
    wireResponse(responses('response.completed', { response: { status: 'cancelled' } }))
    const result = await observe(input('openai-responses'))
    expect(result.events).toEqual([])
    expect(result.error).toMatchObject({ code: 'upstream_cancelled' })
  })

  it('reports upstream incomplete status without done', async () => {
    wireResponse(responses('response.output_text.delta', { delta: '部分' })
      + responses('response.completed', { response: { status: 'incomplete' } }))
    const result = await observe(input('openai-responses'))
    expect(result.events).toEqual([{ type: 'text', text: '部分' }])
    expect(result.error).toMatchObject({ code: 'upstream_incomplete' })
  })

  it('reports a response.failed event without echoing the upstream message', async () => {
    wireResponse(responses('response.output_text.delta', { delta: '部分' })
      + responses('response.failed', { response: { status: 'failed', error: { code: 'no_valid_authorization', message: 'key-secret header-secret' } } }))
    const result = await observe(input('openai-responses'))
    expect(result.events).toEqual([{ type: 'text', text: '部分' }])
    expect(result.error).toMatchObject({ code: 'upstream_error' })
    expect(String(result.error)).not.toMatch(/key-secret|header-secret|no_valid_authorization/)
  })

  it('rejects a response.completed event that carries no response object', async () => {
    wireResponse(responses('response.completed', { status: 'completed', output: [] }))
    const result = await observe(input('openai-responses'))
    expect(result.events).toEqual([])
    expect(result.error).toMatchObject({ code: 'invalid_stream' })
  })

  it('treats stream end without response.completed as incomplete and never emits done', async () => {
    wireResponse(responses('response.output_text.delta', { delta: '部分' }))
    const result = await observe(input('openai-responses'))
    expect(result.events).toEqual([{ type: 'text', text: '部分' }])
    expect(result.error).toMatchObject({ code: 'incomplete_stream' })
  })

  it('ignores unrecognized event types and completes normally', async () => {
    wireResponse(responses('response.created')
      + responses('response.metadata.update', { metadata: { user_id: '123' } })
      + responses('response.output_text.delta', { delta: 'Hi' })
      + responses('response.unknown_future_event', { new_field: 'value' })
      + responses('response.completed', { response: { status: 'completed', output: [] } }))
    expect(await collect(input('openai-responses'))).toEqual([{ type: 'text', text: 'Hi' }, { type: 'done' }])
  })
})



describe('protocol-native multimodal messages', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
  const image = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: png } }
  const nativeImage = (protocol: ProviderProtocol) => protocol === 'openai'
    ? { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }
    : protocol === 'openai-responses' ? { type: 'input_image', image_url: `data:image/png;base64,${png}`, detail: 'auto' } : image
  async function sent(request: StreamChatInput) {
    let body: Record<string, any> = {}
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body))
      return fixtureResponse(completeText(request.provider.protocol))
    })
    await collect(request)
    return body[request.provider.protocol === 'openai-responses' ? 'input' : 'messages'] as any[]
  }

  for (const protocol of ['openai', 'anthropic', 'openai-responses'] as const) {
    it(`${protocol} user_image_is_protocol_native`, async () => {
      const messages = await sent({ ...input(protocol), messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, image] }] })
      expect(messages.at(-1).content).toEqual([{ type: protocol === 'openai-responses' ? 'input_text' : 'text', text: '看图' }, nativeImage(protocol)])
    })

    it(`${protocol} tool_image_is_model_visible and multiple_calls_keep_ids_and_order`, async () => {
      const loadImage = vi.fn(async () => new Uint8Array(Buffer.from(png, 'base64')))
      const messages = await sent({ ...input(protocol), loadImage, messages: [
        { role: 'assistant', content: null, tool_calls: ['a', 'b'].map(id => ({ id, type: 'function', function: { name: 'observe', arguments: '{}' } })) },
        { role: 'tool', tool_call_id: 'a', content: { content: [{ type: 'text', text: 'Captured' }, { type: 'image', artifactId: 'screen', mimeType: 'image/png' }], meta: { snapshot: 's1', coordinate_context: { width: 100 }, privateToken: 'secret' } } },
        { role: 'tool', tool_call_id: 'b', content: 'Ready' }
      ] })
      expect(loadImage).toHaveBeenCalledWith('screen')
      expect(JSON.stringify(messages)).not.toContain('privateToken')
      expect(JSON.stringify(messages)).not.toContain('secret')
      expect(JSON.stringify(messages)).toContain('s1')
      expect(JSON.stringify(messages)).toContain('coordinate_context')
      if (protocol === 'openai') {
        expect(messages.map(message => message.role)).toEqual(['system', 'assistant', 'tool', 'tool', 'user'])
        expect(messages[1].tool_calls.map((call: any) => call.id)).toEqual(['a', 'b'])
        expect(messages.slice(2, 4).map(message => message.tool_call_id)).toEqual(['a', 'b'])
        expect(messages[4].content).toContainEqual(nativeImage(protocol))
        expect(messages[4].content[0].text).toContain('a')
      } else if (protocol === 'anthropic') {
        expect(messages).toHaveLength(2)
        expect(messages[0].content.map((block: any) => block.id)).toEqual(['a', 'b'])
        expect(messages[1].content.map((block: any) => block.tool_use_id)).toEqual(['a', 'b'])
        expect(messages[1].content[0].content).toContainEqual(nativeImage(protocol))
      } else {
        expect(messages.map(message => message.type)).toEqual(['function_call', 'function_call', 'function_call_output', 'function_call_output'])
        expect(messages.map(message => message.call_id)).toEqual(['a', 'b', 'a', 'b'])
        expect(messages[2].output).toContainEqual(nativeImage(protocol))
      }
    })

    it(`${protocol} tool_error_is_not_success, structured-only results and resource links are bounded visible data`, async () => {
      const messages = await sent({ ...input(protocol), messages: [
        { role: 'tool', tool_call_id: 'error-id', content: { isError: true, content: [], structuredContent: { reason: 'denied', large: 'x'.repeat(40000) } } },
        { role: 'tool', tool_call_id: 'resource-id', content: { content: [{ type: 'resource_link', name: 'source', uri: 'https://example.test/resource' }] } }
      ] })
      const result = protocol === 'anthropic' ? messages[0].content[0] : messages[protocol === 'openai' ? 1 : 0]
      const text = protocol === 'anthropic' ? result.content : protocol === 'openai' ? result.content : result.output
      expect(typeof text).toBe('string')
      expect(text.length).toBeLessThanOrEqual(30000)
      expect(text).toContain('denied')
      expect(text).toContain('truncated')
      if (protocol === 'anthropic') expect(result.is_error).toBe(true)
      else expect(text).toContain('[tool error]')
      expect(JSON.stringify(messages)).toContain('https://example.test/resource')
    })
  }

  it('fails before dispatch with a safe explicit image error when loading fails', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const result = await observe({ ...input(), loadImage: async () => { throw new Error('/private/path secret') }, messages: [
      { role: 'tool', tool_call_id: 'a', content: { content: [{ type: 'image', artifactId: 'missing', mimeType: 'image/png' }] } }
    ] })
    expect(result.error).toMatchObject({ code: 'image_unavailable' })
    expect(String(result.error)).toMatch(/图片/)
    expect(String(result.error)).not.toMatch(/private|secret/)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('image-only results and bounded action context', () => {
  it.each(['anthropic', 'openai-responses'] as const)('%s omits empty text blocks in image-only output', async protocol => {
    let body: any
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body))
      return fixtureResponse(completeText(protocol))
    })
    await collect({ ...input(protocol), loadImage: async () => new Uint8Array([1]), messages: [
      { role: 'tool', tool_call_id: 'only-image', content: { content: [{ type: 'image', artifactId: 'a', mimeType: 'image/jpeg' }] } }
    ] })
    const blocks = protocol === 'anthropic' ? body.messages[0].content[0].content : body.input[0].output
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toEqual(protocol === 'anthropic'
      ? { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AQ==' } }
      : { type: 'input_image', image_url: 'data:image/jpeg;base64,AQ==', detail: 'auto' })
  })

  it('retains action context while bounding combined text, structured data and metadata', async () => {
    let body: any
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body))
      return fixtureResponse(completeText('openai'))
    })
    await collect({ ...input(), messages: [{ role: 'tool', tool_call_id: 'long', content: {
      content: [{ type: 'text', text: 'x'.repeat(30000) }], structuredContent: { count: 1 },
      meta: { snapshot: 'current-snapshot', coordinate_context: { width: 800 }, privateToken: 'hidden' }
    } }] })
    const text = body.messages[1].content
    expect(text.length).toBeLessThanOrEqual(30000)
    expect(text).toContain('current-snapshot')
    expect(text).toContain('800')
    expect(text).toContain('truncated')
    expect(text).not.toContain('hidden')
  })

  it('honors cancellation while awaiting image loading before any HTTP request', async () => {
    const controller = new AbortController()
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const result = await observe({ ...input(), signal: controller.signal, loadImage: async () => {
      controller.abort()
      return new Uint8Array([1])
    }, messages: [{ role: 'tool', tool_call_id: 'cancelled', content: { content: [{ type: 'image', artifactId: 'a', mimeType: 'image/png' }] } }] })
    expect(result.error).toMatchObject({ code: 'cancelled' })
    expect(fetch).not.toHaveBeenCalled()
  })
})

it.each(['openai', 'anthropic', 'openai-responses'] as const)('%s refuses explicitly text-only image requests and truthfully reports image HTTP rejection', async protocol => {
  const request = input(protocol)
  request.messages = [{role:'user',content:[{type:'image',source:{type:'base64',media_type:'image/png',data:'aGVsbG8='}}]}]
  request.provider.multimodal = false
  const fetcher = vi.fn(async () => new Response('', {status:400})); vi.stubGlobal('fetch', fetcher)
  const denied = await observe(request)
  expect(denied.error).toMatchObject({code:'vision_unavailable'}); expect(fetcher).not.toHaveBeenCalled()
  request.provider.multimodal = true
  const rejected = await observe(request)
  expect(rejected.error).toMatchObject({code:'http_400',message:expect.stringContaining('切换')})
  expect((rejected.error as Error).message).toContain('尚未')
})
it.each(['openai','anthropic','openai-responses'] as const)('%s image rejection within a successful HTTP stream requests a model switch without claiming a read', async protocol => {
  const request=input(protocol)
  request.provider.multimodal=true
  request.messages=[{role:'tool',tool_call_id:'pdf',content:{content:[{type:'image',artifactId:'page',mimeType:'image/png'}]}}]
  request.loadImage=async()=>new Uint8Array([137,80,78,71])
  wireResponse('event: error\ndata: {"type":"error","error":{"message":"images unsupported"}}\n\n')
  const result=await observe(request)
  expect((result.error as Error).message).toContain('切换')
  expect((result.error as Error).message).toContain('尚未')
})
