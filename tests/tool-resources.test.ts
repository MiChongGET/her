import { describe, expect, it } from 'vitest'
import { ResourceQueue } from '../src/core/tools/resources'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import { ToolApprovalService } from '../src/core/tools/approval'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const signal = () => new AbortController().signal

describe('ResourceQueue', () => {
  it('queues conflicting keys in FIFO order', async () => {
    const queue = new ResourceQueue(), order: string[] = []
    const first = await queue.acquire(['desktop'], signal())
    const second = queue.acquire(['desktop'], signal()).then(release => { order.push('second'); return release })
    const third = queue.acquire(['desktop'], signal()).then(release => { order.push('third'); return release })
    await tick()
    expect(order).toEqual([])
    first()
    ;(await second)()
    await third
    expect(order).toEqual(['second', 'third'])
  })

  it('runs non-conflicting keys in parallel', async () => {
    const queue = new ResourceQueue()
    const releases = await Promise.all([queue.acquire(['write:a'], signal()), queue.acquire(['write:b'], signal()), queue.acquire(['mcp:x'], signal())])
    expect(releases).toHaveLength(3)
  })

  it('holds every key of a multi-key request and orders keys so opposite orders cannot deadlock', async () => {
    const queue = new ResourceQueue()
    const a = await queue.acquire(['write:b', 'write:a'], signal())
    const b = queue.acquire(['write:a', 'write:b'], signal())
    const c = queue.acquire(['write:b'], signal())
    let granted = ''
    void b.then(() => { granted += 'b' }); void c.then(() => { granted += 'c' })
    await tick()
    expect(granted).toBe('')
    a()
    await b
    await tick()
    expect(granted).toBe('b')
  })

  it('does not let a later request jump an earlier waiter that wants the same key', async () => {
    const queue = new ResourceQueue()
    const held = await queue.acquire(['write:a'], signal())
    let early = false, late = false
    void queue.acquire(['write:a', 'write:b'], signal()).then(() => { early = true })
    void queue.acquire(['write:b'], signal()).then(() => { late = true })
    await tick()
    expect([early, late]).toEqual([false, false])
    held()
    await tick()
    expect([early, late]).toEqual([true, false])
  })

  it('removes a cancelled waiter from the queue without disturbing others', async () => {
    const queue = new ResourceQueue()
    const held = await queue.acquire(['desktop'], signal())
    const controller = new AbortController()
    const cancelled = queue.acquire(['desktop'], controller.signal)
    const rejected = expect(cancelled).rejects.toThrow('stop')
    const next = queue.acquire(['desktop'], signal())
    controller.abort(new Error('stop'))
    await rejected
    held()
    ;(await next)()
  })

  it('rejects immediately for an already aborted signal and release is idempotent', async () => {
    const queue = new ResourceQueue()
    const controller = new AbortController(); controller.abort(new Error('done'))
    await expect(queue.acquire(['desktop'], controller.signal)).rejects.toThrow('done')
    const release = await queue.acquire(['desktop'], signal())
    release(); release()
    ;(await queue.acquire(['desktop'], signal()))()
  })
})

describe('registry integration', () => {
  function setup() {
    const queue = new ResourceQueue()
    const registry = new SimpleToolRegistry()
    const log: string[] = []
    const gates = new Map<string, () => void>()
    registry.register({ name: 'act', description: 'act', parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'], additionalProperties: false } },
      async args => { const id = String(args.target); log.push(`start ${id}`); await new Promise<void>(resolve => gates.set(id, resolve)); log.push(`end ${id}`); return { content: [{ type: 'text', text: id }] } },
      { assess: async args => ({ effect: 'send', target: String(args.target), summary: 's' }), resources: () => ['desktop'] })
    const requests: { id: string; revision: string }[] = []
    const approvals = new ToolApprovalService(request => requests.push(request))
    const run = (callId: string, controller = new AbortController()) => registry.snapshot().execute('act', { target: callId }, {
      runId: 'run', conversationId: 'c', callId, signal: controller.signal, resources: queue,
      authorize: (assessment, context) => approvals.authorize(callId, assessment, context) })
    const approve = (index: number) => approvals.decide({ approvalId: requests[index].id, revision: requests[index].revision, decision: 'approve' })
    return { run, approve, log, gates }
  }

  it('a call waiting for approval does not hold the resource', async () => {
    const s = setup()
    const waiting = s.run('a'), other = s.run('b')
    await tick()
    s.approve(1)
    await tick()
    expect(s.log).toEqual(['start b'])
    s.gates.get('b')!(); await other
    s.approve(0); await tick()
    s.gates.get('a')!(); await waiting
    expect(s.log).toEqual(['start b', 'end b', 'start a', 'end a'])
  })

  it('serializes approved calls that share a resource and releases it after the executor fails', async () => {
    const s = setup()
    const a = s.run('a'), b = s.run('b')
    await tick(); s.approve(0); s.approve(1); await tick()
    expect(s.log).toEqual(['start a'])
    s.gates.get('a')!(); await a; await tick()
    expect(s.log).toEqual(['start a', 'end a', 'start b'])
    s.gates.get('b')!(); await b
  })

  it('a call cancelled while queued for the resource never dispatches', async () => {
    const s = setup()
    const first = s.run('a'), controller = new AbortController(), second = s.run('b', controller)
    await tick(); s.approve(0); s.approve(1); await tick()
    const rejected = expect(second).rejects.toThrow()
    controller.abort(new Error('stopped'))
    await rejected
    s.gates.get('a')!(); await first
    expect(s.log).toEqual(['start a', 'end a'])
  })
})
