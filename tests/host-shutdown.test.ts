import { afterEach, describe, expect, it } from 'vitest'
import { createShutdown } from '../src/main/shutdown'
import { startFixtureServer, type Scenario } from './pi-sdk/wire'
import { harness, harnessCleanup } from './helpers/host-harness'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of [...cleanup.splice(0), ...harnessCleanup.splice(0)].reverse()) await close() })
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function server(scenario: Scenario | Scenario[], options: Parameters<typeof startFixtureServer>[2] = {}) {
  const s = await startFixtureServer('openai', scenario, options); cleanup.push(s.close); return s
}
async function profile(f: ReturnType<typeof harness>, baseUrl: string) {
  return f.profiles.save({ name: 'p', protocol: 'openai', baseUrl: baseUrl + '/v1', model: 'test-model', contextWindow: 128000, authMethod: 'none' })
}
function gated() {
  let release!: () => void
  const open = new Promise<void>(resolve => { release = resolve })
  return { release, beforeReply: () => open }
}

describe('application shutdown', () => {
  it('stops two running conversations and persists their stopped state before closing the store', async () => {
    const gate = gated(), s = await server('hang', { beforeReply: gate.beforeReply })
    const f = harness(), p = await profile(f, s.baseUrl)
    const a = await f.send(f.id, p.id, 'A')
    const b = await f.send(f.other, p.id, 'B')
    await expect.poll(() => s.requests.length).toBe(2)
    let closed = false
    const shutdown = createShutdown({ lifetime: new AbortController(), stop: () => f.chat.shutdown(),
      drain: () => f.chat.shutdown(), forceClose: () => {}, close: () => { closed = true } })
    gate.release()
    await shutdown()
    expect(closed).toBe(true)
    expect(f.state(a.requestId)).toContain('cancelled')
    expect(f.state(b.requestId)).toContain('cancelled')
    const [taskA, taskB] = [f.store.getInput(a.requestId), f.store.getInput(b.requestId)]
    expect(taskA?.status).toBe('cancelled')
    expect(taskB?.status).toBe('cancelled')
  }, 20_000)

  it('refuses a new message once shutdown has started', async () => {
    const s = await server('text')
    const f = harness(), p = await profile(f, s.baseUrl)
    const shutdown = createShutdown({ lifetime: new AbortController(), stop: () => f.chat.shutdown(),
      drain: () => f.chat.shutdown(), forceClose: () => {}, close: () => {} })
    const done = shutdown()
    await expect(f.send(f.id, p.id, 'too late')).rejects.toThrow('退出')
    await done
  }, 20_000)

  it('force-closes only after the drain deadline, and only Her-owned processes', async () => {
    const gate = gated(), s = await server('hang', { beforeReply: gate.beforeReply })
    const f = harness(), p = await profile(f, s.baseUrl)
    await f.send(f.id, p.id, 'A')
    await expect.poll(() => s.requests.length).toBe(1)
    let forced = false
    const shutdown = createShutdown({ lifetime: new AbortController(), stop: () => f.chat.shutdown(),
      drain: () => new Promise(() => {}), forceClose: () => { forced = true }, close: () => {} })
    const done = shutdown()
    await wait(50)
    expect(forced).toBe(false)
    await done
    expect(forced).toBe(true)
    gate.release()
  }, 20_000)
})
