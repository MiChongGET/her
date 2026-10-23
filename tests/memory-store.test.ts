import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { HerStore } from '../src/core/storage/store'
import { dataPaths } from '../src/core/storage/paths'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { FileAccessService } from '../src/core/files/access'
import { indexBranch, toFileSources } from '../src/core/agent/sources'
import type { MemoryRecord, MemorySourceRef } from '../src/shared/types'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach(clean => clean()))

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'her-memory-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const path = dataPaths(root).database
  const store = new HerStore(path)
  cleanups.push(() => store.close())
  const daily = store.ensureDailyConversation()
  store.createWorkConversation('work', 'work-session', 'Work')
  return { root, path, store, daily }
}

it('stores_scoped_memory_without_old_database', () => {
  const f = setup()
  const oldDb = join(f.root, 'her.sqlite'), oldSession = join(f.root, 'old.jsonl')
  writeFileSync(oldDb, 'old database must never be opened')
  writeFileSync(oldSession, 'old history must never be parsed')
  const memory = { id: 'm', content: 'new preference', revision: 1, scope: { kind: 'personal' as const }, status: 'active' as const,
    sources: [{ kind: 'pi-entry' as const, id: 'entry', revision: 1, conversationId: f.daily.id, sessionId: f.daily.piSessionId, entryId: 'entry' }], validFrom: '2026-10-23T00:00:00Z' }
  f.store.saveMemory(memory, null)
  const reopened = new HerStore(f.path); cleanups.push(() => reopened.close())
  expect(reopened.getMemory('m')).toEqual(memory)
  const db = new DatabaseSync(f.path); cleanups.push(() => db.close())
  expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 1 })
  expect(readFileSync(oldDb, 'utf8')).toBe('old database must never be opened')
  expect(readFileSync(oldSession, 'utf8')).toBe('old history must never be parsed')
  const otherPath = join(f.root, 'unsupported.sqlite'), other = new DatabaseSync(otherPath)
  other.exec('PRAGMA user_version = 2'); other.close()
  expect(() => new HerStore(otherPath)).toThrow('不支持的数据库版本 2')
})

it('baseline_is_insert_only_and_survives_reopen', () => {
  const f = setup()
  f.store.saveMemoryBaseline({ conversationId: 'work', sessionId: 'work-session', entryIds: ['old-entry'] })
  expect(() => f.store.saveMemoryBaseline({ conversationId: 'work', sessionId: 'work-session', entryIds: [] })).toThrow()
  const reopened = new HerStore(f.path); cleanups.push(() => reopened.close())
  expect(reopened.getMemoryBaseline('work', 'work-session')).toEqual({ conversationId: 'work', sessionId: 'work-session', entryIds: ['old-entry'] })
})

async function fixture() {
  const f = setup(), files = new FileAccessService(f.store)
  const managers = new Map([f.daily.id, 'work'].map(id => [id, SessionManager.inMemory(f.root)]))
  const db = new DatabaseSync(f.path); cleanups.push(() => db.close())
  for (const [id, manager] of managers) db.prepare('UPDATE conversations SET pi_session_id = ? WHERE id = ?').run(manager.getSessionId(), id)
  const resolve = (ref: MemorySourceRef) => {
    const manager = managers.get(ref.conversationId), entry = ref.entryId && manager?.getEntry(ref.entryId)
    if (!manager || !entry || entry.type !== 'message') return null
    const deps = indexBranch(manager.getBranch(entry.id))
    const message = entry.message as { role: string; timestamp: number; toolCallId?: string }
    const key = `${message.role}:${message.timestamp}:${message.role === 'toolResult' ? message.toolCallId : ''}`
    return { ref: { kind: 'pi-entry' as const, id: entry.id, revision: 1, conversationId: ref.conversationId, sessionId: manager.getSessionId(), entryId: entry.id },
      dependencies: { memorySources: [], fileSources: toFileSources(deps.derived.get(key) ?? []) } }
  }
  const { MemoryService } = await import('../src/core/memory/service')
  const service = new MemoryService(f.store, files, resolve)
  function baseline(id: string) {
    const manager = managers.get(id)!
    f.store.saveMemoryBaseline({ conversationId: id, sessionId: manager.getSessionId(), entryIds: manager.getEntries().map(entry => entry.id) })
  }
  function entry(id: string, fileSources = {}) {
    const manager = managers.get(id)!
    manager.appendCustomEntry('her.run', { fileSources })
    const entryId = manager.appendMessage({ role: 'user', content: 'same text', timestamp: Date.now() })
    const ref: MemorySourceRef = { kind: 'pi-entry', id: entryId, revision: 1, conversationId: id, sessionId: manager.getSessionId(), entryId }
    f.store.saveMemorySource(ref, resolve(ref)!.dependencies, f.store.getTopicInfo(id)!.shareRevision)
    return ref
  }
  function memory(id: string, source: MemorySourceRef, scope: MemoryRecord['scope'] = { kind: 'work', conversationId: 'work' }) {
    const record: MemoryRecord = { id, content: 'same text', revision: 1, scope, status: 'active', sources: [source], validFrom: '2026-10-23T00:00:00Z' }
    f.store.saveMemory(record, null)
    return { kind: 'memory' as const, id, revision: 1, conversationId: scope.kind === 'work' ? scope.conversationId : f.daily.id }
  }
  function progress(id: string, source: MemorySourceRef) {
    f.store.saveProgressSummary({ id, revision: 1, conversationId: 'work', summary: 'brief progress', sources: [source], expectedShareRevision: 1 }, null)
    return { kind: 'progress' as const, id, revision: 1, conversationId: 'work' }
  }
  const share = (enabled: boolean) => db.prepare('UPDATE conversation_topics SET share_progress = ?, share_revision = share_revision + 1 WHERE conversation_id = ?').run(Number(enabled), 'work')
  return { ...f, db, files, managers, resolve, service, baseline, entry, memory, progress, share }
}

it('same_text_different_sources_keeps_scope', async () => {
  const f = await fixture(); f.baseline(f.daily.id); f.baseline('work')
  const personal = f.entry(f.daily.id), work = f.entry('work')
  f.memory('personal', personal, { kind: 'personal' }); f.memory('work-memory', work)
  f.memory('promotion', work, { kind: 'personal' })
  expect(f.service.listMemories({ kind: 'personal' }).map(x => x.id)).toEqual(['personal'])
  expect(f.service.listMemories({ kind: 'work', conversationId: 'work' }).map(x => x.id)).toEqual(['work-memory'])
  expect(f.service.getSources('personal')).toEqual([personal])
  expect(f.service.getSources('missing')).toEqual([])
})

it('sharing_off_is_denied_from_first_read', async () => {
  const f = await fixture(); f.baseline('work'); f.share(false)
  const ref = f.entry('work'), mem = f.memory('m', ref)
  expect(f.service.isUsable([ref], 'work')).toBe(true)
  expect(f.service.isUsable([ref], f.daily.id)).toBe(false)
  expect(f.service.isUsable([mem], f.daily.id)).toBe(false)
  expect(f.service.listMemories({ kind: 'work', conversationId: 'work' })).toHaveLength(1)
  expect(() => f.progress('p', ref)).toThrow()
})

it('only_progress_crosses_to_daily_and_share_revision_never_revives_old_progress', async () => {
  const f = await fixture(); f.baseline('work')
  const ref = f.entry('work'), mem = f.memory('m', ref), progress = f.progress('p', mem)
  expect(f.service.isUsable([ref], f.daily.id)).toBe(false)
  expect(f.service.isUsable([mem], f.daily.id)).toBe(false)
  expect(f.service.isUsable([progress], f.daily.id)).toBe(true)
  f.share(false)
  expect(f.service.isUsable([progress], f.daily.id)).toBe(false)
  expect(f.service.isUsable([mem], 'work')).toBe(true)
  f.share(true)
  expect(f.service.isUsable([progress], f.daily.id)).toBe(false)
})

it.each(['revoke', 'change', 'remove'] as const)('entry_exists_but_file_grant_revoked: %s', async action => {
  const f = await fixture(); f.baseline('work')
  const path = join(f.root, 'source.txt'); writeFileSync(path, 'original')
  const [grant] = await f.files.grant([path], { kind: 'file', scope: 'conversation', conversationId: 'work' })
  const context = { conversationId: 'work', runId: 'run', callId: 'call', signal: new AbortController().signal }
  const file = await f.files.reference(grant.id, '', context)
  const ref = f.entry('work', { fileIds: [file.id], grants: [{ id: grant.id, revision: 1 }] })
  const mem = f.memory('m', ref), progress = f.progress('p', mem)
  expect(f.service.isUsable([mem], 'work')).toBe(true)
  expect(f.service.isUsable([progress], f.daily.id)).toBe(true)
  expect(() => f.files.validateSources({ fileIds: [file.id] }, { ...context, conversationId: f.daily.id })).toThrow()
  if (action === 'revoke') await f.files.revoke(grant.id)
  else if (action === 'change') writeFileSync(path, 'changed bytes')
  else rmSync(path)
  expect(f.managers.get('work')!.getEntry(ref.entryId!)).toBeDefined()
  expect(f.service.isUsable([mem], 'work')).toBe(false)
  expect(f.service.isUsable([progress], f.daily.id)).toBe(false)
})

it('baseline_denies_existing_ids_missing_baselines_and_legacy_topics', async () => {
  const f = await fixture(), old = f.entry('work')
  expect(f.service.isUsable([old], 'work')).toBe(false)
  f.baseline('work')
  expect(f.service.isUsable([old], 'work')).toBe(false)
  const fresh = f.entry('work')
  expect(f.service.isUsable([fresh], 'work')).toBe(true)
  f.store.createConversation('legacy', 'legacy-session', 'Legacy')
  expect(f.service.isUsable([{ ...fresh, conversationId: 'legacy' }], f.daily.id)).toBe(false)
  expect(f.store.getTopicInfo('work')).toMatchObject({ shareProgress: true, shareRevision: 1 })
})

it('missing_cycle_revision_exclusion_and_trashed_ancestors_fail_closed', async () => {
  const f = await fixture(); f.baseline('work')
  const ref = f.entry('work'), mem = f.memory('m', ref)
  expect(f.service.isUsable([], 'work')).toBe(false)
  expect(f.service.isUsable([{ ...mem, id: 'missing' }], 'work')).toBe(false)
  expect(f.service.isUsable([{ ...mem, revision: 2 }], 'work')).toBe(false)
  expect(f.service.isUsable([{ ...ref, sessionId: 'forged' }], 'work')).toBe(false)
  expect(f.service.isUsable([{ ...ref, id: 'forged' }], 'work')).toBe(false)
  const cycle: MemorySourceRef = { kind: 'memory', id: 'cycle', revision: 1, conversationId: 'work' }
  f.memory('cycle', cycle)
  expect(f.service.isUsable([cycle], 'work')).toBe(false)
  f.store.excludeMemorySource(ref)
  expect(f.service.isUsable([mem], 'work')).toBe(false)
  const next = f.entry('work'), nextMem = f.memory('next', next)
  f.store.trashConversation('work')
  expect(f.service.isUsable([nextMem], 'work')).toBe(false)
  expect(f.service.isUsable([nextMem], f.daily.id)).toBe(false)
})

it('memory_CAS_retains_superseded_content_and_atomic_sources_exclusion', async () => {
  const f = await fixture(); f.baseline('work')
  const ref = f.entry('work'); f.memory('m', ref)
  const previous = f.store.getMemory('m')!, next = f.entry('work')
  expect(() => f.store.saveMemory({ ...previous, revision: 2, content: 'stale', sources: [next], status: 'excluded' }, 0)).toThrow()
  expect(f.store.getMemory('m')).toEqual(previous)
  expect(f.service.getSources('m')).toEqual([ref])
  f.store.saveMemory({ ...previous, revision: 2, content: 'corrected', sources: [next], validFrom: '2026-10-24T00:00:00Z' }, 1)
  expect(f.store.getMemoryVersion('m', 1)).toMatchObject({ content: 'same text', status: 'superseded', validUntil: '2026-10-24T00:00:00Z', sources: [ref] })
  expect(f.service.getSources('m')).toEqual([next])
  expect(f.service.isUsable([{ kind: 'memory', id: 'm', revision: 1, conversationId: 'work' }], 'work')).toBe(false)
  f.store.saveMemory({ ...f.store.getMemory('m')!, revision: 3, status: 'excluded' }, 2)
  expect(f.service.listMemories({ kind: 'work', conversationId: 'work' })).toEqual([])
})

it('source_dependencies_are_immutable_and_missing_live_or_stored_dependencies_deny', async () => {
  const f = await fixture(); f.baseline('work')
  const ref = f.entry('work')
  expect(() => f.store.saveMemorySource(ref, { memorySources: [{ ...ref, id: 'missing' }], fileSources: {} }, 1)).toThrow()
  const { MemoryService } = await import('../src/core/memory/service')
  expect(new MemoryService(f.store, f.files).isUsable([ref], 'work')).toBe(false)
  expect(new MemoryService(f.store, f.files, () => null).isUsable([ref], 'work')).toBe(false)
  const withMissing = new MemoryService(f.store, f.files, source => {
    const resolved = f.resolve(source)!
    return { ...resolved, dependencies: { memorySources: [{ ...ref, id: 'missing', entryId: 'missing' }], fileSources: {} } }
  })
  expect(withMissing.isUsable([ref], 'work')).toBe(false)
})

it('existing_v1_gains_only_additive_tables_and_keeps_topics', () => {
  const f = setup(), db = new DatabaseSync(f.path)
  for (const table of ['memories', 'memory_sources', 'memory_dependencies', 'memory_exclusions', 'memory_baselines', 'progress_summaries']) db.exec(`DROP TABLE ${table}`)
  db.close()
  const reopened = new HerStore(f.path); cleanups.push(() => reopened.close())
  expect(reopened.getTopicInfo('work')).toMatchObject({ kind: 'work', shareProgress: true, shareRevision: 1 })
  expect(reopened.getMemory('missing')).toBeNull()
  expect(reopened.getMemoryBaseline('work', 'work-session')).toBeNull()
  expect(reopened.getProgressSummary('missing')).toBeNull()
})

it('failed_edge_write_rolls_back_content_revision_source_and_exclusion_together', async () => {
  const f = await fixture(); f.baseline('work')
  const source = f.entry('work'), ref = f.memory('m', source), old = f.store.getMemory('m')!
  f.db.exec("CREATE TRIGGER reject_memory_edge BEFORE INSERT ON memory_sources BEGIN SELECT RAISE(ABORT, 'edge failed'); END")
  expect(() => f.store.saveMemory({ ...old, content: 'discard me', revision: 2, status: 'excluded' }, 1)).toThrow('edge failed')
  expect(f.store.getMemory('m')).toEqual(old)
  expect(f.store.getMemoryVersion('m', 1)?.status).toBe('active')
  expect(f.store.getMemorySource({ ...ref, revision: 2 })).toBeNull()
  expect(f.store.isMemorySourceExcluded(ref)).toBe(false)
  expect(f.service.getSources('m')).toEqual([source])
  expect(f.service.isUsable([ref], 'work')).toBe(true)
})

it('persisted_dependencies_remain_required_even_when_live_resolver_omits_them', async () => {
  const f = await fixture(); f.baseline('work')
  const path = join(f.root, 'source.txt'); writeFileSync(path, 'original')
  const [grant] = await f.files.grant([path], { kind: 'file', scope: 'conversation', conversationId: 'work' })
  const ref = f.entry('work', { grants: [{ id: grant.id, revision: 1 }] })
  const { MemoryService } = await import('../src/core/memory/service')
  const service = new MemoryService(f.store, f.files, source => ({ ...f.resolve(source)!, dependencies: { memorySources: [], fileSources: {} } }))
  expect(service.isUsable([ref], 'work')).toBe(true)
  await f.files.revoke(grant.id)
  expect(service.isUsable([ref], 'work')).toBe(false)
})

it('missing_persisted_dependency_and_changed_Pi_identity_fail_closed_after_reopen', async () => {
  const f = await fixture(); f.baseline('work')
  const ref = f.entry('work'), memory = f.memory('m', ref)
  const reopened = new HerStore(f.path); cleanups.push(() => reopened.close())
  const { MemoryService } = await import('../src/core/memory/service')
  const service = new MemoryService(reopened, new FileAccessService(reopened), f.resolve)
  expect(service.isUsable([memory], 'work')).toBe(true)
  f.db.prepare('DELETE FROM memory_dependencies WHERE json_extract(data, \'$.ref.kind\') = ?').run('pi-entry')
  expect(service.isUsable([memory], 'work')).toBe(false)
  f.store.saveMemorySource(ref, f.resolve(ref)!.dependencies, 1)
  f.managers.set('work', SessionManager.inMemory(f.root))
  expect(service.isUsable([memory], 'work')).toBe(false)
})

it('progress_revision_and_source_exclusion_invalidate_all_descendants', async () => {
  const f = await fixture(); f.baseline('work')
  const ref = f.entry('work'), progress = f.progress('p', ref), next = f.entry('work')
  const old = f.store.getProgressSummary('p')!
  expect(() => f.store.saveProgressSummary({ ...old, revision: 2, sources: [next] }, 0)).toThrow()
  expect(f.store.getProgressSummary('p')).toEqual(old)
  f.store.saveProgressSummary({ ...old, revision: 2, sources: [next] }, 1)
  expect(f.service.isUsable([progress], f.daily.id)).toBe(false)
  expect(f.service.isUsable([{ ...progress, revision: 2 }], f.daily.id)).toBe(true)
  f.store.excludeMemorySource(next)
  const reopened = new HerStore(f.path); cleanups.push(() => reopened.close())
  const { MemoryService } = await import('../src/core/memory/service')
  expect(new MemoryService(reopened, new FileAccessService(reopened), f.resolve).isUsable([{ ...progress, revision: 2 }], f.daily.id)).toBe(false)
})
