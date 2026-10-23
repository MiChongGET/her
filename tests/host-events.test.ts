import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceService } from '../src/core/conversation/workspace'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import { startFixtureServer, TOOL_NAME } from './pi-sdk/wire'
import { approveNextTool, harness, harnessCleanup } from './helpers/host-harness'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of [...cleanup.splice(0), ...harnessCleanup.splice(0)].reverse()) await close() })
const profile = (f: ReturnType<typeof harness>, baseUrl: string) => f.profiles.save({ name: 'p', protocol: 'openai', baseUrl: baseUrl + '/v1', model: 'test-model', contextWindow: 128000, authMethod: 'none' })

describe('run event identity and state', () => {
  it('streams independent runs with runId and monotonically increasing seq, and stopping A leaves B running', async () => {
    const a = await startFixtureServer('openai', 'hang'), b = await startFixtureServer('openai', 'hang')
    cleanup.push(a.close, b.close)
    const f = harness(), pa = await profile(f, a.baseUrl), pb = await profile(f, b.baseUrl)
    const ra = await f.send(f.id, pa.id, 'a'), rb = await f.send(f.other, pb.id, 'b')
    await expect.poll(() => f.events.filter(e => e.message.content.includes('你好')).length).toBeGreaterThanOrEqual(2)
    f.chat.cancel(ra.requestId)
    await expect.poll(() => f.finished(ra.requestId)?.state).toBe('cancelled')
    expect(f.finished(rb.requestId)).toBeUndefined()
    expect(f.chat.getQueue(f.other).running).toBe(true)
    for (const [id, requestId] of [[f.id, ra.requestId], [f.other, rb.requestId]]) {
      const events = f.events.filter(e => e.requestId === requestId)
      const task = f.store.getLatestTask(id)!
      expect(events.length).toBeGreaterThan(0)
      let seq = 0
      for (const event of events) {
        expect(event).toMatchObject({ runId: task.id, generation: task.generation, conversationId: id })
        expect(event.seq).toBeGreaterThan(seq); seq = event.seq!
      }
      expect(f.requests.find(e => e.requestId === requestId && e.state === 'started')).toMatchObject({ runId: task.id, seq: expect.any(Number) })
    }
    f.chat.cancel(rb.requestId)
  })

  it('keeps the task running while its model turn has ended but a tool remains in flight', async () => {
    const server = await startFixtureServer('openai', ['tool', 'text']); cleanup.push(server.close)
    const registry = new SimpleToolRegistry()
    let finish!: () => void, entered = false
    registry.register({ name: TOOL_NAME, description: 'read', parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } },
      () => new Promise(resolve => { entered = true; finish = () => resolve({ content: [{ type: 'text', text: 'done' }] }) }),
      { assess: async () => ({ effect: 'read', target: 'x', summary: 'read' }) })
    const f = harness(undefined, async () => registry.snapshot()), p = await profile(f, server.baseUrl)
    const sent = await f.send(f.id, p.id, 'read')
    await approveNextTool(f.chat, f.id)
    await expect.poll(() => entered).toBe(true)
    expect(f.chat.getConversationTask(f.id)?.run.status).toBe('running')
    expect(f.finished(sent.requestId)).toBeUndefined()
    expect(f.events.at(-1)?.task?.run.status).toBe('running')
    finish()
    await expect.poll(() => f.finished(sent.requestId)?.state).toBe('completed')
    expect(f.events.at(-1)?.task?.run.status).toBe('completed')
  })
})

 it('publishes waiting_resource only while a conflicting tool is queued', async () => {
    const server = await startFixtureServer('openai', ['tool', 'tool', 'text']); cleanup.push(server.close)
    const registry = new SimpleToolRegistry()
    let calls = 0, release!: () => void
    registry.register({ name: TOOL_NAME, description: 'read desktop', parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } },
      async () => { if (++calls === 1) await new Promise<void>(resolve => { release = resolve }); return { content: [{ type: 'text', text: 'done' }] } },
      { assess: async () => ({ effect: 'read', target: 'desktop', summary: 'read' }), resources: () => ['desktop'] })
    const f = harness(undefined, async () => registry.snapshot()), p = await profile(f, server.baseUrl)
    await f.send(f.id, p.id, 'a')
    await approveNextTool(f.chat, f.id)
    await expect.poll(() => calls).toBe(1)
    const b = await f.send(f.other, p.id, 'b')
    await approveNextTool(f.chat, f.other)
    await expect.poll(() => f.chat.getConversationTask(f.other)?.run.status).toBe('waiting_resource')
    expect(calls).toBe(1)
    release()
    await expect.poll(() => f.finished(b.requestId)?.state).toBe('completed')
    expect(calls).toBe(2)
    expect(f.events.filter(e => e.conversationId === f.other).some(e => e.task?.run.status === 'waiting_resource')).toBe(true)
  })


it('selected B keeps its preparing stop identity while A runs, without exposing A', async () => {
  const server = await startFixtureServer('openai', 'hang'); cleanup.push(server.close)
  const f = harness(), p = await profile(f, server.baseUrl)
  const bId = randomUUID(); f.store.createWorkConversation(bId, randomUUID(), 'B')
  const a = await f.send(f.id, p.id, 'A')
  const original = f.profiles.resolve.bind(f.profiles)
  let release!: () => void
  vi.spyOn(f.profiles, 'resolve').mockImplementation(async (...args) => {
    await new Promise<void>(resolve => { release = resolve })
    return original(...args)
  })
  const preparingId = randomUUID()
  const sending = f.send(bId, p.id, 'B', preparingId)
  const stopped = expect(sending).rejects.toThrow('已停止')
  await expect.poll(() => !!release).toBe(true)
  const workspace = new WorkspaceService(f.store, f.chat)
  const selected = await workspace.select({ section: 'work', conversationId: bId })
  expect(selected.activeRequest).toEqual({ requestId: preparingId, conversationId: bId })
  expect(selected.activeRequest?.requestId).not.toBe(a.requestId)
  const list = await workspace.select({ section: 'work' })
  expect(list.activeRequest).toBeNull()
  f.chat.cancel(preparingId); release(); await stopped
  expect(f.chat.getActiveRequest(f.id)?.requestId).toBe(a.requestId)
  f.chat.cancel(a.requestId)
})
