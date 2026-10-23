import { randomUUID } from 'node:crypto'
import { readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentHost } from '../src/core/agent/host'
import { ChatService } from '../src/core/conversation/chat'
import { openConversationHistory } from '../src/core/agent/factory'
import { classifyRun } from '../src/core/agent/recover'
import { startFixtureServer } from './pi-sdk/wire'
import { harness, harnessCleanup } from './helpers/host-harness'

afterEach(async () => { for (const close of harnessCleanup.splice(0).reverse()) await close() })
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

type Fixture = ReturnType<typeof harness>
async function profile(f: Fixture, baseUrl = 'http://127.0.0.1:9') {
  return f.profiles.save({ name: 'p', protocol: 'openai', baseUrl: baseUrl + '/v1', model: 'test-model', contextWindow: 128000, authMethod: 'none' })
}
/** What a crash leaves behind for one request: a claimed input, a running task, and some part of the Pi record. */
async function crashed(f: Fixture, stage: 'claimed' | 'user-written' | 'partial-reply' | 'result-written') {
  const p = await profile(f)
  const requestId = randomUUID(), userMessageId = randomUUID(), assistantMessageId = randomUUID()
  f.store.enqueueInput(f.id, 'hello there', null, requestId, { profileId: p.id, model: 'test-model', userMessageId })
  f.store.claimInput(requestId)
  const taskId = randomUUID()
  f.store.createTask({ id: taskId, conversationId: f.id, requestId, generation: 0, status: 'running', serviceId: p.id, modelId: 'test-model', configRevision: 1, error: null })
  const { manager } = await openConversationHistory(f.directory, f.store.getConversation(f.id)!)
  manager.appendCustomEntry('her.run', { requestId, userMessageId, assistantMessageId, profileId: p.id, model: 'test-model' })
  if (stage !== 'claimed') manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'hello there' }], timestamp: Date.now() })
  if (stage === 'partial-reply' || stage === 'result-written') {
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'half an ans' }], stopReason: 'aborted', timestamp: Date.now(),
      api: 'openai-completions', provider: p.id, model: 'test-model', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as never)
  }
  if (stage === 'result-written') {
    manager.appendCustomEntry('her.result', { id: assistantMessageId, conversationId: f.id, role: 'assistant', content: 'half an ans', status: 'cancelled', createdAt: new Date().toISOString() })
  }
  return { requestId, taskId, userMessageId, assistantMessageId, profileId: p.id }
}
async function restart(f: Fixture) {
  const host = new AgentHost(f.store, f.profiles, f.directory)
  await host.ready()
  return host
}
const piEntries = async (f: Fixture) => (await openConversationHistory(f.directory, f.store.getConversation(f.id)!)).manager.getEntries()

describe('classifying a request from the Pi record', () => {
  it('a marker with no user message after it means the model never saw the input', async () => {
    const f = harness(), c = await crashed(f, 'claimed')
    expect(classifyRun(await piEntries(f), c.requestId)).toMatchObject({ reached: false, assistantText: '' })
  })
  it('a user message after the marker means it reached Pi', async () => {
    const f = harness(), c = await crashed(f, 'user-written')
    expect(classifyRun(await piEntries(f), c.requestId)).toMatchObject({ reached: true })
  })
  it('collects what the model had said, and notices a recorded result', async () => {
    const f = harness(), c = await crashed(f, 'result-written')
    const outcome = classifyRun(await piEntries(f), c.requestId)
    expect(outcome.assistantText).toBe('half an ans')
    expect(outcome.result).toMatchObject({ status: 'cancelled' })
  })
  it('only the last marker for a request counts, so a retried request is judged on its second attempt', async () => {
    const f = harness(), c = await crashed(f, 'user-written')
    const { manager } = await openConversationHistory(f.directory, f.store.getConversation(f.id)!)
    manager.appendCustomEntry('her.run', { requestId: c.requestId, userMessageId: c.userMessageId, assistantMessageId: c.assistantMessageId, profileId: c.profileId, model: 'test-model' })
    expect(classifyRun(manager.getEntries(), c.requestId)).toMatchObject({ reached: false })
  })
  it('knows nothing about a request that never wrote a marker', async () => {
    const f = harness()
    const outcome = classifyRun(await piEntries(f), 'unknown')
    expect(outcome.reached).toBe(false)
    expect(outcome.run).toBeUndefined()
  })
})

describe('start-up recovery', () => {
  it('a claimed input that never reached Pi goes back in the queue, paused, and is not sent', async () => {
    const s = await startFixtureServer('openai', 'text')
    const f = harness(), c = await crashed(f, 'claimed')
    await f.profiles.save({ id: c.profileId, name: 'p', protocol: 'openai', baseUrl: s.baseUrl + '/v1', model: 'test-model', contextWindow: 128000, authMethod: 'none' })
    const host = await restart(f)
    expect(f.store.getInput(c.requestId)).toMatchObject({ status: 'pending' })
    expect(host.getQueue(f.id)).toMatchObject({ paused: 'restart', running: false })
    expect(host.getQueue(f.id).items.map(item => item.requestId)).toEqual([c.requestId])
    await wait(300)
    expect(s.requests).toHaveLength(0)
    await s.close()
  })

  it('an input the model may have seen is closed as interrupted and never sent again', async () => {
    const s = await startFixtureServer('openai', 'text')
    const f = harness(), c = await crashed(f, 'user-written')
    await f.profiles.save({ id: c.profileId, name: 'p', protocol: 'openai', baseUrl: s.baseUrl + '/v1', model: 'test-model', contextWindow: 128000, authMethod: 'none' })
    const host = await restart(f)
    expect(f.store.getInput(c.requestId)).toMatchObject({ status: 'cancelled' })
    expect(host.getQueue(f.id).items).toEqual([])
    host.resumeQueue(f.id)
    await wait(300)
    expect(s.requests).toHaveLength(0)
    await s.close()
  })

  it('shows the unfinished reply as failed, keeping the text the model had already said', async () => {
    const f = harness(), c = await crashed(f, 'partial-reply')
    const host = await restart(f)
    const messages = await host.getMessages(f.id)
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(messages[1]).toMatchObject({ id: c.assistantMessageId, status: 'failed', content: 'half an ans' })
    expect(messages[1].error).toContain('中断')
  })

  it('does not record a second result when the run had already recorded its own', async () => {
    const f = harness(), c = await crashed(f, 'result-written')
    await restart(f)
    const results = (await piEntries(f)).filter(entry => entry.type === 'custom' && entry.customType === 'her.result')
    expect(results).toHaveLength(1)
    expect(f.store.getInput(c.requestId)).toMatchObject({ status: 'cancelled' })
  })

  it('marks the running task interrupted and leaves finished tasks alone', async () => {
    const f = harness(), c = await crashed(f, 'user-written')
    const doneRequest = randomUUID(), doneTask = randomUUID()
    f.store.enqueueInput(f.id, 'done', null, doneRequest); f.store.claimInput(doneRequest); f.store.updateInputStatus(doneRequest, 'completed')
    f.store.createTask({ id: doneTask, conversationId: f.id, requestId: doneRequest, generation: 0, status: 'completed', serviceId: 's', modelId: 'm', configRevision: 1, error: null })
    await restart(f)
    expect(f.store.getTask(c.taskId)).toMatchObject({ status: 'interrupted' })
    expect(f.store.getTask(doneTask)).toMatchObject({ status: 'completed' })
  })

  it('a dispatched action is unknown and its target quarantined, an undispatched one is only cancelled', async () => {
    const f = harness(), c = await crashed(f, 'user-written')
    f.store.insertToolCall({ taskId: c.taskId, callId: 'sent', toolName: 'act', args: '{}', effect: 'send', target: 'alice' })
    f.store.updateToolCall(c.taskId, 'sent', { status: 'running', phase: 'action', dispatched: true })
    f.store.insertToolCall({ taskId: c.taskId, callId: 'waiting', toolName: 'act', args: '{}', effect: 'send', target: 'bob' })
    await restart(f)
    expect(f.store.getToolCall(c.taskId, 'sent')).toMatchObject({ status: 'unknown' })
    expect(f.store.getToolCall(c.taskId, 'waiting')).toMatchObject({ status: 'cancelled' })
    expect(f.store.listQuarantinedTargets()).toEqual(['alice'])
  })

  it('an unreadable session is never resent, because whether the model saw the message is unknown', async () => {
    const s = await startFixtureServer('openai', 'text')
    const f = harness(), c = await crashed(f, 'user-written')
    await f.profiles.save({ id: c.profileId, name: 'p', protocol: 'openai', baseUrl: s.baseUrl + '/v1', model: 'test-model', contextWindow: 128000, authMethod: 'none' })
    const dir = join(f.directory, 'pi', 'sessions', f.id)
    writeFileSync(join(dir, readdirSync(dir)[0]), 'this is not a session file')
    const host = await restart(f)
    expect(f.store.getInput(c.requestId)).toMatchObject({ status: 'cancelled' })
    host.resumeQueue(f.id)
    await wait(300)
    expect(s.requests).toHaveLength(0)
    await s.close()
  })

  it('a conversation in the trash has its claimed input closed without reading its session', async () => {
    const f = harness(), c = await crashed(f, 'claimed')
    f.store.trashConversation(f.id)
    await restart(f)
    expect(f.store.getInput(c.requestId)).toMatchObject({ status: 'cancelled' })
  })

  it('other conversations are recovered independently of a broken one', async () => {
    const f = harness(), broken = await crashed(f, 'user-written')
    const dir = join(f.directory, 'pi', 'sessions', f.id)
    writeFileSync(join(dir, readdirSync(dir)[0]), 'garbage')
    const requestId = randomUUID()
    f.store.enqueueInput(f.other, 'other', null, requestId, { profileId: broken.profileId, model: 'test-model', userMessageId: randomUUID() })
    f.store.claimInput(requestId)
    const { manager } = await openConversationHistory(f.directory, f.store.getConversation(f.other)!)
    manager.appendCustomEntry('her.run', { requestId, userMessageId: randomUUID(), assistantMessageId: randomUUID(), profileId: broken.profileId, model: 'test-model' })
    await restart(f)
    expect(f.store.getInput(broken.requestId)).toMatchObject({ status: 'cancelled' })
    expect(f.store.getInput(requestId)).toMatchObject({ status: 'pending' })
  })
})

describe('continuing the queue after a restart', () => {
  it('runs the waiting message once the user resumes, even though nothing has been sent since the restart', async () => {
    const s = await startFixtureServer('openai', 'text')
    const f = harness(), c = await crashed(f, 'claimed')
    await f.profiles.save({ id: c.profileId, name: 'p', protocol: 'openai', baseUrl: s.baseUrl + '/v1', model: 'test-model', contextWindow: 128000, authMethod: 'none' })
    const requests: { requestId: string; state: string }[] = []
    const chat = new ChatService(f.store, new AgentHost(f.store, f.profiles, f.directory), () => {}, event => requests.push(event))
    await new Promise(resolve => setTimeout(resolve, 50))
    chat.resumeQueue(f.id)
    await expect.poll(() => requests.find(event => event.requestId === c.requestId && event.state === 'completed'), { timeout: 10_000 }).toBeDefined()
    expect(s.requests).toHaveLength(1)
    expect(f.store.getInput(c.requestId)).toMatchObject({ status: 'completed' })
    await chat.shutdown(); await s.close()
  }, 20_000)

  it('a request that cannot start is closed, not left running forever', async () => {
    const f = harness(), c = await crashed(f, 'claimed')
    f.store.requeueInput(c.requestId)
    const host = await restart(f)
    f.store.deleteService(c.profileId)
    // No sink is registered and the service is gone: the attempt must fail and leave the input in a final state.
    host.resumeQueue(f.id, { onChat: () => {}, onRequest: () => {}, systemPrompt: '' })
    await expect.poll(() => f.store.getInput(c.requestId)?.status, { timeout: 5000 }).toBe('cancelled')
  })
})

it('delegation_restart_requires_explicit_resume_without_dispatch', async () => {
  const { DelegationService } = await import('../src/core/delegations/service')
  const f = harness(), service = new DelegationService(f.store)
  const intent = { id: randomUUID(), messageId: randomUUID(), conversationId: f.id, text: '比较酒店', source: 'user' as const, kind: 'unclassified' as const, spans: [] }
  f.store.saveUserIntent(intent)
  service.admitIntent(intent, { id: 'scope', revision: 1, evidenceSpans: [[0, 4]], scope: {
    purpose: '比较酒店', objects: ['hotel:a'], completion: '比较表已保存', allowedCapabilities: ['http.read'], origins: [], constraints: {}
  } })
  const d = service.approveScope('scope', 1)
  const s = await startFixtureServer('openai', 'text')
  try {
    const p = await profile(f, s.baseUrl), requestId = randomUUID(), taskId = randomUUID()
    f.store.enqueueInput(d.conversationId, intent.text, null, requestId, { profileId: p.id, model: 'test-model', userMessageId: randomUUID() })
    f.store.bindDelegationInput(requestId, intent.id, d.id)
    f.store.claimInput(requestId)
    f.store.createTask({ id: taskId, conversationId: d.conversationId, requestId, generation: 0, status: 'running', serviceId: p.id, modelId: 'test-model', configRevision: 1, error: null })
    service.attachRun(d.id, taskId)
    const host = await restart(f)
    expect(host.delegations.get(d.id)).toMatchObject({ status: 'active', resumeRequired: true })
    expect(f.store.getDelegationForRun(taskId)?.id).toBe(d.id)
    await wait(100)
    expect(s.requests).toHaveLength(0)
    await host.stopAll()
  } finally { await s.close() }
})
