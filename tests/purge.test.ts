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
    expect(store.listQuarantinedTargets()).toEqual(['other-key', 'shared-looking-key'])
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

import { harness, harnessCleanup } from './helpers/host-harness'
import { startFixtureServer } from './pi-sdk/wire'
import { AgentHost } from '../src/core/agent/host'
import { DatabaseSync } from 'node:sqlite'

async function withPiHistory() {
  const server = await startFixtureServer('openai', 'text'); harnessCleanup.push(server.close)
  const f = harness()
  const p = await f.profiles.save({ name: 'p', protocol: 'openai', baseUrl: server.baseUrl + '/v1', model: 'test-model', contextWindow: 128000, authMethod: 'none' })
  const sent = await f.send(f.id, p.id, 'history')
  await expect.poll(() => f.finished(sent.requestId)?.state).toBe('completed')
  await f.chat.trashConversation(f.id)
  return f
}
afterEach(async () => { for (const close of harnessCleanup.splice(0).reverse()) await close() })

it('permanent deletion removes Pi history and workspace while retaining unknown target isolation', async () => {
  const f = await withPiHistory()
  const sessionDir = join(f.directory, 'pi', 'sessions', f.id)
  expect(existsSync(sessionDir)).toBe(true)
  f.store.quarantineTarget('external-unknown', f.id, 'old-task', 'old-call')
  await f.chat.purgeConversations([f.id])
  expect(existsSync(sessionDir)).toBe(false)
  expect(existsSync(join(f.directory, 'pi', 'workspaces', f.id))).toBe(false)
  expect(f.store.hasConversation(f.id)).toBe(false)
  expect(f.store.isTargetQuarantined('external-unknown')).toBe(true)
})

it('retains a durable tombstone and visible error after failed deletion, blocks restore, and retries after restart', async () => {
  const f = await withPiHistory()
  const raw = new DatabaseSync(join(f.directory, 'her.sqlite'))
  raw.exec("CREATE TRIGGER fail_pi_purge BEFORE DELETE ON conversations BEGIN SELECT RAISE(ABORT, 'injected purge error'); END;")
  await expect(f.chat.purgeConversations([f.id])).rejects.toThrow('清理')
  expect(f.store.listTrashedConversations()[0]).toMatchObject({ cleanupPending: true, cleanupError: expect.stringContaining('清理') })
  expect(() => f.chat.restoreConversation(f.id)).toThrow('清理')
  await f.chat.shutdown()
  const restarted = new AgentHost(f.store, f.profiles, f.directory)
  harnessCleanup.push(() => restarted.stopAll())
  await restarted.ready()
  expect(f.store.listTrashedConversations()[0].cleanupPending).toBe(true)
  raw.exec('DROP TRIGGER fail_pi_purge'); raw.close()
  await restarted.purgeConversations([f.id])
  expect(f.store.getConversation(f.id)).toBeNull()
  expect(f.store.listPurgeJobs()).toEqual([])
})
