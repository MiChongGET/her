import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { HerStore } from '../src/core/storage/store'
import { AgentHost } from '../src/core/agent/host'
import { ProfileService } from '../src/core/storage/profiles'
import { createHash } from 'node:crypto'
import { HttpComparison } from '../src/core/delegations/http-comparison'
import { ControlService } from '../src/core/delegations/control'
import { DelegationService } from '../src/core/delegations/service'
import type { DelegationProducers, UserIntent } from '../src/core/delegations/types'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach(close => close()))
function fixture(producers: DelegationProducers = { revalidate: () => true }) {
  const directory = mkdtempSync(join(tmpdir(), 'her-progress-')), path = join(directory, 'her.sqlite')
  let store = new HerStore(path)
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  const intent: UserIntent = { id: 'original-intent', messageId: 'private-message', conversationId: store.ensureDailyConversation().id,
    text: 'PRIVATE REQUEST BODY', source: 'user', kind: 'unclassified', spans: [] }
  store.saveUserIntent(intent)
  const service = new DelegationService(store, producers)
  service.admitIntent(intent, { id: 'proposal', revision: 1, evidenceSpans: [[0, 7]], scope: {
    purpose: 'PRIVATE PURPOSE', objects: ['PRIVATE TARGET'], completion: 'PRIVATE CONDITION', allowedCapabilities: ['read'], origins: [], constraints: {} } })
  const delegation = service.approveScope('proposal', 1)
  const task = (id = 'run', bound = true) => {
    store.enqueueInput(delegation.conversationId, 'PRIVATE INPUT', null, id + '-request')
    store.createTask({ id, requestId: id + '-request', conversationId: delegation.conversationId, generation: 1, status: 'running',
      serviceId: 'PRIVATE PROVIDER', modelId: 'PRIVATE MODEL', configRevision: 1, error: null }, bound ? { delegationId: delegation.id, scopeRevision: 1 } : undefined)
  }
  return { store, intent, service, delegation, task, reopen: () => { store.close(); store = new HerStore(path); return new DelegationService(store, producers) } }
}

it('returns only persisted own-work state and opaque source references, excluding private content and unrelated owners', () => {
  const f = fixture(), d = f.delegation
  const [progress] = f.service.getProgressEvidence(d.conversationId)
  expect(progress).toEqual({ delegationId: d.id, conversationId: d.conversationId, revision: 1, status: 'active', pendingReason: null,
    completedActionCount: 0, observedAt: expect.any(String), evidenceRefs: [{ kind: 'user-request', id: f.intent.id }] })
  expect(Number.isNaN(Date.parse(progress.observedAt))).toBe(false)
  expect(JSON.stringify(progress)).not.toContain('PRIVATE')
  expect(f.service.getProgressEvidence(f.intent.conversationId)).toEqual([])
  expect(f.service.getProgressEvidence('missing')).toEqual([])
  f.service.pause(d.id, 1)
  expect(f.reopen().getProgressEvidence(d.conversationId)[0]).toMatchObject({ revision: 2, status: 'paused', pendingReason: null, completedActionCount: 0 })
})

it('reports actual bound approval and unresolved outcome states without borrowing another run in the same topic', () => {
  const f = fixture(), d = f.delegation
  f.task(); f.store.updateTaskStatus('run', 'waiting_approval')
  expect(f.service.getProgressEvidence(d.conversationId)[0].pendingReason).toBe('approval')
  f.store.insertToolCall({ taskId: 'run', callId: 'unknown', toolName: 'opaque', args: '{}', effect: 'unknown', target: 'PRIVATE TARGET' })
  f.store.updateToolCall('run', 'unknown', { status: 'unknown', dispatched: true })
  expect(f.service.getProgressEvidence(d.conversationId)[0].pendingReason).toBe('unknown')
  const call = f.store.listUnresolvedToolCalls(d.conversationId)[0]
  f.store.resolveToolCall({ conversationId: d.conversationId, ...call, decision: 'handled' })
  f.store.updateTaskStatus('run', 'completed')
  f.task('ordinary', false); f.store.updateTaskStatus('ordinary', 'waiting_approval')
  expect(f.service.getProgressEvidence(d.conversationId)[0].pendingReason).toBeNull()
})

it('does not treat ordinary tool success, fabricated completion labels or CLI zero as a verified business postcondition', () => {
  const f = fixture(), d = f.delegation
  f.task()
  f.store.insertToolCall({ taskId: 'run', callId: 'success', toolName: 'submit', args: '{}', effect: 'send', target: 'PRIVATE TARGET' })
  f.store.updateToolCall('run', 'success', { status: 'succeeded', phase: 'completed', dispatched: true,
    result: JSON.stringify({ success: true, completed: true, exitCode: 0, receipt: 'invented' }) })
  f.store.updateTaskStatus('run', 'completed')
  expect(f.service.getProgressEvidence(d.conversationId)[0]).toMatchObject({ completedActionCount: 0, evidenceRefs: [{ kind: 'user-request', id: f.intent.id }] })
})

it('reports unavailable capability only for nonterminal work and omits trashed topics', () => {
  const f = fixture({ revalidate: () => false }), d = f.delegation
  expect(f.service.getProgressEvidence(d.conversationId)[0].pendingReason).toBe('capability')
  f.service.cancel(d.id, 1)
  expect(f.service.getProgressEvidence(d.conversationId)[0]).toMatchObject({ revision: 2, status: 'cancelled', pendingReason: null })
  f.store.trashConversation(d.conversationId)
  expect(f.service.getProgressEvidence(d.conversationId)).toEqual([])
})


it('counts producer-verified HTTP postconditions without inventing read ledgers, including the pre-completion proof revision', async () => {
  const f = fixture(), store = f.store
  const text = '请比较下面三家酒店的公开页面，整理来源对照表：\n甲 https://a.example/\n乙 https://b.example/\n丙 https://c.example/'
  const intent = { ...f.intent, id: 'http-intent', messageId: 'http-message', text }
  store.saveUserIntent(intent)
  let available = true
  const producer = new HttpComparison(store, { available: () => available, serviceRevision: id => id === 'http-service' ? '1' : null })
  const service = new DelegationService(store, producer, producer)
  const admitted = service.admitIntent(intent, { id: 'http-proposal', revision: 1, evidenceSpans: [[0, text.length]], scope: f.delegation.scope })
  const d = service.get(admitted.delegationId!)
  store.enqueueInput(d.conversationId, text, null, 'http-request')
  store.createTask({ id: 'http-run', requestId: 'http-request', conversationId: d.conversationId, generation: 1, status: 'running',
    serviceId: 'model', modelId: 'model', configRevision: 1, error: null }, { delegationId: d.id, scopeRevision: 1 })
  let table: string | undefined
  for (const [index, url] of d.scope.objects.entries()) {
    table = producer.recordRead({ runId: 'http-run', conversationId: d.conversationId, callId: `read-${index}`, signal: new AbortController().signal, delegationId: d.id,
      action: { id: `read-${index}`, delegationId: d.id, scopeRevision: 1, adapterId: 'compiled-http', adapterRevision: '1', effect: 'read', targetId: url,
        payloadHash: createHash('sha256').update(JSON.stringify({ url })).digest('hex'), providerId: 'http-service', dataClasses: ['public-web'], capability: 'http.read', confirmation: 'scope', opaque: false } },
    { url, finalUrl: url, title: 'PRIVATE TITLE', content: 'PRIVATE SOURCE BODY', retrievalMethod: 'request' })
  }
  expect(service.getProgressEvidence(d.conversationId)[0]).toMatchObject({ status: 'active', completedActionCount: 3,
    evidenceRefs: [{ kind: 'user-request', id: intent.id }] })
  expect(store.countToolCalls('http-run')).toBe(0)
  const receipt = store.listHttpEvidence(d.id, 1).find(value => value.kind === 'receipt')!
  store.saveHttpEvidence({ ...receipt, id: 'duplicate' })
  expect(service.getProgressEvidence(d.conversationId)[0].completedActionCount).toBe(3)
  store.deleteHttpEvidence('duplicate')
  store.updateTaskStatus('http-run', 'completed')
  producer.recordDelivery(d, 'http-run', 'pi-assistant', table!)
  service.complete(d.id, 1)
  expect(service.getProgressEvidence(d.conversationId)[0]).toMatchObject({ status: 'completed', revision: 2, completedActionCount: 3 })
  expect(JSON.stringify(service.getProgressEvidence(d.conversationId))).not.toContain('PRIVATE')
  store.deleteHttpEvidence(receipt.id)
  expect(service.getProgressEvidence(d.conversationId)[0].completedActionCount).toBe(0)
  store.saveHttpEvidence({ ...receipt, runId: 'unrelated-run' })
  expect(service.getProgressEvidence(d.conversationId)[0].completedActionCount).toBe(0)
  store.deleteHttpEvidence(receipt.id); store.saveHttpEvidence(receipt)
  const directory = mkdtempSync(join(tmpdir(), 'her-progress-host-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const profiles = new ProfileService(store, { encrypt: async value => Buffer.from(value), decrypt: async value => value.toString() })
  const host = new AgentHost(store, profiles, directory, undefined, undefined, undefined, undefined, producer)
  expect(host.delegations.getProgressEvidence(d.conversationId)[0].completedActionCount).toBe(3)
  await host.stopAll()
  const fakeProducer = { revalidate: () => true, getVerifiedReadCount: () => 999 }
  const fakeHost = new AgentHost(store, profiles, directory, undefined, undefined, undefined, undefined, fakeProducer)
  expect(fakeHost.delegations.getProgressEvidence(d.conversationId)[0].completedActionCount).toBe(0)
  await fakeHost.stopAll()
  available = false
  expect(service.getProgressEvidence(d.conversationId)[0]).toMatchObject({ status: 'completed', pendingReason: null, completedActionCount: 0 })
})

it('reports unresolved priority control confirmation while keeping other owners and already resolved controls separate', () => {
  const f = fixture(), d = f.delegation
  const intent = { ...f.intent, id: 'control-intent', kind: 'unclassified' as const, text: 'PRIVATE STOP WORDS' }
  f.store.saveUserIntent(intent)
  f.store.classifyUserIntent(intent.id, 'control')
  const control = { id: 'control', intentId: intent.id, conversationId: intent.conversationId, candidateIntentIds: [f.intent.id], heldIntentIds: [f.intent.id],
    candidates: [{ delegationId: d.id, revision: 1 }], heldDelegationIds: [d.id], revision: 1, status: 'waiting' as const, kind: 'uncertain' as const,
    effect: 'mutation' as const, history: 'pending' as const, createdAt: new Date().toISOString() }
  f.store.savePriorityControl(control)
  expect(f.service.getProgressEvidence(d.conversationId)[0]).toMatchObject({ status: 'active', pendingReason: 'approval' })
  expect(JSON.stringify(f.service.getProgressEvidence(d.conversationId))).not.toContain('PRIVATE')
  f.store.savePriorityControl({ ...control, revision: 2, heldDelegationIds: [], heldIntentIds: ['another-intent'] }, 1)
  expect(f.service.getProgressEvidence(d.conversationId)[0].pendingReason).toBeNull()
  f.store.savePriorityControl({ ...control, revision: 3, status: 'resolved' }, 2)
  expect(f.service.getProgressEvidence(d.conversationId)[0].pendingReason).toBeNull()
})


it.each(['暂停这件事', '先别发'])('keeps owner A resolved after %s while owner B still needs clarification', text => {
  const f = fixture(), a = f.delegation
  const secondIntent = { ...f.intent, id: 'second-intent', messageId: 'second-message' }
  f.store.saveUserIntent(secondIntent)
  f.service.admitIntent(secondIntent, { id: 'second-proposal', revision: 1, evidenceSpans: [[0, 7]], scope: a.scope })
  const b = f.service.approveScope('second-proposal', 1)
  f.task()
  const input = { ...f.intent, id: 'shared-control', messageId: 'control-message', text }
  f.store.saveUserIntent(input)
  for (const intent of [f.intent, secondIntent]) f.store.enqueueInput(intent.conversationId, intent.text, null, intent.id)
  const controls = new ControlService(f.store)
  const { controlId } = controls.intercept(input, f.store.getTopicInfo(input.conversationId)!)
  expect(f.service.getProgressEvidence(a.conversationId)[0].pendingReason).toBe('approval')
  expect(f.service.getProgressEvidence(b.conversationId)[0].pendingReason).toBe('approval')
  controls.resolveForOwner(controlId!, a.conversationId, { kind: 'pause', delegationIds: [a.id] })
  const held = controls.get(controlId!)
  expect(held).toMatchObject({ status: 'waiting', ownerResolutions: { [a.conversationId]: 'pause' } })
  expect(held.heldIntentIds).toContain(f.intent.id)
  if (text === '先别发') expect(held.heldDelegationIds).toContain(a.id)
  const before = f.service.getProgressEvidence(a.conversationId)[0]
  expect(before).toMatchObject({ status: text === '先别发' ? 'active' : 'paused', pendingReason: null })
  expect(f.service.getProgressEvidence(b.conversationId)[0].pendingReason).toBe('approval')
  controls.resolveForOwner(controlId!, b.conversationId, { kind: 'ordinary', delegationIds: [] })
  expect(f.service.getProgressEvidence(a.conversationId)[0]).toEqual({ ...before, observedAt: expect.any(String) })
  expect(controls.get(controlId!).heldIntentIds).toContain(f.intent.id)
  expect(f.service.getProgressEvidence(b.conversationId)[0].pendingReason).toBeNull()
  // A resolved clarification must not hide an actual bound tool approval or unresolved outcome.
  f.store.updateTaskStatus('run', 'waiting_approval')
  expect(f.service.getProgressEvidence(a.conversationId)[0].pendingReason).toBe('approval')
  f.store.insertToolCall({ taskId: 'run', callId: 'uncertain', toolName: 'opaque', args: '{}', effect: 'unknown', target: 'PRIVATE' })
  f.store.updateToolCall('run', 'uncertain', { status: 'unknown', dispatched: true })
  expect(f.service.getProgressEvidence(a.conversationId)[0].pendingReason).toBe('unknown')
})
