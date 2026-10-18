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
