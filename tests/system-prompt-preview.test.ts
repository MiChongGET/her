import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { harness, harnessCleanup } from './helpers/host-harness'
import { startFixtureServer } from './pi-sdk/wire'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import { AgentHost } from '../src/core/agent/host'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of [...cleanup.splice(0), ...harnessCleanup.splice(0)].reverse()) await close() })

it('previews a draft without tool discovery, model requests, session creation or changing settings', async () => {
  const toolsFor = vi.fn(async () => new SimpleToolRegistry().snapshot())
  const f = harness(undefined, toolsFor)
  const p = await f.profiles.save({ name: 'preview', protocol: 'openai', baseUrl: 'https://unused.example/v1', model: 'test-model', contextWindow: 4096, authMethod: 'none' })
  f.store.setSettings({ ...f.store.getSettings(), systemPrompt: 'SAVED' })
  const result = await f.host.previewSystemPrompt({ prompt: 'UNSAVED', profileId: p.id, conversationId: f.id })
  expect(result.parts[0].content).toBe('UNSAVED')
  expect(result.parts.find(part => part.id === 'tools')?.status).toBe('conditional')
  expect(result.parts.find(part => part.id === 'skills')?.status).toBe('omitted')
  expect(result.contextWindow).toBe(4096)
  expect(result.actual).toBeNull()
  expect(toolsFor).not.toHaveBeenCalled()
  expect(existsSync(join(f.directory, 'pi/sessions', f.id))).toBe(false)
  expect(f.store.getSettings().systemPrompt).toBe('SAVED')
})

it('keeps the actual dispatched prompt independent of drafts and restores it after restart without rewriting history', async () => {
  const server = await startFixtureServer('openai'); cleanup.push(server.close)
  const f = harness()
  const p = await f.profiles.save({ name: 'fixture', protocol: 'openai', baseUrl: server.baseUrl + '/v1', model: 'test-model', contextWindow: 128000, authMethod: 'none' })
  f.store.setSettings({ ...f.store.getSettings(), systemPrompt: 'ACTUALLY USED' })
  const sent = await f.send(f.id, p.id, 'hello')
  await expect.poll(() => f.finished(sent.requestId)?.state).toBe('completed')
  const input = { prompt: 'UNSAVED DRAFT', profileId: p.id, conversationId: f.id }
  const folder = join(f.directory, 'pi/sessions', f.id)
  const file = join(folder, readdirSync(folder).find(name => name.endsWith('.jsonl'))!)
  const before = readFileSync(file)
  const result = await f.host.previewSystemPrompt(input)
  expect(result.actual).toMatchObject({ conversationId: f.id, profileId: p.id, model: 'test-model' })
  expect(result.actual?.text).toContain('ACTUALLY USED')
  expect(result.actual?.text).toContain('<cwd>')
  expect(result.actual?.text).not.toContain('UNSAVED DRAFT')
  expect(result.actual?.parts[0].content).toBe('ACTUALLY USED')
  expect(Number.isFinite(Date.parse(result.actual!.usedAt))).toBe(true)
  expect(JSON.stringify(server.requests[0].body)).toContain('ACTUALLY USED')
  const restarted = new AgentHost(f.store, f.profiles, f.directory)
  cleanup.push(() => restarted.stopAll())
  expect((await restarted.previewSystemPrompt(input)).actual).toEqual(result.actual)
  expect(readFileSync(file)).toEqual(before)
  expect(server.requests).toHaveLength(1)
  expect((await f.host.previewSystemPrompt({ ...input, conversationId: f.other })).actual).toBeNull()
  f.store.trashConversation(f.id)
  await expect(f.host.previewSystemPrompt(input)).rejects.toThrow('该对话已经不存在')
})
