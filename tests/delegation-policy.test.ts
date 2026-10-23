import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { HerStore } from '../src/core/storage/store'
import { DelegationService } from '../src/core/delegations/service'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import { ToolApprovalService } from '../src/core/tools/approval'
import { ResourceQueue } from '../src/core/tools/resources'
import type { ActionDescriptor, DelegationScope, UserIntent } from '../src/core/delegations/types'
import type { ActionAssessment, ApprovalRequest } from '../src/shared/types'
import type { ToolExecutionContext, ToolRegistrationOptions } from '../src/core/tools/types'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).reverse().forEach(close => close()))
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const scope: DelegationScope = { purpose: '比较酒店', objects: ['hotel:a'], completion: '比较完成', allowedCapabilities: ['http.read'], origins: ['https://hotel.test'], constraints: {} }
function fixture(effect: ActionAssessment['effect'] = 'read', target = 'hotel:outside', options: ToolRegistrationOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'her-policy-')), store = new HerStore(join(directory, 'db.sqlite'))
  cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  const daily = store.ensureDailyConversation()
  const intent: UserIntent = { id: 'intent', messageId: 'message', conversationId: daily.id, text: '比较酒店', source: 'user', kind: 'unclassified', spans: [] }
  store.saveUserIntent(intent)
  const service = new DelegationService(store)
  service.admitIntent(intent, { id: 'proposal', scope, evidenceSpans: [[0, 4]], revision: 1 })
  const delegation = service.approveScope('proposal', 1)
  const requests: ApprovalRequest[] = [], dispatched: unknown[] = []
  const approvals = new ToolApprovalService(request => requests.push(request)), registry = new SimpleToolRegistry()
  registry.register({ name: 'action', description: 'action', parameters: { type: 'object', additionalProperties: true } },
    async args => { dispatched.push(args); return { content: [] } }, {
      assess: async () => ({ effect, target, summary: 'model prose', ...(effect === 'interact' ? { observationId: 'fresh' } : {}) }),
      validateObservation: () => true,
      describeAction: async args => ({ effect, targetId: target, target: '酒店网站', capability: 'http.read', origin: 'https://hotel.test', constraints: {},
        confirmation: effect === 'read' ? 'scope' : 'always', opaque: false, dataClasses: ['personal'],
        preview: { fields: [{ label: '姓名', value: String(args.name ?? '') }, { label: '邮箱', value: String(args.email ?? '') }], finalText: String(args.text ?? ''), recipient: String(args.recipient ?? ''), transferDestination: 'https://hotel.test' },
        summary: '实际动作', actionLabel: '执行' }), ...options } as ToolRegistrationOptions)
  const base: ToolExecutionContext = { runId: 'run', conversationId: delegation.conversationId, callId: 'call', signal: new AbortController().signal,
    delegationId: delegation.id,
    describeAction: async () => ({ id: 'action', delegationId: delegation.id, scopeRevision: 1, adapterId: '', adapterRevision: '', payloadHash: '',
      effect: 'unknown', targetId: '', capability: '', opaque: true, confirmation: 'always', dataClasses: [], purpose: scope.purpose, scopeSummary: scope.purpose }),
    actionPolicy: service,
    authorize: (assessment, context) => approvals.authorize(context.callId, assessment, context) } as ToolExecutionContext
  const call = (args: Record<string, unknown> = {}, patch: Partial<ToolExecutionContext> = {}) => registry.execute('action', args, { ...base, ...patch })
  const approve = (index = 0) => { const r = requests[index]; approvals.decide({ approvalId: r.id, revision: r.revision, decision: 'approve' }) }
  return { service, store, delegation, registry, base, requests, dispatched, call, approve, approvals }
}

it.each(['read', 'global', 'conversation', 'observation'] as const)('all_paths_reenter_delegation_gate: %s', async path => {
  const f = fixture(path === 'observation' ? 'interact' : path === 'read' ? 'read' : 'send', 'hotel:outside',
    { allowAllOperations: path === 'global', conversationApprovalScope: path === 'conversation' ? 'old-scope' : undefined })
  if (path === 'conversation') {
    const prior = f.approvals.authorize('prior', { effect: 'send', target: 'old', summary: 'old' }, {
      ...f.base, actionPolicy: undefined, approvalBinding: { revision: 'old', validate: () => true, conversationScope: { id: 'old-scope', validate: () => true } }
    })
    const r = f.requests[0]
    f.approvals.decide({ approvalId: r.id, revision: r.revision, decision: 'approve' })
    await prior; f.requests.splice(0)
    // Simulate a live grant issued by the former implementation. It carries no authority now.
    Reflect.get(f.approvals, 'conversationGrants').set(f.base.conversationId, new Map([['old-scope', () => true]]))
  }
  const controller = new AbortController(), pending = f.call({}, { signal: controller.signal })
  const settled = pending.catch(() => {})
  await tick()
  expect(f.dispatched.length).toBe(0)
  expect(f.requests).toHaveLength(1)
  controller.abort(); await settled
})

it('in_scope_read_is_allowed_but_special_actions_still_confirm', async () => {
  const f = fixture('read', 'hotel:a')
  await f.call()
  expect(f.dispatched).toHaveLength(1)
  expect(f.requests).toHaveLength(0)
  const special = fixture('send', 'hotel:a'), pending = special.call()
  await tick(); expect(special.dispatched).toHaveLength(0); expect(special.requests).toHaveLength(1)
  special.approve(); await pending
})

it('scope_changed_while_waiting_resource', async () => {
  const resources = new ResourceQueue(), release = await resources.acquire(['target'], new AbortController().signal)
  const f = fixture('send', 'hotel:a', { resources: () => ['target'] })
  const pending = f.call({}, { resources }), rejected = expect(pending).rejects.toThrow()
  await tick(); f.approve(); await tick()
  f.service.revise(f.delegation.id, 1, { ...scope, objects: ['hotel:b'] })
  release(); await rejected
  expect(f.dispatched).toHaveLength(0)
})

it.each(['name', 'email', 'text', 'recipient'] as const)('preview_matches_exact_payload_and_changed_%s_never_dispatch', async field => {
  const f = fixture('send'), args = { name: '王小明', email: 'ming@example.test', text: '明天见', recipient: 'Alice' }
  const pending = f.call(args), rejected = expect(pending).rejects.toThrow()
  await tick()
  expect(f.requests[0]).toMatchObject({ preview: { fields: [{ label: '姓名', value: args.name }, { label: '邮箱', value: args.email }], finalText: '明天见', recipient: 'Alice', transferDestination: 'https://hotel.test' } })
  args[field] = 'changed-after-preview'; f.approve(); await rejected
  expect(f.dispatched).toHaveLength(0)
})

it('an_out_of_scope_approval_never_grants_the_next_call', async () => {
  const f = fixture(), first = f.call()
  await tick(); f.approve(); await first
  const second = f.call({}, { callId: 'second' })
  await tick(); expect(f.dispatched).toHaveLength(1); expect(f.requests).toHaveLength(2)
  f.approve(1); await second
})

it('paused_delegation_denies_the_action_and_fails_current_validation', () => {
  const f = fixture(), action: ActionDescriptor = { id: 'a', delegationId: f.delegation.id, scopeRevision: 1, adapterId: 'adapter', adapterRevision: '1',
    effect: 'read', targetId: 'hotel:a', payloadHash: 'hash', dataClasses: [], capability: 'http.read', confirmation: 'scope', opaque: false }
  f.service.pause(f.delegation.id, 1)
  expect(f.service.decide(action)).toBe('deny')
  expect(() => f.service.assertCurrent(action)).toThrow()
})


it('a read label without a trusted description remains confirm even inside an approved scope', async () => {
  const f = fixture('read', 'hotel:a', { describeAction: undefined }), controller = new AbortController()
  const pending = f.call({}, { signal: controller.signal }).catch(() => {})
  await tick(); expect(f.dispatched).toHaveLength(0); expect(f.requests).toHaveLength(1)
  controller.abort(); await pending
})

it('a refused exact action stays denied for another call on the same registration', async () => {
  const f = fixture('send'), first = f.call({ text: 'hello' }), rejected = expect(first).rejects.toThrow('拒绝')
  await tick(); const request = f.requests[0]
  f.approvals.decide({ approvalId: request.id, revision: request.revision, decision: 'reject' })
  await rejected
  await expect(f.call({ text: 'hello' }, { callId: 'retry' })).rejects.toThrow('拒绝')
  expect(f.requests).toHaveLength(1); expect(f.dispatched).toHaveLength(0)
})

it('final deferred dispatch rechecks the original payload after its own asynchronous preflight', async () => {
  const f = fixture('send')
  let release!: () => void, reached!: () => void, dispatchCount = 0
  const gate = new Promise<void>(resolve => { release = resolve }), preflight = new Promise<void>(resolve => { reached = resolve })
  f.registry.register({ name: 'deferred', description: 'deferred', parameters: { type: 'object' } }, async (_args, context) => {
    reached(); await gate; context.markDispatched!('action'); dispatchCount++; return { content: [] }
  }, { deferDispatch: true })
  const args = { recipient: 'Alice' }
  const pending = f.registry.execute('deferred', args, f.base)
  await tick(); f.approve(); await preflight
  args.recipient = 'Bob'; release()
  expect(await pending).toMatchObject({ isError: true })
  expect(dispatchCount).toBe(0)
})

it('a clock name and model-shaped authority fields never acquire the actual builtin identity', async () => {
  const registry = new SimpleToolRegistry()
  let dispatches = 0
  registry.register({ name: 'get_current_time', description: 'clock', parameters: { type: 'object' } }, async () => { dispatches++; return { content: [] } },
    { assess: async () => ({ effect: 'read', target: 'system:clock', summary: 'safe' }), allowAllOperations: true })
  await expect(registry.execute('get_current_time', { effect: 'read', opaque: false, capability: 'local.clock', kind: 'delegate' }, {
    runId: 'r', conversationId: 'c', callId: 'k', signal: new AbortController().signal
  })).rejects.toThrow('确认')
  expect(dispatches).toBe(0)
})

it('matching object still requires the scoped origin and capability and honors always-confirm', async () => {
  const f = fixture()
  const action: ActionDescriptor = { id: 'a', delegationId: f.delegation.id, scopeRevision: 1, adapterId: 'adapter', adapterRevision: '1',
    effect: 'read', targetId: 'hotel:a', payloadHash: 'hash', dataClasses: [], capability: 'http.read', confirmation: 'scope', opaque: false, origin: 'https://other.test' }
  expect(f.service.decide(action)).toBe('confirm')
  expect(f.service.decide({ ...action, origin: 'https://hotel.test', capability: 'submit.personal-data' })).toBe('confirm')
  expect(f.service.decide({ ...action, origin: 'https://hotel.test', confirmation: 'always' })).toBe('confirm')
})
