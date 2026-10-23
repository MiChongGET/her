import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HerStore } from '../src/core/storage/store'
import { ActionLedger } from '../src/core/tools/ledger'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import { ToolApprovalService } from '../src/core/tools/approval'
import type { ActionAssessment } from '../src/shared/types'
import type { ToolExecutor, ToolRegistrationOptions } from '../src/core/tools/types'

const directories: string[] = [], stores: HerStore[] = []
afterEach(() => { for (const store of stores.splice(0)) try { store.close() } catch { /* already closed */ } for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }) })
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

function open(path?: string) {
  if (!path) { const directory = mkdtempSync(join(tmpdir(), 'her-ledger-')); directories.push(directory); path = join(directory, 'her.sqlite') }
  const store = new HerStore(path); stores.push(store)
  return { store, path }
}
function task(store: HerStore, conversationId = randomUUID()) {
  store.createConversation(conversationId, randomUUID(), 't')
  const requestId = randomUUID(), taskId = randomUUID()
  store.enqueueInput(conversationId, 'hi', null, requestId)
  store.createTask({ id: taskId, conversationId, requestId, generation: 0, status: 'running', serviceId: 's', modelId: 'm', configRevision: 1, error: null })
  return { conversationId, taskId }
}
const schema = { type: 'object', properties: { target: { type: 'string' } }, required: ['target'], additionalProperties: false }
function fixture(store: HerStore, executor: ToolExecutor, options: ToolRegistrationOptions = {}, effect: ActionAssessment['effect'] = 'send') {
  const registry = new SimpleToolRegistry(), ledger = new ActionLedger(store)
  registry.register({ name: 'act', description: 'act', parameters: schema }, executor,
    { assess: async args => ({ effect, target: String(args.target), summary: 's' }),
      describeAction: async args => ({ effect, targetId: String(args.target), target: String(args.target), capability: 'fixture.action', confirmation: 'always', opaque: false, dataClasses: [], preview: { fields: [] }, summary: 'fixture action', actionLabel: '执行' }), ...options })
  const run = (t: { conversationId: string; taskId: string }, callId: string, target = 'alice', signal = new AbortController().signal) =>
    registry.snapshot().execute('act', { target }, { runId: t.taskId, conversationId: t.conversationId, callId, signal, ledger, authorize: async () => {} })
  return { registry, ledger, run }
}

describe('action ledger', () => {
  it('records the call before the executor runs and settles it as succeeded', async () => {
    const { store } = open(), t = task(store)
    let during: unknown
    const f = fixture(store, async () => { during = store.getToolCall(t.taskId, 'c1'); return { content: [{ type: 'text', text: 'ok' }] } })
    await f.run(t, 'c1')
    expect(during).toMatchObject({ status: 'running', dispatchPhase: 'action', target: 'alice' })
    expect(store.getToolCall(t.taskId, 'c1')).toMatchObject({ status: 'succeeded' })
  })

  it('does not execute when the ledger write fails', async () => {
    const { store } = open(), t = task(store)
    let executed = 0
    const f = fixture(store, async () => { executed++; return { content: [] } })
    await expect(f.run({ ...t, taskId: 'no-such-task' }, 'c1')).rejects.toThrow('动作未执行')
    expect(executed).toBe(0)
  })

  it('never dispatches the same known call twice', async () => {
    const { store } = open(), t = task(store)
    let executed = 0
    const f = fixture(store, async () => { executed++; return { content: [] } })
    await f.run(t, 'c1')
    await expect(f.run(t, 'c1')).rejects.toThrow('动作未执行')
    expect(executed).toBe(1)
  })

  it('cancelled before dispatch is cancelled and quarantines nothing', async () => {
    const { store } = open(), t = task(store), controller = new AbortController()
    controller.abort(new Error('stop'))
    const f = fixture(store, async () => ({ content: [] }))
    await expect(f.run(t, 'c1', 'alice', controller.signal)).rejects.toThrow('stop')
    expect(store.getToolCall(t.taskId, 'c1')).toBeNull()
    expect(f.ledger.quarantined()).toEqual([])
  })

  it('cancelled after dispatch is unknown and quarantines the target', async () => {
    const { store } = open(), t = task(store), controller = new AbortController()
    const f = fixture(store, () => new Promise(() => {}))
    const pending = f.run(t, 'c1', 'alice', controller.signal)
    const rejected = expect(pending).rejects.toThrow('stop')
    await tick(); controller.abort(new Error('stop')); await rejected
    expect(store.getToolCall(t.taskId, 'c1')).toMatchObject({ status: 'unknown' })
    expect(f.ledger.quarantined()).toEqual(['alice'])
  })

  it('a remote error after dispatch is unknown, but a confirmed no-effect failure is just failed', async () => {
    const { store } = open(), t = task(store)
    const f = fixture(store, async (args, context) => {
      if (args.target === 'safe') context.onNoEffect?.()
      return { isError: true, content: [{ type: 'text', text: 'boom' }] }
    })
    await f.run(t, 'c1', 'risky'); await f.run(t, 'c2', 'safe')
    expect(store.getToolCall(t.taskId, 'c1')).toMatchObject({ status: 'unknown' })
    expect(store.getToolCall(t.taskId, 'c2')).toMatchObject({ status: 'failed' })
    expect(f.ledger.quarantined()).toEqual(['risky'])
  })

  it('a completed preflight with no final dispatch is failed, not unknown', async () => {
    const { store } = open(), t = task(store)
    const f = fixture(store, async (_args, context) => {
      context.markDispatched?.('preflight'); context.completePreflight?.()
      return { isError: true, content: [{ type: 'text', text: 'drift' }] }
    }, { deferDispatch: true })
    await f.run(t, 'c1')
    expect(store.getToolCall(t.taskId, 'c1')).toMatchObject({ status: 'failed', dispatchPhase: 'preflight-completed' })
    expect(f.ledger.quarantined()).toEqual([])
  })

  it('a preflight that dies before completing is unknown', async () => {
    const { store } = open(), t = task(store)
    const f = fixture(store, async (_args, context) => { context.markDispatched?.('preflight'); return { isError: true, content: [{ type: 'text', text: 'tab closed' }] } }, { deferDispatch: true })
    await f.run(t, 'c1')
    expect(store.getToolCall(t.taskId, 'c1')).toMatchObject({ status: 'unknown', dispatchPhase: 'preflight' })
  })
})

describe('late results', () => {
  it('a result arriving after the call was stopped is recorded for audit and changes nothing else', async () => {
    const { store } = open(), t = task(store), controller = new AbortController()
    let finish!: () => void
    const f = fixture(store, () => new Promise(resolve => { finish = () => resolve({ content: [{ type: 'text', text: 'too late' }] }) }))
    const pending = f.run(t, 'c1', 'alice', controller.signal)
    const rejected = expect(pending).rejects.toThrow('stop')
    await tick(); controller.abort(new Error('stop')); await rejected
    expect(store.getToolCall(t.taskId, 'c1')).toMatchObject({ status: 'unknown' })
    finish(); await tick(); await tick()
    expect(store.getToolCall(t.taskId, 'c1')).toMatchObject({ status: 'unknown' })
    expect(f.ledger.quarantined()).toEqual(['alice'])
    const row = store.listOpenToolCalls(t.taskId)
    expect(row).toHaveLength(1)
  })

  it('a normally completed call is not audited as late', async () => {
    const { store } = open(), t = task(store)
    const f = fixture(store, async () => ({ content: [{ type: 'text', text: 'on time' }] }))
    await f.run(t, 'c1')
    expect(store.getToolCall(t.taskId, 'c1')).toMatchObject({ status: 'succeeded' })
  })
})

describe('target quarantine', () => {
  const unknownCall = async (f: ReturnType<typeof fixture>, t: ReturnType<typeof task>, target = 'alice') => { await f.run(t, randomUUID(), target) }

  it('blocks later mutations of that target in another conversation', async () => {
    const { store } = open(), a = task(store), b = task(store)
    let executed = 0
    const f = fixture(store, async () => { executed++; return { isError: true, content: [{ type: 'text', text: 'boom' }] } })
    await unknownCall(f, a)
    await expect(f.run(b, 'other')).rejects.toThrow('结果未知')
    await f.run(b, 'elsewhere', 'bob')
    expect(executed).toBe(2)
  })

  it('survives a restart and is not lifted by recreating services', async () => {
    const { store, path } = open(), t = task(store)
    const f = fixture(store, async () => ({ isError: true, content: [{ type: 'text', text: 'boom' }] }))
    await unknownCall(f, t)
    store.close()
    const reopened = open(path).store
    expect(new ActionLedger(reopened).quarantined()).toEqual(['alice'])
    const again = fixture(reopened, async () => ({ content: [] }))
    await expect(again.run(task(reopened), 'c9')).rejects.toThrow('结果未知')
  })

  it('is lifted by the user, after which the target works again', async () => {
    const { store } = open(), t = task(store)
    const f = fixture(store, async () => ({ isError: true, content: [{ type: 'text', text: 'boom' }] }))
    await unknownCall(f, t)
    expect(f.ledger.resolve('alice', 'handled')).toBe(true)
    expect(f.ledger.quarantined()).toEqual([])
    expect(f.ledger.recovered('alice')).toBe(true)
    await expect(f.run(t, 'after')).resolves.toMatchObject({ isError: true })
  })

  it('is lifted only by a successful read of the same target, never by a failed or other read', async () => {
    const { store } = open(), t = task(store)
    const f = fixture(store, async () => ({ isError: true, content: [{ type: 'text', text: 'boom' }] }))
    await unknownCall(f, t)
    const registry = new SimpleToolRegistry()
    let fail = false
    registry.register({ name: 'look', description: 'look', parameters: schema }, async () => fail ? { isError: true, content: [{ type: 'text', text: 'x' }] } : { content: [{ type: 'text', text: 'seen' }] },
      { assess: async args => ({ effect: 'read', target: String(args.target), summary: 'look' }),
        describeAction: async args => ({ effect: 'read', targetId: String(args.target), target: String(args.target), capability: 'fixture.read', confirmation: 'scope', opaque: false, dataClasses: [], preview: { fields: [] }, summary: 'look', actionLabel: 'look' }) })
    const look = (target: string) => registry.snapshot().execute('look', { target }, { runId: t.taskId, conversationId: t.conversationId, callId: randomUUID(), signal: new AbortController().signal, ledger: f.ledger, authorize: async () => {} })
    fail = true; await look('alice')
    expect(f.ledger.quarantined()).toEqual(['alice'])
    fail = false; await look('bob')
    expect(f.ledger.quarantined()).toEqual(['alice'])
    await look('alice')
    expect(f.ledger.quarantined()).toEqual([])
  })

  it('crash recovery: a dispatched call left running becomes unknown and quarantines, an undispatched one is cancelled', () => {
    const { store, path } = open(), t = task(store)
    store.insertToolCall({ taskId: t.taskId, callId: 'sent', toolName: 'act', args: '{}', effect: 'send', target: 'alice' })
    store.updateToolCall(t.taskId, 'sent', { status: 'running', phase: 'action', dispatched: true })
    store.insertToolCall({ taskId: t.taskId, callId: 'waiting', toolName: 'act', args: '{}', effect: 'send', target: 'bob' })
    store.close()
    const reopened = open(path).store
    new ActionLedger(reopened).recover()
    expect(reopened.getToolCall(t.taskId, 'sent')).toMatchObject({ status: 'unknown' })
    expect(reopened.getToolCall(t.taskId, 'waiting')).toMatchObject({ status: 'cancelled' })
    expect(reopened.listQuarantinedTargets()).toEqual(['alice'])
  })

  it('does not replay on restart: recovery never runs any executor', async () => {
    const { store, path } = open(), t = task(store)
    store.insertToolCall({ taskId: t.taskId, callId: 'sent', toolName: 'act', args: '{}', effect: 'send', target: 'alice' })
    store.updateToolCall(t.taskId, 'sent', { status: 'running', phase: 'action', dispatched: true })
    store.close()
    let executed = 0
    const reopened = open(path).store
    fixture(reopened, async () => { executed++; return { content: [] } }).ledger.recover()
    await tick()
    expect(executed).toBe(0)
  })
})

describe('approval and quarantine order', () => {
  it('a quarantined target is refused before any approval prompt is raised', async () => {
    const { store } = open(), t = task(store)
    const f = fixture(store, async () => ({ isError: true, content: [{ type: 'text', text: 'boom' }] }))
    await f.run(t, 'first')
    const prompts: unknown[] = []
    const approvals = new ToolApprovalService(request => prompts.push(request))
    await expect(f.registry.snapshot().execute('act', { target: 'alice' }, { runId: t.taskId, conversationId: t.conversationId, callId: 'second',
      signal: new AbortController().signal, ledger: f.ledger, authorize: (assessment, context) => approvals.authorize('second', assessment, context) })).rejects.toThrow('结果未知')
    expect(prompts).toEqual([])
  })
})

describe('recovered interaction', () => {
  function interact(store: HerStore) {
    const registry = new SimpleToolRegistry(), ledger = new ActionLedger(store), prompts: string[] = []
    registry.register({ name: 'type', description: 'type', parameters: schema }, async () => ({ content: [{ type: 'text', text: 'typed' }] }),
      { assess: async args => ({ effect: 'interact', target: String(args.target), summary: 's', observationId: 'obs' }), validateObservation: () => true })
    const approvals = new ToolApprovalService(request => { prompts.push(request.id); approvals.decide({ approvalId: request.id, revision: request.revision, decision: 'approve' }) })
    const run = (t: { conversationId: string; taskId: string }, callId: string) => registry.snapshot().execute('type', { target: 'alice' }, {
      runId: t.taskId, conversationId: t.conversationId, callId, signal: new AbortController().signal, ledger,
      authorize: (assessment, context) => approvals.authorize(callId, assessment, context) })
    return { ledger, prompts, run }
  }

  it('fresh observations and recovered targets both require exact approval without trusted scope', async () => {
    const { store } = open(), t = task(store), f = interact(store)
    await f.run(t, 'normal')
    expect(f.prompts).toHaveLength(1)
    store.quarantineTarget('alice', t.conversationId, t.taskId, 'normal')
    expect(f.ledger.resolve('alice', 'handled')).toBe(true)
    await f.run(t, 'after-recovery')
    expect(f.prompts).toHaveLength(2)
  })
})



it('an approved opaque read label cannot escape unknown-outcome accounting or clear quarantine', async () => {
  const { store } = open(), t = task(store), registry = new SimpleToolRegistry(), ledger = new ActionLedger(store)
  let dispatchCount = 0
  registry.register({ name: 'opaque', description: 'claims read', parameters: schema }, async () => {
    dispatchCount++; return { isError: true, content: [{ type: 'text', text: 'connection lost' }] }
  }, { assess: async () => ({ effect: 'read', target: 'alice', summary: 'claims safe' }) })
  const approvals = new ToolApprovalService(request => approvals.decide({ approvalId: request.id, revision: request.revision, decision: 'approve' }))
  const run = (callId: string) => registry.execute('opaque', { target: 'alice' }, { runId: t.taskId, conversationId: t.conversationId,
    callId, signal: new AbortController().signal, ledger, authorize: (assessment, context) => approvals.authorize(callId, assessment, context) })
  await run('opaque-1')
  expect(store.getToolCall(t.taskId, 'opaque-1')).toMatchObject({ effect: 'unknown', status: 'unknown' })
  await expect(run('opaque-2')).rejects.toThrow('结果未知')
  expect(dispatchCount).toBe(1)
  expect(ledger.quarantined()).toEqual(['alice'])
})
