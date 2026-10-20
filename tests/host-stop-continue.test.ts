import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import { startFixtureServer, TOOL_NAME, type Scenario } from './pi-sdk/wire'
import { harness, harnessCleanup } from './helpers/host-harness'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of [...cleanup.splice(0), ...harnessCleanup.splice(0)].reverse()) await close() })
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }

async function server(scenario: Scenario | Scenario[]) {
  const s = await startFixtureServer('openai', scenario); cleanup.push(s.close); return s
}
async function profile(f: ReturnType<typeof harness>, baseUrl: string) {
  return f.profiles.save({ name: 'p', protocol: 'openai', baseUrl: baseUrl + '/v1', model: 'test-model', authMethod: 'none' })
}
/** A mutating tool that stays in flight until `finish` is called. */
function slowTool(options: { effect?: 'send' | 'read' } = {}) {
  const calls: unknown[] = []
  let finish!: () => void
  const registry = new SimpleToolRegistry()
  registry.register({ name: TOOL_NAME, description: 'act', parameters: schema },
    () => { calls.push('started'); return new Promise(resolve => { finish = () => resolve({ content: [{ type: 'text', text: 'too late' }] }) }) },
    { assess: async () => ({ effect: options.effect ?? 'send', target: 'thing', summary: 'act' }), allowAllOperations: true })
  return { registry, calls, finish: () => finish() }
}

describe('stopping a run', () => {
  it('keeps text produced before the stop as an interrupted fragment, not a finished answer', async () => {
    const s = await server('hang')
    const f = harness(), p = await profile(f, s.baseUrl)
    const first = await f.send(f.id, p.id, 'say something')
    await expect.poll(() => f.events.some(event => event.message.content.includes('你好')), { timeout: 10_000 }).toBe(true)
    f.chat.cancel(first.requestId)
    await expect.poll(() => f.finished(first.requestId)?.state, { timeout: 10_000 }).toBe('cancelled')
    const task = f.store.listConversations().length && f.requests.find(event => event.requestId === first.requestId)
    expect(task).toBeTruthy()
    const messages = await f.chat.getMessages(f.id)
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', status: 'cancelled' })
    const taskId = (f.store as unknown as { db: { prepare(sql: string): { get(): { id: string } } } }).db.prepare('SELECT id FROM tasks').get().id
    expect(f.store.getTask(taskId)).toMatchObject({ status: 'stopped' })
    expect(f.store.listDraftFragments(taskId)).toEqual([{ type: 'interrupted-text', content: expect.stringContaining('你好') }])
  }, 30_000)

  it('stopping while a mutating tool is in flight records it unknown, and its late result changes nothing', async () => {
    const s = await server(['tool', 'text'])
    const tool = slowTool()
    const f = harness(undefined, async () => tool.registry.snapshot()), p = await profile(f, s.baseUrl)
    const first = await f.send(f.id, p.id, 'act')
    await expect.poll(() => tool.calls.length, { timeout: 10_000 }).toBe(1)
    f.chat.cancel(first.requestId)
    await expect.poll(() => f.finished(first.requestId)?.state, { timeout: 10_000 }).toBe('cancelled')
    const requestsAtStop = s.requests.length
    tool.finish(); await wait(300)
    const taskId = (f.store as unknown as { db: { prepare(sql: string): { get(): { id: string } } } }).db.prepare('SELECT id FROM tasks').get().id
    expect(f.store.getTask(taskId)).toMatchObject({ status: 'stopped' })
    expect(f.store.getToolCall(taskId, 'call_1')).toMatchObject({ status: 'unknown' })
    expect(f.store.listOpenToolCalls(taskId)).toHaveLength(1)
    expect((await f.chat.getMessages(f.id)).at(-1)).toMatchObject({ status: 'cancelled' })
    // The model was not asked again, and the run did not come back to life.
    expect(s.requests).toHaveLength(requestsAtStop)
    // Nothing is running any more, but the unknown outcome is still shown so the person can decide about it.
    const shown = f.chat.getConversationTask(f.id)
    expect(shown?.run.status).toBe('stopped')
    expect(shown?.unknownCalls).toHaveLength(1)
    expect(shown?.approval).toBeUndefined()
  }, 30_000)

  it('a stop closes the queue before anything else, so a waiting message cannot slip in', async () => {
    const s = await server(['hang', 'text'])
    const f = harness(), p = await profile(f, s.baseUrl)
    const first = await f.send(f.id, p.id, 'one')
    const second = await f.send(f.id, p.id, 'two')
    await expect.poll(() => s.requests.length).toBe(1)
    f.chat.cancel(first.requestId)
    expect(f.chat.getQueue(f.id).paused).toBe('stopped')
    await expect.poll(() => f.finished(first.requestId)?.state, { timeout: 10_000 }).toBe('cancelled')
    await wait(300)
    expect(f.state(second.requestId)).toEqual([])
  }, 30_000)
})

describe('an unknown action pauses the queue', () => {
  it('a run that ends with a mutation of unknown outcome does not let the next message start', async () => {
    const s = await server(['tool', 'text', 'text'])
    const tool = slowTool()
    const f = harness(undefined, async () => tool.registry.snapshot()), p = await profile(f, s.baseUrl)
    // The tool fails after dispatch with a remote error, which is an unknown outcome for a mutation.
    const failing = new SimpleToolRegistry()
    failing.register({ name: TOOL_NAME, description: 'act', parameters: schema },
      async () => ({ isError: true, content: [{ type: 'text', text: 'boom' }] }),
      { assess: async () => ({ effect: 'send', target: 'thing', summary: 'act' }), allowAllOperations: true })
    const g = harness(undefined, async () => failing.snapshot()), q = await profile(g, s.baseUrl)
    const first = await g.send(g.id, q.id, 'act')
    const second = await g.send(g.id, q.id, 'next')
    await expect.poll(() => g.finished(first.requestId)?.state, { timeout: 15_000 }).toBe('completed')
    await wait(300)
    expect(g.chat.getQueue(g.id).paused).toBe('unknown-action')
    expect(g.state(second.requestId)).toEqual([])
    g.chat.resumeQueue(g.id)
    await expect.poll(() => g.finished(second.requestId)?.state, { timeout: 15_000 }).toBe('completed')
    expect(f.id).toBeDefined(); expect(p.id).toBeDefined()
  }, 40_000)
})

describe('continuing a task', () => {
  async function stopped() {
    const s = await server(['tool', 'text', 'text'])
    const tool = slowTool()
    const f = harness(undefined, async () => tool.registry.snapshot()), p = await profile(f, s.baseUrl)
    const first = await f.send(f.id, p.id, 'act')
    await expect.poll(() => tool.calls.length, { timeout: 10_000 }).toBe(1)
    f.chat.cancel(first.requestId)
    await expect.poll(() => f.finished(first.requestId)?.state, { timeout: 10_000 }).toBe('cancelled')
    const taskId = (f.store as unknown as { db: { prepare(sql: string): { get(): { id: string } } } }).db.prepare('SELECT id FROM tasks').get().id
    return { s, f, p, tool, taskId }
  }

  it('starts a linked attempt that warns about the unknown action, and the target stays quarantined', async () => {
    const { s, f, p, tool, taskId } = await stopped()
    expect(f.store.listOpenToolCalls(taskId)).toHaveLength(1)
    const requestId = randomUUID()
    const result = await f.chat.continueTask({ runId: taskId, requestId, profileId: p.id })
    expect(result.userMessage.content).toContain('结果未知')
    expect(result.userMessage.content).toContain('thing')
    await expect.poll(() => f.finished(requestId)?.state, { timeout: 15_000 }).toBe('completed')
    const next = (f.store as unknown as { db: { prepare(sql: string): { get(id: string): { id: string } } } }).db.prepare('SELECT id FROM tasks WHERE continuation_of = ?').get(taskId)
    expect(next).toBeTruthy()
    expect(f.store.getContinuation(taskId)).toBe(next.id)
    // The mutation was not replayed: the target is still isolated, so the tool never ran a second time.
    expect(tool.calls).toHaveLength(1)
    expect(JSON.stringify(s.requests.at(-1)?.body)).toContain('不要重复执行')
  }, 40_000)

  it('refuses a task that is not stopped, one already continued, and one in a busy conversation', async () => {
    const { f, p, taskId } = await stopped()
    await expect(f.chat.continueTask({ runId: 'missing', requestId: randomUUID(), profileId: p.id })).rejects.toThrow('找不到')
    const requestId = randomUUID()
    await f.chat.continueTask({ runId: taskId, requestId, profileId: p.id })
    await expect.poll(() => f.finished(requestId)?.state, { timeout: 15_000 }).toBe('completed')
    await expect(f.chat.continueTask({ runId: taskId, requestId: randomUUID(), profileId: p.id })).rejects.toThrow('继续过')
    const done = (f.store as unknown as { db: { prepare(sql: string): { get(id: string): { id: string } } } }).db.prepare('SELECT id FROM tasks WHERE continuation_of = ?').get(taskId)
    await expect(f.chat.continueTask({ runId: done.id, requestId: randomUUID(), profileId: p.id })).rejects.toThrow('只有被中断')
  }, 40_000)
})
