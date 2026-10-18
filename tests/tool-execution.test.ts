import { afterEach, describe, expect, it, vi } from 'vitest'
import { HerStore } from '../src/core/storage/store'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import { ToolApprovalService } from '../src/core/tools/approval'
import { TaskExecution } from '../src/core/tools/execution'
import type { ActionAssessment, ApprovalRequest, TaskRun } from '../src/shared/types'

const stores: HerStore[] = []
afterEach(() => { vi.useRealTimers(); for (const store of stores.splice(0)) store.close() })
const result = { content: [{ type: 'text' as const, text: 'observed' }] }
const send: ActionAssessment = { effect: 'send', target: 'alice', summary: 'hello' }
const read: ActionAssessment = { effect: 'read', target: 'alice', summary: 'read current state' }
const definition = { name: 'act', description: 'act', parameters: { type: 'object', properties: { target: { type: 'string' } }, additionalProperties: false } }
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function setup(registry: SimpleToolRegistry, unknownTargets: string[] = []) {
  const store = new HerStore(':memory:'); stores.push(store)
  const conversation = store.createConversation()
  const run: TaskRun = { id: 'run', requestId: 'request', conversationId: conversation.id, assistantMessageId: 'assistant', providerId: 'p', model: 'm', status: 'running', toolCallsCount: 0, activeMs: 0 }
  const requests: ApprovalRequest[] = []
  const approvals = new ToolApprovalService(request => requests.push(request))
  const controller = new AbortController()
  const execution = new TaskExecution(run, store, registry.snapshot(), approvals, controller.signal, () => {}, unknownTargets)
  const execute = (id = 'call', args = {}) => execution.execute(execution.prepare({ id, name: 'act', arguments: args }))
  const approve = () => { const r = requests.at(-1)!; approvals.decide({ approvalId: r.id, revision: r.revision, decision: 'approve' }) }
  return { store, run, requests, execution, controller, execute, approve }
}

describe('serial task execution admission', () => {
  it('all-operation permission keeps schema checks, stop and unknown-result blocking', async () => {
    const registry = new SimpleToolRegistry(); let dispatched = 0
    registry.register(definition, async () => { dispatched++; return { isError: true, content: [] } }, { allowAllOperations: true, assess: async () => send })
    const s = setup(registry)
    try {
      expect((await s.execute('invalid', { target: 42 })).isError).toBe(true)
      expect(dispatched).toBe(0)
      await s.execute('unknown')
      expect(s.requests).toHaveLength(0)
      expect(s.execution.hasUnknownResults()).toBe(true)
      await expect(s.execute('never-retry')).rejects.toThrow(/未知/)
      expect(dispatched).toBe(1)
      s.controller.abort()
      await expect(s.execute('stopped')).rejects.toThrow()
      expect(dispatched).toBe(1)
    } finally { s.execution.finish('stopped') }
  })

  it('records awaiting approval without dispatch and dispatches once only after approval', async () => {
    const registry = new SimpleToolRegistry(); let dispatched = 0
    registry.register(definition, async () => { dispatched++; return result }, { assess: async () => send })
    const s = setup(registry); const pending = s.execute(); await tick()
    expect(s.store.listToolCalls('run')[0]).toMatchObject({ status: 'awaiting_confirmation' })
    expect(s.store.listToolCalls('run')[0].startedAt).toBeUndefined()
    expect(dispatched).toBe(0)
    s.approve(); s.approve(); await pending
    expect(dispatched).toBe(1)
    expect(s.store.listToolCalls('run')[0]).toMatchObject({ status: 'succeeded', startedAt: expect.any(String) })
    s.execution.finish('completed')
  })

  it('disabled_service_invalidates_approval and unregister/re-register cannot resurrect it', async () => {
    const registry = new SimpleToolRegistry(); let dispatched = 0
    const executor = async () => { dispatched++; return result }
    registry.register(definition, executor, { assess: async () => send })
    const s = setup(registry); const pending = s.execute(); await tick()
    registry.unregister('act'); registry.register(definition, executor, { assess: async () => send })
    s.approve(); await expect(pending).rejects.toThrow(/失效/)
    expect(dispatched).toBe(0)
    expect(s.store.listToolCalls('run')[0]).toMatchObject({ status: 'cancelled' })
    s.execution.finish('failed')
  })

  it('stop before approval is cancelled, not an unknown dispatched mutation', async () => {
    const registry = new SimpleToolRegistry(); let dispatched = 0
    registry.register(definition, async () => { dispatched++; return result }, { assess: async () => send })
    const s = setup(registry); const pending = s.execute(); await tick()
    const rejected = expect(pending).rejects.toThrow(); s.controller.abort(); s.approve(); await rejected
    expect(s.store.listToolCalls('run')[0]).toMatchObject({ status: 'cancelled' })
    expect(dispatched).toBe(0); s.execution.finish('stopped')
  })

  it('validates schema before assessment or execution', async () => {
    const registry = new SimpleToolRegistry(); let assessed = 0; let dispatched = 0
    registry.register(definition, async () => { dispatched++; return result }, { assess: async () => { assessed++; return read } })
    const s = setup(registry); const actual = await s.execute('bad', { target: 42 })
    expect(actual.isError).toBe(true); expect(assessed).toBe(0); expect(dispatched).toBe(0)
    s.execution.finish('completed')
  })

  it('call_41_pauses without dispatch', async () => {
    const registry = new SimpleToolRegistry(); let dispatched = 0
    registry.register(definition, async () => { dispatched++; return result }, { assess: async () => read })
    const s = setup(registry)
    for (let i = 1; i <= 40; i++) await s.execute(String(i))
    await expect(s.execute('41')).rejects.toThrow(/上限/)
    expect(dispatched).toBe(40); s.execution.finish('paused')
    expect(s.store.getTaskRun('run')).toMatchObject({ status: 'paused', toolCallsCount: 40 })
  })

  it('active_time_excludes_confirmation_wait and invocation timeout starts after approval', async () => {
    vi.useFakeTimers()
    const registry = new SimpleToolRegistry(); let dispatched = 0
    registry.register(definition, async () => { dispatched++; return result }, { assess: async () => send })
    const s = setup(registry); const pending = s.execute()
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(dispatched).toBe(0); expect(s.requests).toHaveLength(1)
    s.approve(); await pending; s.execution.finish('completed')
    expect(dispatched).toBe(1); expect(s.store.getTaskRun('run')!.activeMs).toBe(0)
  })

  it('post-dispatch timeout of a mutation is unknown and late completion never changes the record', async () => {
    vi.useFakeTimers()
    const registry = new SimpleToolRegistry(); let release!: (value: typeof result) => void
    registry.register(definition, async () => new Promise(resolve => { release = resolve }), { assess: async () => send })
    const s = setup(registry); const pending = s.execute(); await vi.advanceTimersByTimeAsync(0); s.approve()
    await vi.advanceTimersByTimeAsync(60_000); await pending
    expect(s.store.listToolCalls('run')[0]).toMatchObject({ status: 'unknown' })
    release(result); await vi.advanceTimersByTimeAsync(0)
    expect(s.store.listToolCalls('run')[0].status).toBe('unknown'); s.execution.finish('paused')
  })

  it('unknown mutation requires actual fresh successful read of the same target', async () => {
    const registry = new SimpleToolRegistry(); let assessment = send; const dispatched: string[] = []
    registry.register(definition, async () => { dispatched.push(assessment.effect); return result }, { assess: async () => assessment })
    const s = setup(registry, ['alice'])
    await expect(s.execute('promise-only')).rejects.toThrow(/观察/)
    expect(s.requests).toHaveLength(0)
    assessment = { ...read, target: 'clock' }; await s.execute('unrelated-read')
    assessment = send; await expect(s.execute('still-blocked')).rejects.toThrow(/观察/)
    assessment = read; await s.execute('fresh-observation')
    assessment = send; const pending = s.execute('new-action'); await tick(); s.approve(); await pending
    expect(dispatched).toEqual(['read', 'read', 'send']); s.execution.finish('completed')
  })
})

describe('recovery and observation races', () => {
  it('requires explicit approval for an interact recovery even after reading the affected target', async () => {
    const registry = new SimpleToolRegistry(); let assessment: ActionAssessment = read; let count = 0
    registry.register(definition, async () => { count++; return result }, {
      assess: async () => assessment, validateObservation: () => true
    })
    const s = setup(registry, ['alice']); await s.execute('observe')
    assessment = { effect: 'interact', target: 'alice', summary: 'type again', observationId: 'fresh' }
    const pending = s.execute('recovery'); await tick()
    expect(count).toBe(1); expect(s.requests).toHaveLength(1)
    s.approve(); await pending; s.execution.finish('completed')
  })

  it('invalidates an approval when its observed target changes', async () => {
    const registry = new SimpleToolRegistry(); let fresh = true; let count = 0
    registry.register(definition, async () => { count++; return result }, {
      assess: async () => ({ ...send, observationId: 'snapshot-1' }), validateObservation: () => fresh
    })
    const s = setup(registry); const pending = s.execute(); await tick(); fresh = false; s.approve()
    await expect(pending).rejects.toThrow(/失效/)
    expect(count).toBe(0); s.execution.finish('failed')
  })

  it('rejects changed argument content instead of dispatching old or changed values', async () => {
    const registry = new SimpleToolRegistry(); let count = 0
    registry.register(definition, async () => { count++; return result }, { assess: async () => send })
    const s = setup(registry)
    const record = s.execution.prepare({ id: 'args', name: 'act', arguments: { target: 'alice' } })
    const pending = s.execution.execute(record); await tick(); record.arguments.target = 'bob'; s.approve()
    await expect(pending).rejects.toThrow(/失效/); expect(count).toBe(0); s.execution.finish('failed')
  })

  it('remote isError after mutation dispatch remains unknown and failed reads cannot clear it', async () => {
    const registry = new SimpleToolRegistry(); let assessment = send
    registry.register(definition, async () => ({ ...result, isError: true }), { assess: async () => assessment })
    const s = setup(registry); const pending = s.execute('write'); await tick(); s.approve(); await pending
    expect(s.store.listToolCalls('run')[0].status).toBe('unknown')
    assessment = read; await s.execute('failed-read'); assessment = send
    await expect(s.execute('must-not-replay')).rejects.toThrow(/观察/)
    s.execution.finish('paused')
  })
})

it('rejects concurrent execution and refuses to replay a completed record', async () => {
  const registry = new SimpleToolRegistry(); let count = 0
  registry.register(definition, async () => { count++; return result }, { assess: async () => send })
  const s = setup(registry)
  const first = s.execution.prepare({ id: 'first', name: 'act', arguments: {} })
  const second = s.execution.prepare({ id: 'second', name: 'act', arguments: {} })
  const pending = s.execution.execute(first); await tick()
  await expect(s.execution.execute(second)).rejects.toThrow(/串行/)
  s.approve(); await pending
  await expect(s.execution.execute(first)).rejects.toThrow(/重复/)
  expect(count).toBe(1); s.execution.finish('completed')
})

it('clears persisted unknown only after successful Host observation and retains generation isolation', async () => {
  const target = 'peekaboo:service:12:45:9007199254740993123'
  const registry = new SimpleToolRegistry()
  let observed = target + '-new-generation'
  let failed = false
  registry.register(definition, async (_args, context) => { context.onObserved?.(observed); return { ...result, isError: failed } }, { assess: async () => ({ effect: 'read', target: 'unverified-pid-window', summary: 'capture' }) })
  const s = setup(registry, [target])
  await s.execute('different'); expect(s.execution.hasUnknownResults()).toBe(true)
  observed = target; failed = true
  await s.execute('failed'); expect(s.execution.hasUnknownResults()).toBe(true)
  failed = false
  await s.execute('fresh'); expect(s.execution.hasUnknownResults()).toBe(false)
  expect(s.store.listToolCalls('run').find(call => call.id === 'fresh')?.assessment?.target).toBe(target)
  s.execution.finish('completed')
})

it('does not apply a Host observation that arrives before a cancelled read settles', async () => {
  const registry = new SimpleToolRegistry()
  let release!: () => void
  registry.register(definition, async (_args, context) => {
    context.onObserved?.('owned-target')
    await new Promise<void>(resolve => { release = resolve })
    return result
  }, { assess: async () => ({ effect: 'read', target: 'capture-request', summary: 'capture' }) })
  const s = setup(registry, ['owned-target'])
  const pending = s.execute('capture'); const failed = expect(pending).rejects.toThrow()
  await tick(); s.controller.abort(); release(); await failed
  expect(s.execution.hasUnknownResults()).toBe(true)
  expect(s.store.listToolCalls('run')[0].assessment?.target).toBe('capture-request')
  s.execution.finish('stopped')
})
