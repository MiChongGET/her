import { afterEach, describe, expect, it } from 'vitest'
import { AgentHost } from '../src/core/agent/host'
import { ChatService } from '../src/core/conversation/chat'
import { openConversationHistory } from '../src/core/agent/factory'
import { startFixtureServer } from './pi-sdk/wire'
import { harness, harnessCleanup } from './helpers/host-harness'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of [...cleanup.splice(0), ...harnessCleanup.splice(0)].reverse()) await close() })

/** Stops a reply after the fixture has streamed "你好🌙", then returns what is needed to inspect the aftermath. */
async function stoppedMidReply() {
  const s = await startFixtureServer('openai', ['hang', 'text', 'text']); cleanup.push(s.close)
  const f = harness()
  const p = await f.profiles.save({ name: 'p', protocol: 'openai', baseUrl: s.baseUrl + '/v1', model: 'test-model', authMethod: 'none' })
  const first = await f.send(f.id, p.id, 'say something')
  await expect.poll(() => f.events.some(event => event.message.content.includes('你好')), { timeout: 10_000 }).toBe(true)
  f.chat.cancel(first.requestId)
  await expect.poll(() => f.finished(first.requestId)?.state, { timeout: 10_000 }).toBe('cancelled')
  const task = f.store.getTaskByRequest(first.requestId)!
  return { s, f, p, first, task }
}
const lastBody = (s: { requests: { body: unknown }[] }) => JSON.stringify(s.requests.at(-1)!.body)

describe('interrupted fragments', () => {
  it('keeps what was said before the stop as a fragment of that task, not as a finished answer', async () => {
    const { f, first, task } = await stoppedMidReply()
    expect(f.store.listDraftFragments(task.id)).toEqual([{ type: 'interrupted-text', content: expect.stringContaining('你好') }])
    const messages = await f.chat.getMessages(f.id)
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', status: 'cancelled', content: expect.stringContaining('你好') })
    expect(task).toMatchObject({ status: 'stopped', requestId: first.requestId })
  })

  it('records the run in the Pi session so the fragment can be tied back to its request', async () => {
    const { f, first, task } = await stoppedMidReply()
    const entries = (await openConversationHistory(f.directory, f.store.getConversation(f.id)!)).manager.getEntries()
    const marker = entries.find(entry => entry.type === 'custom' && entry.customType === 'her.run')
    expect(marker).toMatchObject({ data: { requestId: first.requestId } })
    expect(f.store.getTaskByRequest(first.requestId)!.id).toBe(task.id)
  })

  it('does not send the fragment to the model in the next request', async () => {
    const { s, f, p } = await stoppedMidReply()
    f.chat.resumeQueue(f.id)
    const second = await f.send(f.id, p.id, 'next question')
    await expect.poll(() => f.finished(second.requestId)?.state, { timeout: 10_000 }).toBe('completed')
    const body = lastBody(s)
    expect(body).toContain('next question')
    expect(body).not.toContain('你好')
  }, 20_000)

  it('still does not send it after a restart', async () => {
    const { s, f, p } = await stoppedMidReply()
    const restarted = new ChatService(f.store, new AgentHost(f.store, f.profiles, f.directory), () => {}, () => {})
    cleanup.push(() => restarted.shutdown())
    restarted.resumeQueue(f.id)
    await restarted.send({ requestId: 'after-restart', conversationId: f.id, profileId: p.id, content: 'after the restart' })
    await expect.poll(() => s.requests.length, { timeout: 10_000 }).toBe(2)
    expect(lastBody(s)).toContain('after the restart')
    expect(lastBody(s)).not.toContain('你好')
  }, 20_000)

  it('the original text stays viewable even though the model no longer sees it', async () => {
    const { s, f, p } = await stoppedMidReply()
    f.chat.resumeQueue(f.id)
    const second = await f.send(f.id, p.id, 'next question')
    await expect.poll(() => f.finished(second.requestId)?.state, { timeout: 10_000 }).toBe('completed')
    expect((await f.chat.getMessages(f.id)).some(message => message.content.includes('你好') && message.status === 'cancelled')).toBe(true)
    void s
  }, 20_000)
})
