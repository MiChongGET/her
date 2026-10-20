import { afterEach, describe, expect, it } from 'vitest'
import { startFixtureServer } from './pi-sdk/wire'
import { harness, harnessCleanup } from './helpers/host-harness'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of [...cleanup.splice(0), ...harnessCleanup.splice(0)].reverse()) await close() })
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

type Fixture = ReturnType<typeof harness>
/** Starts a reply that is held at the model, lets `change` happen meanwhile, then releases it. */
async function duringRun(change: (f: Fixture, profileId: string) => Promise<void> | void, scenario: 'text' | 'hang' = 'text') {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const s = await startFixtureServer('openai', [scenario, 'text'], { beforeReply: () => gate }); cleanup.push(s.close)
  const f = harness()
  const p = await f.profiles.save({ name: 'p', protocol: 'openai', baseUrl: s.baseUrl + '/v1', model: 'test-model', authMethod: 'api-key', apiKey: 'first-key' })
  const queued = await f.send(f.id, p.id, 'first'), waiting = await f.send(f.id, p.id, 'second')
  await expect.poll(() => s.requests.length).toBe(1)
  await change(f, p.id)
  release()
  await expect.poll(() => f.finished(queued.requestId)?.state, { timeout: 10_000 }).toBeDefined()
  await wait(200)
  return { s, f, p, first: f.finished(queued.requestId)!, waiting, queue: f.chat.getQueue(f.id) }
}
const resave = (f: Fixture, id: string, patch: object) => {
  const current = f.profiles.list().find(item => item.id === id)!
  return f.profiles.save({ id, name: current.name, protocol: current.protocol, baseUrl: current.baseUrl, model: current.model, authMethod: 'api-key', ...patch } as never)
}

describe('a service that is deleted while a reply is running', () => {
  it('stops that reply at once, says why, and holds the queue', async () => {
    const r = await duringRun((f, id) => { f.profiles.delete(id) })
    expect(r.first.state).toBe('cancelled')
    expect(r.first.error).toContain('已被删除')
    expect(r.queue.paused).toBe('service-changed')
    expect(r.f.state(r.waiting.requestId)).toEqual([])
  })
})

describe('a service whose credentials or address change while a reply is running', () => {
  it('stops the reply when the API key is replaced', async () => {
    const r = await duringRun(async (f, id) => { await resave(f, id, { apiKey: 'second-key' }) })
    expect(r.first.state).toBe('cancelled')
    expect(r.first.error).toContain('地址或凭据')
    expect(r.queue.paused).toBe('service-changed')
  })
  it('stops the reply when the key is removed', async () => {
    const r = await duringRun(async (f, id) => { await resave(f, id, { apiKey: '', authMethod: 'none' }) })
    expect(r.first.state).toBe('cancelled')
  })
  it('stops the reply when the base address changes', async () => {
    const r = await duringRun(async (f, id) => { const c = f.profiles.list().find(x => x.id === id)!; await resave(f, id, { baseUrl: c.baseUrl + '/elsewhere' }) })
    expect(r.first.state).toBe('cancelled')
  })
})

describe('an ordinary edit does not touch a running reply', () => {
  it('renaming the service lets the reply finish and the queue carry on', async () => {
    const r = await duringRun(async (f, id) => { await resave(f, id, { name: 'renamed' }) })
    expect(r.first.state).toBe('completed')
    expect(r.queue.paused).toBeNull()
    await expect.poll(() => r.f.finished(r.waiting.requestId)?.state, { timeout: 10_000 }).toBe('completed')
  })
  it('editing the model list lets it finish', async () => {
    const r = await duringRun(async (f, id) => { await resave(f, id, { models: [{ id: 'test-model' }, { id: 'extra' }] }) })
    expect(r.first.state).toBe('completed')
  })
})

describe('only the runs that use the changed service are stopped', () => {
  it('another conversation on a different service keeps going', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const s = await startFixtureServer('openai', 'text', { beforeReply: () => gate }); cleanup.push(s.close)
    const f = harness()
    const a = await f.profiles.save({ name: 'a', protocol: 'openai', baseUrl: s.baseUrl + '/v1', model: 'test-model', authMethod: 'none' })
    const b = await f.profiles.save({ name: 'b', protocol: 'openai', baseUrl: s.baseUrl + '/v1', model: 'test-model', authMethod: 'none' })
    const onA = await f.send(f.id, a.id, 'hi'), onB = await f.send(f.other, b.id, 'hi')
    await expect.poll(() => s.requests.length).toBe(2)
    f.profiles.delete(a.id)
    release()
    await expect.poll(() => f.finished(onA.requestId)?.state, { timeout: 10_000 }).toBe('cancelled')
    await expect.poll(() => f.finished(onB.requestId)?.state, { timeout: 10_000 }).toBe('completed')
  })

  it('deleting a service nobody is using changes nothing', async () => {
    const s = await startFixtureServer('openai', 'text'); cleanup.push(s.close)
    const f = harness()
    const idle = await f.profiles.save({ name: 'idle', protocol: 'openai', baseUrl: s.baseUrl + '/v1', model: 'test-model', authMethod: 'none' })
    const used = await f.profiles.save({ name: 'used', protocol: 'openai', baseUrl: s.baseUrl + '/v1', model: 'test-model', authMethod: 'none' })
    const sent = await f.send(f.id, used.id, 'hi')
    f.profiles.delete(idle.id)
    await expect.poll(() => f.finished(sent.requestId)?.state, { timeout: 10_000 }).toBe('completed')
  })
})

describe('a later task uses the changed configuration', () => {
  it('after the key is replaced and the queue resumed, the next message goes out with the new key', async () => {
    const r = await duringRun(async (f, id) => { await resave(f, id, { apiKey: 'second-key' }) })
    r.f.chat.resumeQueue(r.f.id)
    await expect.poll(() => r.f.finished(r.waiting.requestId)?.state, { timeout: 10_000 }).toBe('completed')
    const header = (r.s.requests.at(-1)!.headers.authorization ?? '') as string
    expect(header).toContain('second-key')
    expect(header).not.toContain('first-key')
  })
})
