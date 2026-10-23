import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { startFixtureServer, type Scenario } from './pi-sdk/wire'
import { approveNextTool, harness, harnessCleanup } from './helpers/host-harness'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of [...cleanup.splice(0), ...harnessCleanup.splice(0)].reverse()) await close() })
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function server(scenario: Scenario | Scenario[], options: Parameters<typeof startFixtureServer>[2] = {}) {
  const s = await startFixtureServer('openai', scenario, options); cleanup.push(s.close); return s
}
async function profile(f: ReturnType<typeof harness>, baseUrl: string) {
  return f.profiles.save({ name: 'p', protocol: 'openai', baseUrl: baseUrl + '/v1', model: 'test-model', contextWindow: 128000, authMethod: 'none' })
}
function gated() {
  let release!: () => void
  const open = new Promise<void>(resolve => { release = resolve })
  return { release, beforeReply: () => open }
}

describe('trashing a conversation', () => {
  it('stops its running task and pauses its queue, while another conversation keeps going', async () => {
    const gate = gated(), s = await server(['hang', 'text'], { beforeReply: gate.beforeReply })
    const f = harness(), p = await profile(f, s.baseUrl)
    const inA = await f.send(f.id, p.id, 'A')
    const inB = await f.send(f.other, p.id, 'B')
    await expect.poll(() => s.requests.length).toBe(2)
    await f.chat.trashConversation(f.id)
    gate.release()
    await expect.poll(() => f.finished(inA.requestId)?.state, { timeout: 10_000 }).toBe('cancelled')
    await expect.poll(() => f.finished(inB.requestId)?.state, { timeout: 10_000 }).toBe('completed')
    expect(f.store.hasConversation(f.id)).toBe(false)
  }, 30_000)

  it('a message queued behind the trashed conversation is never sent, and the queue stays paused', async () => {
    const gate = gated(), s = await server(['hang', 'text'], { beforeReply: gate.beforeReply })
    const f = harness(), p = await profile(f, s.baseUrl)
    const running = await f.send(f.id, p.id, 'running')
    const waiting = await f.send(f.id, p.id, 'waiting')
    await expect.poll(() => s.requests.length).toBe(1)
    await f.chat.trashConversation(f.id)
    gate.release()
    await expect.poll(() => f.finished(running.requestId)?.state, { timeout: 10_000 }).toBe('cancelled')
    await wait(300)
    expect(f.state(waiting.requestId)).toEqual([])
    expect(s.requests).toHaveLength(1)
  }, 30_000)

  it('a tool call already dispatched before the trash cannot take a new action afterwards', async () => {
    const { SimpleToolRegistry } = await import('../src/core/tools/registry')
    const { TOOL_NAME } = await import('./pi-sdk/wire')
    const s = await server(['tool', 'text'])
    let markDispatched: ((phase: 'preflight' | 'action') => void) | undefined
    let validateRuntime: (() => boolean) | undefined
    const registry = new SimpleToolRegistry()
    registry.register({ name: TOOL_NAME, description: 'act', parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } },
      async (_args, context) => { markDispatched = context.markDispatched; validateRuntime = context.validateRuntime; await wait(300); return { content: [{ type: 'text', text: 'done' }] } },
      { assess: async () => ({ effect: 'read', target: 'x', summary: 'act' }), deferDispatch: true })
    const f = harness(undefined, async () => registry.snapshot()), p = await profile(f, s.baseUrl)
    const running = f.send(f.id, p.id, 'go')
    await approveNextTool(f.chat, f.id)
    await expect.poll(() => validateRuntime !== undefined, { timeout: 10_000 }).toBe(true)
    expect(validateRuntime!()).toBe(true)
    await f.chat.trashConversation(f.id)
    expect(validateRuntime!()).toBe(false)
    await running.catch(() => {})
  }, 20_000)

  it('releases the handle: a later send to the trashed id fails, a new conversation of the same host works', async () => {
    const s = await server('text')
    const f = harness(), p = await profile(f, s.baseUrl)
    await f.chat.trashConversation(f.id)
    await expect(f.send(f.id, p.id, 'x')).rejects.toThrow('不存在')
    const fresh = randomUUID(); f.store.createConversation(fresh, randomUUID(), 'y')
    const sent = await f.send(fresh, p.id, 'ok')
    await expect.poll(() => f.finished(sent.requestId)?.state, { timeout: 10_000 }).toBe('completed')
  }, 20_000)
})

describe('restoring a conversation', () => {
  it('restored_daily_does_not_replace_current_daily', async () => {
    const f = harness()
    const old = f.store.ensureDailyConversation()
    await f.chat.trashConversation(old.id)
    const trashed = f.store.getConversation(old.id)
    const current = f.store.ensureDailyConversation()
    expect(current.id).not.toBe(old.id)
    expect(f.store.getConversation(old.id)).toEqual(trashed)
    expect(f.store.getTopicInfo(old.id)).toBeNull()
    f.chat.restoreConversation(old.id)
    expect(f.store.hasConversation(old.id)).toBe(true)
    expect(f.store.ensureDailyConversation()).toEqual(current)
    expect(f.store.getConversation(old.id)?.piSessionId).toBe(old.piSessionId)
    expect(f.store.getTopicInfo(old.id)).toBeNull()
    expect(f.store.listTopicInfo()).toEqual([{ conversationId: current.id, kind: 'daily', shareProgress: false, shareRevision: 1 }])
  })

  it('does not resume the paused queue or re-run anything by itself', async () => {
    const gate = gated(), s = await server(['hang', 'text'], { beforeReply: gate.beforeReply })
    const f = harness(), p = await profile(f, s.baseUrl)
    const running = await f.send(f.id, p.id, 'running')
    const waiting = await f.send(f.id, p.id, 'waiting')
    await expect.poll(() => s.requests.length).toBe(1)
    await f.chat.trashConversation(f.id)
    gate.release()
    await expect.poll(() => f.finished(running.requestId)?.state, { timeout: 10_000 }).toBe('cancelled')
    f.chat.restoreConversation(f.id)
    expect(f.store.hasConversation(f.id)).toBe(true)
    await wait(300)
    expect(f.state(waiting.requestId)).toEqual([])
    expect(f.chat.getQueue(f.id)).toMatchObject({ running: false })
  }, 30_000)

  it('a restored conversation can be used again after the user resumes its queue', async () => {
    const s = await server('text')
    const f = harness(), p = await profile(f, s.baseUrl)
    await f.chat.trashConversation(f.id)
    f.chat.restoreConversation(f.id)
    f.chat.resumeQueue(f.id)
    const sent = await f.send(f.id, p.id, 'back')
    await expect.poll(() => f.finished(sent.requestId)?.state, { timeout: 10_000 }).toBe('completed')
  }, 20_000)
})
