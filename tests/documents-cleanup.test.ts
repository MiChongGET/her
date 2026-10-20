import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { HerStore } from '../src/core/storage/store'
import { DocumentCache } from '../src/core/documents/cache'
import { DocumentService } from '../src/core/documents/service'
import { FileAccessService } from '../src/core/files/access'
import { createShutdown } from '../src/main/shutdown'
const cleanup: (() => void)[] = []
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); cleanup.splice(0).reverse().forEach(fn => fn()) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'her-doc-cleanup-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'store.sqlite'); let store = new HerStore(path); let closed = false
  cleanup.push(() => { if (!closed) store.close() })
  const context = { conversationId: (() => { const id = randomUUID(); store.createConversation(id, randomUUID(), 't'); return id })(), runId: 'r', callId: 'c', signal: new AbortController().signal }
  const original = join(root, 'original.docx'); await writeFile(original, 'original bytes')
  const lifetime = new AbortController(); const files = new FileAccessService(store, lifetime.signal)
  const [grant] = await files.grant([original], { scope: 'conversation', kind: 'file', conversationId: context.conversationId })
  const file = await files.reference(grant.id, '', context)
  const cache = new DocumentCache(store.documentDirectory)
  return { root, path, get store() { return store }, context, original, lifetime, files, file, cache,
    reopen: () => { store.close(); store = new HerStore(path); return store }, close: () => { store.close(); closed = true } }
}
it('recovers staged originals and unpublished text after reopen; purge preserves other owners and source', async () => {
  const f = await setup(); const id = randomUUID()
  f.store.beginDocumentFiles(id, f.context.conversationId)
  const staged = await f.cache.stage(id, Buffer.from('staged original'), '.docx')
  await f.cache.write(id, 'unpublished text')
  expect(await readFile(staged, 'utf8')).toBe('staged original')
  const other = (() => { const id = randomUUID(); f.store.createConversation(id, randomUUID(), 't'); return id })(), otherId = randomUUID()
  f.store.beginDocumentFiles(otherId, other)
  await f.cache.write(otherId, 'other owned text')
  // Simulate an already published cache without affecting this interrupted owner's state.
  f.store.saveFileReference({ reference: { ...f.file, id: 'other-file' }, conversationId: other, path: f.original, grantRevision: 1 })
  f.store.saveDocument({ reference: { id: otherId, fileId: 'other-file', version: f.file.version, parserVersion: 'test', status: 'ready' }, conversationId: other, cacheKey: 'other' })
  f.reopen()
  expect(existsSync(staged)).toBe(false); expect(await f.cache.read(id)).toBeUndefined()
  expect(f.store.listDocumentOwners(f.context.conversationId)).toEqual([])
  f.store.trashConversation(f.context.conversationId); f.store.purgeConversation(f.context.conversationId)
  expect(await f.cache.read(otherId)).toBe('other owned text'); expect(await readFile(f.original, 'utf8')).toBe('original bytes')
})
it('failed unlink retains durable owner and trash for retry, including recovery of unpublished files', async () => {
  const f = await setup(); const id = randomUUID()
  f.store.beginDocumentFiles(id, f.context.conversationId)
  const stage = await f.cache.stage(id, Buffer.from('staged original'), '.docx')
  // A directory at the cache filename produces a real non-ENOENT unlink error.
  await mkdir(join(f.store.documentDirectory, id + '.json'))
  await writeFile(join(f.store.documentDirectory, id + '.json', 'owned'), 'unpublished text')
  f.reopen()
  expect(f.store.documentCleanupWarning).toMatch(/重试/)
  expect(f.store.listDocumentOwners(f.context.conversationId)).toHaveLength(1)
  expect(existsSync(stage)).toBe(true)
  f.store.trashConversation(f.context.conversationId)
  expect(() => f.store.purgeConversation(f.context.conversationId)).toThrow(/文档.*清理.*重试/)
  expect(f.store.listTrashedConversations().some(c => c.id === f.context.conversationId)).toBe(true)
  expect(f.store.listDocumentOwners(f.context.conversationId)).toHaveLength(1)
  await expect(f.cache.remove(id)).rejects.toThrow(/清理.*重试/)
  await rm(join(f.store.documentDirectory, id + '.json'), { recursive: true })
  f.store.purgeConversation(f.context.conversationId)
  expect(f.store.listDocumentOwners(f.context.conversationId)).toHaveLength(1); expect(existsSync(stage)).toBe(false)
  f.reopen(); expect(f.store.listDocumentOwners(f.context.conversationId)).toEqual([])
  expect(await readFile(f.original, 'utf8')).toBe('original bytes')
})
it.each([false, true])('shutdown drains delayed cleanup; pastDeadline=%s never touches a closed database', async pastDeadline => {
  const f = await setup(); let started!: () => void, release!: () => void, parsing!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const parseEntered = new Promise<void>(resolve => { parsing = resolve })
  const service = new DocumentService(f.store, f.files, () => ({ version: 'test', configuration: '1', validate: () => {}, convert: async () => { parsing(); return new Promise<string>(() => {}) } }))
  const actual = DocumentCache.prototype.removeStaging
  vi.spyOn(DocumentCache.prototype, 'removeStaging').mockImplementation(async function (this: DocumentCache, id) { started(); await gate; return actual.call(this, id) })
  const execution = service.extract(f.file.id, f.context).then(() => 'published', () => 'cancelled')
  await parseEntered
  const databaseCalls = (['saveDocument', 'forgetDocumentFiles', 'hasConversation', 'getFileReference', 'getFileGrant', 'findDocument', 'getDocument'] as const).map(name => vi.spyOn(f.store, name))
  const closed = vi.fn(() => f.close())
  vi.useFakeTimers()
  const shutdown = createShutdown({ lifetime: f.lifetime, stop: () => {}, drain: () => service.shutdown(), forceClose: () => {}, close: closed })
  const quitting = shutdown(); await entered
  expect(closed).not.toHaveBeenCalled()
  if (pastDeadline) { await vi.advanceTimersByTimeAsync(5000); await quitting; expect(closed).toHaveBeenCalledOnce() }
  release(); vi.useRealTimers()
  await quitting; expect(await execution).toBe('cancelled'); await service.shutdown()
  expect(closed).toHaveBeenCalledOnce(); databaseCalls.forEach(call => expect(call).not.toHaveBeenCalled())
  expect(await readdir(join(f.cache.directory, 'staging'))).toEqual([])
  const reopened = new HerStore(f.path)
  expect(reopened.listDocumentOwners(f.context.conversationId)).toEqual([]); reopened.close()
})
it('purge retains unfinished ownership when an admitted staging write completes late and cleanup fails', async () => {
  const f = await setup(); let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const actualStage = DocumentCache.prototype.stage
  vi.spyOn(DocumentCache.prototype, 'stage').mockImplementation(async function (this: DocumentCache, id, bytes, extension) {
    entered(); await gate; return actualStage.call(this, id, bytes, extension)
  })
  vi.spyOn(DocumentCache.prototype, 'remove').mockRejectedValue(new Error('simulated cleanup failure'))
  const service = new DocumentService(f.store, f.files, () => ({ version: 'test', configuration: '1', validate: () => {}, convert: async () => 'text' }))
  const operation = service.extract(f.file.id, f.context).then(() => false, () => true)
  await started
  const owner = f.store.listDocumentOwners(f.context.conversationId)[0]
  f.store.trashConversation(f.context.conversationId); f.store.purgeConversation(f.context.conversationId)
  release(); expect(await operation).toBe(true)
  expect(await readFile(join(f.cache.directory, 'staging', owner.id, 'source.docx'), 'utf8')).toBe('original bytes')
  expect(f.store.listDocumentOwners(f.context.conversationId)).toHaveLength(1)
  vi.restoreAllMocks(); f.reopen()
  expect(existsSync(join(f.cache.directory, 'staging', owner.id))).toBe(false)
  expect(f.store.listDocumentOwners(f.context.conversationId)).toEqual([])
  expect(await readFile(f.original, 'utf8')).toBe('original bytes')
})

import { DatabaseSync } from 'node:sqlite'
it('a SQL rollback preserves ownership/history while an evicted cache can regenerate from authorized source', async () => {
  const f = await setup()
  const convert = vi.fn(async () => 'published text')
  const service = new DocumentService(f.store, f.files, () => ({ version: 'test', configuration: '1', validate: () => {}, convert }))
  const reference = await service.extract(f.file.id, f.context)
  f.store.trashConversation(f.context.conversationId)
  const raw = new DatabaseSync(f.path)
  raw.exec("CREATE TRIGGER fail_purge BEFORE DELETE ON conversations BEGIN SELECT RAISE(ABORT, 'injected SQL failure'); END;")
  expect(() => f.store.purgeConversation(f.context.conversationId)).toThrow('injected SQL failure')
  expect(f.store.listTrashedConversations().some(c => c.id === f.context.conversationId)).toBe(true)
  expect(f.store.listDocumentOwners(f.context.conversationId)).toEqual([{ id: reference.id, published: 1 }])
  expect(await f.cache.read(reference.id)).toBeUndefined()
  raw.exec('DROP TRIGGER fail_purge'); raw.close()
  f.store.restoreConversation(f.context.conversationId)
  expect((await service.read(reference.id, {}, f.context)).text).toBe('published text'); expect(convert).toHaveBeenCalledTimes(2)
  expect(await readFile(f.original, 'utf8')).toBe('original bytes')
})
