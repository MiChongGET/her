import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openConversationHistory } from '../src/core/agent/factory'
import { startFixtureServer } from './pi-sdk/wire'
import { harness, harnessCleanup } from './helpers/host-harness'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of [...cleanup.splice(0), ...harnessCleanup.splice(0)].reverse()) await close() })

async function withHistory(turns = 2) {
  const s = await startFixtureServer('openai', 'text'); cleanup.push(s.close)
  const f = harness()
  const p = await f.profiles.save({ name: 'p', protocol: 'openai', baseUrl: s.baseUrl + '/v1', model: 'test-model', authMethod: 'none' })
  for (let i = 0; i < turns; i++) {
    const sent = await f.send(f.id, p.id, `question ${i}`)
    await expect.poll(() => f.finished(sent.requestId)?.state, { timeout: 10_000 }).toBe('completed')
  }
  return { f, p }
}
const rows = (f: ReturnType<typeof harness>, table = 'projection_entries') => {
  const db = new DatabaseSync(join(f.directory, 'her.sqlite'))
  try { return db.prepare(`SELECT * FROM ${table} WHERE conversation_id = ? ORDER BY sequence_number`).all(f.id) as Record<string, unknown>[] } finally { db.close() }
}
const raw = (f: ReturnType<typeof harness>, sql: string, ...args: string[]) => {
  const db = new DatabaseSync(join(f.directory, 'her.sqlite'))
  try { return db.prepare(sql).run(...args) } finally { db.close() }
}
const piEntries = async (f: ReturnType<typeof harness>) => (await openConversationHistory(f.directory, f.store.getConversation(f.id)!)).manager.getEntries()

describe('rebuilding the projection from the Pi session', () => {
  it('clearing the projection and reading again gives exactly the same messages', async () => {
    const { f } = await withHistory(3)
    const before = await f.chat.getMessages(f.id)
    expect(before).toHaveLength(6)
    raw(f, 'DELETE FROM projection_entries WHERE conversation_id = ?', f.id)
    expect(rows(f)).toEqual([])
    expect(await f.chat.getMessages(f.id)).toEqual(before)
    expect(rows(f)).toHaveLength(6)
  })

  it('a damaged cursor or stale rows are replaced, not merged', async () => {
    const { f } = await withHistory(2)
    const before = await f.chat.getMessages(f.id)
    raw(f, "UPDATE projection_entries SET content = '{\"id\":\"stale\"}' WHERE conversation_id = ?", f.id)
    raw(f, "UPDATE conversations SET last_entry_id = 'bogus' WHERE id = ?", f.id)
    expect(await f.chat.getMessages(f.id)).toEqual(before)
  })

  it('keeps the order of the conversation and the stable ids of each message', async () => {
    const { f } = await withHistory(2)
    const messages = await f.chat.getMessages(f.id)
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(messages.map(message => message.content).filter((_, index) => index % 2 === 0)).toEqual(['question 0', 'question 1'])
    raw(f, 'DELETE FROM projection_entries WHERE conversation_id = ?', f.id)
    expect((await f.chat.getMessages(f.id)).map(message => message.id)).toEqual(messages.map(message => message.id))
  })
})

describe('catching up when Pi has entries the projection has not seen', () => {
  it('shows a message Pi wrote after the last projection, once', async () => {
    const { f } = await withHistory(1)
    const before = await f.chat.getMessages(f.id)
    expect(before).toHaveLength(2)
    // The crash window: Pi has the entry on disk, SQLite was never told.
    const { manager } = await openConversationHistory(f.directory, f.store.getConversation(f.id)!)
    manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'written to Pi only' }], timestamp: Date.now() })
    expect(rows(f)).toHaveLength(2)
    const after = await f.chat.getMessages(f.id)
    expect(after).toHaveLength(3)
    expect(after.filter(message => message.content === 'written to Pi only')).toHaveLength(1)
    expect(after.slice(0, 2)).toEqual(before)
  })

  it('reading again, or restarting, does not duplicate anything', async () => {
    const { f } = await withHistory(1)
    const { manager } = await openConversationHistory(f.directory, f.store.getConversation(f.id)!)
    manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'written to Pi only' }], timestamp: Date.now() })
    const first = await f.chat.getMessages(f.id)
    for (let i = 0; i < 4; i++) expect(await f.chat.getMessages(f.id)).toEqual(first)
    const { AgentHost } = await import('../src/core/agent/host')
    const restarted = new AgentHost(f.store, f.profiles, f.directory)
    await restarted.ready()
    expect(await restarted.getMessages(f.id)).toEqual(first)
    expect(rows(f)).toHaveLength(first.length)
  })

  it('moves the cursor to the last Pi entry, and does so again as Pi grows', async () => {
    const { f } = await withHistory(1)
    await f.chat.getMessages(f.id)
    const cursor = () => {
      const db = new DatabaseSync(join(f.directory, 'her.sqlite'))
      try { return (db.prepare('SELECT last_entry_id AS id FROM conversations WHERE id = ?').get(f.id) as { id: string }).id } finally { db.close() }
    }
    expect(cursor()).toBe((await piEntries(f)).at(-1)!.id)
    const { manager } = await openConversationHistory(f.directory, f.store.getConversation(f.id)!)
    manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'more' }], timestamp: Date.now() })
    await f.chat.getMessages(f.id)
    expect(cursor()).toBe((await piEntries(f)).at(-1)!.id)
  })

  it('does not let a message in the middle of a run show up twice when the run finishes', async () => {
    const { f, p } = await withHistory(1)
    const sent = await f.send(f.id, p.id, 'another')
    await expect.poll(() => f.finished(sent.requestId)?.state, { timeout: 10_000 }).toBe('completed')
    const messages = await f.chat.getMessages(f.id)
    expect(new Set(messages.map(message => message.id)).size).toBe(messages.length)
    expect(rows(f)).toHaveLength(messages.length)
  })
})
