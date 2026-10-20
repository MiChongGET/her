import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { HerStore, untestedConnections, type StoredService } from '../src/core/storage/store'

const directories: string[] = [], stores: HerStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) try { store.close() } catch { /* already closed */ }
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'her-storage-'))
  directories.push(directory)
  return join(directory, 'her.sqlite')
}
function open(path = databasePath()) {
  const store = new HerStore(path); stores.push(store)
  return { store, path }
}
const conversation = (store: HerStore, title = '对话') => { const id = randomUUID(); store.createConversation(id, randomUUID(), title); return id }
const raw = <T>(path: string, action: (db: DatabaseSync) => T): T => { const db = new DatabaseSync(path); try { return action(db) } finally { db.close() } }
const service = (patch: Partial<StoredService> = {}): StoredService => ({
  id: 'svc', name: 'Claude', protocol: 'anthropic', baseUrl: 'https://example.com/v1', defaultModel: 'm1', authMethod: 'api-key',
  sealedSecrets: null, hasApiKey: false, hasCustomHeaders: false, maxOutputTokens: null, contextWindow: null,
  models: [{ id: 'm1', longOutput: false, multimodal: false, tests: untestedConnections() }], revision: 1, tests: untestedConnections(), ...patch
})
const settings = (patch: object = {}) => ({ activeProfileId: null, shortcut: 'CommandOrControl+Shift+H', stopShortcut: 'CommandOrControl+Shift+Escape', launchAtLogin: false, ...patch })

describe('schema', () => {
  it('creates the Her-Pi v1 tables and nothing from the pre-Pi layout', () => {
    const { path } = open()
    const tables = raw(path, db => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(row => row.name))
    for (const name of ['services', 'conversations', 'input_requests', 'tasks', 'task_usage', 'tool_calls', 'target_quarantine', 'projection_entries',
      'draft_fragments', 'mcp_services', 'file_grants', 'settings', 'tool_artifacts', 'artifact_owners', 'documents', 'document_owners']) expect(tables).toContain(name)
    for (const name of ['messages', 'profiles', 'task_runs', 'tool_executions']) expect(tables).not.toContain(name)
  })

  it('stamps version 1, enforces foreign keys and uses a write-ahead log', () => {
    const { path } = open()
    expect(raw(path, db => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)).toBe(1)
    const { store } = open(databasePath())
    void store
  })

  it('reopens an existing v1 database without changing it', () => {
    const { store, path } = open()
    const id = conversation(store, '保留')
    store.close()
    const reopened = open(path).store
    expect(reopened.getConversation(id)?.title).toBe('保留')
    expect(raw(path, db => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)).toBe(1)
  })

  it.each([2, 7, 12, 99])('refuses a database stamped with version %i and leaves it untouched', version => {
    const path = databasePath()
    raw(path, db => db.exec(`CREATE TABLE marker (v TEXT); INSERT INTO marker VALUES ('keep'); PRAGMA user_version = ${version}`))
    expect(() => new HerStore(path)).toThrow(`不支持的数据库版本 ${version}`)
    expect(raw(path, db => (db.prepare('SELECT v FROM marker').get() as { v: string }).v)).toBe('keep')
    expect(raw(path, db => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)).toBe(version)
  })

  it('works fully in memory too', () => {
    const store = new HerStore(':memory:'); stores.push(store)
    const id = conversation(store)
    expect(store.hasConversation(id)).toBe(true)
    expect(store.artifactDirectory).toBe('')
  })
})

describe('settings', () => {
  it('returns defaults before anything is saved', () => {
    const { store } = open()
    expect(store.getSettings()).toEqual(settings())
    expect(store.getSettings().systemPrompt).toBeUndefined()
  })

  it('stores and retrieves the system prompt, and keeps it across reopening', () => {
    const { store, path } = open()
    store.setSettings(settings({ systemPrompt: '你是一个友好的助手' }))
    expect(store.getSettings().systemPrompt).toBe('你是一个友好的助手')
    store.close()
    expect(open(path).store.getSettings().systemPrompt).toBe('你是一个友好的助手')
  })

  it('replaces the saved value rather than accumulating rows', () => {
    const { store, path } = open()
    store.setSettings(settings({ shortcut: 'A' })); store.setSettings(settings({ shortcut: 'B' }))
    expect(store.getSettings().shortcut).toBe('B')
    expect(raw(path, db => (db.prepare('SELECT COUNT(*) AS n FROM settings').get() as { n: number }).n)).toBe(1)
  })
})

describe('model services', () => {
  it('round-trips every field, including models, context window and output cap', () => {
    const { store } = open()
    const saved = service({ contextWindow: 200_000, maxOutputTokens: 8192, hasApiKey: true, sealedSecrets: 'sealed', revision: 4,
      models: [{ id: 'm1', longOutput: true, multimodal: false, tests: untestedConnections() }, { id: 'm2', longOutput: false, multimodal: true, tests: untestedConnections() }] })
    store.saveService(saved)
    expect(store.getService('svc')).toEqual(saved)
  })

  it('reads back null for an unset window and output cap', () => {
    const { store } = open()
    store.saveService(service())
    expect(store.getService('svc')).toMatchObject({ contextWindow: null, maxOutputTokens: null })
  })

  it('keeps per-model test results through a save and a reopen', () => {
    const { store, path } = open()
    const tests = { ...untestedConnections(), chat: { status: 'passed' as const, message: '通过' } }
    store.saveService(service({ models: [{ id: 'm1', longOutput: false, multimodal: false, tests }] }))
    store.close()
    expect(open(path).store.getService('svc')?.models[0].tests.chat).toEqual({ status: 'passed', message: '通过' })
  })

  it('saving again with the same id replaces the service', () => {
    const { store } = open()
    store.saveService(service({ name: 'old' })); store.saveService(service({ name: 'new', revision: 2 }))
    expect(store.listServices()).toHaveLength(1)
    expect(store.getService('svc')).toMatchObject({ name: 'new', revision: 2 })
  })

  it('lists several and deletes only the one asked for', () => {
    const { store } = open()
    store.saveService(service({ id: 'a' })); store.saveService(service({ id: 'b' }))
    store.deleteService('a')
    expect(store.listServices().map(item => item.id)).toEqual(['b'])
    expect(store.getService('a')).toBeNull()
  })

  it('profile helpers see the same rows as the service ones', () => {
    const { store } = open()
    store.saveProfile(service({ id: 'p' }))
    expect(store.getProfile('p')?.id).toBe('p')
    expect(store.listProfiles().map(item => item.id)).toEqual(['p'])
    store.deleteProfile('p')
    expect(store.getProfile('p')).toBeNull()
  })
})

describe('conversations', () => {
  it('creates a conversation that is visible, untrashed and not yet custom-titled', () => {
    const { store } = open()
    const id = conversation(store, '新对话')
    expect(store.getConversation(id)).toMatchObject({ id, title: '新对话', titleCustom: false, deletedAt: null })
    expect(store.hasConversation(id)).toBe(true)
    expect(store.listConversations().map(item => item.id)).toEqual([id])
  })

  it('keeps each conversation on its own Pi session id, and refuses a repeated one', () => {
    const { store } = open()
    const session = randomUUID()
    store.createConversation(randomUUID(), session, 'a')
    expect(() => store.createConversation(randomUUID(), session, 'b')).toThrow()
  })

  it('returns null and false for a conversation that does not exist', () => {
    const { store } = open()
    expect(store.getConversation('missing')).toBeNull()
    expect(store.hasConversation('missing')).toBe(false)
  })

  it('lists the most recently updated first', () => {
    const { store, path } = open()
    const a = conversation(store, 'a'), b = conversation(store, 'b')
    // Timestamps have millisecond resolution, so set them explicitly instead of racing the clock.
    raw(path, db => {
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run('2026-10-20T00:00:01.000Z', a)
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run('2026-10-20T00:00:02.000Z', b)
    })
    expect(store.listConversations().map(item => item.id)).toEqual([b, a])
    raw(path, db => db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run('2026-10-20T00:00:03.000Z', a))
    expect(store.listConversations().map(item => item.id)).toEqual([a, b])
  })

  it('breaks a tie on updated_at by creation order, newest first, so the list never shuffles', () => {
    const { store, path } = open()
    const a = conversation(store, 'a'), b = conversation(store, 'b'), c = conversation(store, 'c')
    raw(path, db => db.prepare('UPDATE conversations SET updated_at = ?').run('2026-10-20T00:00:00.000Z'))
    expect(store.listConversations().map(item => item.id)).toEqual([c, b, a])
  })
})

describe('renaming a conversation', () => {
  it('trims the title, marks it custom, and returns the summary', () => {
    const { store } = open(), id = conversation(store)
    expect(store.renameConversation(id, '  我的计划  ')).toMatchObject({ id, title: '我的计划', titleCustom: true })
    expect(store.getConversation(id)).toMatchObject({ title: '我的计划', titleCustom: true })
  })

  it.each(['', '   ', '\n\t'])('rejects the blank title %j and leaves the title unchanged', title => {
    const { store } = open(), id = conversation(store, '原标题')
    expect(() => store.renameConversation(id, title)).toThrow('请输入对话标题')
    expect(store.getConversation(id)?.title).toBe('原标题')
  })

  it('counts code points, not UTF-16 units: 80 emoji are allowed, 81 are not', () => {
    const { store } = open(), id = conversation(store)
    expect(() => store.renameConversation(id, '😀'.repeat(80))).not.toThrow()
    expect(() => store.renameConversation(id, '😀'.repeat(81))).toThrow('最多 80')
    expect(Array.from(store.getConversation(id)!.title)).toHaveLength(80)
  })

  it('does not reorder the list or touch updated_at', () => {
    const { store } = open()
    const older = conversation(store, 'older'), newer = conversation(store, 'newer')
    const before = store.getConversation(older)!.updatedAt.getTime()
    store.renameConversation(older, 'renamed')
    expect(store.getConversation(older)!.updatedAt.getTime()).toBe(before)
    expect(store.listConversations().map(item => item.id)).toEqual([newer, older])
  })

  it('refuses a conversation that is missing or in the trash', () => {
    const { store } = open(), id = conversation(store)
    expect(() => store.renameConversation('missing', 'x')).toThrow('不存在')
    store.trashConversation(id)
    expect(() => store.renameConversation(id, 'x')).toThrow('不存在')
  })

  it('keeps a custom title across a restart', () => {
    const { store, path } = open(), id = conversation(store)
    store.renameConversation(id, '固定的名字')
    store.close()
    expect(open(path).store.getConversation(id)).toMatchObject({ title: '固定的名字', titleCustom: true })
  })
})

describe('trash and restore', () => {
  it('hides a trashed conversation from the list but lists it in the trash with its deletion time', () => {
    const { store } = open(), id = conversation(store, '要删的')
    store.trashConversation(id)
    expect(store.hasConversation(id)).toBe(false)
    expect(store.listConversations()).toEqual([])
    expect(store.listConversations(true).map(item => item.id)).toEqual([id])
    const [trashed] = store.listTrashedConversations()
    expect(trashed).toMatchObject({ id, title: '要删的' })
    expect(Number.isFinite(Date.parse(trashed.deletedAt))).toBe(true)
  })

  it('restores with the title and custom flag intact', () => {
    const { store } = open(), id = conversation(store)
    store.renameConversation(id, '保留的标题')
    store.trashConversation(id)
    expect(store.restoreConversation(id)).toMatchObject({ id, title: '保留的标题', titleCustom: true })
    expect(store.hasConversation(id)).toBe(true)
    expect(store.listTrashedConversations()).toEqual([])
  })

  it('refuses to restore something that is not in the trash', () => {
    const { store } = open(), id = conversation(store)
    expect(() => store.restoreConversation(id)).toThrow('不在回收站')
    expect(() => store.restoreConversation('missing')).toThrow('不在回收站')
  })

  it('keeps the trash across a restart', () => {
    const { store, path } = open(), id = conversation(store)
    store.trashConversation(id)
    store.close()
    const reopened = open(path).store
    expect(reopened.listTrashedConversations().map(item => item.id)).toEqual([id])
    expect(reopened.hasConversation(id)).toBe(false)
  })

  it('lists the most recently trashed first', () => {
    const { store } = open()
    const a = conversation(store), b = conversation(store)
    store.trashConversation(a); store.trashConversation(b)
    expect(store.listTrashedConversations().map(item => item.id)).toEqual([b, a])
  })
})

describe('purging', () => {
  it('only removes conversations that are in the trash, and says so', () => {
    const { store } = open(), id = conversation(store)
    expect(() => store.purgeConversation(id)).toThrow('回收站')
    expect(store.hasConversation(id)).toBe(true)
  })

  it('removes the conversation and everything that hangs off it, and nothing else', () => {
    const { store, path } = open()
    const gone = conversation(store), kept = conversation(store)
    for (const id of [gone, kept]) {
      const request = `r-${id}`, task = `t-${id}`
      store.enqueueInput(id, 'x', null, request)
      store.createTask({ id: task, conversationId: id, requestId: request, generation: 0, status: 'completed', serviceId: 's', modelId: 'm', configRevision: 1, error: null })
      store.insertToolCall({ taskId: task, callId: 'c', toolName: 'act', args: '{}', effect: 'read', target: 'x' })
      store.saveDraftFragment(task, 'interrupted-text', 'partial')
      store.replaceMessageProjection(id, [{ entryId: 'e1', message: { id: 'm1', conversationId: id, role: 'user', content: 'hi', status: 'complete', createdAt: new Date().toISOString() } }], 'e1')
    }
    store.trashConversation(gone)
    store.purgeConversation(gone)
    const count = (table: string, column: string, id: string) => raw(path, db => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(id) as { n: number }).n)
    expect([count('input_requests', 'conversation_id', gone), count('tasks', 'conversation_id', gone), count('projection_entries', 'conversation_id', gone),
      count('tool_calls', 'task_id', `t-${gone}`), count('draft_fragments', 'task_id', `t-${gone}`)]).toEqual([0, 0, 0, 0, 0])
    expect([count('input_requests', 'conversation_id', kept), count('tasks', 'conversation_id', kept), count('projection_entries', 'conversation_id', kept),
      count('tool_calls', 'task_id', `t-${kept}`), count('draft_fragments', 'task_id', `t-${kept}`)]).toEqual([1, 1, 1, 1, 1])
  })

  it('clears the quarantine entries the purged conversation caused, and only those', () => {
    const { store } = open()
    const gone = conversation(store), kept = conversation(store)
    store.quarantineTarget('a', gone, 't1', 'c1'); store.quarantineTarget('b', kept, 't2', 'c2')
    store.trashConversation(gone); store.purgeConversation(gone)
    expect(store.listQuarantinedTargets()).toEqual(['b'])
  })

  it('removes several at once, all or nothing', () => {
    const { store, path } = open()
    const a = conversation(store), b = conversation(store)
    store.trashConversation(a); store.trashConversation(b)
    raw(path, db => db.exec("CREATE TRIGGER fail_purge BEFORE DELETE ON conversations BEGIN SELECT RAISE(ABORT, 'injected'); END;"))
    expect(() => store.purgeConversations([a, b])).toThrow('injected')
    expect(store.listTrashedConversations().map(item => item.id).sort()).toEqual([a, b].sort())
    raw(path, db => db.exec('DROP TRIGGER fail_purge'))
    store.purgeConversations([a, b])
    expect(store.listTrashedConversations()).toEqual([])
  })

  it('does nothing for an empty list', () => {
    const { store } = open()
    expect(() => store.purgeConversations([])).not.toThrow()
  })
})

describe('projection', () => {
  const message = (id: string, conversationId: string, content: string) => ({ id, conversationId, role: 'user' as const, content, status: 'complete' as const, createdAt: '2026-10-20T00:00:00.000Z' })

  it('reads messages back in sequence order, whatever order the entry ids sort in', () => {
    const { store } = open(), id = conversation(store)
    store.replaceMessageProjection(id, [
      { entryId: 'zzz', message: message('1', id, 'first') }, { entryId: 'aaa', message: message('2', id, 'second') }], 'aaa')
    expect(store.getMessages(id).map(item => item.content)).toEqual(['first', 'second'])
  })

  it('replaces the whole projection each time and records the cursor', () => {
    const { store, path } = open(), id = conversation(store)
    store.replaceMessageProjection(id, [{ entryId: 'e1', message: message('1', id, 'old') }], 'e1')
    store.replaceMessageProjection(id, [{ entryId: 'e2', message: message('2', id, 'new') }], 'e2')
    expect(store.getMessages(id).map(item => item.content)).toEqual(['new'])
    expect(store.getConversation(id)?.lastEntryId).toBe('e2')
    expect(raw(path, db => (db.prepare('SELECT COUNT(*) AS n FROM projection_entries').get() as { n: number }).n)).toBe(1)
  })

  it('rolls back completely when a row cannot be written', () => {
    const { store } = open(), id = conversation(store)
    store.replaceMessageProjection(id, [{ entryId: 'e1', message: message('1', id, 'keep me') }], 'e1')
    expect(() => store.replaceMessageProjection(id, [
      { entryId: 'dup', message: message('2', id, 'a') }, { entryId: 'dup', message: message('3', id, 'b') }], 'dup')).toThrow()
    expect(store.getMessages(id).map(item => item.content)).toEqual(['keep me'])
    expect(store.getConversation(id)?.lastEntryId).toBe('e1')
  })

  it('keeps one conversation\'s projection apart from another\'s', () => {
    const { store } = open(), a = conversation(store), b = conversation(store)
    store.replaceMessageProjection(a, [{ entryId: 'e', message: message('1', a, 'A') }], 'e')
    store.replaceMessageProjection(b, [{ entryId: 'e', message: message('1', b, 'B') }], 'e')
    expect(store.getMessages(a).map(item => item.content)).toEqual(['A'])
    expect(store.getMessages(b).map(item => item.content)).toEqual(['B'])
  })
})

describe('MCP services', () => {
  const config = (id: string, revision: number) => ({ id, revision, config: { id, revision, name: 'mock', enabled: true } as never, sealedSecrets: null })

  it('creates once and refuses a second create with the same id', () => {
    const { store } = open()
    expect(store.saveMcpService(config('m', 1))).toBe(true)
    expect(store.saveMcpService(config('m', 1))).toBe(false)
  })

  it('updates only when the caller still holds the current revision', () => {
    const { store } = open()
    store.saveMcpService(config('m', 1))
    expect(store.saveMcpService(config('m', 2), 1)).toBe(true)
    expect(store.saveMcpService(config('m', 3), 1)).toBe(false)
    expect(store.getMcpService('m')?.revision).toBe(2)
  })

  it('a removed service disappears from reads but its revision keeps counting up', () => {
    const { store } = open()
    store.saveMcpService(config('m', 1))
    expect(store.removeMcpService('m')).toBe(2)
    expect(store.getMcpService('m')).toBeUndefined()
    expect(store.listMcpServices()).toEqual([])
    expect(store.removeMcpService('m')).toBeUndefined()
  })
})
