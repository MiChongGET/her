import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { HerStore, untestedConnections } from '../src/core/storage/store'
import { ProfileService } from '../src/core/storage/profiles'
import { AgentHost } from '../src/core/agent/host'
import { openConversationHistory } from '../src/core/agent/factory'
import { ChatService } from '../src/core/conversation/chat'
import { WorkspaceService } from '../src/core/conversation/workspace'
import { TopicHandoffService, topicHandoffReceiver } from '../src/core/conversation/topic-handoff'
import { handoffKey } from '../src/core/agent/sources'
import { startFixtureServer } from './pi-sdk/wire'

const dispose: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of dispose.splice(0).reverse()) await close() })

async function fixture(withFile = false, baseUrl = 'http://127.0.0.1:1/v1') {
  const directory = mkdtempSync(join(tmpdir(), 'her-handoff-'))
  const store = new HerStore(join(directory, 'her.sqlite'))
  const daily = store.ensureDailyConversation()
  store.saveService({ id: 'service', name: '本地服务', protocol: 'openai', baseUrl, defaultModel: 'fake', authMethod: 'none',
    sealedSecrets: null, hasApiKey: false, hasCustomHeaders: false, maxOutputTokens: null, contextWindow: null,
    models: [{ id: 'fake', longOutput: false, multimodal: false, tests: untestedConnections() }], revision: 1, tests: untestedConnections() })
  store.setSettings({ ...store.getSettings(), activeProfileId: 'service' })
  const codec = { encrypt: async (text: string) => Buffer.from(text), decrypt: async (bytes: Buffer) => bytes.toString() }
  const profiles = new ProfileService(store, codec)
  const host = new AgentHost(store, profiles, directory)
  const chat = new ChatService(store, host)
  dispose.push(async () => { await chat.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true }) })
  const workspace = new WorkspaceService(store, chat)
  const handoff = new TopicHandoffService(store, chat, workspace)
  const { manager } = await openConversationHistory(directory, daily)
  manager.appendCustomEntry('her.run', { userMessageId: 'source-message', assistantMessageId: 'source-answer', ...(withFile ? { fileSources: { fileIds: ['secret-file'] } } : {}) })
  manager.appendMessage({ role: 'user', content: [{ type: 'text', text: '周末想去河边走走' }], timestamp: Date.now() })
  await workspace.select({ section: 'daily' })
  return { store, daily, chat, workspace, handoff, directory, host, profiles }
}

it('confirmed_snapshot_is_the_only_saved_background_and_same_operation_creates_one_topic', async () => {
  const f = await fixture()
  const preview = await f.handoff.preview({ conversationId: f.daily.id, messageIds: ['source-message'] })
  expect(preview.excerpts.map(item => item.text)).toEqual(['周末想去河边走走'])
  expect(f.store.listTopicInfo().filter(item => item.kind === 'work')).toHaveLength(0)
  const operationId = randomUUID()
  const input = { operationId, previewId: preview.id, digest: preview.digest }
  const first = await f.handoff.commit(input)
  expect(first.status).toBe('created')
  expect(await f.handoff.commit(input)).toEqual(first)
  expect(f.store.listTopicInfo().filter(item => item.kind === 'work')).toHaveLength(1)
  const { manager } = await openConversationHistory(f.directory, f.store.getConversation(first.conversationId!)!)
  expect(manager.getEntries().filter(entry => entry.type === 'custom_message' && entry.customType === 'her.topic-handoff')).toHaveLength(1)
  expect(JSON.stringify(manager.buildSessionContext().messages)).not.toContain('her.topic-handoff-anchor')
  await f.workspace.select({ section: 'work', conversationId: first.conversationId })
  expect((await f.chat.getMessages(first.conversationId!))[0].content).toContain('周末想去河边走走')
  await expect(f.handoff.commit({ ...input, digest: 'different' })).rejects.toThrow()
})

it('brings a verified same-service Samantha reply alongside the latest user message', async () => {
  const f = await fixture()
  const { manager } = await openConversationHistory(f.directory, f.daily)
  manager.appendCustomEntry('her.run', { userMessageId: 'pair-user', assistantMessageId: 'pair-answer',
    receiverKey: topicHandoffReceiver(f.store)!.key })
  manager.appendMessage({ role: 'user', content: [{ type: 'text', text: '今天走了远路' }], timestamp: Date.now() })
  manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: '那一路上，有什么让你多看了一眼吗？' }], stopReason: 'stop', timestamp: Date.now(),
    api: 'openai-completions', provider: 'service', model: 'fake', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as never)
  const preview = await f.handoff.preview({ conversationId: f.daily.id, messageIds: ['pair-user', 'pair-answer'] })
  expect(preview.excerpts.map(item => [item.role, item.text])).toEqual([
    ['user', '今天走了远路'], ['assistant', '那一路上，有什么让你多看了一眼吗？']
  ])
  const created = await f.handoff.commit({ operationId: randomUUID(), previewId: preview.id, digest: preview.digest })
  expect(created.status).toBe('created')
  expect((await f.chat.getMessages(created.conversationId!))[0].content).toContain('Samantha 回应：那一路上，有什么让你多看了一眼吗？')
})

it('omits an older reply whose receiving service cannot be proven', async () => {
  const f = await fixture()
  const { manager } = await openConversationHistory(f.directory, f.daily)
  manager.appendCustomEntry('her.run', { userMessageId: 'older-user', assistantMessageId: 'older-answer' })
  manager.appendMessage({ role: 'user', content: [{ type: 'text', text: '想聊聊今天' }], timestamp: Date.now() })
  manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: '我在听' }], stopReason: 'stop', timestamp: Date.now(),
    api: 'openai-completions', provider: 'service', model: 'fake', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as never)
  const preview = await f.handoff.preview({ conversationId: f.daily.id, messageIds: ['older-user', 'older-answer'] })
  expect(preview.excerpts.map(item => item.role)).toEqual(['user'])
  expect(preview.omittedCount).toBe(1)
})

it('accepts an older completed reply when its task proves the same service revision', async () => {
  const f = await fixture()
  f.store.enqueueInput(f.daily.id, '想聊聊今天', null, 'older-request')
  f.store.createTask({ id: 'older-run', conversationId: f.daily.id, requestId: 'older-request', generation: 0,
    status: 'completed', serviceId: 'service', modelId: 'fake', configRevision: 1, error: null, assistantMessageId: 'older-answer' })
  const { manager } = await openConversationHistory(f.directory, f.daily)
  manager.appendCustomEntry('her.run', { runId: 'older-run', profileId: 'service', userMessageId: 'older-user', assistantMessageId: 'older-answer' })
  manager.appendMessage({ role: 'user', content: [{ type: 'text', text: '想聊聊今天' }], timestamp: Date.now() })
  manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: '我在听' }], stopReason: 'stop', timestamp: Date.now(),
    api: 'openai-completions', provider: 'service', model: 'fake', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as never)
  const preview = await f.handoff.preview({ conversationId: f.daily.id, messageIds: ['older-user', 'older-answer'] })
  expect(preview.excerpts.map(item => item.role)).toEqual(['user', 'assistant'])
  const created = await f.handoff.commit({ operationId: randomUUID(), previewId: preview.id, digest: preview.digest })
  expect((await f.chat.getMessages(created.conversationId!))[0].content).toContain('Samantha 回应：我在听')
})

it('previews a verified reply from another service with an explicit transfer notice', async () => {
  const f = await fixture()
  f.store.enqueueInput(f.daily.id, '我在', null, 'prior-request')
  f.store.createTask({ id: 'prior-run', conversationId: f.daily.id, requestId: 'prior-request', generation: 0,
    status: 'completed', serviceId: 'service', modelId: 'fake', configRevision: 1, error: null, assistantMessageId: 'prior-answer' })
  const { manager } = await openConversationHistory(f.directory, f.daily)
  manager.appendCustomEntry('her.run', { runId: 'prior-run', profileId: 'service', userMessageId: 'prior-user', assistantMessageId: 'prior-answer' })
  manager.appendMessage({ role: 'user', content: [{ type: 'text', text: '我在' }], timestamp: Date.now() })
  manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: '我也在，慢慢说。' }], stopReason: 'stop', timestamp: Date.now(),
    api: 'openai-completions', provider: 'service', model: 'fake', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as never)
  f.store.saveService({ ...f.store.getService('service')!, id: 'next-service', name: '当前服务' })
  f.store.setSettings({ ...f.store.getSettings(), activeProfileId: 'next-service' })
  const preview = await f.handoff.preview({ conversationId: f.daily.id, messageIds: ['prior-user', 'prior-answer'] })
  expect(preview.excerpts.map(item => item.role)).toEqual(['user', 'assistant'])
  expect(preview.omittedCount).toBe(0)
  expect(preview.crossServiceReplyCount).toBe(1)
  expect(preview.receiverLabel).toBe('当前服务')
  const created = await f.handoff.commit({ operationId: randomUUID(), previewId: preview.id, digest: preview.digest })
  expect(created.status).toBe('created')
  expect((await f.chat.getMessages(created.conversationId!))[0].content).toContain('Samantha 回应：我也在，慢慢说。')
  f.store.saveService({ ...f.store.getService('service')!, revision: 2 })
  expect((await f.chat.getMessages(created.conversationId!))[0].content).toContain('背景已失效')
})

it('concurrent_confirmations_with_one_operation_create_one_topic', async () => {
  const f = await fixture()
  const preview = await f.handoff.preview({ conversationId: f.daily.id, messageIds: ['source-message'] })
  const input = { operationId: randomUUID(), previewId: preview.id, digest: preview.digest }
  const [first, second] = await Promise.all([f.handoff.commit(input), f.handoff.commit(input)])
  expect(first).toEqual(second)
  expect(first.status).toBe('created')
  expect(f.store.listTopicInfo().filter(item => item.kind === 'work')).toHaveLength(1)
})

it('concurrent_confirmations_with_different_operations_cannot_duplicate_a_preview', async () => {
  const f = await fixture()
  const preview = await f.handoff.preview({ conversationId: f.daily.id, messageIds: ['source-message'] })
  const results = await Promise.allSettled([randomUUID(), randomUUID()].map(operationId =>
    f.handoff.commit({ operationId, previewId: preview.id, digest: preview.digest })))
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(f.store.listTopicInfo().filter(item => item.kind === 'work')).toHaveLength(1)
})

it('receiver_change_while_saving_cannot_publish_the_handoff', async () => {
  const f = await fixture()
  const preview = await f.handoff.preview({ conversationId: f.daily.id, messageIds: ['source-message'] })
  const original = f.chat.saveTopicHandoffBackground.bind(f.chat)
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const saving = vi.spyOn(f.chat, 'saveTopicHandoffBackground').mockImplementation(async (...args) => { await barrier; return original(...args) })
  const pending = f.handoff.commit({ operationId: randomUUID(), previewId: preview.id, digest: preview.digest })
  await vi.waitFor(() => expect(saving).toHaveBeenCalledOnce())
  f.store.setSettings({ ...f.store.getSettings(), activeProfileId: null })
  release()
  expect(await pending).toMatchObject({ status: 'failed', errorCode: 'receiver-changed' })
  await f.workspace.select({ section: 'work' })
  expect(f.workspace.listWorkItems()).toEqual([])
})

it('source_removal_while_saving_cannot_publish_the_handoff', async () => {
  const f = await fixture()
  const preview = await f.handoff.preview({ conversationId: f.daily.id, messageIds: ['source-message'] })
  const original = f.chat.saveTopicHandoffBackground.bind(f.chat)
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const saving = vi.spyOn(f.chat, 'saveTopicHandoffBackground').mockImplementation(async (...args) => { await barrier; return original(...args) })
  const pending = f.handoff.commit({ operationId: randomUUID(), previewId: preview.id, digest: preview.digest })
  await vi.waitFor(() => expect(saving).toHaveBeenCalledOnce())
  f.store.trashConversation(f.daily.id)
  release()
  expect(await pending).toMatchObject({ status: 'failed', errorCode: 'source-changed' })
  await f.workspace.select({ section: 'work' })
  expect(f.workspace.listWorkItems()).toEqual([])
})

it('failed_source_check_creates_nothing', async () => {
  const f = await fixture(true)
  await expect(f.handoff.preview({ conversationId: f.daily.id, messageIds: ['source-message'] })).rejects.toThrow('没有可安全带入')
  expect(f.store.listTopicInfo().filter(item => item.kind === 'work')).toHaveLength(0)
})

it('recover_after_pi_append_before_sqlite_commit_reuses_same_entry', async () => {
  const f = await fixture()
  const preview = await f.handoff.preview({ conversationId: f.daily.id, messageIds: ['source-message'] })
  const finish = f.store.finishTopicHandoff.bind(f.store)
  vi.spyOn(f.store, 'finishTopicHandoff').mockImplementationOnce(() => { throw new Error('injected commit interruption') }).mockImplementation(finish)
  const operationId = randomUUID()
  const pending = await f.handoff.commit({ operationId, previewId: preview.id, digest: preview.digest })
  expect(pending).toMatchObject({ status: 'failed', errorCode: 'storage-failed' })
  await f.workspace.select({ section: 'work' })
  expect(f.workspace.listWorkItems()).toEqual([])
  const recovered = await f.handoff.commit({ operationId, previewId: preview.id, digest: preview.digest })
  expect(recovered?.status).toBe('created')
  const { manager } = await openConversationHistory(f.directory, f.store.getConversation(recovered!.conversationId!)!)
  expect(manager.getEntries().filter(entry => entry.type === 'custom_message' && entry.customType === 'her.topic-handoff')).toHaveLength(1)
})

it('trashed_source_and_changed_receiver_invalidate_saved_background', async () => {
  const f = await fixture()
  const preview = await f.handoff.preview({ conversationId: f.daily.id, messageIds: ['source-message'] })
  const operationId = randomUUID()
  const created = await f.handoff.commit({ operationId, previewId: preview.id, digest: preview.digest })
  const guard = (f.host as unknown as { guardFor(id: string, use: () => void): { valid(keys: string[]): boolean } }).guardFor(created.conversationId!, () => {})
  expect(guard.valid([handoffKey(operationId)])).toBe(true)
  f.store.setSettings({ ...f.store.getSettings(), activeProfileId: null })
  expect(guard.valid([handoffKey(operationId)])).toBe(false)
  f.store.setSettings({ ...f.store.getSettings(), activeProfileId: 'service' })
  f.store.trashConversation(f.daily.id)
  expect(guard.valid([handoffKey(operationId)])).toBe(false)
  expect((await f.chat.getMessages(created.conversationId!))[0].content).toContain('背景已失效')
})

it('revoked_handoff_seed_and_its_reply_are_absent_from_real_provider_requests', async () => {
  const server = await startFixtureServer('openai')
  dispose.push(server.close)
  const f = await fixture(false, `${server.baseUrl}/v1`)
  const preview = await f.handoff.preview({ conversationId: f.daily.id, messageIds: ['source-message'] })
  const created = await f.handoff.commit({ operationId: randomUUID(), previewId: preview.id, digest: preview.digest })
  expect(created.status).toBe('created')
  const target = created.conversationId!
  const first = await f.chat.send({ requestId: randomUUID(), conversationId: target, profileId: 'service', content: '先聊这件事' })
  expect(first.userMessage.content).toBe('先聊这件事')
  await expect.poll(() => server.requests.length).toBe(1)
  await expect.poll(() => f.chat.getActiveRequest(target)).toBeNull()
  expect(JSON.stringify(server.requests[0].body)).toContain('周末想去河边走走')
  f.store.saveService({ ...f.store.getService('service')!, id: 'other-service', name: '另一个接收服务' })
  f.store.setSettings({ ...f.store.getSettings(), activeProfileId: 'other-service' })
  await f.chat.send({ requestId: randomUUID(), conversationId: target, profileId: 'other-service', content: '换服务继续聊' })
  await expect.poll(() => server.requests.length).toBe(2)
  await expect.poll(() => f.chat.getActiveRequest(target)).toBeNull()
  expect(JSON.stringify(server.requests[1].body)).not.toContain('周末想去河边走走')
  f.store.setSettings({ ...f.store.getSettings(), activeProfileId: 'service' })
  f.store.trashConversation(f.daily.id)
  const second = await f.chat.send({ requestId: randomUUID(), conversationId: target, profileId: 'service', content: '继续聊' })
  expect(second.userMessage.content).toBe('继续聊')
  await expect.poll(() => server.requests.length).toBe(3)
  await expect.poll(() => f.chat.getActiveRequest(target)).toBeNull()
  expect(server.requests).toHaveLength(3)
  expect(JSON.stringify(server.requests[2].body)).not.toContain('周末想去河边走走')
  await f.chat.shutdown()
  const restarted = new ChatService(f.store, new AgentHost(f.store, f.profiles, f.directory))
  dispose.push(() => restarted.shutdown())
  await restarted.send({ requestId: randomUUID(), conversationId: target, profileId: 'service', content: '重启后继续' })
  await expect.poll(() => server.requests.length).toBe(4)
  await expect.poll(() => restarted.getActiveRequest(target)).toBeNull()
  expect(JSON.stringify(server.requests[3].body)).not.toContain('周末想去河边走走')
})
