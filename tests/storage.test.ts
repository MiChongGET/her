import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { HerStore, untestedConnections, type StoredProfile } from '../src/core/storage/store'

const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'her-storage-'))
  directories.push(directory)
  return join(directory, 'her.sqlite')
}

describe('local chat persistence', () => {
  it('restores messages and settings after closing and reopening the database', () => {
    const path = databasePath()
    const store = new HerStore(path)
    const conversation = store.createConversation()
    store.addMessage({
      id: 'user-1', conversationId: conversation.id, role: 'user',
      content: '今天想聊聊新项目。', status: 'complete', createdAt: '2026-10-13T12:00:00Z'
    })
    store.addMessage({
      id: 'assistant-1', conversationId: conversation.id, role: 'assistant',
      content: '慢慢说。', status: 'complete', createdAt: '2026-10-13T12:00:01Z',
      profileId: 'model-1', model: 'custom-model'
    })
    store.setSettings({ activeProfileId: null, shortcut: 'CommandOrControl+Shift+J', stopShortcut: 'CommandOrControl+Shift+Escape', launchAtLogin: false })
    store.close()

    const reopened = new HerStore(path)
    expect(reopened.getMessages(conversation.id).map(message => message.content))
      .toEqual(['今天想聊聊新项目。', '慢慢说。'])
    expect(reopened.getMessages(conversation.id)[1].model).toBe('custom-model')
    expect(reopened.getSettings().shortcut).toBe('CommandOrControl+Shift+J')
    expect(reopened.listConversations()[0].lastMessage).toBe('慢慢说。')
    reopened.close()
  })

  it('preserves partial content but marks interrupted responses after restart', () => {
    const path = databasePath()
    const store = new HerStore(path)
    const conversation = store.createConversation()
    store.addMessage({
      id: 'partial', conversationId: conversation.id, role: 'assistant',
      content: '我觉得可以先', status: 'streaming', createdAt: new Date().toISOString()
    })
    store.close()
    const reopened = new HerStore(path)
    expect(reopened.getMessages(conversation.id)[0]).toMatchObject({
      content: '我觉得可以先', status: 'cancelled', error: '上次应用退出时，回答尚未完成。'
    })
    reopened.close()
  })

  it('keeps tool calls separate from message content across updates and reopening', () => {
    const path = databasePath()
    const store = new HerStore(path)
    const conversation = store.createConversation()
    const message = {
      id: 'assistant-1', conversationId: conversation.id, role: 'assistant' as const,
      content: '', status: 'streaming' as const, createdAt: '2026-10-13T12:00:01Z'
    }
    store.addMessage(message)
    store.updateMessage({
      ...message, content: '现在是十一点。', status: 'complete',
      toolCalls: [{ id: 'c1', name: 'get_current_time', arguments: { timezone: 'UTC' }, result: '23:03:27' }]
    })
    store.close()
    const reopened = new HerStore(path)
    expect(reopened.getMessages(conversation.id)[0]).toMatchObject({
      content: '现在是十一点。',
      toolCalls: [{ id: 'c1', name: 'get_current_time', arguments: { timezone: 'UTC' }, result: '23:03:27' }]
    })
    reopened.close()
  })

  it('stores and retrieves systemPrompt in settings', () => {
    const store = new HerStore(databasePath())
    expect(store.getSettings().systemPrompt).toBeUndefined()
    store.setSettings({ activeProfileId: null, shortcut: 'CommandOrControl+Shift+H', stopShortcut: 'CommandOrControl+Shift+Escape', launchAtLogin: false, systemPrompt: '你是一个友好的助手' })
    expect(store.getSettings().systemPrompt).toBe('你是一个友好的助手')
    store.close()
  })

  it('persists systemPrompt across reopens', () => {
    const path = databasePath()
    const store = new HerStore(path)
    store.setSettings({ activeProfileId: null, shortcut: 'CommandOrControl+Shift+H', stopShortcut: 'CommandOrControl+Shift+Escape', launchAtLogin: false, systemPrompt: '自定义提示词' })
    store.close()
    const reopened = new HerStore(path)
    expect(reopened.getSettings().systemPrompt).toBe('自定义提示词')
    reopened.close()
  })

  it('rejects messages for unknown conversations instead of creating orphan history', () => {
    const store = new HerStore(databasePath())
    expect(() => store.addMessage({
      id: 'orphan', conversationId: 'missing', role: 'user', content: 'hello',
      status: 'complete', createdAt: new Date().toISOString()
    })).toThrow()
    store.close()
  })

  it('keeps message order even when timestamps are identical', () => {
    const store = new HerStore(databasePath())
    const conversation = store.createConversation()
    const createdAt = '2026-10-13T12:00:00Z'
    for (const [id, role, content] of [
      ['z-user', 'user', 'first'], ['a-assistant', 'assistant', 'second']
    ] as const) {
      store.addMessage({ id, conversationId: conversation.id, role, content, status: 'complete', createdAt })
    }
    expect(store.getMessages(conversation.id).map(message => message.content)).toEqual(['first', 'second'])
    store.close()
  })

  it('rolls back the entire turn when the assistant placeholder cannot be inserted', () => {
    const path = databasePath()
    const store = new HerStore(path)
    const conversation = store.createConversation()
    const db = new DatabaseSync(path)
    db.exec("CREATE TRIGGER fail_assistant BEFORE INSERT ON messages WHEN NEW.role = 'assistant' BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;")
    const createdAt = new Date().toISOString()
    expect(() => store.addMessages([
      { id: 'user', conversationId: conversation.id, role: 'user', content: 'hello', status: 'complete', createdAt },
      { id: 'assistant', conversationId: conversation.id, role: 'assistant', content: '', status: 'streaming', createdAt }
    ])).toThrow('simulated disk failure')
    expect(store.getMessages(conversation.id)).toEqual([])
    expect(store.listConversations()[0]).toMatchObject({ title: '新的对话', lastMessage: '' })
    db.exec('DROP TRIGGER fail_assistant')
    db.close()
    store.close()
  })
})

describe('profile output-token column migration', () => {
  const stored = (maxOutputTokens: number | null): StoredProfile => ({
    id: 'p1', name: 'Claude', protocol: 'anthropic', baseUrl: 'https://example.com/v1', model: 'm',
    sealedSecrets: null, hasApiKey: false, hasCustomHeaders: false, maxOutputTokens,
    models: [{ id: 'm', longOutput: false, multimodal: false, tests: untestedConnections() }], revision: 0
  })

  function createVersionOneDatabase(path: string) {
    const db = new DatabaseSync(path)
    db.exec(`
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, protocol TEXT NOT NULL,
        base_url TEXT NOT NULL, model TEXT NOT NULL, sealed_secrets TEXT,
        has_api_key INTEGER NOT NULL, has_custom_headers INTEGER NOT NULL,
        tests TEXT NOT NULL, revision INTEGER NOT NULL
      );
      CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL);
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('complete', 'streaming', 'failed', 'cancelled')),
        created_at TEXT NOT NULL, profile_id TEXT, model TEXT, error TEXT
      );
      CREATE INDEX messages_by_conversation ON messages(conversation_id);
      PRAGMA user_version = 1;
    `)
    db.prepare('INSERT INTO profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('old', 'Old Claude', 'anthropic', 'https://example.com/v1', 'm', null, 0, 0, JSON.stringify(untestedConnections()), 3)
    db.prepare('INSERT INTO conversations VALUES (?, ?, ?, ?)').run('c1', '旧对话', '2026-10-13T00:00:00Z', '2026-10-13T00:00:00Z')
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('m1', 'c1', 'user', '旧消息', 'complete', '2026-10-13T00:00:00Z', null, null, null)
    db.close()
  }

  const userVersion = (path: string) => {
    const db = new DatabaseSync(path)
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
    db.close()
    return row.user_version
  }

  it('upgrades a version 1 database and keeps its profiles and history', () => {
    const path = databasePath()
    createVersionOneDatabase(path)
    const store = new HerStore(path)
    expect(store.getProfile('old')).toMatchObject({ name: 'Old Claude', revision: 3, maxOutputTokens: null })
    expect(store.getMessages('c1').map(message => message.content)).toEqual(['旧消息'])
    expect(store.listConversations()[0].title).toBe('旧对话')
    store.close()
    expect(userVersion(path)).toBe(12)
  })

  it('opens an already upgraded database again without error', () => {
    const path = databasePath()
    createVersionOneDatabase(path)
    new HerStore(path).close()
    const store = new HerStore(path)
    expect(store.getProfile('old')?.maxOutputTokens).toBeNull()
    store.close()
    expect(userVersion(path)).toBe(12)
  })

  it('refuses a database written by a newer version', () => {
    const path = databasePath()
    new HerStore(path).close()
    const db = new DatabaseSync(path)
    db.exec('PRAGMA user_version = 13')
    db.close()
    expect(() => new HerStore(path)).toThrow('本地资料版本比当前应用新')
  })

  it('reads back a stored number and null after reopening', () => {
    const path = databasePath()
    const store = new HerStore(path)
    store.saveProfile(stored(8192))
    store.saveProfile({ ...stored(null), id: 'p2' })
    store.close()
    const reopened = new HerStore(path)
    expect(reopened.getProfile('p1')?.maxOutputTokens).toBe(8192)
    expect(reopened.getProfile('p2')?.maxOutputTokens).toBeNull()
    reopened.close()
  })
})

describe('profile models migration', () => {
  const passed = { status: 'passed' as const, message: '连接成功', checkedAt: '2026-10-13T00:00:00Z' }

  function createVersionThreeDatabase(path: string, withModelsColumn = false) {
    const db = new DatabaseSync(path)
    db.exec(`
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, protocol TEXT NOT NULL,
        base_url TEXT NOT NULL, model TEXT NOT NULL, sealed_secrets TEXT,
        has_api_key INTEGER NOT NULL, has_custom_headers INTEGER NOT NULL,
        tests TEXT NOT NULL, revision INTEGER NOT NULL, max_output_tokens INTEGER${withModelsColumn ? ', models TEXT' : ''}
      );
      CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL);
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        title_custom INTEGER NOT NULL DEFAULT 0, deleted_at TEXT
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('complete', 'streaming', 'failed', 'cancelled')),
        created_at TEXT NOT NULL, profile_id TEXT, model TEXT, error TEXT
      );
      CREATE INDEX messages_by_conversation ON messages(conversation_id);
      PRAGMA user_version = 3;
    `)
    const tests = JSON.stringify({ ...untestedConnections(), chat: passed })
    const insert = db.prepare(`INSERT INTO profiles (id, name, protocol, base_url, model, sealed_secrets, has_api_key, has_custom_headers, tests, revision, max_output_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    insert.run('old', 'Old Claude', 'anthropic', 'https://example.com/v1', 'm1', null, 0, 0, tests, 2, 8192)
    db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run('c1', '旧对话', passed.checkedAt, passed.checkedAt)
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('msg1', 'c1', 'user', '旧消息', 'complete', passed.checkedAt, null, null, null)
    db.close()
  }

  it('upgrades a version 3 database into a single default model that keeps its test results', () => {
    const path = databasePath()
    createVersionThreeDatabase(path)
    const store = new HerStore(path)
    const profile = store.getProfile('old')!
    expect(profile).toMatchObject({ model: 'm1', revision: 2, maxOutputTokens: 8192 })
    expect(profile.models).toEqual([{ id: 'm1', longOutput: false, multimodal: false, tests: { ...untestedConnections(), chat: passed } }])
    expect(store.getMessages('c1').map(message => message.content)).toEqual(['旧消息'])
    store.close()
  })

  it('opens an already upgraded database again without error or duplicate models', () => {
    const path = databasePath()
    createVersionThreeDatabase(path)
    new HerStore(path).close()
    const store = new HerStore(path)
    expect(store.getProfile('old')?.models).toHaveLength(1)
    store.close()
  })

  it('finishes a migration that added the column but did not backfill', () => {
    const path = databasePath()
    createVersionThreeDatabase(path, true)
    const store = new HerStore(path)
    expect(store.getProfile('old')?.models.map(model => model.id)).toEqual(['m1'])
    store.close()
  })

  it('reads several models back after reopening', () => {
    const path = databasePath()
    const store = new HerStore(path)
    const models = [
      { id: 'a', longOutput: false, multimodal: false, tests: untestedConnections() },
      { id: 'b', longOutput: true, multimodal: false, tests: { ...untestedConnections(), tools: passed } }
    ]
    store.saveProfile({ id: 'p', name: 'S', protocol: 'anthropic', baseUrl: 'https://example.com/v1', model: 'a', sealedSecrets: null, hasApiKey: false, hasCustomHeaders: false, maxOutputTokens: null, models, revision: 0 })
    store.close()
    const reopened = new HerStore(path)
    expect(reopened.getProfile('p')?.models).toEqual(models)
    reopened.close()
  })
})

describe('conversation rename and trash', () => {
  const at = '2026-10-13T12:00:00Z'
  const user = (id: string, conversationId: string, content: string) =>
    ({ id, conversationId, role: 'user' as const, content, status: 'complete' as const, createdAt: at })

  function createVersionTwoDatabase(path: string) {
    const db = new DatabaseSync(path)
    db.exec(`
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, protocol TEXT NOT NULL,
        base_url TEXT NOT NULL, model TEXT NOT NULL, sealed_secrets TEXT,
        has_api_key INTEGER NOT NULL, has_custom_headers INTEGER NOT NULL,
        tests TEXT NOT NULL, revision INTEGER NOT NULL, max_output_tokens INTEGER
      );
      CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL);
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('complete', 'streaming', 'failed', 'cancelled')),
        created_at TEXT NOT NULL, profile_id TEXT, model TEXT, error TEXT
      );
      CREATE INDEX messages_by_conversation ON messages(conversation_id);
      PRAGMA user_version = 2;
    `)
    db.prepare('INSERT INTO conversations VALUES (?, ?, ?, ?)').run('c1', '旧对话', at, at)
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('m1', 'c1', 'user', '旧消息', 'complete', at, null, null, null)
    db.close()
  }

  function userVersion(path: string) {
    const db = new DatabaseSync(path)
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
    db.close()
    return row.user_version
  }

  it('upgrades a version 2 database, keeping conversations and starting with an empty trash', () => {
    const path = databasePath()
    createVersionTwoDatabase(path)
    const store = new HerStore(path)
    expect(store.listConversations()).toMatchObject([{ id: 'c1', title: '旧对话', lastMessage: '旧消息', titleCustom: false }])
    expect(store.getMessages('c1').map(message => message.content)).toEqual(['旧消息'])
    expect(store.listTrashedConversations()).toEqual([])
    store.close()
    expect(userVersion(path)).toBe(12)
    const reopened = new HerStore(path)
    expect(reopened.listConversations()).toHaveLength(1)
    reopened.close()
  })

  it('rejects blank and over-long titles by code point and leaves the title unchanged', () => {
    const store = new HerStore(':memory:')
    const { id } = store.createConversation()
    store.renameConversation(id, '原标题')
    for (const bad of ['', '   \n ', 'a'.repeat(81), '😀'.repeat(81)]) {
      expect(() => store.renameConversation(id, bad)).toThrow()
    }
    expect(store.listConversations()[0].title).toBe('原标题')
    expect(store.renameConversation(id, '😀'.repeat(80)).title).toBe('😀'.repeat(80))
    expect(store.renameConversation(id, '  周报草稿  ').title).toBe('周报草稿')
    store.close()
  })

  it('does not reorder the list or touch updated_at when renaming', () => {
    const store = new HerStore(':memory:')
    const first = store.createConversation()
    const second = store.createConversation()
    const third = store.createConversation()
    const before = store.listConversations()
    store.renameConversation(second.id, '改个名字')
    const after = store.listConversations()
    expect(after.map(item => item.id)).toEqual([third.id, second.id, first.id])
    expect(after.map(item => item.updatedAt)).toEqual(before.map(item => item.updatedAt))
    expect(after[1]).toMatchObject({ title: '改个名字', titleCustom: true })
    store.close()
  })

  it('keeps a custom title after the first message but still auto-names untouched conversations', () => {
    const store = new HerStore(':memory:')
    const renamed = store.createConversation()
    const untouched = store.createConversation()
    store.renameConversation(renamed.id, '读书笔记')
    store.addMessage(user('u1', renamed.id, 'a'.repeat(30)))
    store.addMessage(user('u2', untouched.id, 'b'.repeat(30)))
    const byId = new Map(store.listConversations().map(item => [item.id, item]))
    expect(byId.get(renamed.id)?.title).toBe('读书笔记')
    expect(byId.get(untouched.id)?.title).toBe('b'.repeat(24))
    store.close()
  })

  it('moves a conversation to the trash without deleting its messages and rejects new ones', () => {
    const store = new HerStore(':memory:')
    const keep = store.createConversation()
    const doomed = store.createConversation()
    store.addMessage(user('u1', doomed.id, '要保留的消息'))
    store.trashConversation(doomed.id)
    expect(store.listConversations().map(item => item.id)).toEqual([keep.id])
    expect(store.hasConversation(doomed.id)).toBe(false)
    expect(store.getMessages(doomed.id).map(message => message.content)).toEqual(['要保留的消息'])
    expect(store.listTrashedConversations()).toMatchObject([{ id: doomed.id, title: '要保留的消息' }])
    expect(store.listTrashedConversations()[0].deletedAt).toEqual(expect.any(String))
    expect(() => store.renameConversation(doomed.id, '不行')).toThrow('不存在')
    expect(() => store.trashConversation(doomed.id)).toThrow('不存在')
    store.close()
  })

  it('restores a conversation to its original position with history and title intact', () => {
    const store = new HerStore(':memory:')
    const first = store.createConversation()
    const second = store.createConversation()
    const third = store.createConversation()
    store.renameConversation(second.id, '会回来的')
    store.addMessage(user('u1', second.id, '第二段对话'))
    const order = store.listConversations().map(item => item.id)
    store.trashConversation(second.id)
    const restored = store.restoreConversation(second.id)
    expect(restored).toMatchObject({ id: second.id, title: '会回来的', lastMessage: '第二段对话' })
    expect(store.listConversations().map(item => item.id)).toEqual(order)
    expect(store.listTrashedConversations()).toEqual([])
    expect(store.hasConversation(second.id)).toBe(true)
    expect(() => store.restoreConversation(first.id)).toThrow('回收站')
    expect(third.id).toBeDefined()
    store.close()
  })

  it('purges only trashed conversations and removes their messages', () => {
    const path = databasePath()
    const store = new HerStore(path)
    const live = store.createConversation()
    const doomed = store.createConversation()
    store.addMessage(user('u1', live.id, '活着的消息'))
    store.addMessage(user('u2', doomed.id, '将被删除'))
    expect(() => store.purgeConversation(live.id)).toThrow('回收站')
    expect(store.getMessages(live.id)).toHaveLength(1)
    store.trashConversation(doomed.id)
    store.purgeConversation(doomed.id)
    expect(store.listTrashedConversations()).toEqual([])
    expect(store.getMessages(doomed.id)).toEqual([])
    store.close()
    const db = new DatabaseSync(path)
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(doomed.id)).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE id = ?').get(doomed.id)).toEqual({ n: 0 })
    db.close()
  })

  it('keeps the trash and custom titles across a restart', () => {
    const path = databasePath()
    const store = new HerStore(path)
    const kept = store.createConversation()
    const trashed = store.createConversation()
    store.renameConversation(kept.id, '留在列表')
    store.addMessage(user('u1', trashed.id, '进回收站的消息'))
    store.trashConversation(trashed.id)
    store.close()
    const reopened = new HerStore(path)
    expect(reopened.listConversations()).toMatchObject([{ id: kept.id, title: '留在列表', titleCustom: true }])
    expect(reopened.listTrashedConversations()).toMatchObject([{ id: trashed.id }])
    expect(reopened.getMessages(trashed.id)).toHaveLength(1)
    reopened.close()
  })
})

describe('tool execution persistence migration', () => {
  it('legacy_tool_result_and_v4_database_remain_readable', async () => {
    const path = databasePath()
    const db = new DatabaseSync(path)
    db.exec(`
      CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, title_custom INTEGER NOT NULL DEFAULT 0, deleted_at TEXT);
      CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('complete','streaming','failed','cancelled')), created_at TEXT NOT NULL, profile_id TEXT, model TEXT, error TEXT, attachments TEXT, tool_calls TEXT);
      PRAGMA user_version = 4;
    `)
    const attachments = [{ type: 'image', name: 'old.png', mimeType: 'image/png', data: 'b2xk', size: 3 }]
    const toolCalls = [{ id: 'old-call', name: 'clock', arguments: {}, result: 'legacy text' }]
    db.prepare('INSERT INTO conversations (id,title,created_at,updated_at) VALUES (?,?,?,?)').run('old', 'old', 'now', 'now')
    db.prepare('INSERT INTO messages (id,conversation_id,role,content,status,created_at,attachments,tool_calls) VALUES (?,?,?,?,?,?,?,?)').run('old-message', 'old', 'assistant', 'history', 'complete', 'now', JSON.stringify(attachments), JSON.stringify(toolCalls))
    db.close()
    const store = new HerStore(path)
    try {
      const message = store.getMessages('old')[0]
      expect(message).toMatchObject({ content: 'history', attachments, toolCalls })
      expect(message.toolCalls![0].status).toBeUndefined()
      const { normalizeToolResult } = await import('../src/core/tools/results')
      expect(normalizeToolResult(message.toolCalls![0].result!)).toEqual({ content: [{ type: 'text', text: 'legacy text' }] })
      expect(store.getTaskRun('missing')).toBeNull()
    } finally { store.close() }
  })

  it('reopening stops incomplete runs and marks dispatched calls unknown without replay', () => {
    const path = databasePath()
    const store = new HerStore(path)
    const conversation = store.createConversation()
    const run = { id: 'run', requestId: 'req', conversationId: conversation.id, assistantMessageId: 'assistant', status: 'running' as const, providerId: 'profile', model: 'm', toolCallsCount: 2, activeMs: 42 }
    store.saveTaskRun(run)
    store.saveToolCall({ id: 'running', runId: run.id, name: 'click', arguments: {}, status: 'running', startedAt: 'now' })
    store.saveToolCall({ id: 'pending', runId: run.id, name: 'read', arguments: {}, status: 'pending' })
    store.saveToolCall({ id: 'finished', runId: run.id, name: 'clock', arguments: {}, status: 'succeeded', result: { content: [{ type: 'text', text: 'ok' }] }, finishedAt: 'then' })
    store.close()
    const reopened = new HerStore(path)
    try {
      expect(reopened.getTaskRun('run')).toEqual({ ...run, status: 'stopped' })
      expect(reopened.listToolCalls('run')).toEqual([
        expect.objectContaining({ id: 'running', status: 'unknown' }),
        expect.objectContaining({ id: 'pending', status: 'cancelled' }),
        expect.objectContaining({ id: 'finished', status: 'succeeded', result: { content: [{ type: 'text', text: 'ok' }] } })
      ])
      reopened.trashConversation(conversation.id)
      reopened.purgeConversation(conversation.id)
      expect(reopened.getTaskRun('run')).toBeNull()
      expect(reopened.listToolCalls('run')).toEqual([])
    } finally { reopened.close() }
  })
})

it('migrates v5 and persists continuation linkage, tool versions and action assessment on reopen', () => {
  const path = databasePath()
  const initial = new HerStore(path)
  const conversation = initial.createConversation()
  initial.close()
  const db = new DatabaseSync(path)
  db.exec('DROP TABLE artifact_owners; DROP TABLE document_owners; DROP TABLE documents; DROP TABLE file_references; DROP TABLE file_grants; ALTER TABLE messages DROP COLUMN files; ALTER TABLE messages DROP COLUMN file_sources; DROP TABLE tool_resolutions; ALTER TABLE tool_executions DROP COLUMN dispatch_phase; ALTER TABLE task_runs DROP COLUMN continuation_of; ALTER TABLE task_runs DROP COLUMN tool_revisions; ALTER TABLE tool_executions DROP COLUMN assessment; DROP TABLE mcp_services; PRAGMA user_version = 5;')
  db.close()
  const store = new HerStore(path)
  const run = { id: 'continued', requestId: 'next', conversationId: conversation.id, assistantMessageId: 'next-assistant', status: 'failed' as const,
    providerId: 'new-profile', model: 'new-model', toolCallsCount: 1, activeMs: 10, continuationOf: 'original', toolRevisions: { send: 'revision-1' } }
  store.saveTaskRun(run)
  const call = { id: 'send', runId: run.id, name: 'send', arguments: {}, status: 'unknown' as const,
    assessment: { effect: 'send' as const, target: 'alice', summary: 'hello', observationId: 'snapshot' } }
  store.saveToolCall(call); store.close()
  const reopened = new HerStore(path)
  expect(reopened.getTaskRun(run.id)).toEqual(run)
  expect(reopened.listToolCalls(run.id)).toEqual([call])
  reopened.close()
})


it('migrates v6 to v7 without changing task history, profiles or settings', () => {
  const path = databasePath()
  const first = new HerStore(path)
  const conversation = first.createConversation()
  const settings = { activeProfileId: null, shortcut: 'Custom', stopShortcut: 'CommandOrControl+Shift+Escape', launchAtLogin: true }
  first.setSettings(settings)
  const run = { id: 'v6-run', requestId: 'v6-request', conversationId: conversation.id, assistantMessageId: 'a', status: 'completed' as const, providerId: 'p', model: 'm', toolCallsCount: 0, activeMs: 1, continuationOf: 'older', toolRevisions: { clock: 'v1' } }
  first.saveTaskRun(run)
  first.close()
  const db = new DatabaseSync(path)
  db.exec('DROP TABLE artifact_owners; DROP TABLE document_owners; DROP TABLE documents; DROP TABLE file_references; DROP TABLE file_grants; ALTER TABLE messages DROP COLUMN files; ALTER TABLE messages DROP COLUMN file_sources; DROP TABLE tool_resolutions; ALTER TABLE tool_executions DROP COLUMN dispatch_phase; DROP TABLE IF EXISTS mcp_services; PRAGMA user_version = 6;')
  db.close()
  const upgraded = new HerStore(path)
  expect(upgraded.getTaskRun(run.id)).toEqual(run)
  expect(upgraded.getSettings()).toEqual(settings)
  upgraded.close()
  const inspected = new DatabaseSync(path)
  expect(inspected.prepare('PRAGMA user_version').get()).toEqual({ user_version: 12 })
  expect(inspected.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mcp_services'").get()).toEqual({ name: 'mcp_services' })
  inspected.close()
  new HerStore(path).close()
})

it('migrates v8 file metadata without rewriting dispatch phases or independent human resolutions', () => {
  const path = databasePath(); const initial = new HerStore(path)
  const conversation = initial.createConversation()
  const run = { id: 'v8-run', requestId: 'v8-request', conversationId: conversation.id, assistantMessageId: 'a', status: 'failed' as const, providerId: 'p', model: 'm', toolCallsCount: 1, activeMs: 42 }
  initial.saveTaskRun(run)
  initial.saveToolCall({ id: 'unknown', runId: run.id, name: 'send', arguments: { text: 'original audit' }, status: 'unknown', dispatchPhase: 'action', assessment: { effect: 'send', target: 'target', summary: 'original' } })
  const unresolved = initial.listUnresolvedToolCalls(conversation.id)[0]
  initial.resolveUnknownToolCall({ conversationId: conversation.id, runId: run.id, callId: 'unknown', revision: unresolved.revision, decision: 'handled' })
  const calls = initial.listToolCalls(run.id); initial.close()
  const db = new DatabaseSync(path)
  db.exec('DROP TABLE artifact_owners; DROP TABLE document_owners; DROP TABLE documents; DROP TABLE file_references; DROP TABLE file_grants; ALTER TABLE messages DROP COLUMN files; ALTER TABLE messages DROP COLUMN file_sources; PRAGMA user_version = 8;')
  db.close()
  const upgraded = new HerStore(path)
  expect(upgraded.getTaskRun(run.id)).toEqual(run)
  expect(upgraded.listToolCalls(run.id)).toEqual(calls)
  expect(upgraded.listToolCalls(run.id)[0]).toMatchObject({ status: 'unknown', dispatchPhase: 'action', resolution: { decision: 'handled' } })
  expect(upgraded.listFileGrants()).toEqual([])
  upgraded.close()
  const inspected = new DatabaseSync(path)
  expect(inspected.prepare('PRAGMA user_version').get()).toEqual({ user_version: 12 })
  inspected.close()
})
