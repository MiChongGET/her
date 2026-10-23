import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { HerStore } from '../src/core/storage/store'
import { DelegationService } from '../src/core/delegations/service'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import { ToolApprovalService } from '../src/core/tools/approval'
import { AgentHost } from '../src/core/agent/host'
import { ProfileService } from '../src/core/storage/profiles'
import { ChatService } from '../src/core/conversation/chat'
import { WorkspaceService } from '../src/core/conversation/workspace'
import type { ActionDescriptor, ActionDescription, DelegationProducers, DelegationScope, DenialRevisionProof, UserIntent } from '../src/core/delegations/types'
import type { ApprovalRequest, ChatEvent } from '../src/shared/types'
import type { ToolExecutionContext } from '../src/core/tools/types'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const waitFor = async (condition: () => boolean) => { for (let i = 0; i < 500; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 10)) } throw new Error('fixture timed out') }
const scope: DelegationScope = { purpose: '比较酒店', objects: ['hotel:a', 'hotel:b'], completion: '比较表已交付', allowedCapabilities: ['http.read'], origins: [], constraints: {} }
const submit: ActionDescription = { effect: 'send', targetId: 'hotel:a', target: '酒店 A', capability: 'http.submit', confirmation: 'always', opaque: false,
  dataClasses: ['personal.email', 'personal.name'], businessEffect: 'submit.personal-data', preview: { fields: [{ label: '邮箱', value: 'guest@example.test' }] }, summary: '提交资料', actionLabel: '提交' }
const publicRead: ActionDescription = { effect: 'read', targetId: 'hotel:b', target: '酒店 B', capability: 'http.read', confirmation: 'scope', opaque: false,
  dataClasses: ['public'], preview: { fields: [] }, summary: '查询公开价格', actionLabel: '查询' }
function storage() {
  const directory = mkdtempSync(join(tmpdir(), 'her-denial-')), path = join(directory, 'db.sqlite'), store = new HerStore(path)
  cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  const daily = store.ensureDailyConversation(), intent: UserIntent = { id: 'intent', messageId: 'message', conversationId: daily.id, text: '比较酒店', source: 'user', kind: 'unclassified', spans: [] }
  store.saveUserIntent(intent)
  return { directory, path, store, intent }
}
function policy(producers: DelegationProducers = {}) {
  const f = storage(), service = new DelegationService(f.store, { revalidate: () => true, ...producers })
  service.admitIntent(f.intent, { id: 'proposal', scope, evidenceSpans: [[0, 4]], revision: 1 })
  const delegation = service.approveScope('proposal', 1), requests: ApprovalRequest[] = [], registry = new SimpleToolRegistry()
  let dispatches = 0
  const register = (name: string, facts?: ActionDescription) => registry.register({ name, description: name, parameters: { type: 'object' } },
    async () => { dispatches++; return { content: [] } }, facts ? { describeAction: async () => facts, revision: name } : {})
  register('submit', submit)
  const approvals = new ToolApprovalService(request => requests.push(request))
  const context: ToolExecutionContext = { runId: 'run', conversationId: delegation.conversationId, callId: 'call', signal: new AbortController().signal,
    delegationId: delegation.id, actionPolicy: service,
    describeAction: async () => ({ id: '', delegationId: delegation.id, scopeRevision: service.get(delegation.id).revision, adapterId: '', adapterRevision: '', payloadHash: '',
      effect: 'unknown', targetId: '', capability: '', confirmation: 'always', opaque: true, dataClasses: [] }),
    authorize: (assessment, actual) => approvals.authorize(actual.callId, assessment, actual) }
  const call = (name = 'submit', args = {}, patch: Partial<ToolExecutionContext> = {}) => registry.execute(name, args, { ...context, ...patch })
  const reject = async () => {
    const denied = call('submit', { text: 'first wording' }).catch(error => error)
    await tick(); const request = requests.at(-1)!
    approvals.decide({ approvalId: request.id, revision: request.revision, decision: 'reject' })
    return denied
  }
  return { ...f, service, delegation, requests, registry, register, approvals, call, reject, dispatches: () => dispatches }
}

it('denied_action_cannot_change_tools_payload_transport_or_call_identity', async () => {
  const f = policy()
  await f.reject()
  f.register('browser_form', { ...submit, effect: 'interact', capability: 'browser.form', dataClasses: ['personal.name', 'personal.email'] })
  const retry = f.call('browser_form', { text: 'same submission in different words' }, { callId: 'another-call' })
  const result = retry.catch(error => error)
  await tick()
  expect(f.requests).toHaveLength(1)
  expect(await result).toMatchObject({ name: 'DeniedStepError' })
  expect(f.dispatches()).toBe(0)
})

it('opaque_or_missing_business_facts_cannot_prompt_around_denial_but_proven_public_read_continues', async () => {
  const f = policy()
  await f.reject()
  f.register('script')
  f.register('unclassified_submit', { ...submit, businessEffect: undefined, targetId: 'other-looking-target' })
  for (const name of ['script', 'unclassified_submit']) {
    const pending = f.call(name, { effect: 'read', opaque: false, businessEffect: 'unrelated', targetId: 'public', dataClasses: ['public'] }).catch(error => error)
    await tick(); expect(f.requests).toHaveLength(1)
    expect(await pending).toMatchObject({ name: 'DeniedStepError' })
  }
  f.register('query', publicRead)
  await f.call('query')
  expect(f.dispatches()).toBe(1)
  expect(f.service.get(f.delegation.id).status).toBe('active')
})

it('denial_is_durable_before_approval_wait_ends_and_pause_resume_revise_never_withdraw_it', async () => {
  const f = policy()
  let persistedAtResume = false
  const pending = f.call('submit', {}, { onApproval: request => {
    if (!request) {
      const reopened = new HerStore(f.path)
      try {
        const service = new DelegationService(reopened)
        persistedAtResume = service.decide({ ...submit, id: 'retry', delegationId: f.delegation.id, scopeRevision: 1, adapterId: 'new', adapterRevision: '2', payloadHash: 'new' }) === 'deny'
      } finally { reopened.close() }
    }
  } }).catch(error => error)
  await tick(); const request = f.requests[0]
  f.approvals.decide({ approvalId: request.id, revision: request.revision, decision: 'reject' })
  expect(await pending).toMatchObject({ name: 'DeniedStepError', actionId: 'call' })
  expect(persistedAtResume).toBe(true)
  let d = f.service.pause(f.delegation.id, 1)
  expect(d.status).toBe('paused')
  d = f.service.resume(d.id, d.revision)
  d = f.service.revise(d.id, d.revision, { ...scope, completion: '调整后的比较表' })
  d = f.service.resume(d.id, d.revision)
  await expect(f.call('submit', { changed: 'again' })).rejects.toMatchObject({ name: 'DeniedStepError' })
  expect(f.requests).toHaveLength(1)
  expect(f.service.get(d.id).status).toBe('active')
  expect(f.service.cancel(d.id, d.revision).status).toBe('cancelled')
})

async function hostScenario(essential: boolean) {
  const f = storage(), registry = new SimpleToolRegistry(), requests: Record<string, any>[] = []
  let submissions = 0, queries = 0, opaqueReplays = 0
  registry.register({ name: 'submit', description: 'submit', parameters: { type: 'object' } }, async () => { submissions++; return { content: [] } }, { describeAction: async () => submit })
  registry.register({ name: 'alternate_submit', description: 'alternate', parameters: { type: 'object' } }, async () => { submissions++; return { content: [] } }, { describeAction: async () => ({ ...submit, effect: 'interact', capability: 'browser.form' }) })
  registry.register({ name: 'script', description: 'opaque script', parameters: { type: 'object' } }, async () => { opaqueReplays++; return { content: [] } })
  registry.register({ name: 'query', description: 'query', parameters: { type: 'object' } }, async () => { queries++; return { content: [{ type: 'text', text: '公开价格 500' }] } }, { describeAction: async () => publicRead })
  const proposal = { id: 'proposal', scope, evidenceSpans: [[0, 4]], revision: 1 }
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body)
    const daily = body.tools.some((tool: any) => tool.function.name === 'delegate_work'), previous = body.messages.filter((message: any) => message.role === 'tool')
    const steps = essential ? ['submit'] : ['submit', 'alternate_submit', 'script', 'query']
    const name = daily ? previous.length ? undefined : 'delegate_work' : steps[previous.length]
    const answer = daily ? '已接纳' : essential ? '资料提交已被拒绝，缺少资料无法完成；请调整安排。' : '已跳过资料提交并查询其他酒店；比较仍待完成。'
    const delta = name ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${previous.length}`, type: 'function', function: { name, arguments: JSON.stringify(daily ? proposal : { text: `wording-${previous.length}` }) } }] } : { role: 'assistant', content: answer }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const part of [{ delta, finish_reason: null }, { delta: {}, finish_reason: name ? 'tool_calls' : 'stop' }]) res.write(`data: ${JSON.stringify({ id: 'response', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, ...part }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const profiles = new ProfileService(f.store, { encrypt: async text => Buffer.from(text), decrypt: async bytes => bytes.toString() })
  const profile = await profiles.save({ name: 'local', protocol: 'openai', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: 'test', contextWindow: 128000, authMethod: 'none' })
  const host = new AgentHost(f.store, profiles, f.directory, async () => registry.snapshot(), undefined, undefined, undefined, { resolveScope: () => ({ scope }), revalidate: () => true })
  cleanup.push(async () => { await host.stopAll(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const events: ChatEvent[] = [], done: string[] = []
  const chat = new ChatService(f.store, host, event => events.push(event), event => { if (['completed', 'failed'].includes(event.state)) done.push(event.state) })
  await chat.send({ requestId: 'daily', conversationId: f.intent.conversationId, profileId: profile.id, content: '比较酒店' })
  await waitFor(() => events.some(event => !!event.task?.approval))
  const request = events.find(event => !!event.task?.approval)!.task!.approval!
  await chat.decideApproval({ approvalId: request.id, revision: request.revision, decision: 'reject' })
  await waitFor(() => done.length === 2)
  const control = f.store.listDelegationControls()[0], delegation = host.delegations.get(control.delegationId!)
  return { ...f, host, chat, events, requests, done, delegation, submissions, queries, opaqueReplays }
}

it('refuse_personal_data_keep_comparing_through_actual_Host_Pi_gate', async () => {
  const f = await hostScenario(false)
  expect(f.submissions).toBe(0)
  expect(f.opaqueReplays).toBe(0)
  expect(f.queries).toBe(1)
  expect(f.done).toEqual(['completed', 'completed'])
  expect(f.delegation.status).toBe('active')
  expect(f.events.filter(event => !!event.task?.approval)).toHaveLength(1)
  const work = f.requests.filter(body => !body.tools.some((tool: any) => tool.function.name === 'delegate_work'))
  const refusal = work[1].messages.find((message: any) => message.role === 'tool').content
  expect(refusal).toContain('继续')
  expect(refusal).toContain('不依赖')
  expect(refusal).not.toContain(f.delegation.id)
}, 15_000)

it('essential_step_waits_for_user_without_cancelling_or_faking_completion', async () => {
  const f = await hostScenario(true)
  expect(f.submissions).toBe(0)
  expect(f.queries).toBe(0)
  expect(f.delegation.status).toBe('active')
  expect(f.store.getDelegationProof(f.delegation.id)).toBeNull()
  expect(new WorkspaceService(f.store, f.chat).getPendingActions().map(notice => notice.status)).toEqual(['paused'])
  expect(f.events.at(-1)?.message.content).toContain('调整安排')
}, 15_000)

function revisionIntent(f: ReturnType<typeof policy>, id = 'revise-intent', conversationId = f.delegation.conversationId) {
  f.store.saveUserIntent({ id, messageId: `message-${id}`, conversationId, text: '明确改为允许这一步提交资料', source: 'user', kind: 'unclassified', spans: [] })
  f.store.classifyUserIntent(id, 'control')
  return f.store.getUserIntent(id)!
}
const validateRevision: NonNullable<DelegationProducers['validateDenialRevision']> = (delegation, denial, intent, evidenceSpans) => ({
  delegationId: delegation.id, scopeRevision: delegation.revision, denialId: denial.id, targetId: denial.targetId, businessEffect: denial.businessEffect,
  effect: denial.effect, dataClasses: denial.dataClasses ?? [], intentId: intent.id, messageId: intent.messageId, evidenceSpans, decision: 'withdraw-denial'
})

it('only_a_trusted_explicit_revision_proof_can_withdraw_a_refusal_and_must_revalidate_before_dispatch', async () => {
  const f = policy()
  await f.reject()
  const denial = f.store.listDelegationDenials(f.delegation.id)[0], intent = revisionIntent(f)
  expect(() => f.service.reviseDeniedStep(f.delegation.id, 1, denial.id, intent.id, [[0, intent.text.length]])).toThrow('可信')
  const service = new DelegationService(f.store, { revalidate: () => true, validateDenialRevision: validateRevision })
  const revised = service.reviseDeniedStep(f.delegation.id, 1, denial.id, intent.id, [[0, intent.text.length]])
  expect(revised).toMatchObject({ revision: 2, resumeRequired: true, status: 'active' })
  expect(f.store.listDelegationDenials(revised.id)[0].withdrawal).toMatchObject({ intentId: intent.id, denialId: denial.id, scopeRevision: 1 })
  await expect(f.call()).rejects.toThrow('重新确认')
  service.resume(revised.id, 2)
  const pending = f.call().catch(error => error)
  await tick(); expect(f.requests).toHaveLength(2)
  const request = f.requests[1]
  f.approvals.decide({ approvalId: request.id, revision: request.revision, decision: 'approve' })
  await pending
  expect(f.dispatches()).toBe(1)
})

it.each(['target', 'effect', 'classes', 'denial', 'revision', 'message', 'spans', 'decision'] as const)('a proof with changed %s cannot withdraw the selected refusal', async field => {
  const f = policy(), intent = revisionIntent(f)
  await f.reject()
  const denial = f.store.listDelegationDenials(f.delegation.id)[0]
  const service = new DelegationService(f.store, { validateDenialRevision: (...args) => {
    const proof = validateRevision(...args)!
    if (field === 'target') proof.targetId = 'another-object'
    if (field === 'effect') proof.businessEffect = 'another-effect'
    if (field === 'classes') proof.dataClasses = []
    if (field === 'denial') proof.denialId = 'another-denial'
    if (field === 'revision') proof.scopeRevision++
    if (field === 'message') proof.messageId = 'another-message'
    if (field === 'spans') proof.evidenceSpans = [[0, 1]]
    if (field === 'decision') proof.decision = 'approve' as DenialRevisionProof['decision']
    return proof
  } })
  expect(() => service.reviseDeniedStep(f.delegation.id, 1, denial.id, intent.id, [[0, intent.text.length]])).toThrow()
  expect(f.store.listDelegationDenials(f.delegation.id)[0].withdrawal).toBeUndefined()
})

it('revision_evidence_is_consumed_once_and_a_stale_scope_CAS_rolls_back_its_denial_write', async () => {
  const f = policy(), intent = revisionIntent(f)
  await f.reject()
  const first = f.store.listDelegationDenials(f.delegation.id)[0]
  const service = new DelegationService(f.store, { revalidate: () => true, validateDenialRevision: validateRevision })
  service.reviseDeniedStep(f.delegation.id, 1, first.id, intent.id, [[0, intent.text.length]])
  service.resume(f.delegation.id, 2)
  await f.reject()
  const second = f.store.listDelegationDenials(f.delegation.id)[1]
  expect(() => service.reviseDeniedStep(f.delegation.id, 3, second.id, intent.id, [[0, intent.text.length]])).toThrow('已使用')
  const fresh = revisionIntent(f, 'fresh')
  const stale = new DelegationService(f.store, { validateDenialRevision: (...args) => {
    service.pause(f.delegation.id, 3)
    return validateRevision(...args)
  } })
  expect(() => stale.reviseDeniedStep(f.delegation.id, 3, second.id, fresh.id, [[0, fresh.text.length]])).toThrow('版本')
  expect(f.store.listDelegationDenials(f.delegation.id)[1].withdrawal).toBeUndefined()
  const reopened = new HerStore(f.path)
  try { expect(reopened.listDelegationDenials(f.delegation.id)[1].withdrawal).toBeUndefined() } finally { reopened.close() }
})

it('refusal_matches_the_same_business_step_after_data_classes_are_missing_or_rewritten_and_a_restart', async () => {
  const f = policy()
  await f.reject()
  const reopened = new HerStore(f.path)
  try {
    const service = new DelegationService(reopened)
    for (const classes of [[], ['public'], ['personal.email'], ['personal.email', 'extra']]) {
      const action: ActionDescriptor = { ...submit, dataClasses: classes, effect: 'interact', capability: 'browser.form', id: 'new-call', delegationId: f.delegation.id, scopeRevision: 1, adapterId: 'changed', adapterRevision: '10', payloadHash: 'rewritten' }
      expect(service.isDenied(action)).toBe(true)
      expect(service.decide(action)).toBe('deny')
    }
  } finally { reopened.close() }
})

it('an_unrelated_topic_or_non_control_intent_and_invalid_spans_cannot_revise_denial', async () => {
  const f = policy({ validateDenialRevision: validateRevision })
  await f.reject()
  const denial = f.store.listDelegationDenials(f.delegation.id)[0]
  f.store.createWorkConversation('unrelated', 'unrelated-session', '别的工作')
  const wrong = revisionIntent(f, 'wrong-topic', 'unrelated')
  expect(() => f.service.reviseDeniedStep(f.delegation.id, 1, denial.id, wrong.id, [[0, 2]])).toThrow('依据')
  const ordinary = revisionIntent(f, 'ordinary')
  f.store.classifyUserIntent(ordinary.id, 'ordinary')
  expect(() => f.service.reviseDeniedStep(f.delegation.id, 1, denial.id, ordinary.id, [[0, 2]])).toThrow('依据')
  const right = revisionIntent(f, 'right')
  for (const spans of [[], [[-1, 2]], [[1, 1]], [[0, right.text.length + 1]]]) {
    expect(() => f.service.reviseDeniedStep(f.delegation.id, 1, denial.id, right.id, spans as [number, number][])).toThrow('依据')
  }
  expect(f.store.listDelegationDenials(f.delegation.id)[0].withdrawal).toBeUndefined()
})
