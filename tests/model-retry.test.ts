import { afterEach, describe, expect, it } from 'vitest'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import { MODEL_RETRIES } from '../src/core/agent/factory'
import { startFixtureServer, TOOL_NAME, type Protocol, type Scenario } from './pi-sdk/wire'
import { approveNextTool, harness, harnessCleanup } from './helpers/host-harness'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of [...cleanup.splice(0), ...harnessCleanup.splice(0)].reverse()) await close() })
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function run(protocol: Protocol, scenarios: Scenario[], toolsFor?: ConstructorParameters<typeof import('../src/core/agent/host').AgentHost>[3]) {
  const s = await startFixtureServer(protocol, scenarios); cleanup.push(s.close)
  const f = harness(undefined, toolsFor)
  const p = await f.profiles.save({ name: 'p', protocol, baseUrl: s.baseUrl + '/v1', model: 'test-model', contextWindow: 128000, authMethod: 'none' })
  const sent = await f.send(f.id, p.id, 'hi')
  if (toolsFor) await approveNextTool(f.chat, f.id)
  await expect.poll(() => f.finished(sent.requestId)?.state, { timeout: 20_000, interval: 50 }).toBeDefined()
  return { s, f, final: f.finished(sent.requestId)!, reply: (await f.chat.getMessages(f.id)).at(-1)! }
}

describe('retrying a model request', () => {
  it('is limited to two retries: three requests in all, then the run fails', async () => {
    expect(MODEL_RETRIES).toBe(2)
    const { s, final } = await run('openai', ['server-error', 'server-error', 'server-error', 'text'])
    expect(s.requests).toHaveLength(3)
    expect(final.state).toBe('failed')
  })

  it.each(['openai', 'anthropic', 'openai-responses'] as const)('%s: a transient 503 is retried and the run then completes', async protocol => {
    const { s, final, reply } = await run(protocol, ['server-error', 'text'])
    expect(s.requests).toHaveLength(2)
    expect(final.state).toBe('completed')
    expect(reply).toMatchObject({ status: 'complete', content: '你好🌙' })
  })

  it('recovers on the second retry too', async () => {
    const { s, final } = await run('openai', ['server-error', 'server-error', 'text'])
    expect(s.requests).toHaveLength(3)
    expect(final.state).toBe('completed')
  })

  it('does not append the retried reply to text the failed attempt had already streamed', async () => {
    const { reply, f } = await run('anthropic', ['missing-terminal', 'text'])
    expect(reply.content).toBe('你好🌙')
    expect(f.events.filter(event => event.done).at(-1)?.message.content).toBe('你好🌙')
  })

  it('shows the person only the final failure, in plain Chinese, once retries are used up', async () => {
    const { final, reply } = await run('openai', ['server-error', 'server-error', 'server-error'])
    expect(final.error).toContain('HTTP 503')
    expect(reply.status).toBe('failed')
    expect(JSON.stringify([final, reply])).not.toContain('synthetic_secret_marker')
  })
})

describe('what is never retried', () => {
  it.each(['openai', 'anthropic', 'openai-responses'] as const)('%s: an authentication failure (401) is tried once', async protocol => {
    const { s, final } = await run(protocol, ['http-error', 'text'])
    expect(s.requests).toHaveLength(1)
    expect(final.state).toBe('failed')
    expect(final.error).toContain('HTTP 401')
  })

  it('a refused redirect is tried once', async () => {
    const { s, final } = await run('openai', ['redirect', 'text'])
    expect(s.requests).toHaveLength(1)
    expect(final.state).toBe('failed')
  })

  it('a stopped reply is not started again', async () => {
    const s = await startFixtureServer('openai', ['hang', 'text']); cleanup.push(s.close)
    const f = harness()
    const p = await f.profiles.save({ name: 'p', protocol: 'openai', baseUrl: s.baseUrl + '/v1', model: 'test-model', contextWindow: 128000, authMethod: 'none' })
    const sent = await f.send(f.id, p.id, 'hi')
    await expect.poll(() => s.requests.length).toBe(1)
    f.chat.cancel(sent.requestId)
    await expect.poll(() => f.finished(sent.requestId)?.state, { timeout: 10_000 }).toBe('cancelled')
    await wait(300)
    expect(s.requests).toHaveLength(1)
  })

  it('a response that ends normally but says nothing is not retried', async () => {
    const { s, final } = await run('openai', ['empty-text', 'text'])
    expect(s.requests).toHaveLength(1)
    expect(final.state).toBe('failed')
  })
})

describe('a retry never replays a tool', () => {
  function counting() {
    const calls: string[] = []
    const registry = new SimpleToolRegistry()
    registry.register({ name: TOOL_NAME, description: 'act', parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } },
      async () => { calls.push('ran'); return { content: [{ type: 'text', text: 'done' }] } }, { assess: async () => ({ effect: 'read', target: 'x', summary: 'x' }) })
    return { calls, registry }
  }
  it('when the request after a tool result fails and is retried, the tool still ran exactly once', async () => {
    const { calls, registry } = counting()
    const { s, final } = await run('openai', ['tool', 'server-error', 'text'], async () => registry.snapshot())
    expect(final.state).toBe('completed')
    expect(s.requests).toHaveLength(3)
    expect(calls).toEqual(['ran'])
  })
  it('when the request carrying the tool call fails first, the tool has not run at all yet and then runs once', async () => {
    const { calls, registry } = counting()
    const { final } = await run('openai', ['server-error', 'tool', 'text'], async () => registry.snapshot())
    expect(final.state).toBe('completed')
    expect(calls).toEqual(['ran'])
  })
})
