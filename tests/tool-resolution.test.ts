import { expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HerStore } from '../src/core/storage/store'
import { ChatService } from '../src/core/conversation/chat'
import { ProfileService } from '../src/core/storage/profiles'
import type { TaskRun } from '../src/shared/types'
function seed(store: HerStore) {
  const conversation = store.createConversation()
  const run: TaskRun = { id: 'original', conversationId: conversation.id, requestId: 'r', assistantMessageId: 'm', providerId: 'p', model: 'm', status: 'stopped', toolCallsCount: 1, activeMs: 0 }
  store.saveTaskRun(run)
  store.saveToolCall({ id: 'call', runId: run.id, name: 'click', arguments: { target: 'e1' }, status: 'unknown', startedAt: '2026-10-15', finishedAt: '2026-10-15', result: { isError: true, content: [] }, assessment: { effect: 'unknown', target: 'browser:b:action', summary: 'Click Send; may reset crashed tab' }, dispatchPhase: 'action' })
  store.saveTaskRun({ ...run, id: 'later', requestId: 'later', assistantMessageId: 'later' })
  return conversation.id
}
it('resolves exact older unknown explicitly, persists separate audit across restart and never rewrites original outcome', () => {
  const dir = mkdtempSync(join(tmpdir(), 'her-resolution-')), path = join(dir, 'db')
  let store = new HerStore(path)
  try {
    const id = seed(store), before = store.listToolCalls('original')[0]
    const pending = store.listUnresolvedToolCalls(id)
    expect(pending).toHaveLength(1); expect(pending[0].runId).toBe('original')
    store.resolveUnknownToolCall({ conversationId: id, ...pending[0], decision: 'handled' })
    expect(store.getUnknownToolTargets(id)).toEqual([])
    expect(store.listToolCalls('original')[0]).toMatchObject({ ...before, status: 'unknown', resolution: { decision: 'handled' } })
    expect(() => store.resolveUnknownToolCall({ conversationId: id, ...pending[0], decision: 'handled' })).toThrow()
    store.close(); store = new HerStore(path)
    expect(store.getUnknownToolTargets(id)).toEqual([])
    expect(store.listToolCalls('original')[0].status).toBe('unknown')
    expect(store.listToolCalls('original')[0].resolution?.decision).toBe('handled')
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})
it('rejects stale token, wrong conversation and nonunknown calls without clearing any target', () => {
  const store = new HerStore(':memory:')
  try {
    const id = seed(store), pending = store.listUnresolvedToolCalls(id)[0], other = store.createConversation()
    for (const change of [{ revision: 'stale' }, { conversationId: other.id }, { callId: 'missing' }]) expect(() => store.resolveUnknownToolCall({ conversationId: id, ...pending, decision: 'abandoned', ...change })).toThrow()
    expect(store.getUnknownToolTargets(id)).toEqual(['browser:b:action'])
    store.saveToolCall({ ...store.listToolCalls('original')[0], result: 'late replacement' })
    expect(() => store.resolveUnknownToolCall({ conversationId: id, ...pending, decision: 'handled' })).toThrow()
  } finally { store.close() }
})
it('exposes older unresolved calls in task state and blocks human resolution during active preparation', async () => {
  const store = new HerStore(':memory:'), id = seed(store), profiles = new ProfileService(store, { encrypt: async text => Buffer.from(text), decrypt: async bytes => bytes.toString() })
  const profile = await profiles.save({ name: 'p', protocol: 'openai', baseUrl: 'http://localhost:1', model: 'm' })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const chat = new ChatService(store, profiles, () => {}, () => '', undefined, undefined, undefined, () => gate)
  const pending = chat.getConversationTask(id)!.unknownCalls![0]
  const sending = chat.send({ requestId: 'active', conversationId: id, profileId: profile.id, content: 'x' }).catch(() => {})
  try {
    expect(() => chat.resolveUnknownToolCall({ conversationId: id, ...pending, decision: 'handled' })).toThrow(/停止|运行|生成/)
    chat.cancelActive(); release(); await sending
    expect(chat.resolveUnknownToolCall({ conversationId: id, ...pending, decision: 'abandoned' })?.unknownCalls).toEqual([])
  } finally { release(); chat.cancelActive(); store.close() }
})

import { SimpleToolRegistry } from '../src/core/tools/registry'
import { TaskExecution } from '../src/core/tools/execution'
import { ToolApprovalService } from '../src/core/tools/approval'
it('requires fresh explicit approval even for a newly observed trusted interaction after human resolution', async () => {
  const store = new HerStore(':memory:'), id = seed(store), pending = store.listUnresolvedToolCalls(id)[0]
  store.resolveUnknownToolCall({ conversationId: id, ...pending, decision: 'handled' })
  const registry = new SimpleToolRegistry(), confirmations: string[] = []
  registry.register({ name: 'interact', description: 'x', parameters: {} }, async () => ({ content: [] }), { assess: async () => ({ effect: 'interact', target: 'browser:b:action', observationId: 'fresh', summary: 'new exact action' }), validateObservation: () => true })
  const approval = new ToolApprovalService(a => { confirmations.push(a.summary); approval.decide({ approvalId: a.id, revision: a.revision, decision: 'approve' }) })
  const run: TaskRun = { id: 'new', requestId: 'new', conversationId: id, assistantMessageId: 'n', status: 'running', providerId: 'p', model: 'm', toolCallsCount: 0, activeMs: 0 }
  const task = new TaskExecution(run, store, registry, approval, new AbortController().signal, () => {})
  try {
    await task.execute(task.prepare({ id: 'call', name: 'interact', arguments: {} }))
    expect(confirmations).toEqual(['new exact action'])
    expect(store.listToolCalls('original')[0].status).toBe('unknown')
  } finally { task.finish('completed'); store.close() }
})
it('sends the human resolution as additional Host context without altering the original stored tool error', async () => {
  const store = new HerStore(':memory:'), id = seed(store), original = store.listToolCalls('original')[0]
  store.addMessage({ id: 'user', conversationId: id, role: 'user', content: 'Handle this task', status: 'complete', createdAt: '2026-10-15' })
  store.addMessage({ id: 'later', conversationId: id, role: 'assistant', content: 'unknown', status: 'cancelled', createdAt: '2026-10-15', toolCalls: [original] })
  const profiles = new ProfileService(store, { encrypt: async text => Buffer.from(text), decrypt: async bytes => bytes.toString() })
  const profile = await profiles.save({ name: 'p', protocol: 'openai', baseUrl: 'http://localhost:1', model: 'm' })
  let text = '', done!: () => void
  const finished = new Promise<void>(resolve => { done = resolve })
  const chat = new ChatService(store, profiles, event => { if (event.done) done() }, () => '', async function* (input) {
    text = JSON.stringify(input.messages); yield { type: 'text', text: 'Continue with fresh observation and approval' }; yield { type: 'done' }
  })
  try {
    chat.resolveUnknownToolCall({ conversationId: id, ...store.listUnresolvedToolCalls(id)[0], decision: 'abandoned' })
    await chat.continueTask({ runId: 'later', requestId: 'new', profileId: profile.id }); await finished
    expect(text).toContain('用户已放弃'); expect(text).toContain('不得重放')
    expect(store.listToolCalls('original')[0].result).toEqual(original.result)
  } finally { chat.shutdown(); store.close() }
})

import { DatabaseSync } from 'node:sqlite'
it('migrates v7 unknown history intact and preserves crash phase semantics across v8 reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'her-v7-')), path = join(dir, 'db')
  let store = new HerStore(path)
  try {
    const id = seed(store); store.close()
    const db = new DatabaseSync(path)
    db.exec('DROP TABLE artifact_owners; DROP TABLE document_owners; DROP TABLE documents; DROP TABLE file_references; DROP TABLE file_grants; ALTER TABLE messages DROP COLUMN files; ALTER TABLE messages DROP COLUMN file_sources; DROP TABLE tool_resolutions; ALTER TABLE tool_executions DROP COLUMN dispatch_phase; PRAGMA user_version=7;'); db.close()
    store = new HerStore(path)
    expect(store.listToolCalls('original')[0]).toMatchObject({ status: 'unknown', arguments: { target: 'e1' } })
    store.saveToolCall({ id: 'inflight', runId: 'original', name: 'click', arguments: {}, status: 'running', dispatchPhase: 'preflight', assessment: { effect: 'unknown', target: 'browser:x:action', summary: 'reset' } })
    store.saveToolCall({ id: 'completed-preflight', runId: 'original', name: 'click', arguments: {}, status: 'pending', dispatchPhase: 'preflight-completed', assessment: { effect: 'unknown', target: 'browser:y:action', summary: 'not sent' } })
    store.close(); store = new HerStore(path)
    expect(store.listToolCalls('original').find(call => call.id === 'inflight')).toMatchObject({ status: 'unknown', dispatchPhase: 'preflight' })
    expect(store.listToolCalls('original').find(call => call.id === 'completed-preflight')).toMatchObject({ status: 'cancelled', dispatchPhase: 'preflight-completed' })
    expect(store.getUnknownToolTargets(id)).not.toContain('browser:y:action')
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})
