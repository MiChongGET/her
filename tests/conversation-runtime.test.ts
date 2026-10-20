import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HerStore } from '../src/core/storage/store'
import { ProfileService } from '../src/core/storage/profiles'
import { FileAccessService } from '../src/core/files/access'
import { AgentHost } from '../src/core/agent/host'
import { ChatService } from '../src/core/conversation/chat'
import type { ChatEvent, RequestEvent } from '../src/shared/types'
import { startFixtureServer } from './pi-sdk/wire'
import { retryPolicy } from '../src/core/agent/factory'

// Real backoff is seconds long; nothing in this file is about timing.
retryPolicy.baseDelayMs = 10

const codec = { encrypt: async (text: string) => Buffer.from(text), decrypt: async (bytes: Buffer) => bytes.toString() }
function fixture(secretCodec = codec) {
  const directory = mkdtempSync(join(tmpdir(), 'her-conversation-runtime-'))
  const store = new HerStore(join(directory, 'her.sqlite'))
  const profiles = new ProfileService(store, secretCodec)
  const host = new AgentHost(store, profiles, directory)
  const events: ChatEvent[] = [], requests: RequestEvent[] = []
  const chat = new ChatService(store, host, event => events.push(structuredClone(event)), event => requests.push(event))
  const id = randomUUID()
  store.createConversation(id, randomUUID(), '新对话')
  return { directory, store, profiles, host, chat, events, requests, id,
    close: async () => { await chat.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true }) } }
}

describe('conversation loading', () => {
  it('loads empty messages and grants, while rejecting missing or trashed conversations', async () => {
    const f = fixture()
    try {
      expect(f.store.hasConversation(f.id)).toBe(true)
      expect(await f.chat.getMessages(f.id)).toEqual([])
      expect(new FileAccessService(f.store).listGrants(f.id)).toEqual([])
      expect(new FileAccessService(f.store).listPersistentGrants()).toEqual([])
      f.store.trashConversation(f.id)
      expect(f.store.hasConversation(f.id)).toBe(false)
      await expect(f.chat.getMessages(f.id)).rejects.toThrow('不存在')
      expect(() => new FileAccessService(f.store).listGrants(f.id)).toThrow()
    } finally { await f.close() }
  })

  it('persists scoped grants and revocations without revealing filesystem paths', async () => {
    const f = fixture()
    try {
      const file = join(f.directory, 'sample.txt')
      writeFileSync(file, 'hello')
      const files = new FileAccessService(f.store)
      const [grant] = await files.grant([file], { conversationId: f.id, scope: 'conversation', kind: 'file' })
      expect(files.listGrants(f.id)).toEqual([grant])
      expect(JSON.stringify(files.listGrants(f.id))).not.toContain(f.directory)
      const second = randomUUID(); f.store.createConversation(second, randomUUID(), 'other')
      expect(files.listGrants(second)).toEqual([])
      const reopened = new HerStore(join(f.directory, 'her.sqlite'))
      try { expect(new FileAccessService(reopened).listGrants(f.id)).toEqual([grant]) } finally { reopened.close() }
      await files.revoke(grant.id)
      expect(files.listGrants(f.id)).toEqual([])
    } finally { await f.close() }
  })
})

for (const protocol of ['openai', 'anthropic', 'openai-responses'] as const) {
  it(`sends through a real Pi session with ${protocol}, persists and restores history`, async () => {
    const server = await startFixtureServer(protocol, 'text')
    const f = fixture()
    try {
      const profile = await f.profiles.save({ name: 'fixture', protocol, baseUrl: server.baseUrl + '/prefix/v1', model: 'test-model', authMethod: 'api-key', apiKey: 'synthetic-credential-fixture' })
      const requestId = randomUUID()
      const sent = await f.chat.send({ requestId, conversationId: f.id, profileId: profile.id, content: 'hello' })
      await expect.poll(() => f.requests.find(event => event.requestId === requestId && event.state === 'completed')).toBeDefined()
      expect(f.events.some(event => !event.done && event.message.content === '你好🌙')).toBe(true)
      const messages = await f.chat.getMessages(f.id)
      expect(messages).toHaveLength(2)
      expect(messages[0]).toMatchObject({ id: sent.userMessage.id, role: 'user', content: 'hello', status: 'complete' })
      expect(messages[1]).toMatchObject({ id: sent.assistantMessage.id, role: 'assistant', content: '你好🌙', status: 'complete' })
      expect(Date.parse(messages[0].createdAt)).toBeLessThanOrEqual(Date.parse(messages[1].createdAt))
      expect(f.chat.getActiveRequest()).toBeNull()
      expect(server.requests[0].headers.authorization ?? server.requests[0].headers['x-api-key']).toContain('synthetic-credential-fixture')
      const restored = new ChatService(f.store, new AgentHost(f.store, f.profiles, f.directory))
      expect(await restored.getMessages(f.id)).toEqual(messages)
      const next = randomUUID()
      await restored.send({ requestId: next, conversationId: f.id, profileId: profile.id, content: 'follow up' })
      await expect.poll(() => restored.getActiveRequest()).toBeNull()
      expect(server.requests).toHaveLength(2)
      expect(JSON.stringify(server.requests[1].body)).toContain('hello')
      expect(JSON.stringify(server.requests[1].body)).toContain('你好🌙')
      expect(JSON.stringify(server.requests[1].body)).toContain('follow up')
      expect(await restored.getMessages(f.id)).toHaveLength(4)
      await restored.shutdown()
    } finally { await f.close(); await server.close() }
  }, 20_000)
}

for (const scenario of ['http-error', 'missing-terminal', 'truncated', 'empty-text', 'redirect'] as const) {
  it(`reports ${scenario} as failed, clears busy state and preserves safe history`, async () => {
    const server = await startFixtureServer('anthropic', scenario)
    const f = fixture()
    try {
      const profile = await f.profiles.save({ name: 'fixture', protocol: 'anthropic', baseUrl: server.baseUrl + '/v1', model: 'test-model', authMethod: 'none' })
      const requestId = randomUUID()
      await f.chat.send({ requestId, conversationId: f.id, profileId: profile.id, content: 'hello' })
      await expect.poll(() => f.requests.find(event => event.requestId === requestId && event.state === 'failed'), { timeout: 5000 }).toBeDefined()
      expect(f.chat.getActiveRequest()).toBeNull()
      const messages = await f.chat.getMessages(f.id)
      expect(messages[0]).toMatchObject({ role: 'user', content: 'hello' })
      expect(messages[1]).toMatchObject({ role: 'assistant', status: 'failed' })
      expect(JSON.stringify(messages)).not.toContain('synthetic_secret_marker')
      // A stream that dropped without finishing is transient and is retried twice; every other failure is tried once.
      expect(server.requests).toHaveLength(scenario === 'missing-terminal' ? 3 : 1)
    } finally { await f.close(); await server.close() }
  })
}

it('stops an in-flight stream and allows the conversation to send again', async () => {
  const server = await startFixtureServer('openai-responses', ['hang', 'text'])
  const f = fixture()
  try {
    const profile = await f.profiles.save({ name: 'fixture', protocol: 'openai-responses', baseUrl: server.baseUrl + '/v1', model: 'test-model', authMethod: 'none' })
    const requestId = randomUUID()
    await f.chat.send({ requestId, conversationId: f.id, profileId: profile.id, content: 'hello' })
    await expect.poll(() => server.requests.length).toBe(1)
    f.chat.cancel(requestId)
    await expect.poll(() => f.chat.getActiveRequest()).toBeNull()
    expect((await f.chat.getMessages(f.id))[1].status).toBe('cancelled')
    expect(f.requests.at(-1)?.state).toBe('cancelled')
    await f.chat.send({ requestId: randomUUID(), conversationId: f.id, profileId: profile.id, content: 'again' })
    await expect.poll(() => f.chat.getActiveRequest()).toBeNull()
    expect((await f.chat.getMessages(f.id)).at(-1)).toMatchObject({ content: '你好🌙', status: 'complete' })
  } finally { await f.close(); await server.close() }
})

it('rejects sends into missing or trashed conversations before any model request', async () => {
  const f = fixture()
  try {
    f.store.trashConversation(f.id)
    await expect(f.chat.send({ requestId: randomUUID(), conversationId: f.id, profileId: 'missing', content: 'hello' })).rejects.toThrow('不存在')
    expect(f.chat.getActiveRequest()).toBeNull()
  } finally { await f.close() }
})

it('does not mark an OpenAI stream complete when EOF arrives before DONE', async () => {
  const server = await startFixtureServer('openai', 'missing-terminal')
  const f = fixture()
  try {
    const profile = await f.profiles.save({ name: 'fixture', protocol: 'openai', baseUrl: server.baseUrl + '/v1', model: 'test-model', authMethod: 'none' })
    await f.chat.send({ requestId: randomUUID(), conversationId: f.id, profileId: profile.id, content: 'hello' })
    await expect.poll(() => f.chat.getActiveRequest()).toBeNull()
    expect((await f.chat.getMessages(f.id))[1].status).toBe('failed')
  } finally { await f.close(); await server.close() }
})

it('honors stop while the saved credentials are still being read', async () => {
  const server = await startFixtureServer('openai', 'text')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const f = fixture({ ...codec, decrypt: async bytes => { await gate; return bytes.toString() } })
  try {
    const profile = await f.profiles.save({ name: 'fixture', protocol: 'openai', baseUrl: server.baseUrl + '/v1', model: 'test-model', authMethod: 'api-key', apiKey: 'fixture-key' })
    const requestId = randomUUID()
    const sending = f.chat.send({ requestId, conversationId: f.id, profileId: profile.id, content: 'hello' })
    f.chat.cancel(requestId)
    release()
    await expect(sending).rejects.toThrow('停止')
    expect(server.requests).toHaveLength(0)
    expect(f.chat.getActiveRequest()).toBeNull()
  } finally { release(); await f.close(); await server.close() }
})

it('retains an admitted user message and cancelled reply when stopped during session initialization', async () => {
  const f = fixture()
  try {
    const profile = await f.profiles.save({ name: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'test-model', authMethod: 'none' })
    const requestId = randomUUID()
    const sent = await f.chat.send({ requestId, conversationId: f.id, profileId: profile.id, content: 'keep this message' })
    f.chat.cancel(requestId)
    await f.host.stop(f.id)
    expect(await f.chat.getMessages(f.id)).toMatchObject([
      { id: sent.userMessage.id, role: 'user', content: 'keep this message' },
      { id: sent.assistantMessage.id, role: 'assistant', status: 'cancelled' }
    ])
  } finally { await f.close() }
})
