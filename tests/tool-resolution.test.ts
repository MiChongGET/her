import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { startFixtureServer, type Scenario } from './pi-sdk/wire'
import { harness, harnessCleanup } from './helpers/host-harness'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of [...cleanup.splice(0), ...harnessCleanup.splice(0)].reverse()) await close() })
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

type Fixture = ReturnType<typeof harness>
async function server(scenario: Scenario | Scenario[], options: Parameters<typeof startFixtureServer>[2] = {}) {
  const s = await startFixtureServer('openai', scenario, options); cleanup.push(s.close); return s
}
async function profile(f: Fixture, baseUrl: string) {
  return f.profiles.save({ name: 'p', protocol: 'openai', baseUrl: baseUrl + '/v1', model: 'test-model', authMethod: 'none' })
}
/** A task that ended (stopped) after dispatching an action whose outcome is unknown, with its target quarantined. */
function stoppedWithUnknown(f: Fixture, options: { conversationId?: string; target?: string; callId?: string; taskId?: string } = {}) {
  const conversationId = options.conversationId ?? f.id, target = options.target ?? 'browser:b:action', callId = options.callId ?? 'call'
  const requestId = randomUUID(), taskId = options.taskId ?? randomUUID(), assistantMessageId = randomUUID()
  f.store.enqueueInput(conversationId, 'do it', null, requestId, { userMessageId: randomUUID() })
  f.store.claimInput(requestId); f.store.updateInputStatus(requestId, 'cancelled')
  f.store.createTask({ id: taskId, conversationId, requestId, generation: 0, status: 'stopped', serviceId: 's', modelId: 'm', configRevision: 1, error: null, assistantMessageId })
  f.store.insertToolCall({ taskId, callId, toolName: 'click', args: '{"target":"e1"}', effect: 'unknown', target })
  f.store.updateToolCall(taskId, callId, { status: 'unknown', phase: 'action', dispatched: true, result: '{"isError":true,"content":[]}' })
  f.store.quarantineTarget(target, conversationId, taskId, callId)
  return { taskId, callId, target, requestId, assistantMessageId }
}
const pendingOf = (f: Fixture, conversationId = f.id) => f.store.listUnresolvedToolCalls(conversationId)

describe('deciding about an unknown outcome', () => {
  it('lists it with a revision, and lifting it records a separate decision without rewriting the call', () => {
    const f = harness(), u = stoppedWithUnknown(f)
    const before = f.store.getToolCallRecord(u.taskId, u.callId)!
    const [pending] = pendingOf(f)
    expect(pending).toMatchObject({ runId: u.taskId, callId: u.callId, dispatchPhase: 'action' })
    expect(pending.summary).toContain('click')
    f.host.resolveUnknownToolCall({ conversationId: f.id, runId: u.taskId, callId: u.callId, revision: pending.revision, decision: 'handled' })
    expect(f.store.listQuarantinedTargets()).toEqual([])
    expect(f.store.getToolCallRecord(u.taskId, u.callId)).toEqual({ ...before, resolution: 'handled' })
    expect(f.store.getToolCallRecord(u.taskId, u.callId)!.status).toBe('unknown')
    expect(pendingOf(f)).toEqual([])
  })

  it('cannot be decided twice, and the decision survives a restart', () => {
    const f = harness(), u = stoppedWithUnknown(f)
    const [pending] = pendingOf(f), input = { conversationId: f.id, runId: u.taskId, callId: u.callId, revision: pending.revision, decision: 'abandoned' as const }
    f.host.resolveUnknownToolCall(input)
    expect(() => f.host.resolveUnknownToolCall(input)).toThrow('已经变化或已处理')
    f.store.close()
    const reopened = harness(f.directory)
    expect(reopened.store.getToolCallRecord(u.taskId, u.callId)).toMatchObject({ status: 'unknown', resolution: 'abandoned' })
    expect(reopened.store.listQuarantinedTargets()).toEqual([])
  })

  it.each([
    ['a stale revision', { revision: 'stale' }],
    ['a call id that does not exist', { callId: 'missing' }],
    ['a different decision value', { decision: 'maybe' }]
  ])('rejects %s and changes nothing', (_name, change) => {
    const f = harness(), u = stoppedWithUnknown(f), [pending] = pendingOf(f)
    const input = { conversationId: f.id, runId: u.taskId, callId: u.callId, revision: pending.revision, decision: 'handled' as const, ...change }
    expect(() => f.host.resolveUnknownToolCall(input as never)).toThrow()
    expect(f.store.listQuarantinedTargets()).toEqual([u.target])
    expect(pendingOf(f)).toHaveLength(1)
  })

  it('rejects a call that belongs to another conversation', () => {
    const f = harness(), u = stoppedWithUnknown(f), [pending] = pendingOf(f)
    expect(() => f.host.resolveUnknownToolCall({ conversationId: f.other, runId: u.taskId, callId: u.callId, revision: pending.revision, decision: 'handled' })).toThrow()
    expect(f.store.listQuarantinedTargets()).toEqual([u.target])
  })

  it('rejects a call whose outcome was in fact known', () => {
    const f = harness(), u = stoppedWithUnknown(f)
    f.store.updateToolCall(u.taskId, u.callId, { status: 'succeeded' })
    expect(() => f.host.resolveUnknownToolCall({ conversationId: f.id, runId: u.taskId, callId: u.callId, revision: 'x', decision: 'handled' })).toThrow()
    expect(f.store.getToolCallRecord(u.taskId, u.callId)!.resolution).toBeNull()
  })

  it('lifts the block on a target only when no other unresolved unknown outcome points at it', () => {
    const f = harness()
    const first = stoppedWithUnknown(f, { callId: 'one' }), second = stoppedWithUnknown(f, { callId: 'two' })
    const [a, b] = pendingOf(f)
    f.host.resolveUnknownToolCall({ conversationId: f.id, runId: a.runId, callId: a.callId, revision: a.revision, decision: 'handled' })
    expect(f.store.listQuarantinedTargets()).toEqual([first.target])
    f.host.resolveUnknownToolCall({ conversationId: f.id, runId: b.runId, callId: b.callId, revision: b.revision, decision: 'handled' })
    expect(f.store.listQuarantinedTargets()).toEqual([])
    void second
  })

  it('leaves another conversation\'s unknown outcome and quarantine alone', () => {
    const f = harness()
    stoppedWithUnknown(f, { target: 'target:a' }); stoppedWithUnknown(f, { conversationId: f.other, target: 'target:b' })
    const [mine] = pendingOf(f)
    f.host.resolveUnknownToolCall({ conversationId: f.id, runId: mine.runId, callId: mine.callId, revision: mine.revision, decision: 'handled' })
    expect(f.store.listQuarantinedTargets()).toEqual(['target:b'])
    expect(pendingOf(f, f.other)).toHaveLength(1)
  })

  it('a lifted target is not trusted again for a fresh interaction: it needs approval once more', async () => {
    const f = harness(), u = stoppedWithUnknown(f), [pending] = pendingOf(f)
    f.host.resolveUnknownToolCall({ conversationId: f.id, runId: u.taskId, callId: u.callId, revision: pending.revision, decision: 'handled' })
    const { ActionLedger } = await import('../src/core/tools/ledger')
    expect(new ActionLedger(f.store).recovered(u.target)).toBe(true)
  })
})

describe('what the task view shows', () => {
  it('shows a stopped task with its unresolved unknown outcomes, tied to the reply it was producing', () => {
    const f = harness(), u = stoppedWithUnknown(f)
    const task = f.chat.getConversationTask(f.id)!
    expect(task.run).toMatchObject({ id: u.taskId, status: 'stopped', assistantMessageId: u.assistantMessageId, toolCallsCount: 1 })
    expect(task.unknownCalls).toHaveLength(1)
  })

  it('stops listing the unknown outcome once it is decided, and a finished clean task shows nothing', () => {
    const f = harness(), u = stoppedWithUnknown(f), [pending] = pendingOf(f)
    const after = f.host.resolveUnknownToolCall({ conversationId: f.id, runId: u.taskId, callId: u.callId, revision: pending.revision, decision: 'handled' })
    expect(after?.unknownCalls).toBeUndefined()
    f.store.updateTaskStatus(u.taskId, 'completed')
    expect(f.chat.getConversationTask(f.id)).toBeNull()
  })

  it('returns nothing for a conversation that never ran a task', () => {
    expect(harness().chat.getConversationTask(randomUUID())).toBeNull()
  })

  it('refuses to decide while the conversation is running, and allows it once the task is stopped', async () => {
    const s = await server(['hang', 'text'])
    const f = harness(), p = await profile(f, s.baseUrl), u = stoppedWithUnknown(f), [pending] = pendingOf(f)
    const running = await f.send(f.id, p.id, 'go')
    await expect.poll(() => s.requests.length).toBe(1)
    const input = { conversationId: f.id, runId: u.taskId, callId: u.callId, revision: pending.revision, decision: 'handled' as const }
    expect(() => f.host.resolveUnknownToolCall(input)).toThrow(/停止|运行/)
    expect(f.store.listQuarantinedTargets()).toEqual([u.target])
    f.chat.cancel(running.requestId)
    await expect.poll(() => f.finished(running.requestId)?.state, { timeout: 10_000 }).toBe('cancelled')
    expect(() => f.host.resolveUnknownToolCall(input)).not.toThrow()
    expect(f.store.listQuarantinedTargets()).toEqual([])
  }, 20_000)
})

describe('continuing after a human decision', () => {
  it('tells the model what the person decided and that the outcome is still unknown, and keeps the stored result as it was', async () => {
    const s = await server('text')
    const f = harness(), p = await profile(f, s.baseUrl), u = stoppedWithUnknown(f)
    const original = f.store.getToolCallRecord(u.taskId, u.callId)!.result
    const [pending] = pendingOf(f)
    f.host.resolveUnknownToolCall({ conversationId: f.id, runId: u.taskId, callId: u.callId, revision: pending.revision, decision: 'abandoned' })
    const requestId = randomUUID()
    await f.chat.continueTask({ runId: u.taskId, requestId, profileId: p.id })
    await expect.poll(() => f.finished(requestId)?.state, { timeout: 15_000 }).toBe('completed')
    const body = JSON.stringify(s.requests.at(-1)!.body)
    expect(body).toContain('用户已放弃')
    expect(body).toContain('不得重放')
    expect(f.store.getToolCallRecord(u.taskId, u.callId)).toMatchObject({ result: original, status: 'unknown' })
  }, 30_000)

  it('without a decision, the model is told to re-observe instead', async () => {
    const s = await server('text')
    const f = harness(), p = await profile(f, s.baseUrl), u = stoppedWithUnknown(f)
    const requestId = randomUUID()
    await f.chat.continueTask({ runId: u.taskId, requestId, profileId: p.id })
    await expect.poll(() => f.finished(requestId)?.state, { timeout: 15_000 }).toBe('completed')
    const body = JSON.stringify(s.requests.at(-1)!.body)
    expect(body).toContain('不要重复执行')
    expect(body).not.toContain('用户已处理')
    await wait(10)
  }, 30_000)
})
