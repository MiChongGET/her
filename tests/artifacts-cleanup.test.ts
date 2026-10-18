import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { HerStore } from '../src/core/storage/store'
import { ToolArtifactStore } from '../src/core/tools/artifacts'
import { createShutdown } from '../src/main/shutdown'

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }))
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))

const cleanup: (() => void)[] = []
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); cleanup.splice(0).reverse().forEach(fn => fn()) })
function setup() {
  const root = fs.mkdtempSync(join(tmpdir(), 'her-artifact-cleanup-'))
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'store.sqlite'); let store = new HerStore(path); let closed = false
  cleanup.push(() => { if (!closed) store.close() })
  const conversationId = store.createConversation().id
  const lifetime = new AbortController()
  const context = { conversationId, runId: 'r', callId: 'c', signal: new AbortController().signal }
  return { root, path, conversationId, lifetime, context, get store() { return store },
    artifacts: new ToolArtifactStore(store, lifetime.signal),
    reopen: () => { store.close(); store = new HerStore(path); return store },
    close: () => { store.close(); closed = true } }
}
const denied = (path: unknown) => Object.assign(new Error(`EACCES synthetic private path: ${String(path)}`), { code: 'EACCES' })
function gate() {
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const waiting = new Promise<void>(resolve => { release = resolve })
  return { entered, release, started, waiting }
}

it('EACCES during multi-conversation purge retains trash and durable owners for retry while other images stay readable', async () => {
  const f = setup(), second = f.store.createConversation().id, other = f.store.createConversation().id
  const firstImage = await f.artifacts.put(new Uint8Array([1]), { conversationId: f.conversationId }, 'image/png')
  const secondImage = await f.artifacts.put(new Uint8Array([2]), { conversationId: second }, 'image/png')
  const otherImage = await f.artifacts.put(new Uint8Array([3]), { conversationId: other }, 'image/png')
  f.store.trashConversation(f.conversationId); f.store.trashConversation(second)
  const actual = fs.unlinkSync
  vi.spyOn(fs, 'unlinkSync').mockImplementation(path => { if (String(path).endsWith(secondImage.id)) throw denied(path); actual(path) })
  let error: unknown
  try { f.store.purgeConversations([f.conversationId, second]) } catch (cause) { error = cause }
  expect(f.store.listTrashedConversations().map(c => c.id).sort()).toEqual([f.conversationId, second].sort())
  expect(String(error)).toMatch(/图片.*清理.*重试/)
  expect(String(error)).not.toContain(f.root)
  expect(f.store.getArtifact(secondImage.id)).toEqual(secondImage)
  expect(f.store.listArtifactOwners(second)).toEqual([{ id: secondImage.id, published: 1 }])
  expect(f.store.listArtifactOwners(f.conversationId)).toEqual([{ id: firstImage.id, published: 1 }])
  expect(fs.existsSync(join(f.store.artifactDirectory, firstImage.id))).toBe(false)
  f.store.restoreConversation(f.conversationId)
  await expect(f.artifacts.read(firstImage.id, f.context)).rejects.toThrow(/缺失/)
  f.store.trashConversation(f.conversationId)
  expect(await f.artifacts.read(otherImage.id, { ...f.context, conversationId: other })).toEqual(new Uint8Array([3]))
  vi.restoreAllMocks(); f.reopen()
  f.store.purgeConversations([f.conversationId, second])
  expect(f.store.listTrashedConversations()).toEqual([])
  expect(f.store.listArtifactOwners(second)).toEqual([])
  expect(fs.existsSync(join(f.store.artifactDirectory, secondImage.id))).toBe(false)
  expect(await new ToolArtifactStore(f.store).read(otherImage.id, { ...f.context, conversationId: other })).toEqual(new Uint8Array([3]))
})

it('reopen cleans only explicit unfinished owners and retains actionable failed owners for a later retry', async () => {
  const f = setup(), id = randomUUID(), blocked = randomUUID()
  f.store.beginArtifactFiles(id, f.conversationId); f.store.beginArtifactFiles(blocked, f.conversationId)
  await fsp.mkdir(f.store.artifactDirectory)
  await fsp.writeFile(join(f.store.artifactDirectory, id), 'partial')
  await fsp.writeFile(join(f.store.artifactDirectory, blocked), 'partial blocked')
  await fsp.writeFile(join(f.store.artifactDirectory, 'anonymous'), 'unassignable')
  const actual = fs.unlinkSync; let attempts = 0
  vi.spyOn(fs, 'unlinkSync').mockImplementation(path => { if (String(path).endsWith(blocked)) { attempts++; throw denied(path) }; actual(path) })
  f.reopen()
  expect(attempts).toBe(1)
  expect(f.store.artifactCleanupWarning).toMatch(/图片.*清理.*重试/)
  expect(f.store.artifactCleanupWarning).not.toContain(f.root)
  expect(f.store.listArtifactOwners(f.conversationId)).toEqual([{ id: blocked, published: 0 }])
  expect(fs.existsSync(join(f.store.artifactDirectory, id))).toBe(false)
  vi.restoreAllMocks(); f.reopen()
  expect(f.store.listArtifactOwners(f.conversationId)).toEqual([])
  expect(await fsp.readFile(join(f.store.artifactDirectory, 'anonymous'), 'utf8')).toBe('unassignable')
})

it('records ownership before mkdir and preserves failed partial writes when cleanup also fails', async () => {
  const f = setup(), actualMkdir = fsp.mkdir, actualWrite = fsp.writeFile
  let beforeMkdir = false
  vi.spyOn(fsp, 'mkdir').mockImplementation(async (...args: Parameters<typeof fsp.mkdir>) => {
    beforeMkdir = f.store.listArtifactOwners(f.conversationId).length === 1
    return actualMkdir(...args)
  })
  vi.spyOn(fsp, 'writeFile').mockImplementation(async (path, data, options) => { await actualWrite(path, data, options); throw denied(path) })
  vi.spyOn(fsp, 'unlink').mockImplementation(async path => { throw denied(path) })
  const error = await f.artifacts.put(new Uint8Array([7]), { conversationId: f.conversationId }, 'image/png').catch(error => error)
  expect(beforeMkdir).toBe(true)
  expect(String(error)).toMatch(/图片.*清理.*重试/); expect(String(error)).not.toContain(f.root)
  const owner = f.store.listArtifactOwners(f.conversationId)[0]
  expect(owner.published).toBe(0); expect(f.store.getArtifact(owner.id)).toBeNull()
  expect(await fsp.readFile(join(f.store.artifactDirectory, owner.id))).toEqual(Buffer.from([7]))
  vi.restoreAllMocks(); f.reopen()
  expect(f.store.listArtifactOwners(f.conversationId)).toEqual([])
  expect(fs.existsSync(join(f.store.artifactDirectory, owner.id))).toBe(false)
})

it('failed write with successful cleanup releases ownership and reports a path-safe write failure', async () => {
  const f = setup()
  vi.spyOn(fsp, 'writeFile').mockImplementation(async path => { throw denied(path) })
  const error = await f.artifacts.put(new Uint8Array([7]), { conversationId: f.conversationId }, 'image/png').catch(error => error)
  expect(String(error)).toMatch(/图片.*写入/); expect(String(error)).not.toContain(f.root)
  expect(f.store.listArtifactOwners(f.conversationId)).toEqual([])
})

it('purge keeps an admitted write owner so late bytes cannot republish and reopen recovers failed cleanup', async () => {
  const f = setup(), pause = gate(), actual = fsp.writeFile
  vi.spyOn(fsp, 'writeFile').mockImplementation(async (...args) => { pause.entered(); await pause.waiting; return actual(...args) })
  vi.spyOn(fsp, 'unlink').mockImplementation(async path => { throw denied(path) })
  const operation = f.artifacts.put(new Uint8Array([8]), { conversationId: f.conversationId }, 'image/png').then(() => 'published', () => 'failed')
  await pause.started
  const owner = f.store.listArtifactOwners(f.conversationId)[0]
  f.store.trashConversation(f.conversationId); f.store.purgeConversation(f.conversationId)
  expect(f.store.listArtifactOwners(f.conversationId)).toEqual([{ id: owner.id, published: 0 }])
  pause.release(); expect(await operation).toBe('failed')
  expect(f.store.getArtifact(owner.id)).toBeNull()
  expect(await fsp.readFile(join(f.store.artifactDirectory, owner.id))).toEqual(Buffer.from([8]))
  vi.restoreAllMocks(); f.reopen()
  expect(f.store.listArtifactOwners(f.conversationId)).toEqual([])
  expect(fs.existsSync(join(f.store.artifactDirectory, owner.id))).toBe(false)
})

it.each([false, true])('shutdown drains admitted writes with the aggregate deadline; pastDeadline=%s avoids DB after abort', async pastDeadline => {
  const f = setup(), pause = gate(), actual = fsp.writeFile
  vi.spyOn(fsp, 'writeFile').mockImplementation(async (...args) => { pause.entered(); await pause.waiting; return actual(...args) })
  const operation = f.artifacts.put(new Uint8Array([8]), { conversationId: f.conversationId }, 'image/png').then(() => 'published', () => 'cancelled')
  await pause.started
  const owner = f.store.listArtifactOwners(f.conversationId)[0]
  const calls = (['saveArtifact', 'forgetArtifactFiles', 'hasConversation', 'getArtifact'] as const).map(name => vi.spyOn(f.store, name))
  if (pastDeadline) vi.spyOn(fsp, 'unlink').mockImplementation(async path => { throw denied(path) })
  const close = vi.fn(() => f.close())
  vi.useFakeTimers()
  const quit = createShutdown({ lifetime: f.lifetime, stop: () => {}, drain: () => f.artifacts.shutdown(), forceClose: () => {}, close })()
  expect(close).not.toHaveBeenCalled()
  if (pastDeadline) { await vi.advanceTimersByTimeAsync(5000); await quit; expect(close).toHaveBeenCalledOnce() }
  pause.release(); vi.useRealTimers()
  await quit; expect(await operation).toBe('cancelled'); await f.artifacts.shutdown()
  expect(close).toHaveBeenCalledOnce(); calls.forEach(call => expect(call).not.toHaveBeenCalled())
  expect(fs.existsSync(join(f.root, 'tool-artifacts', owner.id))).toBe(pastDeadline)
  vi.restoreAllMocks()
  const reopened = new HerStore(f.path)
  expect(reopened.listArtifactOwners(f.conversationId)).toEqual([]); reopened.close()
})

it('schema11 published images migrate without changing history or readable references', async () => {
  const f = setup()
  const reference = await f.artifacts.put(new Uint8Array([4]), { conversationId: f.conversationId }, 'image/png')
  f.store.addMessage({ id: 'm', conversationId: f.conversationId, role: 'assistant', content: 'image', status: 'complete', createdAt: '2026-10-15', toolCalls: [{ id: 'c', name: 'image', arguments: {}, result: { content: [{ type: 'image', artifactId: reference.id, mimeType: 'image/png' }] } }] })
  const history = f.store.getMessages(f.conversationId)
  const db = new DatabaseSync(f.path); db.exec('DROP TABLE IF EXISTS artifact_owners; PRAGMA user_version=11'); db.close()
  f.reopen()
  expect(f.store.listArtifactOwners(f.conversationId)).toEqual([{ id: reference.id, published: 1 }])
  expect(f.store.getMessages(f.conversationId)).toEqual(history)
  expect(await new ToolArtifactStore(f.store).read(reference.id, f.context)).toEqual(new Uint8Array([4]))
})

it('rejects traversal ownership without removing a neighboring original', async () => {
  const f = setup(), original = join(f.root, 'original')
  await fsp.writeFile(original, 'original')
  expect(() => f.store.beginArtifactFiles('../original', f.conversationId)).toThrow(/图片.*失效/)
  expect(await fsp.readFile(original, 'utf8')).toBe('original')
})

it('SQL rollback retains published ownership and trash but removed image bytes remain explicitly missing', async () => {
  const f = setup()
  const image = await f.artifacts.put(new Uint8Array([6]), { conversationId: f.conversationId }, 'image/png')
  f.store.trashConversation(f.conversationId)
  const db = new DatabaseSync(f.path)
  try {
    db.exec("CREATE TRIGGER fail_purge BEFORE DELETE ON conversations BEGIN SELECT RAISE(ABORT, 'injected SQL failure'); END;")
    expect(() => f.store.purgeConversation(f.conversationId)).toThrow('injected SQL failure')
    expect(f.store.listTrashedConversations().map(c => c.id)).toContain(f.conversationId)
    expect(f.store.listArtifactOwners(f.conversationId)).toEqual([{ id: image.id, published: 1 }])
    db.exec('DROP TRIGGER fail_purge')
  } finally { db.close() }
  f.store.restoreConversation(f.conversationId)
  await expect(f.artifacts.read(image.id, f.context)).rejects.toThrow(/缺失/)
  f.store.trashConversation(f.conversationId); f.store.purgeConversation(f.conversationId)
  expect(f.store.listArtifactOwners(f.conversationId)).toEqual([])
})
