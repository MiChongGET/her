import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { harness, harnessCleanup } from './helpers/host-harness'
import { startFixtureServer } from './pi-sdk/wire'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of [...cleanup.splice(0), ...harnessCleanup.splice(0)].reverse()) await close() })

it('restores the SDK context estimate without new model requests or rewriting history; another model never inherits it', async () => {
  const server = await startFixtureServer('openai'); cleanup.push(server.close)
  const f = harness()
  const p = await f.profiles.save({ name: 'p', protocol: 'openai', baseUrl: server.baseUrl + '/v1', model: 'test-model', contextWindow: 128000, authMethod: 'none' })
  const input = { conversationId: f.id, profileId: p.id }
  expect(await f.host.getConversationContext(input)).toEqual({ tokens: null, contextWindow: 128000 })
  const sent = await f.send(f.id, p.id, 'hi')
  await expect.poll(() => f.finished(sent.requestId)?.state).toBe('completed')
  const folder = join(f.directory, 'pi/sessions', f.id), file = join(folder, readdirSync(folder)[0])
  const before = readFileSync(file)
  expect(await f.host.getConversationContext(input)).toEqual({ tokens: 16, contextWindow: 128000 })
  expect(readFileSync(file)).toEqual(before)
  expect(server.requests).toHaveLength(1)
  const { AgentHost } = await import('../src/core/agent/host')
  const restarted = new AgentHost(f.store, f.profiles, f.directory)
  await restarted.ready()
  expect(await restarted.getConversationContext(input)).toEqual({ tokens: 16, contextWindow: 128000 })
  const other = await f.profiles.save({ name: 'other', protocol: 'openai', baseUrl: server.baseUrl + '/v1', model: 'test-model', contextWindow: 8192, authMethod: 'none' })
  expect(await restarted.getConversationContext({ ...input, profileId: other.id })).toEqual({ tokens: null, contextWindow: 8192 })
  await restarted.stopAll()
})

it('does not display SDK zero defaults as measured usage', async () => {
  const server = await startFixtureServer('openai', 'no-usage'); cleanup.push(server.close)
  const f = harness()
  const p = await f.profiles.save({ name: 'p', protocol: 'openai', baseUrl: server.baseUrl + '/v1', model: 'test-model', contextWindow: 128000, authMethod: 'none' })
  const sent = await f.send(f.id, p.id, 'hi')
  await expect.poll(() => f.finished(sent.requestId)?.state).toBe('completed')
  expect(await f.host.getConversationContext({ conversationId: f.id, profileId: p.id })).toEqual({ tokens: null, contextWindow: 128000 })
})

it('clears the pre-compaction estimate until a new provider response reports usage', async () => {
  const server = await startFixtureServer('openai'); cleanup.push(server.close)
  const f = harness()
  const p = await f.profiles.save({ name: 'p', protocol: 'openai', baseUrl: server.baseUrl + '/v1', model: 'test-model', contextWindow: 4096, authMethod: 'none' })
  for (let i = 0; i < 5; i++) {
    const sent = await f.send(f.id, p.id, `${i}:${'sample '.repeat(300)}`)
    await expect.poll(() => f.finished(sent.requestId)?.state).toBe('completed')
  }
  const input = { conversationId: f.id, profileId: p.id }
  await f.chat.compact(input)
  expect(await f.host.getConversationContext(input)).toEqual({ tokens: null, contextWindow: 4096 })
  const next = await f.send(f.id, p.id, 'continue')
  await expect.poll(() => f.finished(next.requestId)?.state).toBe('completed')
  expect((await f.host.getConversationContext(input)).tokens).toBeGreaterThan(0)
})

it('does not reuse a snapshot after a newer Pi message was written before a crash', async () => {
  const server = await startFixtureServer('openai'); cleanup.push(server.close)
  const f = harness()
  const p = await f.profiles.save({ name: 'p', protocol: 'openai', baseUrl: server.baseUrl + '/v1', model: 'test-model', contextWindow: 128000, authMethod: 'none' })
  const sent = await f.send(f.id, p.id, 'hi')
  await expect.poll(() => f.finished(sent.requestId)?.state).toBe('completed')
  const { openConversationHistory } = await import('../src/core/agent/factory')
  const { manager } = await openConversationHistory(f.directory, f.store.getConversation(f.id)!)
  manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'written before crash' }], timestamp: Date.now() })
  expect(await f.host.getConversationContext({ conversationId: f.id, profileId: p.id })).toEqual({ tokens: null, contextWindow: 128000 })
})
