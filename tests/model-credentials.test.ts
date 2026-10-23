import { afterEach, describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openConversationHistory } from '../src/core/agent/factory'
import { harness, harnessCleanup } from './helpers/host-harness'
import { startFixtureServer } from './pi-sdk/wire'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of [...cleanup.splice(0), ...harnessCleanup.splice(0)].reverse()) await close() })
function bytes(directory: string): string {
  return readdirSync(directory, { withFileTypes: true }).map(entry => entry.isDirectory()
    ? bytes(join(directory, entry.name)) : readFileSync(join(directory, entry.name)).toString('latin1')).join('\n')
}

describe('Her runtime credential isolation', () => {
  it('keeps concurrent same-protocol profiles in independent her-prefixed provider slots', async () => {
    const a = await startFixtureServer('openai', 'text'), b = await startFixtureServer('openai', 'text')
    cleanup.push(a.close, b.close)
    const f = harness()
    const pa = await f.profiles.save({ name: 'a', protocol: 'openai', baseUrl: a.baseUrl + '/v1', model: 'test-model', contextWindow: 128000, authMethod: 'api-key', apiKey: 'private-a' })
    const pb = await f.profiles.save({ name: 'b', protocol: 'openai', baseUrl: b.baseUrl + '/v1', model: 'test-model', contextWindow: 128000, authMethod: 'api-key', apiKey: 'private-b' })
    const runs = await Promise.all([f.send(f.id, pa.id, 'a'), f.send(f.other, pb.id, 'b')])
    for (const run of runs) await expect.poll(() => f.finished(run.requestId)?.state).toBe('completed')
    expect(a.requests[0].headers.authorization).toBe('Bearer private-a')
    expect(b.requests[0].headers.authorization).toBe('Bearer private-b')
    for (const [id, profile] of [[f.id, pa], [f.other, pb]] as const) {
      const history = await openConversationHistory(f.directory, f.store.getConversation(id)!)
      const message = history.manager.getEntries().find(entry => entry.type === 'message' && entry.message.role === 'assistant')
      expect(message).toMatchObject({ message: { provider: `her-${profile.id}` } })
    }
    const persisted = bytes(join(f.directory, 'pi'))
    expect(persisted).not.toContain('private-a')
    expect(persisted).not.toContain('private-b')
  })

  it.each(['openai', 'anthropic', 'openai-responses'] as const)('%s: sends only explicit gateway headers and never persists the internal credential', async protocol => {
    const server = await startFixtureServer(protocol, 'text'); cleanup.push(server.close)
    const f = harness()
    const profile = await f.profiles.save({ name: 'headers', protocol, baseUrl: server.baseUrl + '/v1', model: 'test-model', contextWindow: 128000, authMethod: 'headers', customHeaders: { 'X-Gateway': 'gateway-key' } })
    const run = await f.send(f.id, profile.id, 'hello')
    await expect.poll(() => f.finished(run.requestId)?.state).toBe('completed')
    expect(server.requests[0].headers.authorization).toBeUndefined()
    expect(server.requests[0].headers['x-api-key']).toBeUndefined()
    expect(server.requests[0].headers['x-gateway']).toBe('gateway-key')
    // Runtime-generated credentials must not be recorded in Pi's authoritative history.
    const sessions = bytes(join(f.directory, 'pi'))
    expect(sessions).not.toContain('gateway-key')
    expect(sessions).not.toContain('apiKey')
  })
})

 it('does not expose credential-bearing upstream errors through chat, request events, logs or Pi history', async () => {
    const logs = [vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'log')]
    const server = await startFixtureServer('openai', 'http-error', { errorMessage: 'private-key private-header synthetic_secret_marker' }); cleanup.push(server.close)
    const f = harness()
    const p = await f.profiles.save({ name: 'p', protocol: 'openai', baseUrl: server.baseUrl + '/v1', model: 'test-model', contextWindow: 128000, authMethod: 'api-key', apiKey: 'private-key', customHeaders: { 'X-Auth': 'private-header' } })
    const sent = await f.send(f.id, p.id, 'hello')
    await expect.poll(() => f.finished(sent.requestId)?.state).toBe('failed')
    expect(f.finished(sent.requestId)?.error).toMatch(/检查|认证/)
    const exposed = JSON.stringify([f.events, f.requests, logs.map(log => log.mock.calls)]) + bytes(join(f.directory, 'pi'))
    expect(exposed).not.toMatch(/private-key|private-header|synthetic_secret_marker/)
  })
