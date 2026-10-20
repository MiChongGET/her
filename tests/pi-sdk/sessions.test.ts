import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { startMockProvider } from '../helpers/mock-provider'
import { createProbeSession } from './harness'

type Session = Awaited<ReturnType<typeof createProbeSession>>['session']

function record(session: Session) {
  const events: AgentSessionEvent[] = []
  const text: string[] = []
  session.subscribe(event => {
    events.push(event)
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') text.push(event.assistantMessageEvent.delta)
  })
  return { events, text }
}

describe('Pi 1.3.0 session behaviour', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'her-pi-root-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('runs two sessions concurrently without crossing events', async () => {
    const arrivals: number[] = []
    const provider = await startMockProvider({
      reply: body => { arrivals.push(Date.now()); return { text: JSON.stringify(body.messages).includes('from-A') ? 'answer-A' : 'answer-B', delayMs: 400 } }
    })
    try {
      const a = await createProbeSession({ root, baseUrl: provider.baseUrl, providerId: 'her-a', apiKey: 'key-a' })
      const b = await createProbeSession({ root, baseUrl: provider.baseUrl, providerId: 'her-b', apiKey: 'key-b' })
      const ra = record(a.session), rb = record(b.session)
      await Promise.all([a.session.prompt('from-A'), b.session.prompt('from-B')])
      // Both requests reach the server before either 400ms reply completes.
      expect(arrivals).toHaveLength(2)
      expect(Math.abs(arrivals[1] - arrivals[0])).toBeLessThan(400)
      expect(ra.text.join('')).toBe('answer-A')
      expect(rb.text.join('')).toBe('answer-B')
      const auth = provider.requests.map(request => [JSON.stringify(request.body.messages).includes('from-A'), request.headers.authorization])
      expect(auth).toEqual(expect.arrayContaining([[true, 'Bearer key-a'], [false, 'Bearer key-b']]))
      a.session.dispose(); b.session.dispose()
    } finally { await provider.close() }
  })

  it('abort affects only its own session', async () => {
    const provider = await startMockProvider({ reply: body => ({ text: 'done', delayMs: JSON.stringify(body.messages).includes('slow') ? 2000 : 200 }) })
    try {
      const a = await createProbeSession({ root, baseUrl: provider.baseUrl, providerId: 'her-a', apiKey: 'k' })
      const b = await createProbeSession({ root, baseUrl: provider.baseUrl, providerId: 'her-b', apiKey: 'k' })
      const ra = record(a.session), rb = record(b.session)
      const pa = a.session.prompt('slow').catch(error => error)
      const pb = b.session.prompt('fast')
      await new Promise(resolve => setTimeout(resolve, 50))
      await a.session.abort()
      await pa
      await pb
      expect(ra.events.find(event => event.type === 'agent_settled')).toMatchObject({ aborted: true })
      expect(rb.events.find(event => event.type === 'agent_settled')).toMatchObject({ aborted: false })
      expect(rb.text.join('')).toBe('done')
      a.session.dispose(); b.session.dispose()
    } finally { await provider.close() }
  })

  // 1.3.0 persists ordinary messages via appendMessage() right after message_end without emitting
  // entry_appended; projection must pull from SessionManager rather than rely on that event.
  it('persists messages synchronously by agent_settled and keeps custom entries out of model context', async () => {
    let fileAtRequest = ''
    let sessionFile: string | undefined
    const provider = await startMockProvider({ reply: () => {
      fileAtRequest = sessionFile && existsSync(sessionFile) ? readFileSync(sessionFile, 'utf8') : ''
      return { text: 'ok' }
    } })
    try {
      const { session } = await createProbeSession({ root, baseUrl: provider.baseUrl, apiKey: 'k', persist: true })
      sessionFile = session.sessionManager.getSessionFile()
      const { events } = record(session)
      let entriesAtSettled = -1
      session.subscribe(event => { if (event.type === 'agent_settled') entriesAtSettled = session.sessionManager.getEntries().length })
      session.sessionManager.appendCustomEntry('her.run', { runId: 'RUN-MARKER-1', requestId: 'req-1' })
      await session.prompt('hello')
      const types = events.map(event => event.type)
      expect(types.lastIndexOf('agent_end')).toBeLessThan(types.indexOf('agent_settled'))
      expect(types.filter(type => type === 'entry_appended')).toEqual([])
      expect(fileAtRequest).toContain('"her.run"')
      expect(fileAtRequest).toContain('hello')
      const onDisk = readFileSync(sessionFile!, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { type: string; message?: { role: string } })
      expect(entriesAtSettled).toBe(session.sessionManager.getEntries().length)
      expect(onDisk.flatMap(entry => entry.type === 'message' ? [entry.message!.role] : [])).toEqual(['system', 'user', 'assistant'])
      expect(JSON.stringify(provider.requests.map(request => request.body))).not.toContain('RUN-MARKER-1')
      session.dispose()
    } finally { await provider.close() }
  })

  it('rejects a bare prompt while streaming', async () => {
    const provider = await startMockProvider({ reply: () => ({ text: 'ok', delayMs: 300 }) })
    try {
      const { session } = await createProbeSession({ root, baseUrl: provider.baseUrl, apiKey: 'k' })
      const first = session.prompt('one')
      await new Promise(resolve => setTimeout(resolve, 30))
      await expect(session.prompt('two')).rejects.toThrow()
      await first
      session.dispose()
    } finally { await provider.close() }
  })
})
