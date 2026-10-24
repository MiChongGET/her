import { afterEach, expect, it } from 'vitest'
import { harness, harnessCleanup } from './helpers/host-harness'
import { startFixtureServer } from './pi-sdk/wire'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of [...cleanup.splice(0), ...harnessCleanup.splice(0)].reverse()) await close() })

it('sends the companion guidance only while enabled and preserves the custom prompt across subsequent requests', async () => {
  const server = await startFixtureServer('openai'); cleanup.push(server.close)
  const f = harness()
  const profile = await f.profiles.save({ name: 'fixture', protocol: 'openai', baseUrl: server.baseUrl + '/v1', model: 'test-model', contextWindow: 128000, authMethod: 'none' })
  f.store.setSettings({ ...f.store.getSettings(), systemPrompt: 'MY CUSTOM SAMANTHA', disabledSkillIds: ['peekaboo', 'ego-browser'] })
  for (const [index, enabled] of [true, false, true].entries()) {
    f.store.setSettings({ ...f.store.getSettings(), disabledSkillIds: ['peekaboo', 'ego-browser', ...(!enabled ? ['love-companion'] : [])] })
    const sent = await f.send(index === 1 ? f.other : f.id, profile.id, '今天有点累，想安静待一会儿。')
    await expect.poll(() => f.finished(sent.requestId)?.state).toBe('completed')
    const request = server.requests[index].body as { messages: { role: string; content: string }[] }
    const body = request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n')
    expect(body).toContain('MY CUSTOM SAMANTHA')
    for (const text of ['<builtin_skill name="love-companion">', '# Emotion Detection & Reception System Matching', '# Persona Archetypes: Expressions of Nourishing Love']) {
      if (enabled) expect(body).toContain(text)
      else expect(body).not.toContain(text)
    }
    expect(f.store.getSettings().systemPrompt).toBe('MY CUSTOM SAMANTHA')
  }
})
