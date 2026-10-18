import { mkdir, writeFile } from 'node:fs/promises'
import { afterAll, describe, expect, it } from 'vitest'
import { streamChat } from '../../src/core/providers/stream'
import type { ProviderProtocol, StreamChatInput } from '../../src/shared/types'
import { collectPi, collectStream, makeInput, protocols, startFixtureServer, tool, type Observation, type Scenario } from './fixtures'
import { streamChatWithPi } from './adapter'

interface CaseRecord { protocol: ProviderProtocol; case: string; verdict: 'match' | 'gap'; her: unknown; pi: unknown; note?: string }
const records: CaseRecord[] = []
const capabilities: Array<{ protocol: ProviderProtocol; case: string; expected: unknown; actual: unknown }> = []
const observations: Array<Record<string, unknown>> = []
function semantic(result: Observation) {
  return { done: result.events.some(event => event.type === 'done'), text: result.events.filter(event => event.type === 'text').map(event => event.text).join(''), tools: result.events.filter(event => event.type === 'tool').map(({ id: _id, ...rest }) => rest), rejected: Boolean(result.error) }
}
function record(protocol: ProviderProtocol, name: string, her: unknown, pi: unknown, note?: string) {
  const verdict = JSON.stringify(her) === JSON.stringify(pi) ? 'match' : 'gap'
  records.push({ protocol, case: name, verdict, her, pi, ...(note ? { note } : {}) })
  return verdict
}
afterAll(async () => {
  await mkdir('experiments/pi-ai-compat/results', { recursive: true })
  await writeFile('experiments/pi-ai-compat/results/protocol.json', JSON.stringify({
    generatedAt: new Date().toISOString(), runtime: process.versions, package: '@earendil-works/pi-ai@1.2.0',
    method: 'Actual Pi SDK against loopback HTTP SSE server; same fixtures compared with production Her streamChat. Match means scenario-level observable parity, not live-provider certification. Test assertions passing do not mean all scenarios are compatible.',
    summary: { total: records.length, match: records.filter(item => item.verdict === 'match').length, gap: records.filter(item => item.verdict === 'gap').length }, records, capabilities, observations,
  }, null, 2))
})

async function compare(protocol: ProviderProtocol, scenario: Scenario, mutate?: (input: StreamChatInput) => void, byteChunks = false) {
  const server = await startFixtureServer(protocol, scenario, { byteChunks })
  try {
    const herInput = makeInput(protocol, server.baseUrl)
    const piInput = makeInput(protocol, server.baseUrl)
    mutate?.(herInput); mutate?.(piInput)
    const her = await collectStream(herInput, streamChat)
    const pi = await collectPi(piInput)
    return { her, pi, requests: server.requests }
  } finally { await server.close() }
}

describe('same wire: production Her versus the thin Pi adapter', () => {
  const shared: Scenario[] = ['text', 'tool', 'multi-tool', 'bad-json-tool', 'partial-json-tool', 'array-tool', 'unknown-tool', 'mixed-invalid', 'missing-terminal', 'truncated', 'truncated-tool', 'upstream-error', 'malformed-json', 'invalid-content-type', 'unknown-stop', 'http-error']
  for (const protocol of protocols) {
    for (const scenario of shared) it(`${protocol} ${scenario}: capture parity or explicit gap`, async () => {
      const result = await compare(protocol, scenario)
      // Check the control implementation and fixture independently of Pi's outcome.
      if (['text', 'tool', 'multi-tool'].includes(scenario)) expect(result.her.error).toBeNull()
      else expect(result.her.error).not.toBeNull()
      const verdict = record(protocol, scenario, semantic(result.her), semantic(result.pi), result.pi.error?.message)
      // Assert both known compatibility and known gaps; passing assertions are not compatibility claims.
      const knownGap = ['bad-json-tool', 'partial-json-tool', 'mixed-invalid', 'invalid-content-type'].includes(scenario) || protocol === 'openai' && scenario === 'missing-terminal'
      expect(verdict).toBe(knownGap ? 'gap' : 'match')
      if (scenario === 'http-error') record(protocol, 'error-message-redaction', result.her.error?.message.includes('synthetic_secret_marker'), result.pi.error?.message.includes('synthetic_secret_marker'))
    })
    it(`${protocol} byte-fragmented UTF-8`, async () => {
      const result = await compare(protocol, 'text', undefined, true)
      expect(result.her.error).toBeNull()
      expect(record(protocol, 'byte-fragmented-utf8', semantic(result.her), semantic(result.pi))).toBe('match')
    })
    for (const keyed of [false, true]) it(`${protocol} keyless ${keyed ? 'with custom gateway header' : 'without auth'}`, async () => {
      const result = await compare(protocol, 'text', input => { input.provider.apiKey = ''; input.provider.customHeaders = keyed ? { 'X-Gateway-Token': 'fixture-gateway' } : {} })
      expect(result.her.error).toBeNull()
      expect(record(protocol, keyed ? 'keyless-custom-header' : 'keyless', semantic(result.her), semantic(result.pi), result.pi.error?.message)).toBe('gap')
    })
    it(`${protocol} cancellation before request`, async () => {
      const result = await compare(protocol, 'text', input => { const controller = new AbortController(); controller.abort(); input.signal = controller.signal })
      expect(result.requests).toHaveLength(0)
      expect(record(protocol, 'pre-abort', semantic(result.her), semantic(result.pi))).toBe('match')
    })
    it(`${protocol} cancellation after first text`, async () => {
      const server = await startFixtureServer(protocol, 'hang')
      try {
        const outcomes: Observation[] = []
        for (const implementation of [streamChat, async function* (input: StreamChatInput) { const { streamChatWithPi } = await import('./adapter'); yield* streamChatWithPi(input) }]) {
          const controller = new AbortController()
          const input = makeInput(protocol, server.baseUrl); input.signal = controller.signal
          outcomes.push(await collectStream(input, async function* (request) { for await (const event of implementation(request)) { yield event; if (event.type === 'text') controller.abort() } }))
        }
        expect(outcomes[0].error?.code).toBe('cancelled')
        expect(outcomes[1].error?.code).toBe('cancelled')
        expect(record(protocol, 'mid-abort', semantic(outcomes[0]), semantic(outcomes[1]))).toBe('match')
      } finally { await server.close() }
    })
    it(`${protocol} usage extraction`, async () => {
      const result = await compare(protocol, 'text')
      expect(result.pi.usage).toMatchObject({ input: 11, output: 5, totalTokens: 16 })
      // This is a new capability, recorded separately from parity.
      capabilities.push({ protocol, case: 'usage-reporting', expected: { input: 11, output: 5, totalTokens: 16 }, actual: result.pi.usage })
    })
    it(`${protocol} request shape, explicit and default output limits`, async () => {
      for (const max of [undefined, 7, 1_000_000]) {
        const result = await compare(protocol, 'text', input => { input.provider.maxOutputTokens = max; input.forceTool = tool.name })
        expect(result.requests).toHaveLength(2)
        const shape = (request: typeof result.requests[number]) => ({
          pathname: new URL(request.url, 'http://fixture').pathname,
          auth: request.headers.authorization ?? request.headers['x-api-key'], customHeader: request.headers['x-fixture'],
          model: request.body.model, stream: request.body.stream,
          max: request.body.max_tokens ?? request.body.max_completion_tokens ?? request.body.max_output_tokens,
          maxField: ['max_tokens', 'max_completion_tokens', 'max_output_tokens'].find(key => key in request.body),
          toolChoice: request.body.tool_choice,
        })
        expect(shape(result.requests[0]).pathname).toBe(`/proxy/v1/${protocol === 'openai' ? 'chat/completions' : protocol === 'anthropic' ? 'messages' : 'responses'}`)
        expect(record(protocol, `request-shape-max-${max ?? 'unset'}`, shape(result.requests[0]), shape(result.requests[1]))).toBe(protocol === 'anthropic' || protocol === 'openai-responses' && max === 7 ? 'gap' : 'match')
      }
    })
    it(`${protocol} base URL query and fragment`, async () => {
      const result = await compare(protocol, 'text', input => { input.provider.baseUrl = input.provider.baseUrl.replace(/\/$/, '') + '?tenant=fixture#ignored' })
      expect(result.requests).toHaveLength(2)
      expect(record(protocol, 'base-url-query-fragment', result.requests[0].url, result.requests[1].url)).toBe('gap')
    })
    it(`${protocol} case-insensitive custom authentication override`, async () => {
      const result = await compare(protocol, 'text', input => { input.provider.customHeaders = { Authorization: 'Bearer override', 'X-Api-Key': 'override-key', 'Anthropic-Version': 'custom-version' } })
      expect(result.requests).toHaveLength(2)
      const headers = (request: typeof result.requests[number]) => ({ authorization: request.headers.authorization, apiKey: request.headers['x-api-key'], version: request.headers['anthropic-version'] })
      expect(record(protocol, 'case-insensitive-header-override', headers(result.requests[0]), headers(result.requests[1]))).toBe('match')
    })
    it(`${protocol} redirects are rejected by Her and followed by Pi`, async () => {
      const result = await compare(protocol, 'redirect')
      expect(result.her.error).not.toBeNull()
      expect(result.pi.error).toBeNull()
      expect(result.requests.some(request => request.url === '/fixture-final')).toBe(true)
      expect(record(protocol, 'redirect-policy', semantic(result.her), semantic(result.pi))).toBe('gap')
    })
    it(`${protocol} SDK timeout is not a response-body idle timeout`, async () => {
      const server = await startFixtureServer(protocol, 'hang')
      try {
        const controller = new AbortController()
        const input = makeInput(protocol, server.baseUrl); input.signal = controller.signal
        let firstText: () => void = () => {}
        const textSeen = new Promise<void>(resolve => { firstText = resolve })
        let settled = false
        const result = collectStream(input, async function* (request) {
          for await (const event of streamChatWithPi(request, { timeoutMs: 100 })) { yield event; if (event.type === 'text') firstText() }
        }).then(value => { settled = true; return value })
        await textSeen
        await new Promise(resolve => setTimeout(resolve, 250))
        const finishedBy250ms = settled
        controller.abort()
        expect((await result).error?.code).toBe('cancelled')
        expect(finishedBy250ms).toBe(false)
        observations.push({ protocol, case: 'body-idle-timeout', configuredPiTimeoutMs: 100, waitedAfterFirstTextMs: 250, settledBeforeExplicitAbort: finishedBy250ms, note: 'Pi request headers arrived promptly; its timeout did not terminate a stalled body. Her has a fixed 60000 ms per-read timeout in source; that 60-second deadline was not timed here.' })
      } finally { await server.close() }
    })
  }
  for (const protocol of ['openai', 'anthropic'] as const) {
    for (const scenario of ['missing-finish', 'wrong-tool-finish', 'tool-without-calls'] as const) it(`${protocol} ${scenario}`, async () => {
      const result = await compare(protocol, scenario)
      expect(result.her.error).not.toBeNull()
      record(protocol, scenario, semantic(result.her), semantic(result.pi), result.pi.error?.message)
    })
  }
  for (const scenario of ['missing-block-stop', 'missing-start'] as const) it(`anthropic ${scenario}`, async () => {
    const result = await compare('anthropic', scenario)
    expect(result.her.error).not.toBeNull()
    expect(record('anthropic', scenario, semantic(result.her), semantic(result.pi), result.pi.error?.message)).toBe('gap')
  })
  for (const scenario of ['final-only-tool', 'queued-status', 'missing-status'] as const) it(`openai-responses ${scenario}`, async () => {
    const result = await compare('openai-responses', scenario)
    expect(Boolean(result.her.error)).toBe(scenario !== 'final-only-tool')
    expect(record('openai-responses', scenario, semantic(result.her), semantic(result.pi), result.pi.error?.message)).toBe('gap')
  })
})
