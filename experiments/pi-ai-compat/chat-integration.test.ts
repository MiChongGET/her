// Compatibility experiment: the real Her chat loop and SQLite with a Pi stream adapter.
import { afterEach, describe, expect, it } from 'vitest'
import { HerStore } from '../../src/core/storage/store'
import { ProfileService } from '../../src/core/storage/profiles'
import { ChatService } from '../../src/core/conversation/chat'
import { SimpleToolRegistry } from '../../src/core/tools/registry'
import type { ChatEvent, ProviderProtocol } from '../../src/shared/types'
import { streamChatWithPi } from './adapter'
import { startFixtureServer } from './fixtures'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(protocol: ProviderProtocol, scenario: Parameters<typeof startFixtureServer>[1]) {
  const fixture = await startFixtureServer(protocol, scenario)
  cleanups.push(() => fixture.close())
  const store = new HerStore(':memory:')
  cleanups.push(() => store.close())
  const profiles = new ProfileService(store, {
    // Only test strings are used; this is not a replacement for Her safeStorage.
    encrypt: async value => Buffer.from(value),
    decrypt: async value => value.toString(),
  })
  const profile = await profiles.save({
    name: 'Pi compatibility fixture', protocol, baseUrl: fixture.baseUrl,
    model: 'test-model', apiKey: 'fixture-key',
  })
  const conversation = store.createConversation()
  const events: ChatEvent[] = []
  const subscribers = new Set<(event: ChatEvent) => void>()
  const executed: Record<string, unknown>[] = []
  const tools = new SimpleToolRegistry()
  tools.register({
    name: 'report_connection', description: 'Report connection',
    parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
  }, async args => {
    executed.push(args)
    return '工具成功'
  })
  const chat = new ChatService(store, profiles, event => {
    events.push(structuredClone(event))
    for (const subscriber of subscribers) subscriber(event)
  }, () => '你是 Her。', streamChatWithPi, tools)
  cleanups.push(() => chat.shutdown())
  const waitFor = (predicate: (event: ChatEvent) => boolean) => {
    if (events.some(predicate)) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        subscribers.delete(listener)
        reject(new Error('Timed out waiting for Her chat event'))
      }, 5000)
      const listener = (event: ChatEvent) => {
        if (!predicate(event)) return
        clearTimeout(timer)
        subscribers.delete(listener)
        resolve()
      }
      subscribers.add(listener)
    })
  }
  const send = () => chat.send({
    requestId: 'pi-chat', conversationId: conversation.id,
    profileId: profile.id, content: '请检查连接。',
  })
  return { fixture, store, conversation, events, executed, chat, waitFor, send }
}

describe.each(['openai', 'anthropic', 'openai-responses'] as const)('%s in the real Her chat service', protocol => {
  it('persists a completed Chinese reply without duplicating the user turn', async () => {
    const context = await setup(protocol, 'text')
    await context.send()
    await context.waitFor(event => event.done)
    const messages = context.store.getMessages(context.conversation.id)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ role: 'user', content: '请检查连接。', status: 'complete' })
    expect(messages[1]).toMatchObject({ role: 'assistant', status: 'complete' })
    expect(messages[1].content).toContain('你好')
    expect(context.executed).toEqual([])
    expect(context.fixture.requests).toHaveLength(1)
  })

  it('executes a tool once and sends its real result back before persisting the final answer', async () => {
    const context = await setup(protocol, ['tool', 'text'])
    await context.send()
    await context.waitFor(event => event.done)
    const messages = context.store.getMessages(context.conversation.id)
    expect(messages).toHaveLength(2)
    expect(context.executed).toEqual([{ ok: true }])
    expect(context.fixture.requests).toHaveLength(2)
    const body = context.fixture.requests[1].body
    if (protocol === 'openai') {
      expect(body.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'assistant', tool_calls: [expect.objectContaining({
          id: 'call_1', function: { name: 'report_connection', arguments: '{"ok":true}' },
        })] }),
        { role: 'tool', tool_call_id: 'call_1', content: '工具成功' },
      ]))
    } else if (protocol === 'anthropic') {
      expect(body.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'assistant', content: expect.arrayContaining([
          expect.objectContaining({ type: 'tool_use', id: 'call_1', name: 'report_connection', input: { ok: true } }),
        ]) }),
        expect.objectContaining({ role: 'user', content: expect.arrayContaining([
          expect.objectContaining({ type: 'tool_result', tool_use_id: 'call_1', content: '工具成功' }),
        ]) }),
      ]))
    } else {
      expect(body.input).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'function_call', call_id: 'call_1', name: 'report_connection', arguments: '{"ok":true}' }),
        expect.objectContaining({ type: 'function_call_output', call_id: 'call_1', output: '工具成功' }),
      ]))
    }
    expect(messages[1]).toMatchObject({ status: 'complete' })
    expect(messages[1].toolCalls).toEqual([
      expect.objectContaining({ name: 'report_connection', arguments: { ok: true }, result: '工具成功' }),
    ])
    expect(messages[1].content).not.toBe('')
  })

  it('keeps visible text on cancellation and never persists a later completion or tool', async () => {
    const context = await setup(protocol, 'hang')
    await context.send()
    await context.waitFor(event => !event.done && event.message.content.length > 0)
    const partial = context.events.at(-1)!.message.content
    context.chat.cancel('pi-chat')
    await context.waitFor(event => event.done)
    expect(context.store.getMessages(context.conversation.id)[1]).toMatchObject({
      content: partial, status: 'cancelled',
    })
    expect(context.executed).toEqual([])
    expect(context.events.filter(event => event.done)).toHaveLength(1)
    expect(context.fixture.requests).toHaveLength(1)
  })
})
