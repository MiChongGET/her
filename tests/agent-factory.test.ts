import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Type } from 'typebox'
import { createHerAgentSession } from '../src/core/agent/factory'
import { startFixtureServer } from './pi-sdk/wire'
import { harness, harnessCleanup } from './helpers/host-harness'
import { openConversationHistory } from '../src/core/agent/factory'
import type { StoredConversation } from '../src/core/storage/store'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of [...cleanup.splice(0), ...harnessCleanup.splice(0)].reverse()) await close() })

const tool = (name: string) => ({ name, label: name, description: name, parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) })

describe('the tool whitelist is checked after the session is built', () => {
  async function build(tools: ReturnType<typeof tool>[]) {
    const directory = mkdtempSync(join(tmpdir(), 'her-factory-')); cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    const s = await startFixtureServer('openai', 'text'); cleanup.push(s.close)
    const provider = { id: 'p', name: 'p', protocol: 'openai' as const, baseUrl: s.baseUrl + '/v1', model: 'm', apiKey: 'k', customHeaders: {} }
    const conversation = { id: randomUUID(), piSessionId: randomUUID() } as StoredConversation
    return createHerAgentSession(provider, conversation, directory, 'prompt', new AbortController().signal, undefined, tools as never)
  }
  it('exposes exactly the tools it was given, and no built-in ones', async () => {
    const { session } = await build([tool('alpha'), tool('beta')])
    try { expect([...session.getActiveToolNames()].sort()).toEqual(['alpha', 'beta']) } finally { session.dispose() }
  })
  it('exposes nothing when it was given nothing', async () => {
    const { session } = await build([])
    try { expect(session.getActiveToolNames()).toEqual([]) } finally { session.dispose() }
  })
  it('refuses to start when the session ends up with a tool set that differs from the one given', async () => {
    // Two tools sharing a name: Pi keeps one, so the exposed set no longer matches what was handed in.
    await expect(build([tool('same'), tool('same')])).rejects.toThrow('未授权的工具')
  })
})

describe('history is not cut at the old 50 messages / 64,000 characters', () => {
  async function seeded(messages: number, charsEach: number) {
    const s = await startFixtureServer('openai', 'text'); cleanup.push(s.close)
    const f = harness()
    const p = await f.profiles.save({ name: 'p', protocol: 'openai', baseUrl: s.baseUrl + '/v1', model: 'test-model', authMethod: 'none', contextWindow: 10_000_000 })
    const { manager } = await openConversationHistory(f.directory, f.store.getConversation(f.id)!)
    const now = Date.now()
    for (let i = 0; i < messages; i++) {
      const text = `MARK-${i} ` + 'x'.repeat(charsEach)
      if (i % 2 === 0) manager.appendMessage({ role: 'user', content: [{ type: 'text', text }], timestamp: now + i })
      else manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', timestamp: now + i,
        api: 'openai-completions', provider: p.id, model: 'test-model', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as never)
    }
    const sent = await f.send(f.id, p.id, 'latest question')
    await expect.poll(() => f.finished(sent.requestId)?.state, { timeout: 20_000 }).toBe('completed')
    return JSON.stringify(s.requests[0].body)
  }
  it('sends all 120 earlier messages, including the very first, to the model', async () => {
    const body = await seeded(120, 20)
    expect(body).toContain('MARK-0 ')
    expect(body).toContain('MARK-119 ')
    expect(body).toContain('MARK-60 ')
    expect(body).toContain('latest question')
  }, 40_000)
  it('sends more than 64,000 characters of earlier history, starting from the first message', async () => {
    const body = await seeded(10, 12_000)
    expect(body.length).toBeGreaterThan(100_000)
    expect(body).toContain('MARK-0 ')
    expect(body).toContain('MARK-9 ')
  }, 40_000)
})
