import { afterEach, describe, expect, it } from 'vitest'
import { startFixtureServer } from './pi-sdk/wire'
import { harness, harnessCleanup } from './helpers/host-harness'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of [...cleanup.splice(0), ...harnessCleanup.splice(0)].reverse()) await close() })

async function setup() {
  const s = await startFixtureServer('openai', 'text'); cleanup.push(s.close)
  const f = harness()
  const p = await f.profiles.save({ name: 'p', protocol: 'openai', baseUrl: s.baseUrl + '/v1', model: 'default-model', contextWindow: 128000, authMethod: 'none',
    models: [{ id: 'default-model' }, { id: 'other-model' }] })
  return { s, f, p }
}
const modelOf = (s: { requests: { body: unknown }[] }, index: number) => (s.requests[index].body as { model: string }).model
async function sendAs(f: ReturnType<typeof harness>, conversationId: string, profileId: string, model?: string) {
  const sent = await f.chat.send({ requestId: `r-${Math.random()}`, conversationId, profileId, content: 'hi', ...(model ? { model } : {}) })
  return sent
}

describe('choosing a model for a send', () => {
  it('uses the service default when none is chosen, and the chosen one otherwise', async () => {
    const { s, f, p } = await setup()
    await sendAs(f, f.id, p.id)
    await expect.poll(() => s.requests.length, { timeout: 10_000 }).toBe(1)
    await expect.poll(() => f.chat.getActiveRequest(), { timeout: 10_000 }).toBeNull()
    await sendAs(f, f.id, p.id, 'other-model')
    await expect.poll(() => s.requests.length, { timeout: 10_000 }).toBe(2)
    expect([modelOf(s, 0), modelOf(s, 1)]).toEqual(['default-model', 'other-model'])
  })

  it('rejects a model the service does not have, before anything is queued or sent', async () => {
    const { s, f, p } = await setup()
    await expect(sendAs(f, f.id, p.id, 'not-a-model')).rejects.toThrow('没有这个模型')
    expect(f.chat.getQueue(f.id).items).toEqual([])
    expect(await f.chat.getMessages(f.id)).toEqual([])
    expect(s.requests).toHaveLength(0)
  })

  it('applies the chosen model to that request only: another conversation still gets the default', async () => {
    const { s, f, p } = await setup()
    await sendAs(f, f.id, p.id, 'other-model')
    await sendAs(f, f.other, p.id)
    await expect.poll(() => s.requests.length, { timeout: 10_000 }).toBe(2)
    expect(s.requests.map((_, i) => modelOf(s, i)).sort()).toEqual(['default-model', 'other-model'])
  })

  it('records the model on the reply that was produced with it', async () => {
    const { f, p } = await setup()
    const sent = await sendAs(f, f.id, p.id, 'other-model')
    expect(sent.assistantMessage.model).toBe('other-model')
    await expect.poll(async () => (await f.chat.getMessages(f.id)).at(-1)?.status, { timeout: 10_000 }).toBe('complete')
    expect((await f.chat.getMessages(f.id)).at(-1)?.model).toBe('other-model')
  })

  it('rejects sending to a conversation in the trash without creating any message', async () => {
    const { s, f, p } = await setup()
    f.store.trashConversation(f.id)
    await expect(sendAs(f, f.id, p.id)).rejects.toThrow('不存在')
    expect(s.requests).toHaveLength(0)
    expect(f.store.listPendingInputs(f.id)).toEqual([])
  })
})
