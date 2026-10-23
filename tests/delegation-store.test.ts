import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { HerStore } from '../src/core/storage/store'
import { DelegationService } from '../src/core/delegations/service'
import type { CompletionProof, DelegationScope, UserIntent } from '../src/core/delegations/types'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach(close => close()))
const scope: DelegationScope = { purpose: '比较酒店', objects: ['hotel:a', 'hotel:b'], completion: '两家酒店比较表已保存', allowedCapabilities: ['http.read'], origins: ['https://example.test'], constraints: { nights: 1 } }
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'her-delegation-')), path = join(directory, 'her.sqlite')
  let store = new HerStore(path)
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  const daily = store.ensureDailyConversation()
  const intent: UserIntent = { id: 'intent', messageId: 'message', conversationId: daily.id, text: '比较这两家酒店', source: 'user', kind: 'unclassified', spans: [] }
  store.saveUserIntent(intent)
  const service = new DelegationService(store)
  const admission = service.admitIntent(intent, { id: 'proposal', scope, evidenceSpans: [[0, intent.text.length]], revision: 1 })
  const delegation = service.approveScope('proposal', 1)
  return { store, path, intent, service, admission, delegation, reopen: () => { store.close(); store = new HerStore(path); return store } }
}

it('delegation_survives_restart_without_dispatch', () => {
  const f = fixture(), d = f.delegation
  f.store.enqueueInput(d.conversationId, 'compare', null, 'request')
  f.store.createTask({ id: 'run', conversationId: d.conversationId, requestId: 'request', generation: 1, status: 'running', serviceId: 'p', modelId: 'm', configRevision: 1, error: null })
  f.service.attachRun(d.id, 'run')
  let dispatchCount = 0
  const store = f.reopen(), service = new DelegationService(store, { onReady: () => { dispatchCount++ } })
  expect(service.get(d.id)).toMatchObject({ scope, revision: 1, resumeRequired: true })
  expect(store.getDelegationForRun('run')?.id).toBe(d.id)
  expect(dispatchCount).toBe(0)
})

it('cancel_invalidates_authority_but_preserves_history', () => {
  const f = fixture(), d = f.delegation
  f.store.replaceMessageProjection(d.conversationId, [{ entryId: 'history', message: { id: 'm', conversationId: d.conversationId, role: 'user', content: 'history', status: 'complete', createdAt: new Date().toISOString() } }], 'history')
  expect(f.service.cancel(d.id, 1).status).toBe('cancelled')
  expect(() => f.service.resume(d.id, 2)).toThrow()
  expect(() => f.service.revise(d.id, 2, scope)).toThrow()
  expect(f.store.getMessages(d.conversationId)[0].content).toBe('history')
})

it('pause_retains_scope_and_stale_revisions_fail', () => {
  const f = fixture(), d = f.delegation
  expect(f.service.pause(d.id, 1)).toMatchObject({ status: 'paused', scope, revision: 2 })
  expect(() => f.service.cancel(d.id, 1)).toThrow()
  expect(() => f.service.resume(d.id, 2)).toThrow() // No trusted current-object/capability verifier.
  const validated = new DelegationService(f.store, { revalidate: () => true })
  expect(validated.resume(d.id, 2)).toMatchObject({ status: 'active', revision: 3, resumeRequired: false })
  expect(validated.revise(d.id, 3, { ...scope, constraints: { nights: 2 } })).toMatchObject({ revision: 4, resumeRequired: true })
})

it('completion_requires_end_condition_and_current_host_proof', () => {
  const f = fixture(), d = f.delegation
  expect(() => f.service.complete(d.id, 1)).toThrow()
  let proof: CompletionProof | null = { delegationId: d.id, scopeRevision: 99, condition: scope.completion, evidenceId: 'persisted-comparison' }
  const service = new DelegationService(f.store, { validateCompletion: () => proof })
  expect(() => service.complete(d.id, 1)).toThrow()
  proof = { ...proof!, scopeRevision: 1 }
  expect(service.complete(d.id, 1).status).toBe('completed')
  expect(f.store.getDelegationProof(d.id)).toEqual(proof)
  expect(() => service.resume(d.id, 2)).toThrow()
})

it('v1_additions_preserve_existing_data_and_version', () => {
  const f = fixture()
  const db = new DatabaseSync(f.path)
  expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 1 })
  const oldId = f.intent.conversationId
  db.exec('DROP TABLE delegation_runs; DROP TABLE delegation_denials; DROP TABLE delegation_controls; DROP TABLE delegations; DROP TABLE delegation_inputs; DROP TABLE user_intents;')
  db.close()
  expect(f.reopen().getConversation(oldId)?.id).toBe(oldId)
})

it('model_shaped_intent_cannot_call_create_directly', () => {
  const f = fixture()
  expect(() => f.service.create(f.store.getTopicInfo(f.delegation.conversationId)!, { ...f.intent, id: 'forged', kind: 'delegate' }, scope)).toThrow()
})

it('purged_candidate_topic_is_never_recreated_by_repeated_model_proposal', () => {
  const f = fixture(), raw = { ...f.intent, id: 'waiting-intent' }
  f.store.saveUserIntent(raw)
  const candidate = { id: 'waiting-proposal', revision: 1, scope, evidenceSpans: [[0, 4]] as [number, number][] }
  const admission = f.service.admitIntent(raw, candidate)
  f.store.trashConversation(admission.conversationId)
  f.store.permanentlyDeleteConversation(admission.conversationId)
  expect(() => f.service.admitIntent(raw, candidate)).toThrow()
  expect(f.store.getConversation(admission.conversationId)).toBeNull()
})

it('completion_rechecks_host_evidence_and_never_accepts_wrong_condition_or_delegation', () => {
  const f = fixture(), d = f.delegation
  const proofs = [
    { delegationId: 'other', scopeRevision: 1, condition: scope.completion, evidenceId: 'x' },
    { delegationId: d.id, scopeRevision: 1, condition: 'model finished', evidenceId: 'x' },
    { delegationId: d.id, scopeRevision: 1, condition: scope.completion, evidenceId: '' }
  ]
  const service = new DelegationService(f.store, { validateCompletion: () => proofs.shift() ?? null })
  for (let i = 0; i < 4; i++) expect(() => service.complete(d.id, 1)).toThrow()
  expect(service.get(d.id).status).toBe('active')
})

it('task_and_delegation_association_commit_atomically', () => {
  const f = fixture(), d = f.delegation
  f.store.enqueueInput(d.conversationId, 'compare', null, 'atomic-request')
  const db = new DatabaseSync(f.path)
  db.exec("CREATE TRIGGER fail_association BEFORE INSERT ON delegation_runs BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END")
  db.close()
  expect(() => f.store.createTask({ id: 'atomic-run', conversationId: d.conversationId, requestId: 'atomic-request', generation: 1, status: 'running', serviceId: 'p', modelId: 'm', configRevision: 1, error: null },
    { delegationId: d.id, scopeRevision: 1 })).toThrow()
  expect(f.store.getTask('atomic-run')).toBeNull()
})
