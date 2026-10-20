import { afterEach, describe, expect, it } from 'vitest'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import { buildSystemPrompt } from '../src/core/agent/system-prompt'
import { BUILTIN_SKILLS_PROMPT } from '../src/core/skills/builtin'
import { startFixtureServer, TOOL_NAME } from './pi-sdk/wire'
import { harness, harnessCleanup } from './helpers/host-harness'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of [...cleanup.splice(0), ...harnessCleanup.splice(0)].reverse()) await close() })

describe('buildSystemPrompt', () => {
  it('keeps the user prompt first and always appends the bundled skills', () => {
    const text = buildSystemPrompt('USER PROMPT', [], { contextWindow: 200_000 })
    expect(text.startsWith('USER PROMPT')).toBe(true)
    expect(text).toContain(BUILTIN_SKILLS_PROMPT)
  })
  it('without tools adds no environment or tool list', () => {
    const text = buildSystemPrompt('p', [], { contextWindow: 200_000 })
    expect(text).not.toContain('Host 实际操作系统')
    expect(text).not.toContain('你可以使用以下工具')
  })
  it('with tools names them and states the real platform', () => {
    const text = buildSystemPrompt('p', ['read_text', 'list_files'], { contextWindow: 200_000, platform: 'darwin' })
    expect(text).toContain('read_text、list_files')
    expect(text).toContain('Host 实际操作系统：darwin')
    expect(text).toContain('TextEdit')
  })
  it('does not claim macOS apps on another platform', () => {
    const text = buildSystemPrompt('p', ['x'], { contextWindow: 200_000, platform: 'linux' })
    expect(text).toContain('Host 实际操作系统：linux')
    expect(text).not.toContain('这是 macOS')
  })
  it('tells the model never to replay an action whose outcome is unknown', () => {
    expect(buildSystemPrompt('p', ['x'], { contextWindow: 200_000 })).toContain('结果未知的动作不得重放')
  })
})

describe('skills and the window', () => {
  it('are left out when they would take more than a quarter of a small window', () => {
    for (const window of [2048, 4096]) expect(buildSystemPrompt('p', [], { contextWindow: window })).not.toContain('builtin_skill')
  })
  it('are included once the window can afford them', () => {
    for (const window of [32_000, 200_000]) expect(buildSystemPrompt('p', [], { contextWindow: window })).toContain('builtin_skill')
  })
  it('the tool list and environment still go out when the skills are left out', () => {
    const text = buildSystemPrompt('p', ['read_text'], { contextWindow: 2048, platform: 'darwin' })
    expect(text).not.toContain('builtin_skill')
    expect(text).toContain('read_text')
  })
})

describe('what the model receives', () => {
  async function send(tools: boolean) {
    const s = await startFixtureServer('openai', 'text'); cleanup.push(s.close)
    const registry = new SimpleToolRegistry()
    if (tools) registry.register({ name: TOOL_NAME, description: 'x', parameters: { type: 'object', properties: {}, additionalProperties: false } },
      async () => ({ content: [] }), { assess: async () => ({ effect: 'read', target: 'x', summary: 'x' }) })
    const f = harness(undefined, async () => registry.snapshot())
    const p = await f.profiles.save({ name: 'p', protocol: 'openai', baseUrl: s.baseUrl + '/v1', model: 'test-model', authMethod: 'none' })
    f.store.saveSettings({ ...f.store.getSettings(), systemPrompt: 'MY CUSTOM PROMPT' })
    const sent = await f.send(f.id, p.id, 'hi')
    await expect.poll(() => f.finished(sent.requestId)?.state, { timeout: 10_000 }).toBe('completed')
    return JSON.stringify(s.requests[0].body)
  }
  it('the request carries the user prompt, the skills and the tool names', async () => {
    const body = await send(true)
    expect(body).toContain('MY CUSTOM PROMPT')
    expect(body).toContain('builtin_skill')
    expect(body).toContain(TOOL_NAME)
    expect(body).toContain('Host 实际操作系统')
  })
  it('with no tools the request still carries the skills but no environment block', async () => {
    const body = await send(false)
    expect(body).toContain('MY CUSTOM PROMPT')
    expect(body).toContain('builtin_skill')
    expect(body).not.toContain('Host 实际操作系统')
  })
})
