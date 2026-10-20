import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Type } from 'typebox'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { createProbeSession, memoryCredentials } from './harness'
import { startFixtureServer, TOOL_NAME, type Protocol, type Scenario } from './wire'

/**
 * Re-observes the pi-ai 1.2.0 differences recorded in experiments/pi-ai-compat/REPORT.md
 * through the full AgentSession path Her will use. Results are written to
 * experiments/pi-sdk-1.3.0/results/differences.json; assertions only pin what Her must rely on.
 */
const apis = { openai: 'openai-completions', anthropic: 'anthropic-messages', 'openai-responses': 'openai-responses' } as const
const observations: Record<string, unknown>[] = []

async function observe(protocol: Protocol, scenario: Scenario, options: { apiKey?: string; headers?: Record<string, string>; authHeader?: boolean; abortAfterMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'her-pi-diff-'))
  const server = await startFixtureServer(protocol, [scenario, 'text'])
  const calls: unknown[] = []
  const tool = defineTool({
    name: TOOL_NAME, label: 'report', description: '报告连接状态',
    parameters: Type.Object({ ok: Type.Boolean() }),
    execute: async (_id, params) => { calls.push(params); return { content: [{ type: 'text', text: 'recorded' }], details: undefined } }
  })
  const credentials = options.apiKey === undefined ? memoryCredentials() : memoryCredentials({ 'her-diff': { type: 'api_key', key: options.apiKey } })
  let error: string | undefined
  try {
    const { session } = await createProbeSession({
      root, baseUrl: server.baseUrl + '/proxy/v1', providerId: 'her-diff', api: apis[protocol], credentials,
      tools: [tool], modelId: 'test-model', headers: options.headers, authHeader: options.authHeader
    })
    try {
      const run = session.prompt('请记住我喜欢茶。')
      const timer = options.abortAfterMs ? setTimeout(() => { void session.abort() }, options.abortAfterMs) : undefined
      await run.catch(caught => { error = caught instanceof Error ? caught.message : String(caught) })
      clearTimeout(timer)
      const assistants = session.messages.filter(message => message.role === 'assistant') as { stopReason?: string; errorMessage?: string; content: { type: string }[] }[]
      const first = assistants[0]
      const local = (value: string | null) => value?.replaceAll(process.cwd(), '<repo>') ?? null
      const result = {
        protocol, scenario,
        requests: server.requests.length,
        path: server.requests[0] ? new URL(server.requests[0].url, 'http://fixture').pathname : null,
        auth: server.requests[0] ? (server.requests[0].headers.authorization ?? server.requests[0].headers['x-api-key'] ?? null) : null,
        customHeader: server.requests[0]?.headers['x-fixture'] ?? null,
        firstStopReason: first?.stopReason ?? null,
        firstError: local(first?.errorMessage ?? null),
        toolCalls: calls,
        promptError: local(error ?? null)
      }
      observations.push(result)
      return result
    } finally { session.dispose() }
  } finally {
    await server.close()
    rmSync(root, { recursive: true, force: true })
  }
}

describe('pi-ai 1.2.0 differences re-tested on Pi 1.3.0 AgentSession', () => {
  afterAll(() => {
    const dir = join(process.cwd(), 'experiments', 'pi-sdk-1.3.0', 'results')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'differences.json'), JSON.stringify(observations, null, 2) + '\n')
  })

  for (const protocol of ['openai', 'anthropic', 'openai-responses'] as const) {
    it(`${protocol}: valid tool call executes once with parsed args`, async () => {
      const result = await observe(protocol, 'tool', { apiKey: 'fixture-key' })
      expect(result.toolCalls).toEqual([{ ok: true }])
    })
    for (const scenario of ['bad-json-tool', 'partial-json-tool', 'mixed-invalid', 'missing-terminal', 'missing-finish', 'truncated-tool', 'invalid-content-type', 'final-only-tool', 'queued-status', 'missing-status', 'missing-start', 'missing-block-stop', 'redirect'] as const) {
      it(`${protocol}: observe ${scenario}`, async () => { await observe(protocol, scenario, { apiKey: 'fixture-key' }) })
    }
    it(`${protocol}: base URL path`, async () => {
      const result = await observe(protocol, 'text', { apiKey: 'fixture-key' })
      expect(result.requests).toBeGreaterThan(0)
    })
    it(`${protocol}: no credential at all`, async () => { await observe(protocol, 'text') })
    it(`${protocol}: custom auth header only (authHeader=false)`, async () => {
      await observe(protocol, 'text', { headers: { 'X-Fixture': 'her' }, authHeader: false })
    })
    it(`${protocol}: error text is not leaked into prompt errors`, async () => {
      await observe(protocol, 'http-error', { apiKey: 'fixture-key' })
    })
    it(`${protocol}: abort during a stalled body`, async () => {
      const started = Date.now()
      const result = await observe(protocol, 'hang', { apiKey: 'fixture-key', abortAfterMs: 200 })
      expect(Date.now() - started).toBeLessThan(5000)
      expect(result.toolCalls).toEqual([])
    })
  }
})
