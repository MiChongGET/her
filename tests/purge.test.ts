import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HerStore } from '../src/core/storage/store'
import { ToolArtifactStore } from '../src/core/tools/artifacts'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
function open() {
  const directory = mkdtempSync(join(tmpdir(), 'her-purge-')); cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const store = new HerStore(join(directory, 'her.sqlite')); cleanup.push(() => { try { store.close() } catch { /* closed */ } })
  return { directory, store, reopen: () => new HerStore(join(directory, 'her.sqlite')) }
}
const conversation = (store: HerStore) => { const id = randomUUID(); store.createConversation(id, randomUUID(), 't'); return id }
const context = (conversationId: string) => ({ conversationId, runId: 'r', callId: 'c', signal: new AbortController().signal })

describe('permanently deleting a conversation', () => {
  it('refuses a conversation that is not in the trash', () => {
    const { store } = open(), id = conversation(store)
    expect(() => store.purgeConversation(id)).toThrow('回收站')
    expect(store.hasConversation(id)).toBe(true)
  })

  it('removes the row and everything that cascades from it, and it does not come back after a restart', async () => {
    const { store, reopen } = open(), id = conversation(store)
    const requestId = randomUUID()
    store.enqueueInput(id, 'x', null, requestId)
    store.createTask({ id: 'task', conversationId: id, requestId, generation: 0, status: 'completed', serviceId: 's', modelId: 'm', configRevision: 1, error: null })
    store.insertToolCall({ taskId: 'task', callId: 'c1', toolName: 'act', args: '{}', effect: 'read', target: 'x' })
    store.saveDraftFragment('task', 'interrupted-text', 'partial')
    store.trashConversation(id)
    store.purgeConversation(id)
    expect(store.hasConversation(id)).toBe(false)
    expect(store.getTask('task')).toBeNull()
    expect(store.getInput(requestId)).toBeNull()
    expect(store.listDraftFragments('task')).toEqual([])
    const restarted = reopen()
    expect(restarted.hasConversation(id)).toBe(false)
    expect(restarted.listTrashedConversations().some(c => c.id === id)).toBe(false)
    restarted.close()
  })

  it('removes only the purged conversation\'s unpublished image owner, never a conversation it does not own, and leaves another conversation\'s image readable', async () => {
    const { store, directory } = open(), gone = conversation(store), kept = conversation(store)
    const artifacts = new ToolArtifactStore(store)
    const goneImage = await artifacts.put(new Uint8Array([1]), { conversationId: gone }, 'image/png')
    const keptImage = await artifacts.put(new Uint8Array([2]), { conversationId: kept }, 'image/png')
    store.trashConversation(gone)
    store.purgeConversation(gone)
    expect(existsSync(join(directory, 'artifacts', goneImage.id))).toBe(false)
    expect(store.listArtifactOwners(gone)).toEqual([])
    expect(await artifacts.read(keptImage.id, context(kept))).toEqual(new Uint8Array([2]))
  })

  it('never deletes the user\'s own authorised source file, only Her-managed cache and artifact bytes', async () => {
    const { store, directory } = open(), id = conversation(store)
    const { FileAccessService } = await import('../src/core/files/access')
    const files = new FileAccessService(store)
    const sourcePath = join(directory, 'users-own-file.txt')
    writeFileSync(sourcePath, 'the user\'s own content')
    const [grant] = await files.grant([sourcePath], { scope: 'conversation', conversationId: id, kind: 'file' })
    await files.reference(grant.id, '', context(id))
    store.trashConversation(id)
    store.purgeConversation(id)
    expect(existsSync(sourcePath)).toBe(true)
  })

  it('a failure during purge keeps the conversation visibly in the trash and retryable, not silently gone', () => {
    const { store, directory } = open(), id = conversation(store)
    const artifacts = new ToolArtifactStore(store)
    void artifacts
    store.trashConversation(id)
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
    const raw = new DatabaseSync(join(directory, 'her.sqlite'))
    raw.exec("CREATE TRIGGER fail_purge BEFORE DELETE ON conversations BEGIN SELECT RAISE(ABORT, 'injected SQL failure'); END;")
    expect(() => store.purgeConversation(id)).toThrow('injected SQL failure')
    expect(store.listTrashedConversations().some(c => c.id === id)).toBe(true)
    raw.exec('DROP TRIGGER fail_purge;')
    raw.close()
    store.purgeConversation(id)
    expect(store.hasConversation(id)).toBe(false)
  })

  it('keeps a target_quarantine entry for an unknown action in another conversation untouched', () => {
    const { store } = open(), purged = conversation(store), other = conversation(store)
    store.quarantineTarget('shared-looking-key', purged, 'task-a', 'call-a')
    store.quarantineTarget('other-key', other, 'task-b', 'call-b')
    store.trashConversation(purged)
    store.purgeConversation(purged)
    expect(store.listQuarantinedTargets()).toEqual(['other-key'])
    expect(store.isTargetQuarantined('other-key')).toBe(true)
  })

  it('purges several conversations together, atomically: a mid-batch failure leaves none of them purged', () => {
    const { store, directory } = open(), a = conversation(store), b = conversation(store)
    store.trashConversation(a); store.trashConversation(b)
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
    const raw = new DatabaseSync(join(directory, 'her.sqlite'))
    raw.exec("CREATE TRIGGER fail_purge BEFORE DELETE ON conversations BEGIN SELECT RAISE(ABORT, 'injected SQL failure'); END;")
    expect(() => store.purgeConversations([a, b])).toThrow('injected SQL failure')
    raw.exec('DROP TRIGGER fail_purge;'); raw.close()
    expect(store.hasConversation(a)).toBe(false) // still trashed, not gone
    expect(store.listTrashedConversations().map(c => c.id).sort()).toEqual([a, b].sort())
  })
})
