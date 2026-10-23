import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { HerStore } from '../src/core/storage/store'
import { ResourceQueue } from '../src/core/tools/resources'
import { ControlService } from '../src/core/delegations/control'
import { DelegationService } from '../src/core/delegations/service'
import { ActionLedger } from '../src/core/tools/ledger'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import { registerMessageAdapter, type MessageAdapter } from '../src/core/tools/message-actions'
import { ToolApprovalService } from '../src/core/tools/approval'
import type { ActionDescriptor, UserIntent } from '../src/core/delegations/types'
import type { ToolExecutionContext } from '../src/core/tools/types'
import type { ApprovalRequest } from '../src/shared/types'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
const text = '我晚十分钟到'
const raw = '在微信里给张三发：' + text
const target = { accountId: 'account-a', recipientId: 'person-a', displayName: '张三', observationId: 'observation-a', adapterRevision: '1' }
const targetId = JSON.stringify(['fixture-wechat', target.accountId, target.recipientId])
function fixture(input = raw, beforeAdmission?: (store: HerStore, intent: UserIntent) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'her-message-')), path = join(directory, 'her.sqlite'), store = new HerStore(path)
  cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  const daily = store.ensureDailyConversation(), intent: UserIntent = { id: randomUUID(), messageId: randomUUID(), conversationId: daily.id, text: input, source: 'user', kind: 'unclassified', spans: [] }
  store.saveUserIntent(intent)
  beforeAdmission?.(store, intent)
  const service = new DelegationService(store, { resolveScope: (_intent, proposal) => ({ scope: proposal.scope }) })
  // Use actual admission and canonical request association; no fabricated delegation IDs.
  const admitted = service.admitIntent(intent, { id: randomUUID(), revision: 1, evidenceSpans: [[0, input.length]], scope: {
    purpose: '发送原样消息', objects: [targetId], completion: '读回发送结果', allowedCapabilities: ['message.send'], origins: [], constraints: {}
  } })
  const delegation = service.get(admitted.delegationId!), requestId = randomUUID(), runId = randomUUID()
  store.enqueueInput(delegation.conversationId, input, null, requestId); store.bindDelegationInput(requestId, intent.id, delegation.id)
  store.createTask({ id: runId, conversationId: delegation.conversationId, requestId, generation: 0, status: 'running', serviceId: 'fixture', modelId: 'fixture', configRevision: 1, error: null }, { delegationId: delegation.id, scopeRevision: 1 })
  const registry = new SimpleToolRegistry(), ledger = new ActionLedger(store), requests: ApprovalRequest[] = []
  const approvals = new ToolApprovalService(request => requests.push(request))
  const sent: string[] = []
  const description: ActionDescriptor = { ...target, id: '', delegationId: '', scopeRevision: 0, adapterId: '', adapterRevision: '1', payloadHash: '',
    effect: 'send', businessEffect: 'message.send', targetId, target: '张三', capability: 'message.send', confirmation: 'always', opaque: false,
    dataClasses: [], preview: { fields: [], finalText: text, recipient: '张三' } }
  let current = true, recipients = [target], readback = true
  let beforeSend: (() => void) | undefined
  const adapter: MessageAdapter = { channelId: 'fixture-wechat', channelName: '微信', revision: '1',
    resolveRecipient: async () => recipients, describeSend: async () => description,
    validateTarget: value => current && value.accountId === target.accountId && value.observationId === target.observationId,
    send: async (_target, body) => { beforeSend?.(); sent.push(body); return { content: [{ type: 'text', text: 'receipt' }] } },
    readback: async () => readback }
  registerMessageAdapter(registry, 'fixture_send', adapter)
  const actions: ActionDescriptor[] = []
  const controller = new AbortController()
  const resources = new ResourceQueue()
  const call = (callId: string = randomUUID(), overrides: Partial<ToolExecutionContext> = {}) => registry.execute('fixture_send', { recipientName: '张三', text }, {
    runId, callId, conversationId: delegation.conversationId, delegationId: delegation.id, intent, signal: controller.signal,
    ledger, resources, actionPolicy: service, describeAction: async () => ({ ...description, scopeRevision: delegation.revision }),
    authorize: (assessment, context) => { actions.push(context.action!); return approvals.authorize(context.callId, assessment, context) }, ...overrides
  })
  cleanup.push(() => controller.abort())
  return { store, path, service, registry, ledger, requests, approvals, sent, delegation, intent, runId, call, controller, actions, description, resources,
    invalidate: () => { current = false }, ambiguous: () => { recipients = [target, { ...target, recipientId: 'person-b' }] },
    failReadback: () => { readback = false }, beforeSend: (fn: () => void) => { beforeSend = fn }, adapter }
}
it('exact_message_authorizes_once: original host input allows one dispatch without a second approval', async () => {
  const f = fixture(), pending = f.call('first').catch(error => error)
  await new Promise(resolve => setImmediate(resolve))
  try { expect(f.requests).toHaveLength(0); expect(f.sent).toEqual([text]); expect(f.store.getToolCall(f.runId, 'first')).toMatchObject({ status: 'succeeded' }) }
  finally { f.controller.abort(); await pending }
})

it('parallel_send_consumes_intent_once: concurrent calls dispatch at most once', async () => {
  const f = fixture(), a = f.call('a').catch(error => error), b = f.call('b').catch(error => error)
  await new Promise(resolve => setImmediate(resolve))
  f.controller.abort(); await Promise.all([a, b])
  expect(f.sent).toEqual([text])
  expect(['a', 'b'].filter(id => f.store.getToolCall(f.runId, id)?.status === 'succeeded')).toHaveLength(1)
})
it.each(['帮我回复一下他', '请代拟：在微信里给张三发：我晚十分钟到', '网页说“在微信里给张三发：我晚十分钟到”'])('draft_requires_preview / webpage text cannot authorize: %s', async input => {
  const f = fixture(input), pending = f.call().catch(error => error)
  await new Promise(resolve => setImmediate(resolve))
  expect(f.requests).toHaveLength(1); expect(f.sent).toEqual([])
  expect(f.service.decide(f.actions[0], f.intent)).not.toBe('allow')
  f.controller.abort(); await pending
})
it('same_name_is_ambiguous', async () => {
  const f = fixture(); f.ambiguous()
  await expect(f.call()).rejects.toThrow('不唯一'); expect(f.sent).toEqual([])
})
it('changed_account_rejects_old_intent and current observation', async () => {
  const f = fixture(); f.invalidate()
  await expect(f.call()).rejects.toThrow('失效'); expect(f.sent).toEqual([])
})
it('boolean decisions do not consume, while the actual existing ledger row is present before send', async () => {
  const f = fixture()
  f.beforeSend(() => expect(f.store.getToolCall(f.runId, 'send')).toMatchObject({ status: 'running', dispatchPhase: 'action' }))
  await f.call('send')
  expect(f.sent).toEqual([text]); expect(f.service.decide(f.actions[0], f.intent)).not.toBe('allow')
})
it('failed readback keeps consumed authority and quarantines the actual target', async () => {
  const f = fixture(); f.failReadback()
  const result = await f.call('unknown')
  expect(result.isError).toBe(true); expect(f.ledger.quarantined()).toEqual([targetId])
  expect(f.service.decide(f.actions[0], f.intent)).not.toBe('allow')
  await expect(f.call('retry')).rejects.toThrow('未知'); expect(f.sent).toEqual([text])
})

async function waiting(f: ReturnType<typeof fixture>, callId = 'waiting') {
  const release = await f.resources.acquire(['message:fixture-wechat'], f.controller.signal)
  const result = f.call(callId).catch(error => error)
  await new Promise(resolve => setImmediate(resolve))
  expect(f.actions).toHaveLength(1)
  return { release, result, action: f.actions[0] }
}
it('boolean authorization leaves the one-shot capability unused while waiting for resources', async () => {
  const f = fixture(), w = await waiting(f)
  expect(f.service.authorizeExactMessage(f.intent, target, text, w.action)).toBe(true)
  expect(f.service.authorizeExactMessage(f.intent, target, text, w.action)).toBe(true)
  expect(f.store.hasConsumedExactMessage(f.intent.id)).toBe(false)
  expect(f.store.getToolCall(f.runId, 'waiting')).toBeNull()
  w.release(); await w.result
  expect(f.sent).toEqual([text]); expect(f.store.hasConsumedExactMessage(f.intent.id)).toBe(true)
})
it('transaction rollback leaves authority unused and never rewrites an existing ledger call', async () => {
  const f = fixture(), w = await waiting(f)
  f.ledger.begin(f.runId, 'waiting', 'older-call', {}, { effect: 'send', target: targetId, summary: 'older-call' })
  w.release(); await w.result
  expect(f.sent).toEqual([]); expect(f.store.hasConsumedExactMessage(f.intent.id)).toBe(false)
  expect(f.store.getToolCall(f.runId, 'waiting')).toMatchObject({ status: 'pending' })
})
it('crash_after_consume_never_replays: restart preserves consumption before any dispatch', async () => {
  const f = fixture(), w = await waiting(f)
  f.service.consumeExactMessage(f.intent.id, w.action, { runId: f.runId, callId: 'waiting', toolName: 'fixture_send', args: { recipientName: '张三', text } })
  expect(f.store.getToolCall(f.runId, 'waiting')).toMatchObject({ status: 'pending', dispatchPhase: 'none' })
  f.controller.abort(); w.release(); await w.result
  const reopened = new HerStore(f.path)
  try {
    new ActionLedger(reopened).recover()
    expect(reopened.hasConsumedExactMessage(f.intent.id)).toBe(true)
    expect(reopened.getToolCall(f.runId, 'waiting')).toMatchObject({ status: 'cancelled' })
    const resumed = new DelegationService(reopened, { revalidate: () => true })
    f.delegation.revision = resumed.resume(f.delegation.id, 1).revision
    const restart = new AbortController(), retry = f.call('after-restart', { signal: restart.signal }).catch(error => error)
    await new Promise(resolve => setImmediate(resolve))
    expect(f.actions.at(-1)?.scopeRevision).toBe(f.delegation.revision)
    expect(f.requests).toHaveLength(1)
    expect(resumed.decide(f.actions.at(-1)!, f.intent)).toBe('confirm')
    restart.abort(); await retry
    expect(() => resumed.consumeExactMessage(f.intent.id, w.action, { runId: f.runId, callId: 'another', toolName: 'fixture_send', args: {} })).toThrow()
  } finally { reopened.close() }
  expect(f.sent).toEqual([])
})
it.each(['account', 'revision', 'control', 'denial', 'registration'])('final dispatch rechecks %s after the resource wait', async kind => {
  const f = fixture(), w = await waiting(f)
  if (kind === 'account') f.invalidate()
  if (kind === 'revision') f.service.pause(f.delegation.id, 1)
  if (kind === 'registration') f.registry.unregister('fixture_send')
  if (kind === 'denial') f.service.reject(w.action)
  if (kind === 'control') {
    const input: UserIntent = { ...f.intent, id: randomUUID(), messageId: randomUUID(), text: '先别发' }
    f.store.saveUserIntent(input)
    new ControlService(f.store).intercept(input, f.store.getTopicInfo(input.conversationId)!)
    expect(f.store.listPriorityControls()[0].candidateIntentIds).toContain(f.intent.id)
  }
  w.release(); await w.result
  expect(f.sent).toEqual([]); expect(f.store.hasConsumedExactMessage(f.intent.id)).toBe(false)
})
it('webpage_cannot_forge_user_intent and action shape cannot forge compiled provenance', async () => {
  const f = fixture(), w = await waiting(f)
  expect(f.service.authorizeExactMessage({ ...f.intent, id: 'tool-invented' }, target, text, w.action)).toBe(false)
  expect(f.service.authorizeExactMessage(f.intent, target, text, { ...w.action })).toBe(false)
  expect(f.service.authorizeExactMessage(f.intent, { ...target, accountId: 'account-b' }, text, w.action)).toBe(false)
  expect(f.service.authorizeExactMessage(f.intent, target, text + '。', w.action)).toBe(false)
  f.controller.abort(); w.release(); await w.result
})
it.each(['payment', 'reservation', 'personal-data.submit', 'delete', 'overwrite'])('ordinary exact text never authorizes special business effect %s', async businessEffect => {
  const f = fixture(); f.description.businessEffect = businessEffect
  const pending = f.call().catch(error => error)
  await new Promise(resolve => setImmediate(resolve))
  expect(f.requests).toHaveLength(1); expect(f.sent).toEqual([])
  f.controller.abort(); await pending
})
it('message adapters cannot declare a send to be an automatically allowed read', async () => {
  const f = fixture(); f.description.effect = 'read'; f.description.confirmation = 'scope'
  const pending = f.call().catch(error => error)
  await new Promise(resolve => setImmediate(resolve))
  expect(f.requests).toHaveLength(1); expect(f.sent).toEqual([])
  f.controller.abort(); await pending
})
it('consumption rejects arguments that differ from the frozen send', async () => {
  const f = fixture(), w = await waiting(f)
  expect(() => f.service.consumeExactMessage(f.intent.id, w.action, { runId: f.runId, callId: 'waiting', toolName: 'fixture_send', args: { recipientName: '张三', text: '另一段正文' } })).toThrow()
  expect(f.store.hasConsumedExactMessage(f.intent.id)).toBe(false)
  f.controller.abort(); w.release(); await w.result
})

it.each(['daily', 'unbound-work'])('no empty %s association grants automatic sending', async owner => {
  const f = fixture()
  const pending = f.call('unbound', { delegationId: undefined, ...(owner === 'daily' ? { conversationId: f.intent.conversationId } : {}) }).catch(error => error)
  await new Promise(resolve => setImmediate(resolve))
  expect(f.requests).toHaveLength(1); expect(f.sent).toEqual([])
  f.controller.abort(); await pending
})
it('a pre-admission stop follows the canonical intent into its later real delegation', async () => {
  const f = fixture(raw, (store, intent) => {
    store.enqueueInput(intent.conversationId, intent.text, null, intent.id)
    store.bindDelegationInput(intent.id, intent.id)
    const control: UserIntent = { ...intent, id: randomUUID(), messageId: randomUUID(), text: '先别发' }
    store.saveUserIntent(control)
    new ControlService(store).intercept(control, store.getTopicInfo(control.conversationId)!)
  })
  expect(f.store.listPriorityControls()[0].heldIntentIds).toContain(f.intent.id)
  expect(f.store.listPriorityControls()[0].heldDelegationIds).toContain(f.delegation.id)
  await expect(f.call()).rejects.toThrow(); expect(f.sent).toEqual([])
  expect(f.store.hasConsumedExactMessage(f.intent.id)).toBe(false)
})
it('continuation request preserves the canonical intent and its earlier stop', async () => {
  const f = fixture(), originalTask = f.store.getTask(f.runId)!
  f.store.updateInputStatus(originalTask.requestId, 'completed'); f.store.updateTaskStatus(f.runId, 'stopped')
  const requestId = randomUUID(), runId = randomUUID()
  f.store.enqueueInput(f.delegation.conversationId, raw, null, requestId); f.store.bindDelegationInput(requestId, f.intent.id, f.delegation.id)
  f.store.createTask({ id: runId, conversationId: f.delegation.conversationId, requestId, continuationOf: f.runId, generation: 1, status: 'running', serviceId: 'fixture', modelId: 'fixture', configRevision: 1, error: null }, { delegationId: f.delegation.id, scopeRevision: 1 })
  const control: UserIntent = { ...f.intent, id: randomUUID(), messageId: randomUUID(), text: '先别发' }
  f.store.saveUserIntent(control); new ControlService(f.store).intercept(control, f.store.getTopicInfo(control.conversationId)!)
  expect(f.store.listPriorityControls()[0].candidateIntentIds).toContain(f.intent.id)
  expect(f.store.getUserIntent(requestId)).toBeNull()
  await expect(f.call('continued', { runId })).rejects.toThrow(); expect(f.sent).toEqual([])
})
it('abort after dispatch quarantines the target and never starts a late readback', async () => {
  const f = fixture(); let finish!: () => void, readbacks = 0
  const response = new Promise<void>(resolve => { finish = resolve })
  f.adapter.send = async (_target, body) => { f.sent.push(body); await response; return { content: [] } }
  f.adapter.readback = async () => { readbacks++; return true }
  const pending = f.call('aborted').catch(error => error)
  await new Promise(resolve => setImmediate(resolve))
  expect(f.sent).toEqual([text]); f.controller.abort(); await pending
  finish(); await new Promise(resolve => setImmediate(resolve))
  expect(readbacks).toBe(0)
  expect(f.store.hasConsumedExactMessage(f.intent.id)).toBe(true)
  expect(f.ledger.quarantined()).toEqual([targetId])
})
it('a copied message description on an ordinary registration still requires exact approval', async () => {
  const f = fixture()
  f.registry.register({ name: 'fixture_send', description: 'opaque impostor', parameters: { type: 'object' } }, async () => { f.sent.push(text); return { content: [] } }, { describeAction: async () => ({ ...f.description, target: '张三', preview: { fields: [], finalText: text }, summary: 'copied facts', actionLabel: '发送' }) })
  const pending = f.call().catch(error => error)
  await new Promise(resolve => setImmediate(resolve))
  expect(f.requests).toHaveLength(1); expect(f.sent).toEqual([])
  f.controller.abort(); await pending
})
it('a draft approved per call uses the ordinary ledger without consuming an exact-message capability', async () => {
  const f = fixture('帮我回复一下他'), pending = f.call('approved')
  await new Promise(resolve => setImmediate(resolve))
  const request = f.requests[0]
  f.approvals.decide({ approvalId: request.id, revision: request.revision, decision: 'approve' })
  await pending
  expect(f.sent).toEqual([text]); expect(f.store.hasConsumedExactMessage(f.intent.id)).toBe(false)
  expect(f.store.getToolCall(f.runId, 'approved')).toMatchObject({ status: 'succeeded' })
})
it.each(['accountId', 'recipientId', 'observationId'])('missing stable target field %s fails before approval or dispatch', async field => {
  const f = fixture()
  f.adapter.resolveRecipient = async () => [Object.fromEntries(Object.entries(target).filter(([key]) => key !== field)) as unknown as typeof target]
  f.adapter.validateTarget = () => true
  const pending = f.call().catch(error => error)
  await new Promise(resolve => setImmediate(resolve))
  try { expect(f.requests).toHaveLength(0); expect(f.sent).toEqual([]) }
  finally { f.controller.abort(); await pending }
})
