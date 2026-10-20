import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Type } from 'typebox'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { startMockProvider } from '../helpers/mock-provider'
import { createProbeSession, memoryCredentials, seedDecoyHome } from './harness'

describe('Pi 1.3.0 controlled injection', () => {
  let decoy: ReturnType<typeof seedDecoyHome>
  let root: string
  const saved = { HOME: process.env.HOME, PI: process.env.PI_CODING_AGENT_DIR }

  beforeEach(() => {
    decoy = seedDecoyHome()
    root = mkdtempSync(join(tmpdir(), 'her-pi-root-'))
    process.env.HOME = decoy.home
    delete process.env.PI_CODING_AGENT_DIR
  })
  afterEach(() => {
    process.env.HOME = saved.HOME
    if (saved.PI !== undefined) process.env.PI_CODING_AGENT_DIR = saved.PI
    rmSync(decoy.home, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  })

  it('exposes only injected custom tools and ignores the user Pi home', async () => {
    const provider = await startMockProvider({ reply: () => ({ text: 'ok' }) })
    try {
      const probe = defineTool({
        name: 'her_probe', label: 'probe', description: 'probe tool',
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: 'text', text: 'done' }], details: undefined })
      })
      const credentials = memoryCredentials({ 'her-probe': { type: 'api_key', key: 'HER-KEY' } })
      const { session } = await createProbeSession({ root, baseUrl: provider.baseUrl, credentials, tools: [probe] })
      try {
        expect(session.getActiveToolNames()).toEqual(['her_probe'])
        await session.prompt('hi')
        const body = provider.requests[0].body as { tools?: { function: { name: string } }[]; messages: { content: unknown }[] }
        expect(body.tools?.map(tool => tool.function.name)).toEqual(['her_probe'])
        expect(JSON.stringify(body.messages)).not.toContain('DECOY-HOME-INSTRUCTIONS')
        expect(provider.requests[0].headers.authorization).toBe('Bearer HER-KEY')
        expect(existsSync(join(decoy.markers, 'extension-loaded'))).toBe(false)
        // Pi probes every catalog provider id for availability; only Her's own id may yield a credential.
        expect(credentials.reads).toContain('her-probe')
      } finally { session.dispose() }
    } finally { await provider.close() }
  })

  it('does not pick up provider keys from the process environment', async () => {
    const provider = await startMockProvider({ reply: () => ({ text: 'ok' }) })
    const env = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
    process.env.OPENAI_API_KEY = 'DECOY-ENV-KEY'
    process.env.ANTHROPIC_API_KEY = 'DECOY-ENV-KEY'
    try {
      const { session } = await createProbeSession({ root, baseUrl: provider.baseUrl })
      try { await session.prompt('hi').catch(() => {}) } finally { session.dispose() }
      expect(JSON.stringify(provider.requests.map(request => request.headers))).not.toContain('DECOY-ENV-KEY')
    } finally {
      for (const [name, value] of Object.entries(env)) value === undefined ? delete process.env[name] : process.env[name] = value
      await provider.close()
    }
  })

  it('writes nothing outside the injected root', async () => {
    const provider = await startMockProvider({ reply: () => ({ text: 'ok' }) })
    try {
      const before = readdirSync(join(decoy.home, '.pi', 'agent')).sort()
      const { session } = await createProbeSession({ root, baseUrl: provider.baseUrl, apiKey: 'k', persist: true })
      try { await session.prompt('hi') } finally { session.dispose() }
      expect(readdirSync(join(decoy.home, '.pi', 'agent')).sort()).toEqual(before)
      expect(existsSync(join(root, 'pi', 'auth.json'))).toBe(false)
      expect(readdirSync(join(root, 'pi', 'sessions')).length).toBeGreaterThan(0)
    } finally { await provider.close() }
  })
})
