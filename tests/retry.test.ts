import { afterEach, describe, expect, it } from 'vitest'
import { startFixtureServer, type Scenario } from './pi-sdk/wire'
import { harness, harnessCleanup } from './helpers/host-harness'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of [...cleanup.splice(0), ...harnessCleanup.splice(0)].reverse()) await close() })

async function failedFirst(second: Scenario = 'text') {
  const s = await startFixtureServer('openai', ['http-error', second]); cleanup.push(s.close)
  const f = harness()
  const p = await f.profiles.save({ name: 'p', protocol: 'openai', baseUrl: s.baseUrl + '/v1', model: 'test-model', authMethod: 'none' })
  const first = await f.send(f.id, p.id, 'question')
  await expect.poll(() => f.finished(first.requestId)?.state, { timeout: 10_000 }).toBe('failed')
  const reply = (await f.chat.getMessages(f.id)).at(-1)!
  f.chat.resumeQueue(f.id)
  return { s, f, p, reply }
}
const retry = (f: ReturnType<typeof harness>, profileId: string, retryMessageId: string) =>
  f.chat.send({ requestId: `retry-${Math.random()}`, conversationId: f.id, profileId, content: 'question', retryMessageId })

describe('retrying the last reply', () => {
  it('sends the same text again after a failed reply and gets an answer', async () => {
    const { s, f, p, reply } = await failedFirst()
    expect(reply).toMatchObject({ role: 'assistant', status: 'failed' })
    const sent = await retry(f, p.id, reply.id)
    await expect.poll(() => f.requests.find(event => event.requestId === sent.userMessage.id || event.state === 'completed'), { timeout: 10_000 }).toBeDefined()
    await expect.poll(() => s.requests.length, { timeout: 10_000 }).toBe(2)
    await expect.poll(async () => (await f.chat.getMessages(f.id)).at(-1)?.status, { timeout: 10_000 }).toBe('complete')
  })

  it('also works after a reply the user stopped', async () => {
    const s = await startFixtureServer('openai', ['hang', 'text']); cleanup.push(s.close)
    const f = harness()
    const p = await f.profiles.save({ name: 'p', protocol: 'openai', baseUrl: s.baseUrl + '/v1', model: 'test-model', authMethod: 'none' })
    const first = await f.send(f.id, p.id, 'question')
    await expect.poll(() => s.requests.length).toBe(1)
    f.chat.cancel(first.requestId)
    await expect.poll(() => f.finished(first.requestId)?.state, { timeout: 10_000 }).toBe('cancelled')
    const reply = (await f.chat.getMessages(f.id)).at(-1)!
    f.chat.resumeQueue(f.id)
    await retry(f, p.id, reply.id)
    await expect.poll(async () => (await f.chat.getMessages(f.id)).at(-1)?.status, { timeout: 10_000 }).toBe('complete')
  })

  it('refuses a message that is not the last reply, one that is not a reply, and an unknown id', async () => {
    const { s, f, p, reply } = await failedFirst()
    const messages = await f.chat.getMessages(f.id)
    await expect(retry(f, p.id, messages[0].id)).rejects.toThrow('只能重试')   // the user message
    await expect(retry(f, p.id, 'nope')).rejects.toThrow('只能重试')
    expect(s.requests).toHaveLength(1)
    void reply
  })

  it('refuses to retry a reply that completed', async () => {
    const s = await startFixtureServer('openai', 'text'); cleanup.push(s.close)
    const f = harness()
    const p = await f.profiles.save({ name: 'p', protocol: 'openai', baseUrl: s.baseUrl + '/v1', model: 'test-model', authMethod: 'none' })
    const first = await f.send(f.id, p.id, 'question')
    await expect.poll(() => f.finished(first.requestId)?.state, { timeout: 10_000 }).toBe('completed')
    const reply = (await f.chat.getMessages(f.id)).at(-1)!
    await expect(retry(f, p.id, reply.id)).rejects.toThrow('只能重试')
    expect(s.requests).toHaveLength(1)
  })

  it('refuses once a newer message has been sent after the failed one', async () => {
    const { s, f, p, reply } = await failedFirst('text')
    const second = await f.send(f.id, p.id, 'something else')
    await expect.poll(() => f.finished(second.requestId)?.state, { timeout: 10_000 }).toBe('completed')
    await expect(retry(f, p.id, reply.id)).rejects.toThrow('只能重试')
    void s
  })

  it('does not let a retry carry new files along', async () => {
    const { f, p, reply } = await failedFirst()
    await expect(f.chat.send({ requestId: 'r', conversationId: f.id, profileId: p.id, content: 'question', retryMessageId: reply.id, fileIds: ['x'] })).rejects.toThrow()
  })
})
