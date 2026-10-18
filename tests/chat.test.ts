import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ChatEvent, ProviderEvent, StreamChatInput, RequestEvent, RuntimeProvider } from '../src/shared/types'
import { HerStore } from '../src/core/storage/store'
import { ProfileService } from '../src/core/storage/profiles'
import { ChatService } from '../src/core/conversation/chat'
import { ProviderError, streamChat } from '../src/core/providers/stream'
import { ToolArtifactStore } from '../src/core/tools/artifacts'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import { McpRegistryAdapter, mcpToolName } from '../src/core/mcp/registry-adapter'
import peekabooSkill from '../src/core/skills/peekaboo/SKILL.md?raw'

const stores: HerStore[] = []
const directories: string[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function setup(stream: (input: StreamChatInput) => AsyncGenerator<ProviderEvent>, path = ':memory:') {
  const store = new HerStore(path)
  stores.push(store)
  const profiles = new ProfileService(store, {
    encrypt: async () => { throw new Error('not needed without secrets') },
    decrypt: async () => { throw new Error('not needed without secrets') }
  })
  const profile = await profiles.save({
    name: '测试服务', protocol: 'openai', baseUrl: 'http://localhost:1234/v1', model: 'test-model'
  })
  const conversation = store.createConversation()
  const events: ChatEvent[] = []
  const requestEvents: RequestEvent[] = []
  const waiters = new Map<string, () => void>()
  const tools = new SimpleToolRegistry()
  const chat = new ChatService(store, profiles, event => {
    events.push(structuredClone(event))
    if (event.done) waiters.get(event.requestId)?.()
  }, () => '你是一个测试助手', stream, tools, undefined, undefined, event => requestEvents.push(structuredClone(event)))
  const wait = (id: string) => new Promise<void>(resolve => {
    if (events.some(event => event.requestId === id && event.done)) resolve()
    else waiters.set(id, resolve)
  })
  return { store, profiles, profile, conversation, events, requestEvents, chat, wait, tools }
}

describe('independent built-in skill context', () => {
  function register(tools: SimpleToolRegistry) {
    const adapter = new McpRegistryAdapter(tools, 'Mac operations')
    adapter.register('native', 1, [{ name: 'app', inputSchema: { type: 'object', properties: { action: { type: 'string' } } } }], {}, () => true, () => async () => ({ content: [] }))
    return adapter
  }

  it.each(['帮我打开文本编辑器', '继续刚才那件事', '今天心情不错'])('automatically provides the original skill without MCP or keyword routing: %s', async content => {
    const inputs: StreamChatInput[] = []
    const context = await setup(async function* (input) { inputs.push(input); yield { type: 'text', text: '好' }; yield { type: 'done' } })
    await context.chat.send({ requestId: 'skill', conversationId: context.conversation.id, profileId: context.profile.id, content })
    await context.wait('skill')
    expect(inputs[0].system).toContain('你是一个测试助手')
    expect(inputs[0].system).toContain(peekabooSkill)
    expect(inputs[0].tools).toBeUndefined()
  })

  it('keeps skills independent of MCP discovery, tool rounds, task continuation and disconnection', async () => {
    const inputs: StreamChatInput[] = []
    const context = await setup(async function* (input) {
      inputs.push(input)
      if (inputs.length === 1) yield { type: 'tool', id: 'clock-read', name: 'clock', arguments: {} }
      else { yield { type: 'text', text: '已读取' } }
      yield { type: 'done' }
    })
    const adapter = register(context.tools)
    context.tools.register({ name: 'clock', description: 'Read clock', parameters: {} }, async () => ({ content: [{ type: 'text', text: '12:00' }] }), { assess: async () => ({ effect: 'read', target: 'clock', summary: 'Read clock' }) })
    await context.chat.send({ requestId: 'rounds', conversationId: context.conversation.id, profileId: context.profile.id, content: '帮我处理' })
    await context.wait('rounds')
    expect(inputs).toHaveLength(2)
    expect(inputs.every(input => input.system?.includes(peekabooSkill))).toBe(true)
    expect(inputs[0].tools).toEqual([...adapter.definitions(), expect.objectContaining({ name: 'clock' })])
    expect(Object.keys(inputs[0].tools![0]).sort()).toEqual(['description', 'name', 'parameters'])
    const run = context.chat.getConversationTask(context.conversation.id)!.run
    context.store.saveTaskRun({ ...run, status: 'stopped' })
    await context.chat.continueTask({ requestId: 'resume-skill', runId: run.id, profileId: context.profile.id })
    await context.wait('resume-skill')
    expect(inputs.at(-1)?.system).toContain(peekabooSkill)
    adapter.clear()
    await context.chat.send({ requestId: 'disconnected', conversationId: context.conversation.id, profileId: context.profile.id, content: '继续' })
    await context.wait('disconnected')
    expect(inputs.at(-1)?.system).toContain(peekabooSkill)
    expect(inputs.at(-1)?.system).not.toContain(mcpToolName('native', 'app'))
  })
})

describe('one continuous local text conversation', () => {
  it('provides the actual Host operating system to the model when native tools are available', async () => {
    const inputs: StreamChatInput[] = []
    const context = await setup(async function* (input) { inputs.push(input); yield { type: 'text', text: '读取真实系统' }; yield { type: 'done' } })
    context.tools.register({ name: 'native', description: 'Native action', parameters: {} }, async () => ({ content: [] }))
    await context.chat.send({ requestId: 'host-os', conversationId: context.conversation.id, profileId: context.profile.id, content: '打开文本编辑器' })
    await context.wait('host-os')
    expect(inputs[0].system).toContain(`Host 实际操作系统：${process.platform}`)
    if (process.platform === 'darwin') expect(inputs[0].system).toContain('TextEdit')
    expect(inputs[0].system).toContain('不得编造当前目录')
  })

  it('publishes and hydrates conversation browser grants across requests, and revocation restores approval', async () => {
    let round = 0
    const context = await setup(async function* () {
      if (++round % 2) yield { type: 'tool', id: `call-${round}`, name: 'browser', arguments: {} }
      else yield { type: 'text', text: '完成' }
      yield { type: 'done' }
    })
    let calls = 0
    context.tools.register({ name: 'browser', description: 'Browser', parameters: {} }, async () => {
      calls++; return { content: [{ type: 'text', text: 'page' }] }
    }, { conversationApprovalScope: 'connection', assess: async () => ({ effect: 'unknown', target: 'browser', summary: 'Read Chrome' }) })
    const send = (requestId: string) => context.chat.send({ requestId, conversationId: context.conversation.id, profileId: context.profile.id, content: '读取页面' })
    await send('grant')
    await new Promise<void>(resolve => setImmediate(resolve))
    const first = context.chat.getConversationTask(context.conversation.id)!.approval!
    context.chat.decideApproval({ approvalId: first.id, revision: first.revision, decision: 'approve-conversation' })
    await context.wait('grant')
    expect(context.chat.getConversationTask(context.conversation.id)?.browserAutoApproved).toBe(true)
    expect(context.events.at(-1)?.task?.browserAutoApproved).toBe(true)
    await send('next')
    await context.wait('next')
    expect(calls).toBe(2)
    expect(context.events.filter(event => event.task?.approval)).toHaveLength(1)
    context.chat.revokeConversationApprovals(context.conversation.id)
    expect(context.chat.getConversationTask(context.conversation.id)?.browserAutoApproved).toBeUndefined()
    await send('revoked')
    await new Promise<void>(resolve => setImmediate(resolve))
    const pending = context.chat.getConversationTask(context.conversation.id)!.approval!
    expect(pending).toBeDefined()
    expect(calls).toBe(2)
    context.chat.decideApproval({ approvalId: pending.id, revision: pending.revision, decision: 'approve' })
    await context.wait('revoked')
    expect(calls).toBe(3)
  })

  it('streams visible text, saves the finished response, and carries prior turns into the next request', async () => {
    const inputs: StreamChatInput[] = []
    const context = await setup(async function* (input) {
      inputs.push(input)
      yield { type: 'text', text: '慢慢' }
      yield { type: 'text', text: '说，我在。' }
      yield { type: 'done' }
    })
    const first = await context.chat.send({
      requestId: 'request-1', conversationId: context.conversation.id,
      profileId: context.profile.id, content: '今天开始新项目了'
    })
    await context.wait('request-1')
    expect(context.store.getMessages(context.conversation.id)[1]).toMatchObject({
      id: first.assistantMessage.id, content: '慢慢说，我在。', status: 'complete', model: 'test-model'
    })
    expect(context.events.filter(event => !event.done).some(event => event.message.content === '慢慢')).toBe(true)
    await context.chat.send({
      requestId: 'request-2', conversationId: context.conversation.id,
      profileId: context.profile.id, content: '你记得刚才我说什么吗？'
    })
    await context.wait('request-2')
    expect(inputs[1].messages).toEqual([
      { role: 'user', content: '今天开始新项目了' },
      { role: 'assistant', content: '慢慢说，我在。' },
      { role: 'user', content: '你记得刚才我说什么吗？' }
    ])
    expect(context.store.listConversations()[0].title).toBe('今天开始新项目了')
  })

  it('retains partial content on cancellation and ignores text arriving after abort', async () => {
    let resume!: () => void
    const gate = new Promise<void>(resolve => { resume = resolve })
    const context = await setup(async function* () {
      yield { type: 'text', text: '已经显示的部分' }
      await gate
      yield { type: 'text', text: '不应该出现' }
      yield { type: 'done' }
    })
    const sent = await context.chat.send({
      requestId: 'cancel', conversationId: context.conversation.id,
      profileId: context.profile.id, content: '聊一会'
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    context.chat.cancel('cancel')
    resume()
    await context.wait('cancel')
    expect(context.store.getMessages(context.conversation.id)[1]).toMatchObject({
      id: sent.assistantMessage.id, content: '已经显示的部分', status: 'cancelled'
    })
    expect(context.events.at(-1)?.done).toBe(true)
  })

  it('retries a failed answer without duplicating the user message', async () => {
    let attempts = 0
    const context = await setup(async function* () {
      attempts++
      if (attempts === 1) throw new ProviderError('http_401', '鉴权失败')
      yield { type: 'text', text: '这次连接好了。' }
      yield { type: 'done' }
    })
    const first = await context.chat.send({
      requestId: 'fail', conversationId: context.conversation.id,
      profileId: context.profile.id, content: '你好'
    })
    await context.wait('fail')
    expect(context.store.getMessages(context.conversation.id)[1].status).toBe('failed')
    const retry = await context.chat.send({
      requestId: 'retry', conversationId: context.conversation.id,
      profileId: context.profile.id, content: '你好', retryMessageId: first.assistantMessage.id
    })
    await context.wait('retry')
    expect(retry.userMessage.id).toBe(first.userMessage.id)
    expect(context.store.getMessages(context.conversation.id)).toHaveLength(2)
    expect(context.store.getMessages(context.conversation.id)[1]).toMatchObject({
      content: '这次连接好了。', status: 'complete'
    })
  })

  it('binds the selected model to this request without changing another conversation', async () => {
    const inputs: StreamChatInput[] = []
    const context = await setup(async function* (input) {
      inputs.push(input)
      yield { type: 'text', text: input.provider.model }
      yield { type: 'done' }
    })
    await context.chat.send({
      requestId: 'one', conversationId: context.conversation.id,
      profileId: context.profile.id, content: '第一个话题'
    })
    await context.wait('one')
    const otherProfile = await context.profiles.save({
      name: 'Claude', protocol: 'anthropic', baseUrl: 'http://localhost:1234/v1', model: 'other-model'
    })
    const otherConversation = context.store.createConversation()
    await context.chat.send({
      requestId: 'two', conversationId: otherConversation.id,
      profileId: otherProfile.id, content: '另一个话题'
    })
    await context.wait('two')
    expect(inputs[1].provider.protocol).toBe('anthropic')
    expect(inputs[1].messages).toEqual([{ role: 'user', content: '另一个话题' }])
    expect(context.store.getMessages(context.conversation.id)[1].model).toBe('test-model')
  })

  it('rejects simultaneous sends and rejects reused request IDs without a second generation', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const context = await setup(async function* () {
      await gate
      yield { type: 'text', text: '完成' }
      yield { type: 'done' }
    })
    const input = {
      requestId: 'same', conversationId: context.conversation.id,
      profileId: context.profile.id, content: '一次就好'
    }
    await context.chat.send(input)
    await expect(context.chat.send({ ...input, requestId: 'another' })).rejects.toThrow('回答')
    release()
    await context.wait('same')
    await expect(context.chat.send(input)).rejects.toThrow('请求')
    expect(context.store.getMessages(context.conversation.id)).toHaveLength(2)
  })

  it('does not mark an empty or prematurely finished provider response complete', async () => {
    const context = await setup(async function* () { yield { type: 'text', text: '半段回答' } })
    await context.chat.send({
      requestId: 'incomplete', conversationId: context.conversation.id,
      profileId: context.profile.id, content: '测试中断'
    })
    await context.wait('incomplete')
    expect(context.store.getMessages(context.conversation.id)[1]).toMatchObject({
      content: '半段回答', status: 'failed'
    })
  })

  it('leaves no partial turn on an insertion failure and permits resending the same draft once recovered', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'her-chat-failure-'))
    directories.push(directory)
    const path = join(directory, 'her.sqlite')
    const context = await setup(async function* () {
      yield { type: 'text', text: 'OK' }
      yield { type: 'done' }
    }, path)
    const db = new DatabaseSync(path)
    try {
      db.exec("CREATE TRIGGER fail_assistant BEFORE INSERT ON messages WHEN NEW.role = 'assistant' BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;")
      const input = {
        requestId: 'recover', conversationId: context.conversation.id,
        profileId: context.profile.id, content: 'hello'
      }
      await expect(context.chat.send(input)).rejects.toThrow('simulated disk failure')
      expect(context.store.getMessages(context.conversation.id)).toEqual([])
      db.exec('DROP TRIGGER fail_assistant')
      await context.chat.send(input)
      await context.wait('recover')
      expect(context.store.getMessages(context.conversation.id).map(message => message.content)).toEqual(['hello', 'OK'])
    } finally { db.close() }
  })
})

describe('trashing conversations while answers are generated', () => {
  function gated() {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const stream = async function* (): AsyncGenerator<ProviderEvent> {
      yield { type: 'text', text: '前半段' }
      await gate
      yield { type: 'text', text: '后半段' }
      yield { type: 'done' }
    }
    return { release, stream }
  }

  it('refuses to trash the generating conversation and lets the answer finish', async () => {
    const { release, stream } = gated()
    const context = await setup(stream)
    await context.chat.send({
      requestId: 'busy', conversationId: context.conversation.id,
      profileId: context.profile.id, content: '聊一会'
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(() => context.chat.trashConversation(context.conversation.id)).toThrow('请先停止')
    expect(context.store.hasConversation(context.conversation.id)).toBe(true)
    release()
    await context.wait('busy')
    expect(context.store.getMessages(context.conversation.id)[1]).toMatchObject({ content: '前半段后半段', status: 'complete' })
  })

  it('trashes another conversation while the first keeps generating', async () => {
    const { release, stream } = gated()
    const context = await setup(stream)
    const other = context.store.createConversation()
    await context.chat.send({
      requestId: 'busy', conversationId: context.conversation.id,
      profileId: context.profile.id, content: '聊一会'
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    context.chat.trashConversation(other.id)
    expect(context.store.listTrashedConversations().map(item => item.id)).toEqual([other.id])
    release()
    await context.wait('busy')
    expect(context.store.getMessages(context.conversation.id)[1].status).toBe('complete')
  })

  it('refuses while the provider is still being resolved, before any message exists', async () => {
    const { release, stream } = gated()
    const context = await setup(stream)
    const sending = context.chat.send({
      requestId: 'early', conversationId: context.conversation.id,
      profileId: context.profile.id, content: '刚发出'
    })
    expect(() => context.chat.trashConversation(context.conversation.id)).toThrow('请先停止')
    await sending
    release()
    await context.wait('early')
    expect(context.store.hasConversation(context.conversation.id)).toBe(true)
  })

  it('allows trashing once the answer has been stopped', async () => {
    const { release, stream } = gated()
    const context = await setup(stream)
    await context.chat.send({
      requestId: 'stop', conversationId: context.conversation.id,
      profileId: context.profile.id, content: '聊一会'
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    context.chat.cancel('stop')
    release()
    await context.wait('stop')
    context.chat.trashConversation(context.conversation.id)
    expect(context.store.listConversations()).toEqual([])
    expect(context.store.getMessages(context.conversation.id)[1].status).toBe('cancelled')
  })

  it('rejects sending to a trashed conversation without creating messages', async () => {
    const context = await setup(async function* () { yield { type: 'done' } })
    context.chat.trashConversation(context.conversation.id)
    await expect(context.chat.send({
      requestId: 'late', conversationId: context.conversation.id,
      profileId: context.profile.id, content: '还能发吗'
    })).rejects.toThrow('不存在')
    expect(context.store.getMessages(context.conversation.id)).toEqual([])
  })
})

describe('choosing a model within a service', () => {
  async function twoModels(inputs: StreamChatInput[]) {
    const context = await setup(async function* (input) {
      inputs.push(input)
      yield { type: 'text', text: '好' }
      yield { type: 'done' }
    })
    await context.profiles.save({
      id: context.profile.id, name: '测试服务', protocol: 'openai', baseUrl: 'http://localhost:1234/v1',
      model: 'test-model', models: [{ id: 'test-model' }, { id: 'other-model' }]
    })
    return context
  }

  it('uses the default model when none is chosen and the chosen one otherwise', async () => {
    const inputs: StreamChatInput[] = []
    const context = await twoModels(inputs)
    const base = { conversationId: context.conversation.id, profileId: context.profile.id, content: '你好' }
    const first = await context.chat.send({ ...base, requestId: 'default' })
    await context.wait('default')
    const second = await context.chat.send({ ...base, requestId: 'chosen', model: 'other-model' })
    await context.wait('chosen')
    expect(inputs.map(input => input.provider.model)).toEqual(['test-model', 'other-model'])
    expect([first.assistantMessage.model, second.assistantMessage.model]).toEqual(['test-model', 'other-model'])
    expect(context.store.getMessages(context.conversation.id).filter(m => m.role === 'assistant').map(m => m.model))
      .toEqual(['test-model', 'other-model'])
  })

  it('rejects a model that does not belong to the service without adding any message', async () => {
    const context = await twoModels([])
    const base = { conversationId: context.conversation.id, profileId: context.profile.id, content: '你好' }
    await expect(context.chat.send({ ...base, requestId: 'bad', model: 'missing' })).rejects.toThrow('没有这个模型')
    await expect(context.chat.send({ ...base, requestId: 'long', model: 'x'.repeat(2049) })).rejects.toThrow('消息不正确')
    expect(context.store.getMessages(context.conversation.id)).toEqual([])
  })

  it('retries a failed answer with the model passed in the retry', async () => {
    let fail = true
    const inputs: StreamChatInput[] = []
    const context = await setup(async function* (input) {
      inputs.push(input)
      if (fail) throw new ProviderError('boom', '服务出错。')
      yield { type: 'text', text: '好' }
      yield { type: 'done' }
    })
    await context.profiles.save({
      id: context.profile.id, name: '测试服务', protocol: 'openai', baseUrl: 'http://localhost:1234/v1',
      model: 'test-model', models: [{ id: 'test-model' }, { id: 'other-model' }]
    })
    const base = { conversationId: context.conversation.id, profileId: context.profile.id }
    const first = await context.chat.send({ ...base, requestId: 'one', content: '你好' })
    await context.wait('one')
    fail = false
    await context.chat.send({ ...base, requestId: 'two', content: '你好', retryMessageId: first.assistantMessage.id, model: 'other-model' })
    await context.wait('two')
    expect(inputs.map(input => input.provider.model)).toEqual(['test-model', 'other-model'])
  })
})

describe('custom system prompt', () => {
  it('uses the provided system prompt instead of default', async () => {
    const inputs: StreamChatInput[] = []
    const store = new HerStore(':memory:')
    stores.push(store)
    const profiles = new ProfileService(store, {
      encrypt: async () => { throw new Error('not needed') },
      decrypt: async () => { throw new Error('not needed') }
    })
    const profile = await profiles.save({
      name: '测试', protocol: 'openai', baseUrl: 'http://localhost/v1', model: 'test'
    })
    const conversation = store.createConversation()
    const chat = new ChatService(store, profiles, () => {}, () => '你是自定义助手', async function* (input) {
      inputs.push(input)
      yield { type: 'text', text: 'OK' }
      yield { type: 'done' }
    })
    await chat.send({ requestId: 'test', conversationId: conversation.id, profileId: profile.id, content: '你好' })
    expect(inputs[0].system).toContain('你是自定义助手')
    expect(inputs[0].system).toContain(peekabooSkill)
  })
})

describe('tool execution loop', () => {
  it('executes a tool call, returns the result, and continues generation', async () => {
    const calls: number[] = []
    const context = await setup(async function* (input) {
      calls.push(calls.length)
      if (calls.length === 1) {
        yield { type: 'tool', id: 'call-1', name: 'get_current_time', arguments: {} }
        yield { type: 'done' }
      } else {
        yield { type: 'text', text: '现在是北京时间。' }
        yield { type: 'done' }
      }
    })
    context.tools.register(
      { name: 'get_current_time', description: 'Get current time', parameters: { type: 'object', properties: {} } },
      async () => ({ content: [{ type: 'text', text: '2026-10-14 18:00:00' }] })
    , { assess: async () => ({ effect: 'read', target: 'test:fixture', summary: 'Read test fixture' }) })
    await context.chat.send({
      requestId: 'tool-1', conversationId: context.conversation.id,
      profileId: context.profile.id, content: '现在几点了？'
    })
    await context.wait('tool-1')
    expect(calls.length).toBe(2)
    const assistantMessage = context.store.getMessages(context.conversation.id)[1]
    expect(assistantMessage.content).toBe('现在是北京时间。')
    expect(assistantMessage.toolCalls).toEqual([
      expect.objectContaining({ id: 'call-1', name: 'get_current_time', arguments: {}, status: 'succeeded', result: { content: [{ type: 'text', text: '2026-10-14 18:00:00' }] } })
    ])
    expect(assistantMessage.status).toBe('complete')
  })

  it('handles multiple sequential tool calls', async () => {
    let callCount = 0
    const context = await setup(async function* () {
      callCount++
      if (callCount === 1) {
        yield { type: 'tool', id: 'c1', name: 'get_current_time', arguments: {} }
        yield { type: 'done' }
      } else {
        yield { type: 'text', text: '好的，现在可以回答。' }
        yield { type: 'done' }
      }
    })
    context.tools.register(
      { name: 'get_current_time', description: 'Get current time', parameters: { type: 'object', properties: {} } },
      async () => ({ content: [{ type: 'text', text: '2026-10-14' }] })
    , { assess: async () => ({ effect: 'read', target: 'test:fixture', summary: 'Read test fixture' }) })
    await context.chat.send({
      requestId: 'seq', conversationId: context.conversation.id,
      profileId: context.profile.id, content: '现在几点？'
    })
    await context.wait('seq')
    expect(callCount).toBe(2)
    expect(context.store.getMessages(context.conversation.id)[1].status).toBe('complete')
  })

  it('executes several tool calls from one round in order and sends all results back', async () => {
    const rounds: StreamChatInput['messages'][] = []
    const order: string[] = []
    const context = await setup(async function* (input) {
      rounds.push(structuredClone(input.messages))
      if (rounds.length === 1) {
        yield { type: 'tool', id: 'a', name: 'get_current_time', arguments: { timezone: 'UTC' } }
        yield { type: 'tool', id: 'b', name: 'get_current_time', arguments: { timezone: 'Asia/Shanghai' } }
        yield { type: 'done' }
      } else {
        yield { type: 'text', text: '好了。' }
        yield { type: 'done' }
      }
    })
    context.tools.register(
      { name: 'get_current_time', description: 'Get current time', parameters: { type: 'object', properties: {} } },
      async args => { order.push(String(args.timezone)); return { content: [{ type: 'text', text: `time-${String(args.timezone)}` }] } }
    , { assess: async () => ({ effect: 'read', target: 'test:fixture', summary: 'Read test fixture' }) })
    await context.chat.send({
      requestId: 'multi', conversationId: context.conversation.id,
      profileId: context.profile.id, content: '两个时区的时间？'
    })
    await context.wait('multi')
    expect(order).toEqual(['UTC', 'Asia/Shanghai'])
    expect(rounds).toHaveLength(2)
    expect(rounds[1].slice(-3)).toEqual([
      expect.objectContaining({ role: 'assistant', tool_calls: [
        expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'b' })
      ] }),
      { role: 'tool', tool_call_id: 'a', content: { content: [{ type: 'text', text: 'time-UTC' }] } },
      { role: 'tool', tool_call_id: 'b', content: { content: [{ type: 'text', text: 'time-Asia/Shanghai' }] } }
    ])
    expect(context.store.getMessages(context.conversation.id)[1].status).toBe('complete')
  })

  it('returns tool errors to the model without aborting', async () => {
    let callCount = 0
    const context = await setup(async function* () {
      callCount++
      if (callCount === 1) {
        yield { type: 'tool', id: 'c1', name: 'nonexistent_tool', arguments: {} }
        yield { type: 'done' }
      } else {
        yield { type: 'text', text: '抱歉，工具出错了。' }
        yield { type: 'done' }
      }
    })
    context.tools.register(
      { name: 'get_current_time', description: 'Get current time', parameters: { type: 'object', properties: {} } },
      async () => ({ content: [{ type: 'text', text: 'time' }] })
    , { assess: async () => ({ effect: 'read', target: 'test:fixture', summary: 'Read test fixture' }) })
    await context.chat.send({
      requestId: 'err', conversationId: context.conversation.id,
      profileId: context.profile.id, content: '调用不存在的工具'
    })
    await context.wait('err')
    expect(callCount).toBe(2)
    expect(context.store.getMessages(context.conversation.id)[1].toolCalls).toEqual([
      expect.objectContaining({ id: 'c1', name: 'nonexistent_tool', arguments: {}, status: 'failed', result: { isError: true, content: [{ type: 'text', text: 'Unknown tool: nonexistent_tool' }] } })
    ])
    expect(context.store.getMessages(context.conversation.id)[1].status).toBe('complete')
  })

  it('cancels during tool execution', async () => {
    let gate!: () => void
    const context = await setup(async function* () {
      yield { type: 'tool', id: 'c1', name: 'get_current_time', arguments: {} }
      yield { type: 'done' }
    })
    context.tools.register(
      { name: 'get_current_time', description: 'Get current time', parameters: { type: 'object', properties: {} } },
      async (_args, { signal }) => {
        await new Promise<void>(resolve => { gate = resolve })
        signal.throwIfAborted()
        return { content: [{ type: 'text', text: 'time' }] }
      }
    , { assess: async () => ({ effect: 'read', target: 'test:fixture', summary: 'Read test fixture' }) })
    const sending = context.chat.send({
      requestId: 'cancel', conversationId: context.conversation.id,
      profileId: context.profile.id, content: '现在几点？'
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    context.chat.cancel('cancel')
    gate()
    await context.wait('cancel')
    const message = context.store.getMessages(context.conversation.id)[1]
    expect(message.status).toBe('cancelled')
  })
})

describe('durable tool dispatch', () => {
  it('persists the task and running call before invoking the tool and completes the same records', async () => {
    let rounds = 0
    const context = await setup(async function* () {
      if (++rounds === 1) yield { type: 'tool', id: 'dispatch', name: 'observe', arguments: { target: 'window' } }
      else yield { type: 'text', text: 'finished' }
      yield { type: 'done' }
    })
    let during: unknown
    context.tools.register({ name: 'observe', description: 'observe', parameters: {} }, async (_args, execution) => {
      during = { conversationId: execution.conversationId, callId: execution.callId,
        run: context.store.getTaskRun(execution.runId), calls: context.store.listToolCalls(execution.runId) }
      return { content: [{ type: 'text', text: 'observed' }] }
    }, { assess: async () => ({ effect: 'read', target: 'test:fixture', summary: 'Read test fixture' }) })
    await context.chat.send({ requestId: 'durable', conversationId: context.conversation.id, profileId: context.profile.id, content: 'observe' })
    await context.wait('durable')
    expect(during).toMatchObject({ conversationId: context.conversation.id, callId: 'dispatch',
      run: { requestId: 'durable', status: 'running', model: 'test-model', toolCallsCount: 1 },
      calls: [{ id: 'dispatch', status: 'running', startedAt: expect.any(String) }] })
    const call = context.store.getMessages(context.conversation.id)[1].toolCalls![0]
    expect(call).toMatchObject({ status: 'succeeded', result: { content: [{ type: 'text', text: 'observed' }] }, finishedAt: expect.any(String) })
    expect(context.store.getTaskRun(call.runId!)?.status).toBe('completed')
  })

  it('rejects a reused call ID before dispatch and preserves the prior completed trace', async () => {
    let rounds = 0
    let runId = ''
    let firstTrace: ReturnType<HerStore['listToolCalls']> = []
    const context = await setup(async function* () {
      if (++rounds === 2) firstTrace = context.store.listToolCalls(runId)
      yield { type: 'tool', id: 'reused', name: 'act', arguments: { target: rounds === 1 ? 'A' : 'B' } }
      yield { type: 'done' }
    })
    const dispatched: string[] = []
    context.tools.register({ name: 'act', description: 'act', parameters: {} }, async (args, execution) => {
      runId = execution.runId
      dispatched.push(String(args.target))
      return { content: [{ type: 'text', text: `result-${String(args.target)}` }] }
    }, { assess: async () => ({ effect: 'read', target: 'test:fixture', summary: 'Read test fixture' }) })
    await context.chat.send({ requestId: 'duplicate', conversationId: context.conversation.id, profileId: context.profile.id, content: 'act' })
    await context.wait('duplicate')
    expect(dispatched).toEqual(['A'])
    expect(firstTrace).toEqual([expect.objectContaining({ id: 'reused', name: 'act', arguments: { target: 'A' },
      status: 'succeeded', result: { content: [{ type: 'text', text: 'result-A' }] } })])
    expect(context.store.listToolCalls(runId)).toEqual(firstTrace)
    const message = context.store.getMessages(context.conversation.id)[1]
    expect(message.toolCalls).toEqual(firstTrace)
    expect(message).toMatchObject({ status: 'failed', error: expect.stringMatching(/重复/) })
    expect(context.store.getTaskRun(runId)).toMatchObject({ status: 'failed', toolCallsCount: 1 })
  })

  it('keeps a dispatched cancellation unknown and never starts the next collected call', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const context = await setup(async function* () {
      yield { type: 'tool', id: 'first', name: 'act', arguments: {} }
      yield { type: 'tool', id: 'second', name: 'act', arguments: {} }
      yield { type: 'done' }
    })
    let count = 0
    context.tools.register({ name: 'act', description: 'act', parameters: {} }, async () => {
      count++
      await gate
      return { content: [{ type: 'text', text: 'late' }] }
    }, { assess: async () => ({ effect: 'send', target: 'test:fixture', summary: 'Read test fixture' }) })
    await context.chat.send({ requestId: 'durable-cancel', conversationId: context.conversation.id, profileId: context.profile.id, content: 'act' })
    await new Promise<void>(resolve => setImmediate(resolve))
    const approval = context.events.find(event => event.task?.approval)!.task!.approval!
    context.chat.decideApproval({ approvalId: approval.id, revision: approval.revision, decision: 'approve' })
    await new Promise<void>(resolve => setImmediate(resolve))
    context.chat.cancel('durable-cancel')
    release()
    await context.wait('durable-cancel')
    expect(count).toBe(1)
    const message = context.store.getMessages(context.conversation.id)[1]
    expect(message.status).toBe('cancelled')
    expect(message.toolCalls).toEqual([expect.objectContaining({ id: 'first', status: 'unknown' }), expect.objectContaining({ id: 'second', status: 'cancelled' })])
    expect(context.store.getTaskRun(message.toolCalls![0].runId!)?.status).toBe('stopped')
  })
})


describe('tool artifacts through the ChatService provider path', () => {
  it.each(['own', 'foreign', 'source', 'missing'] as const)('loads %s artifacts with current conversation authorization before dispatch', async kind => {
    const directory = mkdtempSync(join(tmpdir(), 'her-chat-images-'))
    directories.push(directory)
    let round = 0
    let body: any
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body))
      return new Response('data: {"choices":[{"index":0,"delta":{"content":"Observed"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    })
    const context = await setup(async function* (input) {
      if (round++ === 0) {
        yield { type: 'tool', id: 'capture-call', name: 'capture', arguments: {} }
        yield { type: 'done' }
      } else yield* streamChat(input)
    }, join(directory, 'her.sqlite'))
    await context.profiles.save({ ...context.profile, models: [{id:'test-model',multimodal:true}] })
    const artifacts = new ToolArtifactStore(context.store)
    const owner = kind === 'foreign' ? context.store.createConversation() : context.conversation
    const reference = kind === 'missing' ? { id: 'missing', mimeType: 'image/png' } : await artifacts.put(new Uint8Array([137,80,78,71]), {
      conversationId: owner.id
    }, 'image/png')
    if (kind === 'source') {
      const db = new DatabaseSync(join(directory, 'her.sqlite'))
      db.prepare('UPDATE tool_artifacts SET source_file_id = ? WHERE id = ?').run('file-id', reference.id)
      db.close()
    } // Legacy source cache with missing authority.
    context.tools.register({ name: 'capture', description: 'capture', parameters: { type: 'object' } }, async () => ({ content: [{ type: 'image', artifactId: reference.id, mimeType: reference.mimeType }] }), { assess: async () => ({ effect: 'read', target: 'test:fixture', summary: 'Read test fixture' }) })
    await context.chat.send({ requestId: 'capture', conversationId: context.conversation.id, profileId: context.profile.id, content: '观察屏幕' })
    await context.wait('capture')
    const final = context.store.getMessages(context.conversation.id).at(-1)!
    expect(final.toolCalls?.[0].id).toBe('capture-call')
    if (kind === 'own') {
      expect(final.status).toBe('complete')
      expect(body.messages.map((message: any) => message.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user'])
      expect(body.messages[3].tool_call_id).toBe('capture-call')
      expect(body.messages[4].content).toContainEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw==' } })
    } else if (kind === 'source') {
      expect(final.status).toBe('complete')
      expect(JSON.stringify(body)).not.toContain('iVBORw==')
      expect(body.messages[3].tool_call_id).toBe('capture-call')
    } else {
      expect(final).toMatchObject({ status: 'failed', error: expect.stringMatching(/图片/) })
      expect(body).toBeUndefined()
    }
  })
})

describe('safe task continuation', () => {
  it('unknown_mutation_is_observed_before_continue with preserved trace and selected model', async () => {
    const inputs: StreamChatInput[] = []
    const order: string[] = []
    let runId = ''
    const context = await setup(async function* (input) {
      inputs.push(input)
      if (inputs.length === 1) yield { type: 'tool', id: 'sent-once', name: 'send', arguments: {} }
      else if (inputs.length === 2) yield { type: 'tool', id: 'blocked', name: 'send', arguments: {} }
      else if (inputs.length === 3) yield { type: 'tool', id: 'observe-now', name: 'observe', arguments: {} }
      else yield { type: 'text', text: '已经发送，已观察确认。' }
      yield { type: 'done' }
    })
    await context.profiles.save({ id: context.profile.id, name: 'test', protocol: 'openai', baseUrl: 'http://localhost/v1', model: 'test-model', models: [{ id: 'test-model' }, { id: 'other-model' }] })
    context.tools.register({ name: 'send', description: 'send', parameters: {} }, async (_args, execution) => {
      runId = execution.runId; order.push('send'); throw new Error('connection lost after send')
    }, { assess: async () => ({ effect: 'send', target: 'alice', summary: 'hello' }) })
    context.tools.register({ name: 'observe', description: 'observe', parameters: {} }, async () => {
      order.push('observe'); return { content: [{ type: 'text', text: 'message is present' }] }
    }, { assess: async () => ({ effect: 'read', target: 'alice', summary: 'observe message' }) })
    const sent = await context.chat.send({ requestId: 'send-task', conversationId: context.conversation.id, profileId: context.profile.id, content: 'send hello' })
    await new Promise<void>(resolve => setImmediate(resolve))
    const approval = context.events.find(event => event.task?.approval)?.task!.approval!
    expect(approval).toBeDefined()
    context.chat.decideApproval({ approvalId: approval.id, revision: approval.revision, decision: 'approve' })
    await context.wait('send-task')
    expect(order).toEqual(['send'])
    expect(context.store.getTaskRun(runId)?.status).toBe('paused')
    await expect(context.chat.send({ requestId: 'unsafe-retry', conversationId: context.conversation.id, profileId: context.profile.id, content: 'send hello', retryMessageId: sent.assistantMessage.id })).rejects.toThrow(/继续/)
    const old = context.store.getTaskRun(runId)!
    await context.chat.continueTask({ runId, requestId: 'continue', profileId: context.profile.id, model: 'other-model' })
    await context.wait('continue')
    expect(order).toEqual(['send', 'observe'])
    expect(inputs[2].provider.model).toBe('other-model')
    expect(inputs[2].messages).toContainEqual(expect.objectContaining({ role: 'tool', tool_call_id: 'sent-once' }))
    expect(context.store.getTaskRun(runId)).toEqual(old)
    const task = context.events.filter(event => event.requestId === 'continue').at(-1)!.task!.run
    expect(task).toMatchObject({ continuationOf: runId, model: 'other-model', status: 'completed', toolCallsCount: 1 })
    expect(context.store.getMessages(context.conversation.id)[1].toolCalls![0].status).toBe('unknown')
  })

  it('cancel_skips_remaining_calls even if a dispatched executor ignores abort', async () => {
    const context = await setup(async function* () {
      yield { type: 'tool', id: 'first', name: 'observe', arguments: {} }
      yield { type: 'tool', id: 'second', name: 'observe', arguments: {} }
      yield { type: 'done' }
    })
    let count = 0
    context.tools.register({ name: 'observe', description: 'read', parameters: {} }, async () => {
      count++; return new Promise(() => {})
    }, { assess: async () => ({ effect: 'read', target: 'window', summary: 'observe' }) })
    await context.chat.send({ requestId: 'stop-hanging', conversationId: context.conversation.id, profileId: context.profile.id, content: 'observe twice' })
    await new Promise<void>(resolve => setImmediate(resolve)); context.chat.cancel('stop-hanging')
    await context.wait('stop-hanging')
    expect(count).toBe(1)
    expect(context.store.getMessages(context.conversation.id)[1].toolCalls).toMatchObject([
      { id: 'first', status: 'cancelled' }, { id: 'second', status: 'cancelled' }
    ])
  })
})

describe('task lifecycle boundaries', () => {
  it('model configuration changes invalidate a pending approval without changing the original run model', async () => {
    let count = 0
    const context = await setup(async function* () {
      yield { type: 'tool', id: 'send', name: 'send', arguments: {} }; yield { type: 'done' }
    })
    context.tools.register({ name: 'send', description: 'send', parameters: {} }, async () => { count++; return { content: [] } })
    await context.chat.send({ requestId: 'configuration', conversationId: context.conversation.id, profileId: context.profile.id, content: 'send' })
    await new Promise<void>(resolve => setImmediate(resolve))
    const approval = context.events.find(event => event.task?.approval)!.task!.approval!
    await context.profiles.save({ id: context.profile.id, name: 'changed', protocol: 'openai', baseUrl: 'http://localhost/v1', model: 'new-model' })
    context.chat.decideApproval({ approvalId: approval.id, revision: approval.revision, decision: 'approve' })
    await context.wait('configuration')
    expect(count).toBe(0)
    expect(context.store.getTaskRun(approval.runId)).toMatchObject({ model: 'test-model', status: 'failed', toolCallsCount: 0 })
    expect(context.store.listToolCalls(approval.runId)[0]).toMatchObject({ status: 'cancelled' })
  })

  it('active deadline pauses an unresponsive model and retains already visible text', async () => {
    vi.useFakeTimers()
    try {
      const context = await setup(async function* () {
        yield { type: 'text', text: 'partial' }; await new Promise(() => {})
      })
      await context.chat.send({ requestId: 'deadline', conversationId: context.conversation.id, profileId: context.profile.id, content: 'work' })
      await vi.advanceTimersByTimeAsync(600_000)
      await context.wait('deadline')
      expect(context.store.getMessages(context.conversation.id).at(-1)).toMatchObject({ content: 'partial', status: 'failed' })
      expect(context.events.at(-1)!.task!.run).toMatchObject({ status: 'paused', activeMs: 600_000 })
    } finally { vi.useRealTimers() }
  })

  it('shutdown permits synchronous database close while approval cleanup settles', async () => {
    const context = await setup(async function* () {
      yield { type: 'tool', id: 'send', name: 'send', arguments: {} }; yield { type: 'done' }
    })
    context.tools.register({ name: 'send', description: 'send', parameters: {} }, async () => ({ content: [] }))
    await context.chat.send({ requestId: 'exit', conversationId: context.conversation.id, profileId: context.profile.id, content: 'send' })
    await new Promise<void>(resolve => setImmediate(resolve))
    context.chat.shutdown()
    const approval = context.events.find(event => event.task?.approval)!.task!.approval!
    expect(context.store.getTaskRun(approval.runId)?.status).toBe('stopped')
    expect(context.store.listToolCalls(approval.runId)[0].status).toBe('cancelled')
    context.store.close(); stores.splice(stores.indexOf(context.store), 1)
    await new Promise<void>(resolve => setImmediate(resolve))
  })
})

it('rejects a runtime resolved across a profile revision change before creating a task', async () => {
  const context = await setup(async function* () { yield { type: 'done' } })
  const original = context.profiles.resolve.bind(context.profiles)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(context.profiles, 'resolve').mockImplementation(async (id, model) => {
    const provider = await original(id, model); await gate; return provider
  })
  const pending = context.chat.send({ requestId: 'resolving-revision', conversationId: context.conversation.id, profileId: context.profile.id, content: 'hello' })
  await new Promise<void>(resolve => setImmediate(resolve))
  await context.profiles.save({ id: context.profile.id, name: 'changed', protocol: 'openai', baseUrl: 'http://localhost/new', model: 'new-model' })
  release()
  await expect(pending).rejects.toThrow(/配置.*变化/)
  expect(context.store.getMessages(context.conversation.id)).toEqual([])
})

it('allows provider call IDs to repeat in an independent new request without replaying old calls', async () => {
  let rounds = 0; let count = 0
  const context = await setup(async function* () {
    if (++rounds % 2 === 1) yield { type: 'tool', id: 'provider-call-1', name: 'read', arguments: {} }
    else yield { type: 'text', text: 'done' }
    yield { type: 'done' }
  })
  context.tools.register({ name: 'read', description: 'read', parameters: {} }, async () => {
    count++; return { content: [{ type: 'text', text: 'value' }] }
  }, { assess: async () => ({ effect: 'read', target: 'fixture', summary: 'read' }) })
  for (const requestId of ['one', 'two']) {
    await context.chat.send({ requestId, conversationId: context.conversation.id, profileId: context.profile.id, content: 'read again' })
    await context.wait(requestId)
  }
  expect(count).toBe(2)
  expect(context.store.getMessages(context.conversation.id).at(-1)?.status).toBe('complete')
})

it('ordinary sends retain unknown mutation recovery across text, clock and failed reads', async () => {
  let phase = 'unknown'; let round = 0
  const dispatched: string[] = []
  const context = await setup(async function* () {
    round++
    if (phase === 'unknown' && round === 1 || phase === 'blocked') {
      yield { type: 'tool', id: 'provider-call-1', name: 'send', arguments: {} }
    } else if ((phase === 'clock' || phase === 'failed-read' || phase === 'recovery') && round === 1) {
      yield { type: 'tool', id: 'read', name: phase === 'clock' ? 'clock' : 'observe', arguments: {} }
    } else if ((phase === 'clock' || phase === 'failed-read' || phase === 'recovery') && round === 2) {
      yield { type: 'tool', id: 'provider-call-1', name: 'send', arguments: {} }
    } else yield { type: 'text', text: 'partial answer' }
    yield { type: 'done' }
  })
  context.tools.register({ name: 'send', description: 'send', parameters: {} }, async () => {
    dispatched.push('send')
    return { isError: phase === 'unknown', content: [{ type: 'text', text: phase === 'unknown' ? 'disconnected after send' : 'sent' }] }
  }, { assess: async () => ({ effect: 'send', target: 'alice', summary: 'send hello' }) })
  context.tools.register({ name: 'clock', description: 'clock', parameters: {} }, async () => {
    dispatched.push('clock'); return { content: [{ type: 'text', text: 'now' }] }
  }, { assess: async () => ({ effect: 'read', target: 'system:clock', summary: 'read time' }) })
  context.tools.register({ name: 'observe', description: 'observe', parameters: {} }, async () => {
    dispatched.push('observe'); return { isError: phase === 'failed-read', content: [{ type: 'text', text: 'current state' }] }
  }, { assess: async () => ({ effect: 'read', target: 'alice', summary: 'observe alice' }) })
  const start = async (next: string) => {
    phase = next; round = 0
    await context.chat.send({ requestId: next, conversationId: context.conversation.id, profileId: context.profile.id, content: next })
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  const approvals = (id: string) => context.events.filter(event => event.requestId === id && event.task?.approval)
  const approve = (id: string) => {
    const request = approvals(id).at(-1)!.task!.approval!
    context.chat.decideApproval({ approvalId: request.id, revision: request.revision, decision: 'approve' })
  }
  await start('unknown'); approve('unknown'); await context.wait('unknown')
  const unknown = context.store.getMessages(context.conversation.id)[1].toolCalls![0]
  expect(unknown.status).toBe('unknown')
  expect(dispatched).toEqual(['send'])
  await start('text'); await context.wait('text')
  for (const next of ['blocked', 'clock', 'failed-read']) {
    await start(next)
    try { expect(approvals(next)).toEqual([]) }
    finally { context.chat.cancel(next); await context.wait(next) }
    expect(dispatched.filter(item => item === 'send')).toHaveLength(1)
  }
  await start('recovery')
  expect(dispatched).toEqual(['send', 'clock', 'observe', 'observe'])
  expect(approvals('recovery')).not.toHaveLength(0)
  approve('recovery'); await context.wait('recovery')
  expect(dispatched).toEqual(['send', 'clock', 'observe', 'observe', 'send'])
  expect(context.store.getMessages(context.conversation.id).at(-1)?.status).toBe('complete')
  expect(context.store.getMessages(context.conversation.id)[1].toolCalls![0]).toEqual(unknown)
})


it('cancels admitted MCP preparation before late discovery can start generation', async () => {
  const context = await setup(async function* () { yield { type: 'done' } })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const chat = new ChatService(context.store, context.profiles, () => {}, () => '', async function* () { calls++; yield { type: 'done' } }, context.tools, undefined, () => gate)
  const sending = chat.send({ requestId: 'preparing', conversationId: context.conversation.id, profileId: context.profile.id, content: 'go' })
  await new Promise(resolve => setImmediate(resolve))
  chat.cancel('preparing')
  release()
  await expect(sending).rejects.toThrow('取消')
  expect(calls).toBe(0)
})

it('queries live approval on reload but restores only the stopped durable task after process restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'her-task-query-')); directories.push(directory)
  const path = join(directory, 'task.sqlite')
  const context = await setup(async function* () { yield { type: 'tool', id: 'call', name: 'send', arguments: {} }; yield { type: 'done' } }, path)
  context.tools.register({ name: 'send', description: 'send', parameters: {} }, async () => ({ content: [] }))
  await context.chat.send({ requestId: 'query-run', conversationId: context.conversation.id, profileId: context.profile.id, content: 'send' })
  await new Promise<void>(resolve => setImmediate(resolve))
  const live = context.chat.getConversationTask(context.conversation.id)!
  expect(live.run.status).toBe('awaiting_confirmation')
  expect(live.approval?.id).toBeTruthy()
  context.chat.shutdown(); context.store.close(); stores.splice(stores.indexOf(context.store), 1)
  const reopened = new HerStore(path); stores.push(reopened)
  const chat = new ChatService(reopened, new ProfileService(reopened, { encrypt: async text => Buffer.from(text), decrypt: async bytes => bytes.toString() }), () => {}, () => '')
  const restored = chat.getConversationTask(context.conversation.id)!
  expect(restored.run.id).toBe(live.run.id)
  expect(restored.run.status).toBe('stopped')
  expect(restored).not.toHaveProperty('approval')
  expect(chat.getActiveRequest()).toBeNull()
  expect(() => chat.getConversationTask('missing')).toThrow('不存在')
})


it.each(['send', 'continue'] as const)('publishes matching start/failure lifecycle for %s before creating a run', async kind => {
  const context = await setup(async function* () { throw new ProviderError('fixture', 'first failure') })
  let runId = ''
  if (kind === 'continue') {
    await context.chat.send({ requestId: 'first', conversationId: context.conversation.id, profileId: context.profile.id, content: 'work' })
    await context.wait('first')
    runId = context.chat.getConversationTask(context.conversation.id)!.run.id
    context.requestEvents.length = 0
  }
  const messagesBefore = context.store.getMessages(context.conversation.id)
  let reject!: (error: Error) => void
  const resolving = new Promise<RuntimeProvider>((_resolve, fail) => { reject = fail })
  vi.spyOn(context.profiles, 'resolve').mockReturnValue(resolving)
  const requestId = 'pre-run-' + kind
  const pending = kind === 'send'
    ? context.chat.send({ requestId, conversationId: context.conversation.id, profileId: context.profile.id, content: 'work' })
    : context.chat.continueTask({ requestId, runId, profileId: context.profile.id })
  const rejected = expect(pending).rejects.toThrow('fixture failure')
  expect.soft(context.requestEvents).toEqual([{ requestId, conversationId: context.conversation.id, state: 'started' }])
  reject(new Error('fixture failure'))
  await rejected
  expect(context.requestEvents.at(-1)).toMatchObject({ requestId, conversationId: context.conversation.id, state: 'failed' })
  expect(context.requestEvents.at(-1)?.error).not.toContain('fixture failure')
  expect(context.chat.getActiveRequest()).toBeNull()
  expect(context.store.getMessages(context.conversation.id)).toEqual(messagesBefore)
})

it('pins exact selected model vision capability in each new run instead of the profile default', async () => {
  const inputs: StreamChatInput[] = []
  const f = await setup(async function* (input) {
    inputs.push(input)
    if (!input.messages.some(m => m.role === 'tool' && m.tool_call_id === 'vision-' + inputs.length)) {
      if (input.messages.at(-1)?.role !== 'tool') { yield {type:'tool',id:'vision-'+inputs.length,name:'vision_context',arguments:{}}; yield {type:'done'}; return }
    }
    yield {type:'text',text:'done'}; yield {type:'done'}
  })
  const seen: (boolean|undefined)[] = []
  f.tools.register({name:'vision_context',description:'test',parameters:{type:'object'}}, async (_,context) => { seen.push(context.modelSupportsVision); return {content:[{type:'text',text:'checked'}]} }, {assess:async () => ({effect:'read',target:'test',summary:'test'})})
  await f.profiles.save({id:f.profile.id,name:'test',protocol:'openai',baseUrl:'http://localhost:1234/v1',model:'text',models:[{id:'text',multimodal:false},{id:'vision',multimodal:true}]})
  await f.chat.send({requestId:'selected-vision',conversationId:f.conversation.id,profileId:f.profile.id,model:'vision',content:'read'})
  await f.wait('selected-vision')
  expect(seen).toEqual([true]); expect(inputs[0].provider).toMatchObject({model:'vision',multimodal:true})
  await f.chat.send({requestId:'selected-text',conversationId:f.conversation.id,profileId:f.profile.id,model:'text',content:'read'})
  await f.wait('selected-text')
  expect(seen).toEqual([true,false])
})
it('continuing with a different selected model captures its vision capability for the new run', async () => {
  const rounds=new Map<string,number>()
  const f=await setup(async function*(input) {
    const round=(rounds.get(input.provider.model)??0)+1; rounds.set(input.provider.model,round)
    if(round===1) {yield {type:'tool',id:'capability-'+input.provider.model,name:'capability',arguments:{}};yield {type:'done'};return}
    if(input.provider.model==='text') throw new ProviderError('fixture_failure','fixture failure')
    yield {type:'text',text:'continued'};yield {type:'done'}
  })
  const seen:(boolean|undefined)[]=[]
  f.tools.register({name:'capability',description:'check',parameters:{type:'object'}},async(_,context)=>{seen.push(context.modelSupportsVision);return {content:[{type:'text',text:'captured'}]}},{assess:async()=>({effect:'read',target:'test',summary:'test'})})
  await f.profiles.save({id:f.profile.id,name:'test',protocol:'openai',baseUrl:'http://localhost:1234/v1',model:'text',models:[{id:'text',multimodal:false},{id:'vision',multimodal:true}]})
  await f.chat.send({requestId:'text-run',conversationId:f.conversation.id,profileId:f.profile.id,model:'text',content:'read'})
  await f.wait('text-run')
  const failed=f.store.getMessages(f.conversation.id).at(-1)!
  expect(failed.status).toBe('failed')
  await f.chat.continueTask({runId:failed.toolCalls![0].runId!,requestId:'vision-continue',profileId:f.profile.id,model:'vision'})
  await f.wait('vision-continue')
  expect(seen).toEqual([false,true]); expect(f.store.getMessages(f.conversation.id).at(-1)?.status).toBe('complete')
})


it('hydrates selected images only in the model view and retry uses original persisted references', async () => {
  const inputs: StreamChatInput[] = []
  const ctx = await setup(async function* (input) { inputs.push(input); if (inputs.length === 1) throw new Error('retry'); yield { type: 'text', text: 'seen' }; yield { type: 'done' } })
  const { FileAccessService } = await import('../src/core/files/access')
  const { writeFileSync } = await import('node:fs')
  const directory = mkdtempSync(join(tmpdir(), 'her-selected-image-')); directories.push(directory)
  writeFileSync(join(directory, 'picture.png'), Buffer.from('image-bytes'))
  const files = new FileAccessService(ctx.store)
  const [grant] = await files.grant([join(directory, 'picture.png')], { kind: 'file', scope: 'conversation', conversationId: ctx.conversation.id })
  const reference = await files.reference(grant.id, '', { conversationId: ctx.conversation.id, runId: 'test', callId: 'test', signal: new AbortController().signal })
  await ctx.profiles.save({ ...ctx.profile, models: [{ id: 'test-model', multimodal: true }] })
  const first = await ctx.chat.send({ requestId: 'image-ref', conversationId: ctx.conversation.id, profileId: ctx.profile.id, content: 'see', fileIds: [reference.id] })
  await ctx.wait('image-ref')
  expect(inputs[0].messages[0].content).toEqual(expect.arrayContaining([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('image-bytes').toString('base64') } }]))
  expect(first.userMessage.files).toEqual([reference]); expect(first.userMessage.attachments).toBeUndefined()
  expect(JSON.stringify(ctx.store.getMessages(ctx.conversation.id))).not.toContain(Buffer.from('image-bytes').toString('base64'))
  await ctx.chat.send({ requestId: 'image-retry', conversationId: ctx.conversation.id, profileId: ctx.profile.id, content: 'see', retryMessageId: first.assistantMessage.id, fileIds: ['unrelated-draft'] })
  await ctx.wait('image-retry')
  expect(inputs[1].messages[0].content).toEqual(inputs[0].messages[0].content)
})

it('rejects selected image input on the actual text-only model before persisting a turn', async () => {
  const ctx = await setup(async function* () { yield { type: 'done' } })
  const { FileAccessService } = await import('../src/core/files/access')
  const { writeFileSync } = await import('node:fs')
  const directory = mkdtempSync(join(tmpdir(), 'her-image-policy-')); directories.push(directory)
  writeFileSync(join(directory, 'picture.png'), 'image')
  const files = new FileAccessService(ctx.store)
  const [grant] = await files.grant([join(directory, 'picture.png')], { kind: 'file', scope: 'conversation', conversationId: ctx.conversation.id })
  const reference = await files.reference(grant.id, '', { conversationId: ctx.conversation.id, runId: 'test', callId: 'test', signal: new AbortController().signal })
  await expect(ctx.chat.send({ requestId: 'image-denied', conversationId: ctx.conversation.id, profileId: ctx.profile.id, content: 'see', fileIds: [reference.id] })).rejects.toThrow(/视觉/)
  expect(ctx.store.getMessages(ctx.conversation.id)).toEqual([])
})

async function selectedImageFixture(stream: (input: StreamChatInput) => AsyncGenerator<ProviderEvent>, size = 5) {
  const ctx = await setup(stream)
  const { FileAccessService } = await import('../src/core/files/access')
  const { writeFileSync } = await import('node:fs')
  const directory = mkdtempSync(join(tmpdir(), 'her-image-authority-')); directories.push(directory)
  writeFileSync(join(directory, 'picture.png'), Buffer.alloc(size, 1))
  const files = new FileAccessService(ctx.store)
  const [grant] = await files.grant([join(directory, 'picture.png')], { kind: 'file', scope: 'conversation', conversationId: ctx.conversation.id })
  const reference = await files.reference(grant.id, '', { conversationId: ctx.conversation.id, runId: 'test', callId: 'test', signal: new AbortController().signal })
  await ctx.profiles.save({ ...ctx.profile, models: [{ id: 'test-model', multimodal: true }, { id: 'text-only', multimodal: false }] })
  return { ...ctx, files, grant, reference, input: { requestId: 'image', conversationId: ctx.conversation.id, profileId: ctx.profile.id, content: 'see', fileIds: [reference.id] } }
}

it.each(['openai', 'openai-responses', 'anthropic'] as const)('selected reference images use the existing %s wire format and legacy images remain readable', async protocol => {
  let wire: unknown
  const { formatModelMessages } = await import('../src/core/providers/message-format')
  const ctx = await selectedImageFixture(async function* (input) { wire = await formatModelMessages(protocol, input.messages, async () => new Uint8Array()); yield { type: 'text', text: 'seen' }; yield { type: 'done' } })
  await ctx.chat.send({ ...ctx.input, attachments: [{ type: 'image', name: 'legacy', mimeType: 'image/png', size: 1, data: 'b2xk' }] })
  await ctx.wait('image')
  const output = JSON.stringify(wire)
  expect(output).toContain(protocol === 'openai' ? 'image_url' : protocol === 'openai-responses' ? 'input_image' : 'base64')
  expect(output).toContain('AQEBAQE='); expect(output).toContain('b2xk'); expect(output).not.toContain('fileSources')
})

it('enforces 10 MiB and combined 10 image limits and selected-model capability before persistence', async () => {
  const big = await selectedImageFixture(async function* () { yield { type: 'done' } }, 10 * 1024 * 1024 + 1)
  await expect(big.chat.send(big.input)).rejects.toThrow(/10 MiB/)
  expect(big.store.getMessages(big.conversation.id)).toEqual([])
  const ctx = await selectedImageFixture(async function* () { yield { type: 'done' } })
  await expect(ctx.chat.send({ ...ctx.input, fileIds: Array(11).fill(ctx.reference.id) })).rejects.toThrow(/10 张/)
  await expect(ctx.chat.send({ ...ctx.input, model: 'text-only' })).rejects.toThrow(/视觉/)
  expect(ctx.store.getMessages(ctx.conversation.id)).toEqual([])
})

it('revalidates selected-image authority after asynchronous hydration before real HTTP dispatch', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  let revoke!: () => Promise<void>
  const ctx = await selectedImageFixture(async function* (input) { await revoke(); yield* streamChat(input) })
  revoke = () => ctx.files.revoke(ctx.grant.id)
  await ctx.chat.send(ctx.input); await ctx.wait('image')
  expect(fetch).not.toHaveBeenCalled()
  expect(ctx.store.getMessages(ctx.conversation.id).at(-1)?.status).toBe('failed')
})

it('continue hydrates the original referenced image after a stopped turn', async () => {
  const inputs: StreamChatInput[] = []
  const ctx = await selectedImageFixture(async function* (input) { inputs.push(input); if (inputs.length === 1) throw new Error('interrupted'); yield { type: 'text', text: 'continued' }; yield { type: 'done' } })
  await ctx.chat.send(ctx.input); await ctx.wait('image')
  const run = ctx.store.getLatestTaskRun(ctx.conversation.id)!
  await ctx.chat.continueTask({ requestId: 'continue-image', profileId: ctx.profile.id, runId: run.id })
  await ctx.wait('continue-image')
  expect(inputs[1].messages[0].content).toEqual(inputs[0].messages[0].content)
})

it('switching from a successful selected-image turn to a text model retains safe vision guidance before dispatch', async () => {
  const inputs: StreamChatInput[] = []
  const ctx = await selectedImageFixture(async function* (input) { inputs.push(input); yield { type: 'text', text: '图片回答' }; yield { type: 'done' } })
  await ctx.chat.send(ctx.input); await ctx.wait('image')
  expect(ctx.store.getMessages(ctx.conversation.id).at(-1)?.status).toBe('complete')
  await ctx.chat.send({ requestId: 'text-after-image', conversationId: ctx.conversation.id, profileId: ctx.profile.id, model: 'text-only', content: '继续聊' })
  await ctx.wait('text-after-image')
  expect(inputs).toHaveLength(1)
  const failed = ctx.store.getMessages(ctx.conversation.id).at(-1)!
  expect(failed).toMatchObject({ status: 'failed', model: 'text-only' })
  expect(failed.error).toMatch(/当前模型不支持视觉.*切换.*视觉/)
  expect(ctx.store.getMessages(ctx.conversation.id)[0].files).toEqual([ctx.reference])
})


it('untyped asynchronous generation failures remain sanitized after the capability error fix', async () => {
  const ctx = await selectedImageFixture(async function* () { throw new Error('/private/model-secret') })
  await ctx.chat.send(ctx.input); await ctx.wait('image')
  const failed = ctx.store.getMessages(ctx.conversation.id).at(-1)!
  expect(failed.error).toBe('回答生成失败，请检查服务配置后重试。')
  expect(failed.error).not.toContain('/private/model-secret')
})
