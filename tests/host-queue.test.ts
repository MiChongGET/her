import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HerStore } from '../src/core/storage/store'
import { ProfileService } from '../src/core/storage/profiles'
import { AgentHost } from '../src/core/agent/host'
import { ChatService } from '../src/core/conversation/chat'
import type { ChatEvent, RequestEvent } from '../src/shared/types'
import { startFixtureServer, type Scenario } from './pi-sdk/wire'
import { harness, harnessCleanup } from './helpers/host-harness'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of [...cleanup.splice(0), ...harnessCleanup.splice(0)].reverse()) await close() })
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function profile(f: ReturnType<typeof harness>, baseUrl: string, extra: object = {}) {
  return f.profiles.save({ name: 'p', protocol: 'openai', baseUrl: baseUrl + '/v1', model: 'test-model', contextWindow: 128000, authMethod: 'none', ...extra })
}
async function server(scenario: Scenario | Scenario[], options: Parameters<typeof startFixtureServer>[2] = {}) {
  const s = await startFixtureServer('openai', scenario, options); cleanup.push(s.close); return s
}
/** A model reply that is held until released. */
function gated() {
  let release!: () => void
  const open = new Promise<void>(resolve => { release = resolve })
  return { release, beforeReply: () => open }
}

describe('queueing', () => {
  it('queues a message sent while the conversation is busy and runs it after the first completes', async () => {
    const gate = gated(), s = await server('text', { beforeReply: gate.beforeReply })
    const f = harness(), p = await profile(f, s.baseUrl)
    const first = await f.send(f.id, p.id, 'one')
    const second = await f.send(f.id, p.id, 'two')
    expect(second.result.queued).toBe(true)
    expect(first.result.queued).toBeUndefined()
    expect(f.chat.getQueue(f.id).items.map(item => item.requestId)).toEqual([second.requestId])
    await expect.poll(() => s.requests.length).toBe(1)
    gate.release()
    await expect.poll(() => f.finished(second.requestId)?.state, { timeout: 10_000 }).toBe('completed')
    expect(f.state(first.requestId)).toContain('completed')
    expect(s.requests).toHaveLength(2)
    expect(f.chat.getQueue(f.id).items).toEqual([])
    const messages = await f.chat.getMessages(f.id)
    expect(messages.map(message => message.content)).toEqual(['one', '你好🌙', 'two', '你好🌙'])
    expect(messages[2].id).toBe(second.result.userMessage.id)
  }, 30_000)

  it('runs queued messages in arrival order, one task each', async () => {
    const gate = gated(), s = await server('text', { beforeReply: gate.beforeReply })
    const f = harness(), p = await profile(f, s.baseUrl)
    await f.send(f.id, p.id, 'one')
    const two = await f.send(f.id, p.id, 'two'), three = await f.send(f.id, p.id, 'three')
    gate.release()
    await expect.poll(() => f.finished(three.requestId)?.state, { timeout: 15_000 }).toBe('completed')
    const order = f.requests.filter(event => event.state === 'started').map(event => event.requestId)
    expect(order.slice(1)).toEqual([two.requestId, three.requestId])
    const tasks = f.store.listConversations().length && [two.requestId, three.requestId].map(id => f.store.getInput(id)?.status)
    expect(tasks).toEqual(['completed', 'completed'])
  }, 30_000)

  it('a withdrawn message is never sent, and a message that has started can no longer be withdrawn', async () => {
    const gate = gated(), s = await server('text', { beforeReply: gate.beforeReply })
    const f = harness(), p = await profile(f, s.baseUrl)
    const first = await f.send(f.id, p.id, 'one')
    const withdrawn = await f.send(f.id, p.id, 'never')
    const kept = await f.send(f.id, p.id, 'kept')
    f.chat.cancelQueued(f.id, withdrawn.requestId)
    expect(f.chat.getQueue(f.id).items.map(item => item.requestId)).toEqual([kept.requestId])
    expect(() => f.chat.cancelQueued(f.id, first.requestId)).toThrow('已经开始处理')
    gate.release()
    await expect.poll(() => f.finished(kept.requestId)?.state, { timeout: 15_000 }).toBe('completed')
    const userMessages = s.requests.flatMap(request => (request.body.messages as { role: string; content: unknown }[]).filter(message => message.role === 'user'))
    expect(JSON.stringify(userMessages)).not.toContain('never')
    expect(f.state(withdrawn.requestId)).toEqual([])
  }, 30_000)

  it('the same message is claimed once even when the queue is kicked repeatedly', async () => {
    const gate = gated(), s = await server('text', { beforeReply: gate.beforeReply })
    const f = harness(), p = await profile(f, s.baseUrl)
    await f.send(f.id, p.id, 'one')
    const two = await f.send(f.id, p.id, 'two')
    gate.release()
    for (let i = 0; i < 5; i++) f.chat.resumeQueue(f.id)
    await expect.poll(() => f.finished(two.requestId)?.state, { timeout: 15_000 }).toBe('completed')
    await wait(100)
    expect(f.requests.filter(event => event.requestId === two.requestId && event.state === 'started')).toHaveLength(1)
    expect(s.requests).toHaveLength(2)
  }, 30_000)

  it('keeps other conversations independent', async () => {
    const gate = gated(), s = await server('text', { beforeReply: gate.beforeReply })
    const f = harness(), p = await profile(f, s.baseUrl)
    await f.send(f.id, p.id, 'a1')
    const b = await f.send(f.other, p.id, 'b1')
    expect(b.result.queued).toBeUndefined()
    expect(f.chat.getQueue(f.other).items).toEqual([])
    gate.release()
    await expect.poll(() => f.finished(b.requestId)?.state, { timeout: 15_000 }).toBe('completed')
  }, 30_000)
})

describe('when the queue goes on by itself', () => {
  it('a stop pauses the queue, so the waiting message does not run until the user resumes', async () => {
    const gate = gated(), s = await server(['hang', 'text'], { beforeReply: gate.beforeReply })
    const f = harness(), p = await profile(f, s.baseUrl)
    const first = await f.send(f.id, p.id, 'one')
    const second = await f.send(f.id, p.id, 'two')
    await expect.poll(() => s.requests.length).toBe(1)
    f.chat.cancel(first.requestId)
    gate.release()
    await expect.poll(() => f.finished(first.requestId)?.state, { timeout: 10_000 }).toBe('cancelled')
    await wait(300)
    expect(f.chat.getQueue(f.id)).toMatchObject({ paused: 'stopped', running: false })
    expect(f.state(second.requestId)).toEqual([])
    expect(s.requests).toHaveLength(1)
    f.chat.resumeQueue(f.id)
    await expect.poll(() => f.finished(second.requestId)?.state, { timeout: 10_000 }).toBe('completed')
    expect(f.chat.getQueue(f.id).paused).toBeNull()
  }, 30_000)

  it('a failed run pauses the queue', async () => {
    const s = await server(['http-error', 'text'])
    const f = harness(), p = await profile(f, s.baseUrl)
    const first = await f.send(f.id, p.id, 'one')
    const second = await f.send(f.id, p.id, 'two')
    await expect.poll(() => f.finished(first.requestId)?.state, { timeout: 10_000 }).toBe('failed')
    await wait(300)
    expect(f.chat.getQueue(f.id).paused).toBe('failed')
    expect(f.state(second.requestId)).toEqual([])
    expect(s.requests).toHaveLength(1)
  }, 30_000)

  it('a new message after a stop with an empty queue starts straight away', async () => {
    const gate = gated(), s = await server(['hang', 'text'], { beforeReply: gate.beforeReply })
    const f = harness(), p = await profile(f, s.baseUrl)
    const first = await f.send(f.id, p.id, 'one')
    await expect.poll(() => s.requests.length).toBe(1)
    f.chat.cancel(first.requestId); gate.release()
    await expect.poll(() => f.finished(first.requestId)?.state, { timeout: 10_000 }).toBe('cancelled')
    const next = await f.send(f.id, p.id, 'again')
    expect(next.result.queued).toBeUndefined()
    await expect.poll(() => f.finished(next.requestId)?.state, { timeout: 10_000 }).toBe('completed')
  }, 30_000)

  it('after a restart nothing runs by itself: interrupted work is only recorded and waiting messages stay queued until resumed', async () => {
    const s = await server('text')
    const f = harness(), p = await profile(f, s.baseUrl)
    // What a crash leaves behind: a task that was running and a message that was waiting.
    const running = f.store.enqueueInput(f.id, 'was running', null, randomUUID(), { profileId: p.id, model: 'test-model' })
    f.store.claimInput(running)
    const taskId = randomUUID()
    f.store.createTask({ id: taskId, conversationId: f.id, requestId: running, generation: 0, status: 'running', serviceId: p.id, modelId: 'test-model', configRevision: 1, error: null })
    const waiting = f.store.enqueueInput(f.id, 'was waiting', null, randomUUID(), { profileId: p.id, model: 'test-model' })
    const restarted = new AgentHost(f.store, f.profiles, f.directory)
    expect(f.store.getTask(taskId)).toMatchObject({ status: 'interrupted' })
    expect(restarted.getQueue(f.id)).toMatchObject({ paused: 'restart', running: false })
    expect(restarted.getQueue(f.id).items.map(item => item.requestId)).toEqual([waiting])
    await wait(300)
    expect(f.store.getInput(waiting)).toMatchObject({ status: 'pending' })
    expect(s.requests).toHaveLength(0)
  })
})
