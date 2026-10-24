import { expect, it } from 'vitest'
import { buildSystemPrompt } from '../src/core/agent/system-prompt'

it('omits disabled skill knowledge without changing independently supplied tools', () => {
  const prompt = buildSystemPrompt('custom', ['mcp_peekaboo'], { contextWindow: 200_000, disabledSkillIds: ['ego-browser'] })
  expect(prompt).toContain('<builtin_skill name="Peekaboo">')
  expect(prompt).not.toContain('<builtin_skill name="ego-browser">')
  expect(prompt).toContain('mcp_peekaboo')
})
it('does not load any skill instructions when all built-in skills are disabled', () => {
  const prompt = buildSystemPrompt('custom', [], { contextWindow: 200_000, disabledSkillIds: ['peekaboo', 'ego-browser', 'love-companion'] })
  expect(prompt).toBe('custom')
})
