import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import { startFixtureServer, TOOL_NAME, type Scenario } from './pi-sdk/wire'
import { harness, harnessCleanup } from './helpers/host-harness'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of [...cleanup.splice(0), ...harnessCleanup.splice(0)].reverse()) await close() })
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function server(scenario: Scenario | Scenario[], options: Parameters<typeof startFixtureServer>[2] = {}) {
  const s = await startFixtureServer('openai', scenario, { measuredUsage: true, ...options }); cleanup.push(s.close); return s
}
async function profile(f: ReturnType<typeof harness>, baseUrl: string, extra: object = {}) {
  return f.profiles.save({ name: 'p', protocol: 'openai', baseUrl: baseUrl + '/v1', model: 'test-model', authMethod: 'none', ...extra })
}
/** Pi counts roughly four characters per token whatever the script, so plain text sizes predictably. */
const long = (n: number) => 'lorem ipsum '.repeat(Math.ceil(n / 12)).slice(0, n)
/** Sends a message and waits until it has completed. */
async function say(f: ReturnType<typeof harness>, profileId: string, content: string, conversationId = f.id) {
  const sent = await f.send(conversationId, profileId, content)
  await expect.poll(() => f.finished(sent.requestId)?.state, { timeout: 15_000 }).toBe('completed')
  return sent
}
const entriesOf = async (f: ReturnType<typeof harness>, conversationId = f.id) => {
  const { openConversationHistory } = await import('../src/core/agent/factory')
  const conversation = f.store.getConversation(conversationId)!
  return (await openConversationHistory(f.directory, conversation)).manager.getEntries()
}
const compactions = async (f: ReturnType<typeof harness>) => (await entriesOf(f)).filter(entry => entry.type === 'compaction')

/** History large enough that Pi has something beyond the recent part it keeps verbatim. */
async function fill(f: ReturnType<typeof harness>, profileId: string, turns = 5) {
  // About 2500 tokens: over what Pi keeps verbatim in a 4096 window, under the point where it compacts by itself.
  for (let i = 0; i < turns; i++) await say(f, profileId, `${i}:${long(2000)}`)
}

describe('manual compaction', () => {
  it('writes a checkpoint, keeps every original message viewable, and lets the conversation go on', async () => {
    const s = await server('text')
    const f = harness(), p = await profile(f, s.baseUrl, { contextWindow: 4096 })
    await fill(f, p.id)
    const before = (await f.chat.getMessages(f.id)).map(message => message.content)
    await f.chat.compact({ conversationId: f.id, profileId: p.id })
    expect(await compactions(f)).toHaveLength(1)
    // The original text stays viewable even though the model context is now the summary.
    expect((await f.chat.getMessages(f.id)).map(message => message.content)).toEqual(before)
    await say(f, p.id, 'after compaction')
    expect((await f.chat.getMessages(f.id)).map(message => message.content).slice(0, before.length)).toEqual(before)
  }, 40_000)

  it('refuses to compact a running conversation, and a conversation with nothing to compact', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const s = await server('text', { beforeReply: () => gate })
    const f = harness(), p = await profile(f, s.baseUrl)
    await expect(f.chat.compact({ conversationId: f.id, profileId: p.id })).rejects.toThrow('没有足够的内容')
    await f.send(f.id, p.id, 'busy')
    await expect(f.chat.compact({ conversationId: f.id, profileId: p.id })).rejects.toThrow('正在处理中')
    release()
  }, 30_000)

  it('queues messages sent during compaction and runs them once it succeeds', async () => {
    const s = await server('text')
    const f = harness(), p = await profile(f, s.baseUrl, { contextWindow: 4096 })
    await fill(f, p.id)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const slow = await server('text', { beforeReply: () => gate })
    await f.profiles.save({ id: p.id, name: 'p', protocol: 'openai', baseUrl: slow.baseUrl + '/v1', model: 'test-model', authMethod: 'none', contextWindow: 4096 })
    const compacting = f.chat.compact({ conversationId: f.id, profileId: p.id })
    await expect.poll(() => f.chat.getQueue(f.id).compacting).toBe(true)
    const queued = await f.send(f.id, p.id, 'sent while compacting')
    expect(queued.result.queued).toBe(true)
    expect(f.state(queued.requestId)).toEqual([])
    release()
    await compacting
    await expect.poll(() => f.finished(queued.requestId)?.state, { timeout: 15_000 }).toBe('completed')
  }, 40_000)

  it('a stopped compaction uses no half summary, pauses the queue, and the original conversation is unchanged', async () => {
    const s = await server('text')
    const f = harness(), p = await profile(f, s.baseUrl, { contextWindow: 4096 })
    await fill(f, p.id)
    const before = (await f.chat.getMessages(f.id)).map(message => message.content)
    const slow = await server('hang')
    await f.profiles.save({ id: p.id, name: 'p', protocol: 'openai', baseUrl: slow.baseUrl + '/v1', model: 'test-model', authMethod: 'none', contextWindow: 4096 })
    const compacting = f.chat.compact({ conversationId: f.id, profileId: p.id })
    const rejected = expect(compacting).rejects.toThrow('已停止')
    await expect.poll(() => slow.requests.length, { timeout: 10_000 }).toBe(1)
    f.chat.stopCompaction(f.id)
    await rejected
    expect(await compactions(f)).toHaveLength(0)
    expect(f.chat.getQueue(f.id)).toMatchObject({ paused: 'compaction-stopped', compacting: false })
    expect((await f.chat.getMessages(f.id)).map(message => message.content)).toEqual(before)
  }, 40_000)

  it('a failed compaction pauses the queue with a retry path and changes nothing', async () => {
    const s = await server('text')
    const f = harness(), p = await profile(f, s.baseUrl, { contextWindow: 4096 })
    await fill(f, p.id)
    const before = (await f.chat.getMessages(f.id)).map(message => message.content)
    const broken = await server('http-error')
    await f.profiles.save({ id: p.id, name: 'p', protocol: 'openai', baseUrl: broken.baseUrl + '/v1', model: 'test-model', authMethod: 'none', contextWindow: 4096 })
    await expect(f.chat.compact({ conversationId: f.id, profileId: p.id })).rejects.toThrow('压缩失败')
    expect(await compactions(f)).toHaveLength(0)
    expect(f.chat.getQueue(f.id)).toMatchObject({ paused: 'compaction-failed' })
    const waiting = await f.send(f.id, p.id, 'waiting')
    expect(waiting.result.queued).toBe(true)
    await f.profiles.save({ id: p.id, name: 'p', protocol: 'openai', baseUrl: s.baseUrl + '/v1', model: 'test-model', authMethod: 'none', contextWindow: 4096 })
    await f.chat.compact({ conversationId: f.id, profileId: p.id })
    expect(await compactions(f)).toHaveLength(1)
    await expect.poll(() => f.finished(waiting.requestId)?.state, { timeout: 15_000 }).toBe('completed')
    expect((await f.chat.getMessages(f.id)).map(message => message.content).slice(0, before.length)).toEqual(before)
  }, 60_000)

  it('rejects a single message larger than the window straight away, without queueing or compacting', async () => {
    const s = await server('text')
    const f = harness(), p = await profile(f, s.baseUrl, { contextWindow: 2048 })
    await expect(f.send(f.id, p.id, '中'.repeat(5000))).rejects.toThrow('超过当前模型的上下文容量')
    expect(f.chat.getQueue(f.id).items).toEqual([])
    expect(s.requests).toHaveLength(0)
    expect(await compactions(f)).toHaveLength(0)
  }, 20_000)
})

describe('automatic compaction', () => {
  it('compacts on its own once the history crosses the old boundary, and every original stays viewable', async () => {
    const s = await server('text')
    const f = harness(), p = await profile(f, s.baseUrl, { contextWindow: 4096 })
    const sent: string[] = []
    for (let i = 0; i < 10; i++) { const text = `${i}:${long(2000)}`; sent.push(text); await say(f, p.id, text) }
    expect((await compactions(f)).length).toBeGreaterThan(0)
    const messages = (await f.chat.getMessages(f.id)).filter(message => message.role === 'user').map(message => message.content)
    expect(messages).toEqual(sent)
  }, 90_000)

  it('a small-window model can still send, and its request stays within the window', async () => {
    const s = await server('text')
    const f = harness(), p = await profile(f, s.baseUrl, { contextWindow: 2048 })
    await say(f, p.id, 'hello')
    const body = s.requests[0].body as { max_tokens?: number; max_completion_tokens?: number }
    expect(body.max_tokens ?? body.max_completion_tokens ?? 0).toBeLessThanOrEqual(1024)
  }, 20_000)

  it('also triggers after a large tool result', async () => {
    const s = await server(['tool', 'text', 'text', 'text'])
    const registry = new SimpleToolRegistry()
    registry.register({ name: TOOL_NAME, description: 'big', parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } },
      async () => ({ content: [{ type: 'text', text: long(12000) }] }), { assess: async () => ({ effect: 'read', target: 'big', summary: 'big' }) })
    const f = harness(undefined, async () => registry.snapshot()), p = await profile(f, s.baseUrl, { contextWindow: 4096 })
    await say(f, p.id, 'read it')
    await say(f, p.id, 'and again')
    expect((await compactions(f)).length).toBeGreaterThan(0)
  }, 60_000)
})

describe('switching models', () => {
  async function two(smallWindow: number, bigWindow: number, extra: { bigMultimodal?: boolean } = {}) {
    const s = await server('text')
    const f = harness()
    const big = await profile(f, s.baseUrl, { contextWindow: bigWindow })
    const small = await f.profiles.save({ name: 'small', protocol: 'openai', baseUrl: s.baseUrl + '/v1', model: 'small-model', authMethod: 'none', contextWindow: smallWindow,
      models: [{ id: 'small-model', multimodal: extra.bigMultimodal === true }] })
    return { s, f, big, small }
  }

  it('is refused while the conversation is running, and does not touch another conversation', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const s = await server('text', { beforeReply: () => gate })
    const f = harness(), p = await profile(f, s.baseUrl)
    await f.send(f.id, p.id, 'busy')
    await expect(f.chat.switchModel({ conversationId: f.id, profileId: p.id })).rejects.toThrow('正在处理中')
    await expect(f.chat.switchModel({ conversationId: f.other, profileId: p.id })).resolves.toBeUndefined()
    release()
  }, 30_000)

  it('compacts with the previous model first when the new window is too small, then switches', async () => {
    const { f, big, small, s } = await two(2048, 200_000)
    for (let i = 0; i < 6; i++) await say(f, big.id, `${i}:${long(2000)}`)
    const requestsBefore = s.requests.length
    await f.chat.switchModel({ conversationId: f.id, profileId: small.id })
    expect((await compactions(f)).length).toBeGreaterThan(0)
    expect(s.requests.length).toBeGreaterThan(requestsBefore)
    // The switch is recorded, so the next send under the new model does not repeat the check.
    await say(f, small.id, 'now on the small model')
  }, 90_000)

  it('switches without compacting when the history already fits', async () => {
    const { f, big, small } = await two(8192, 200_000)
    await say(f, big.id, 'short')
    await f.chat.switchModel({ conversationId: f.id, profileId: small.id })
    expect(await compactions(f)).toHaveLength(0)
  }, 30_000)

  it('refuses a model that cannot handle images already in the conversation', async () => {
    const { f, big, small } = await two(8192, 200_000)
    await say(f, big.id, 'hello')
    const { openConversationHistory } = await import('../src/core/agent/factory')
    const { manager } = await openConversationHistory(f.directory, f.store.getConversation(f.id)!)
    manager.appendMessage({ role: 'user', content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }], timestamp: Date.now() })
    await expect(f.chat.switchModel({ conversationId: f.id, profileId: small.id })).rejects.toThrow('不支持图片')
    expect(randomUUID()).toBeTruthy()
  }, 30_000)

  it('says plainly when the history cannot be made to fit the new window', async () => {
    const { f, big, small } = await two(1024, 200_000)
    await say(f, big.id, long(3000))
    await expect(f.chat.switchModel({ conversationId: f.id, profileId: small.id })).rejects.toThrow()
    await wait(10)
  }, 60_000)
})
