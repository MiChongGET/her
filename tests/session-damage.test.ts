import { afterEach, describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, writeFileSync, chmodSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { startFixtureServer } from './pi-sdk/wire'
import { harness, harnessCleanup } from './helpers/host-harness'
import { AgentHost } from '../src/core/agent/host'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of [...cleanup.splice(0), ...harnessCleanup.splice(0)].reverse()) await close() })

async function withHistory() {
  const s = await startFixtureServer('openai', ['text', 'text', 'text']); cleanup.push(s.close)
  const f = harness()
  const p = await f.profiles.save({ name: 'p', protocol: 'openai', baseUrl: s.baseUrl + '/v1', model: 'test-model', contextWindow: 128000, authMethod: 'none' })
  const sent = await f.send(f.id, p.id, 'hello')
  await expect.poll(() => f.finished(sent.requestId)?.state, { timeout: 10_000 }).toBe('completed')
  const dir = join(f.directory, 'pi', 'sessions', f.id), file = join(dir, readdirSync(dir)[0])
  return { s, f, p, file, good: readFileSync(file, 'utf8') }
}

describe('a damaged session file', () => {
  it('is refused with a plain message that names no path, and the file is left byte for byte as it was', async () => {
    const { f, file } = await withHistory()
    writeFileSync(file, 'this is not a session'); const before = readFileSync(file)
    const error = await f.chat.getMessages(f.id).then(() => undefined, cause => cause as Error)
    expect(error?.message).toContain('已损坏')
    expect(error?.message).not.toContain(f.directory)
    expect(error?.message).not.toContain('.jsonl')
    expect(readFileSync(file).equals(before)).toBe(true)
  })

  it('stops a send to that conversation before anything reaches the model, with the same message', async () => {
    const { s, f, p, file } = await withHistory()
    const requestsBefore = s.requests.length
    writeFileSync(file, '{"type":"nonsense"}\n')
    const error = await f.send(f.id, p.id, 'again').then(() => undefined, cause => cause as Error)
    expect(error?.message).toContain('已损坏')
    expect(error?.message).not.toContain(f.directory)
    expect(s.requests).toHaveLength(requestsBefore)
    expect(f.chat.getQueue(f.id).items).toEqual([])
  })

  it('leaves every other conversation working', async () => {
    const { s, f, p, file } = await withHistory()
    writeFileSync(file, 'garbage')
    const ok = await f.send(f.other, p.id, 'unaffected')
    await expect.poll(() => f.finished(ok.requestId)?.state, { timeout: 10_000 }).toBe('completed')
    expect((await f.chat.getMessages(f.other)).map(message => message.role)).toEqual(['user', 'assistant'])
    expect(s.requests.length).toBeGreaterThan(1)
  })

  it('does not create a replacement session or move the damaged one aside', async () => {
    const { f, file } = await withHistory()
    writeFileSync(file, 'garbage')
    await f.chat.getMessages(f.id).catch(() => {})
    await f.send(f.id, 'missing-profile', 'x').catch(() => {})
    const dir = join(f.directory, 'pi', 'sessions', f.id)
    expect(readdirSync(dir)).toEqual([file.split('/').at(-1)])
  })

  it('is reported as damaged again after a restart, and the repaired file works again', async () => {
    const { s, f, p, file, good } = await withHistory()
    writeFileSync(file, 'garbage')
    await expect(f.chat.getMessages(f.id)).rejects.toThrow('已损坏')
    writeFileSync(file, good)   // the user restores the file from a backup
    expect((await f.chat.getMessages(f.id)).map(message => message.role)).toEqual(['user', 'assistant'])
    const sent = await f.send(f.id, p.id, 'after the repair')
    await expect.poll(() => f.finished(sent.requestId)?.state, { timeout: 10_000 }).toBe('completed')
    void s
  })

  it('an unreadable file (permissions) gets its own message and is not called damaged', async () => {
    const { f, file } = await withHistory()
    chmodSync(file, 0o000)
    try {
      const error = await f.chat.getMessages(f.id).then(() => undefined, cause => cause as Error)
      if (error) {   // root can still read a 000 file, in which case there is nothing to assert
        expect(error.message).toContain('无法读取')
        expect(error.message).not.toContain('已损坏')
        expect(error.message).not.toContain(f.directory)
      }
    } finally { chmodSync(file, 0o600) }
  })
})

describe('a single bad line inside an otherwise valid session', () => {
  it('is quarantined before Pi can silently skip the damaged line', async () => {
    const { s, f, p, file, good } = await withHistory()
    const lines = good.split('\n'); lines.splice(3, 0, '{not json')
    writeFileSync(file, lines.join('\n')); const before = readFileSync(file)
    await expect(f.chat.getMessages(f.id)).rejects.toThrow('已损坏')
    expect(existsSync(join(f.directory, 'pi', 'quarantine', f.id))).toBe(true)
    const requests = s.requests.length
    await expect(f.send(f.id, p.id, 'must not send')).rejects.toThrow('已损坏')
    expect(s.requests).toHaveLength(requests)
    const restarted = new AgentHost(f.store, f.profiles, f.directory)
    await restarted.ready()
    await expect(restarted.getMessages(f.id)).rejects.toThrow('已损坏')
    await restarted.stopAll()
    expect(readFileSync(file).equals(before)).toBe(true)
    writeFileSync(file, good)
    expect((await f.chat.getMessages(f.id)).map(message => message.role)).toEqual(['user', 'assistant'])
    expect(existsSync(join(f.directory, 'pi', 'quarantine', f.id))).toBe(false)
  })
})

it('does not replace a quarantined session when its damaged file goes missing', async () => {
  const { f, file } = await withHistory()
  writeFileSync(file, 'garbage')
  await expect(f.chat.getMessages(f.id)).rejects.toThrow('已损坏')
  unlinkSync(file)
  await expect(f.chat.getMessages(f.id)).rejects.toThrow('已损坏')
  expect(readdirSync(join(f.directory, 'pi', 'sessions', f.id))).toEqual([])
})
