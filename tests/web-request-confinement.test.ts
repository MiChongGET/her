import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('rejects unknown upstream bytes before modifying any file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'her-http-patch-'))
  try {
    mkdirSync(join(dir, 'build'))
    writeFileSync(join(dir, 'package.json'), '{"name":"open-websearch","version":"2.2.0"}')
    writeFileSync(join(dir, 'build/index.js'), 'untrusted')
    const patch = await import('../resources/mcp-web-dependencies/apply-her-patch.mjs')
    await expect(patch.applyHerPatch(dir)).rejects.toThrow('upstream')
    expect(readFileSync(join(dir, 'build/index.js'), 'utf8')).toBe('untrusted')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
