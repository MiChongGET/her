import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from '../src/core/agent/system-prompt'
import { BUILTIN_SKILLS, BUILTIN_SKILLS_PROMPT, builtinSkillsPrompt } from '../src/core/skills/builtin'

const root = join(process.cwd(), 'src/core/skills/ego-browser')

describe('bundled ego-browser skill', () => {
  it('preserves the complete pinned upstream directory and its license byte for byte', async () => {
    const source = await readFile(join(root, 'SOURCE.md'), 'utf8')
    expect(source).toContain('d392204d1ea1a8027a591ab2b0129c2e11d85f26')
    const entries = [...source.matchAll(/^\| `([^`]+)` \| `([a-f0-9]{40})` \| `([a-f0-9]{64})` \|$/gm)]
    expect(entries).toHaveLength(23)
    const localFiles = (await readdir(root, { recursive: true, withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name !== 'SOURCE.md')
      .map(entry => join(entry.parentPath, entry.name).slice(root.length + 1)).sort()
    expect(localFiles).toEqual(entries.map(entry => entry[1]).sort())
    for (const [, path, gitSha, sha256] of entries) {
      const bytes = await readFile(join(root, path))
      expect(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), path).toBe(gitSha)
      expect(createHash('sha256').update(bytes).digest('hex'), path).toBe(sha256)
    }
    expect(entries.find(entry => entry[1] === 'SKILL.md')?.[2]).toBe('ba791f0c8a0f01c832733ca8045678363cb859b3')
  })

  it('exposes source metadata and only the official entry document in the actual system prompt', async () => {
    const skill = BUILTIN_SKILLS.find(skill => skill.id === 'ego-browser')!
    expect(skill.version).toBe('2.1.0')
    expect(skill.sourceUrl).toBe('https://github.com/citrolabs/ego-lite/blob/d392204d1ea1a8027a591ab2b0129c2e11d85f26/skills/ego-browser/SKILL.md')
    expect(skill.content).toBe(await readFile(join(root, 'SKILL.md'), 'utf8'))
    const prompt = buildSystemPrompt('USER PROMPT', [], { contextWindow: 200_000 })
    expect(prompt).toContain(`<builtin_skill name="ego-browser">\n${skill.content}\n</builtin_skill>`)
    expect(prompt).toContain('ego_browser_guide')
    expect(prompt).toContain('ego_browser_run')
    expect(prompt).not.toContain('## Install on macOS')
  })

  it('filters each skill independently and omits ego mappings when its skill is disabled', () => {
    expect(builtinSkillsPrompt()).toBe(BUILTIN_SKILLS_PROMPT)
    expect(BUILTIN_SKILLS.map(skill => skill.id)).toEqual(['peekaboo', 'ego-browser'])
    const desktop = builtinSkillsPrompt(['ego-browser'])
    expect(desktop).toContain('<builtin_skill name="Peekaboo">')
    expect(desktop).not.toContain('ego_browser_guide')
    expect(desktop).not.toContain('<builtin_skill name="ego-browser">')
    const browser = builtinSkillsPrompt(['peekaboo'])
    expect(browser).toContain('<builtin_skill name="ego-browser">')
    expect(browser).not.toContain('<builtin_skill name="Peekaboo">')
    expect(builtinSkillsPrompt(['peekaboo', 'ego-browser'])).toBe('')
    expect(builtinSkillsPrompt(['unknown-skill'])).toBe(BUILTIN_SKILLS_PROMPT)
  })
})
