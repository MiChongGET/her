import { describe, expect, it } from 'vitest'
import { ToolApprovalService } from '../src/core/tools/approval'
import type { ApprovalRequest } from '../src/shared/types'
import type { ToolExecutionContext } from '../src/core/tools/types'

function setup() {
  const requests: ApprovalRequest[] = []
  const approvals = new ToolApprovalService(request => requests.push(request))
  const controller = new AbortController()
  let valid = true
  const context: ToolExecutionContext = { runId: 'run', conversationId: 'conversation', callId: 'call', signal: controller.signal,
    approvalBinding: { revision: 'service-1:args-digest', validate: () => valid } }
  return { approvals, requests, context, controller, invalidate: () => { valid = false } }
}
const assessment = { effect: 'send' as const, target: 'chat:alice', summary: 'Send hello' }

describe('bound tool approvals', () => {
  it('approval_executes_once', async () => {
    const s = setup()
    let executions = 0
    const pending = s.approvals.authorize('call', assessment, s.context).then(() => { executions++ })
    const request = s.requests[0]
    s.approvals.decide({ approvalId: request.id, revision: request.revision, decision: 'approve' })
    s.approvals.decide({ approvalId: request.id, revision: request.revision, decision: 'approve' })
    await pending
    expect(executions).toBe(1)
  })

  it('stop_invalidates_late_approval', async () => {
    const s = setup()
    const pending = s.approvals.authorize('call', assessment, s.context)
    const rejected = expect(pending).rejects.toThrow()
    s.controller.abort()
    const request = s.requests[0]
    s.approvals.decide({ approvalId: request.id, revision: request.revision, decision: 'approve' })
    await rejected
  })

  it.each(['disabled service', 'changed arguments', 'changed model/runtime'])('%s invalidates approval', async () => {
    const s = setup()
    const pending = s.approvals.authorize('call', assessment, s.context)
    const rejected = expect(pending).rejects.toThrow(/失效/)
    s.invalidate()
    const request = s.requests[0]
    s.approvals.decide({ approvalId: request.id, revision: request.revision, decision: 'approve' })
    await rejected
  })

  it('wrong revision consumes neither authorization nor the pending decision', async () => {
    const s = setup()
    let approved = false
    const pending = s.approvals.authorize('call', assessment, s.context).then(() => { approved = true })
    const request = s.requests[0]
    s.approvals.decide({ approvalId: request.id, revision: 'old', decision: 'approve' })
    await Promise.resolve()
    expect(approved).toBe(false)
    s.approvals.decide({ approvalId: request.id, revision: request.revision, decision: 'approve' })
    await pending
  })
})

describe('approval binds one exact call', () => {
  async function gated() {
    const { SimpleToolRegistry } = await import('../src/core/tools/registry')
    const registry = new SimpleToolRegistry()
    const dispatched: unknown[] = []
    registry.register({ name: 'act', description: 'act', parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'], additionalProperties: false } },
      async args => { dispatched.push(args); return { content: [{ type: 'text', text: 'ok' }] } },
      { assess: async args => ({ effect: 'send', target: String(args.target), summary: `send ${args.target}` }) })
    const requests: ApprovalRequest[] = []
    const approvals = new ToolApprovalService(request => requests.push(request))
    const controller = new AbortController()
    const call = (callId: string, runId: string, target: string) => registry.snapshot().execute('act', { target }, {
      runId, conversationId: 'c', callId, signal: controller.signal, authorize: (assessment, context) => approvals.authorize(callId, assessment, context) })
    const settled = (promise: Promise<unknown>) => Promise.race([promise.then(() => true, () => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 30))])
    return { dispatched, requests, approvals, call, settled }
  }

  it('approving call A does not release call B', async () => {
    const s = await gated()
    const a = s.call('a', 'run', 'alice'), b = s.call('b', 'run', 'bob')
    await new Promise(resolve => setImmediate(resolve))
    expect(s.requests.map(request => request.callId).sort()).toEqual(['a', 'b'])
    const ra = s.requests.find(request => request.callId === 'a')!
    s.approvals.decide({ approvalId: ra.id, revision: ra.revision, decision: 'approve' })
    await a
    expect(await s.settled(b)).toBe(false)
    expect(s.dispatched).toEqual([{ target: 'alice' }])
  })

  it('same call and args in a different run, or a different target, get different revisions', async () => {
    const s = await gated()
    void s.call('a', 'run-1', 'alice'); void s.call('a', 'run-2', 'alice'); void s.call('a', 'run-1', 'bob')
    await new Promise(resolve => setImmediate(resolve))
    expect(new Set(s.requests.map(request => request.revision)).size).toBe(3)
  })

  it("a decision carrying another call's revision releases nothing", async () => {
    const s = await gated()
    const a = s.call('a', 'run', 'alice'); void s.call('b', 'run', 'bob')
    await new Promise(resolve => setImmediate(resolve))
    const [ra, rb] = [s.requests.find(r => r.callId === 'a')!, s.requests.find(r => r.callId === 'b')!]
    s.approvals.decide({ approvalId: ra.id, revision: rb.revision, decision: 'approve' })
    expect(await s.settled(a)).toBe(false)
    expect(s.dispatched).toEqual([])
  })
})
