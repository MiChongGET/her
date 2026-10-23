import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rename, symlink, unlink } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HerStore } from '../src/core/storage/store'
import { FileAccessService } from '../src/core/files/access'
import { registerFileTools } from '../src/core/files/tools'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import { ToolArtifactStore } from '../src/core/tools/artifacts'

const cleanups: (() => void)[] = []
afterEach(() => { vi.restoreAllMocks(); cleanups.splice(0).reverse().forEach(clean => clean()) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'her-files-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const store = new HerStore(join(root, 'db.sqlite'))
  cleanups.push(() => store.close())
  const conversationId = randomUUID(), other = randomUUID()
  store.createConversation(conversationId, randomUUID(), 't'); store.createConversation(other, randomUUID(), 't')
  const lifetime = new AbortController()
  const access = new FileAccessService(store, lifetime.signal)
  const registry = new SimpleToolRegistry(); registerFileTools(registry, access)
  const context = { conversationId, runId: 'run', callId: 'call', signal: new AbortController().signal, authorize: async () => {} }
  const directory = join(root, 'allowed'); await mkdir(directory)
  return { root, directory, store, access, registry, context, other, lifetime }
}

describe('file authority on actual filesystem objects', () => {
  it('binds fixed versions and conversation ownership; grants never expose paths', async () => {
    const f = await setup(); const path = join(f.directory, 'a.txt'); await writeFile(path, 'secret')
    const [grant] = await f.access.grant([path], { scope: 'conversation', kind: 'file', conversationId: f.context.conversationId })
    expect(JSON.stringify(grant)).not.toContain(f.root)
    const ref = await f.access.reference(grant.id, '', f.context)
    expect(await f.access.readText(ref.id, f.context)).toMatchObject({ text: 'secret', range: { offset: 0, length: 6 }, truncated: false })
    await expect(f.access.resolve(ref.id, { ...f.context, conversationId: f.other })).rejects.toThrow()
    await expect(f.access.resolve('forged', f.context)).rejects.toThrow()
    await writeFile(path, 'change')
    await expect(f.access.readText(ref.id, f.context)).rejects.toThrow()
    expect((await f.access.reference(grant.id, '', f.context)).id).not.toBe(ref.id)
  })

  it('rejects traversal, prefix-confusion and external symlinks while allowing in-scope symlinks', async () => {
    const f = await setup(); await mkdir(f.directory + '-other'); await writeFile(join(f.directory + '-other', 'secret'), 'outside')
    await writeFile(join(f.directory, 'ok.txt'), 'ok')
    await symlink(join(f.directory + '-other', 'secret'), join(f.directory, 'escape'))
    await symlink(join(f.directory, 'ok.txt'), join(f.directory, 'inside'))
    const [grant] = await f.access.grant([f.directory], { scope: 'conversation', kind: 'directory', conversationId: f.context.conversationId })
    for (const path of ['../allowed-other/secret', f.directory + '-other/secret', 'escape']) await expect(f.access.reference(grant.id, path, f.context)).rejects.toThrow()
    expect(await f.access.readText((await f.access.reference(grant.id, 'inside', f.context)).id, f.context)).toMatchObject({ text: 'ok' })
    await expect(f.access.reference(grant.id, '', f.context)).rejects.toThrow()
    await expect(f.access.reference(grant.id, 'ok.txt', { ...f.context, conversationId: f.other })).rejects.toThrow()
    await rename(f.directory, f.directory + '-old'); await mkdir(f.directory); await writeFile(join(f.directory, 'ok.txt'), 'new')
    await expect(f.access.reference(grant.id, 'ok.txt', f.context)).rejects.toThrow()
  })

  it('restores persistent grants after restart, keeps references private and never revives revoked IDs', async () => {
    const f = await setup(); await writeFile(join(f.directory, 'a'), 'a')
    const [grant] = await f.access.grant([f.directory], { scope: 'persistent', kind: 'directory' })
    const ref = await f.access.reference(grant.id, 'a', f.context)
    const secondStore = new HerStore(join(f.root, 'db.sqlite')); cleanups.push(() => secondStore.close())
    const access = new FileAccessService(secondStore)
    expect(access.listGrants(f.other)).toEqual([grant])
    await expect(access.resolve(ref.id, { ...f.context, conversationId: f.other })).rejects.toThrow()
    const otherRef = await access.reference(grant.id, 'a', { ...f.context, conversationId: f.other })
    expect(otherRef.id).not.toBe(ref.id)
    await access.revoke(grant.id)
    await expect(f.access.readText(ref.id, f.context)).rejects.toThrow()
    expect(f.access.listGrants(f.context.conversationId)).toEqual([])
  })

  it('holds one fd and discards content after replacement, revocation, cancellation or in-place write during consumption', async () => {
    for (const action of ['replace', 'revoke', 'cancel', 'modify', 'trash', 'shutdown'] as const) {
      const f = await setup(); const path = join(f.directory, 'a'); await writeFile(path, 'secret')
      const [grant] = await f.access.grant([path], { scope: 'conversation', kind: 'file', conversationId: f.context.conversationId })
      const ref = await f.access.reference(grant.id, '', f.context)
      const cancel = new AbortController(); const ctx = { ...f.context, signal: cancel.signal }
      let captured: import('node:fs/promises').FileHandle | undefined
      await expect(f.access.withFile(ref.id, ctx, async handle => {
        captured = handle
        const bytes = await handle.readFile()
        if (action === 'replace') { await rename(path, path + '.old'); await writeFile(path, 'secret') }
        if (action === 'modify') await writeFile(path, 'change')
        if (action === 'revoke') await f.access.revoke(grant.id)
        if (action === 'cancel') cancel.abort()
        if (action === 'trash') f.store.trashConversation(f.context.conversationId)
        if (action === 'shutdown') f.lifetime.abort()
        return bytes
      })).rejects.toThrow()
      await expect(captured!.stat()).rejects.toThrow()
    }
  })

  it('source artifacts revalidate reads and late publication; missing sources fail closed', async () => {
    const f = await setup(); const path = join(f.directory, 'a'); await writeFile(path, 'source')
    const [grant] = await f.access.grant([path], { scope: 'conversation', kind: 'file', conversationId: f.context.conversationId })
    const ref = await f.access.reference(grant.id, '', f.context)
    const artifacts = new ToolArtifactStore(f.store, f.lifetime.signal, f.access)
    const image = await artifacts.put(Buffer.from('image'), { conversationId: f.context.conversationId, sourceFileId: ref.id }, 'image/png')
    expect(Buffer.from(await artifacts.read(image.id, f.context)).toString()).toBe('image')
    await f.access.revoke(grant.id)
    await expect(artifacts.read(image.id, f.context)).rejects.toThrow()
    await expect(artifacts.put(Buffer.from('late'), { conversationId: f.context.conversationId, sourceFileId: ref.id }, 'image/png')).rejects.toThrow()
    await unlink(path)
    await expect(f.access.resolve(ref.id, f.context)).rejects.toThrow()
  })

  it('trash preserves references, purge removes only owned references and temporary grants', async () => {
    const f = await setup(); await writeFile(join(f.directory, 'a'), 'a')
    const [grant] = await f.access.grant([f.directory], { scope: 'persistent', kind: 'directory' })
    const [temporary] = await f.access.grant([f.directory], { scope: 'conversation', kind: 'directory', conversationId: f.context.conversationId })
    const ref = await f.access.reference(grant.id, 'a', f.context)
    const other = await f.access.reference(grant.id, 'a', { ...f.context, conversationId: f.other })
    f.store.trashConversation(f.context.conversationId)
    await expect(f.access.resolve(ref.id, f.context)).rejects.toThrow()
    f.store.restoreConversation(f.context.conversationId)
    await expect(f.access.resolve(ref.id, f.context)).resolves.toBeDefined()
    f.store.trashConversation(f.context.conversationId); f.store.purgeConversation(f.context.conversationId)
    expect(f.store.getFileReference(ref.id)).toBeNull()
    expect(f.store.getFileGrant(temporary.id)).toBeNull()
    expect(await f.access.readText(other.id, { ...f.context, conversationId: f.other })).toMatchObject({ text: 'a' })
  })
})

describe('bounded read-only tools', () => {
  it('pages 101 files without duplicates and returns source IDs usable by read_text', async () => {
    const f = await setup()
    for (let i = 0; i < 101; i++) await writeFile(join(f.directory, `a${String(i).padStart(3, '0')}.txt`), `needle ${i}`)
    const [grant] = await f.access.grant([f.directory], { scope: 'persistent', kind: 'directory' })
    const first = await f.registry.execute('list_files', { grantId: grant.id }, f.context)
    expect(first.isError).not.toBe(true)
    const one = first.structuredContent as any
    expect(one.entries).toHaveLength(100); expect(first.truncated).toBe(true)
    const next = await f.registry.execute('list_files', { grantId: grant.id, cursor: one.nextCursor }, f.context)
    const two = next.structuredContent as any
    expect(two.entries).toHaveLength(1); expect(two.nextCursor).toBeUndefined()
    expect(new Set([...one.entries, ...two.entries].map((entry: any) => entry.name)).size).toBe(101)
    const read = await f.registry.execute('read_text', { fileId: two.entries[0].file.id }, f.context)
    expect(read.structuredContent).toMatchObject({ text: 'needle 100', range: { offset: 0, length: 10 } })
    const search = await f.registry.execute('search_files', { grantId: grant.id, query: 'a100' }, f.context)
    expect((search.structuredContent as any).entries).toHaveLength(1)
    const text = await f.registry.execute('search_text', { grantId: grant.id, query: 'needle 100' }, f.context)
    expect((text.structuredContent as any).entries[0]).toMatchObject({ range: { offset: 0, length: 10 } })
    expect(f.registry.getDefinitions().map(tool => tool.name)).toEqual(['list_files', 'search_files', 'search_text', 'read_text'])
  })

  it('reports real character ranges and continuation at 30,001 characters; rejects cancelled searches', async () => {
    const f = await setup(); await writeFile(join(f.directory, 'long.txt'), '中'.repeat(30_001))
    const [grant] = await f.access.grant([f.directory], { scope: 'persistent', kind: 'directory' })
    const ref = await f.access.reference(grant.id, 'long.txt', f.context)
    const result = await f.registry.execute('read_text', { fileId: ref.id }, f.context)
    expect(result.truncated).toBe(true)
    expect(await f.access.readText(ref.id, f.context)).toMatchObject({ range: { offset: 0, length: 30_000 }, nextCursor: '30000' })
    const page = result.structuredContent as any
    expect(page.range.length).toBe(page.text.length)
    expect(Number(page.nextCursor)).toBe(page.text.length)
    expect(page.text.length).toBeLessThan(30_000)
    const last = await f.registry.execute('read_text', { fileId: ref.id, offset: 30000 }, f.context)
    expect(last.structuredContent).toMatchObject({ text: '中', range: { offset: 30000, length: 1 }, truncated: false })
    const cancel = new AbortController(); cancel.abort()
    await expect(f.registry.execute('search_files', { grantId: grant.id, query: 'long' }, { ...f.context, signal: cancel.signal })).rejects.toThrow()
  })
})

import { ChatService } from '../src/core/conversation/chat'
import { ProfileService } from '../src/core/storage/profiles'
import type { ChatEvent, StreamChatInput } from '../src/shared/types'






it('rejects missing sources, nonregular files, oversized files and late search cancellation', async () => {
  const f = await setup(); const path = join(f.directory, 'a'); await writeFile(path, 'needle')
  const [grant] = await f.access.grant([f.directory], { scope: 'persistent', kind: 'directory' })
  const ref = await f.access.reference(grant.id, 'a', f.context)
  await unlink(path)
  await expect(f.access.readText(ref.id, f.context)).rejects.toThrow()
  await writeFile(path, 'needle')
  const { open } = await import('node:fs/promises')
  const large = await open(join(f.directory, 'large'), 'w'); await large.truncate(50 * 1024 * 1024 + 1); await large.close()
  await expect(f.access.reference(grant.id, 'large', f.context)).rejects.toThrow()
  const { execFileSync } = await import('node:child_process')
  execFileSync('mkfifo', [join(f.directory, 'pipe')])
  await expect(f.access.reference(grant.id, 'pipe', f.context)).rejects.toThrow()
  await expect(f.access.grant(['/dev/null'], { scope: 'persistent', kind: 'file' })).rejects.toThrow()
  const cancel = new AbortController()
  const read = f.access.readBytes.bind(f.access)
  vi.spyOn(f.access, 'readBytes').mockImplementation(async (id, context) => { const bytes = await read(id, context); cancel.abort(); return bytes })
  await expect(f.registry.execute('search_text', { grantId: grant.id, query: 'needle' }, { ...f.context, signal: cancel.signal })).rejects.toThrow()
})


it('publishing an artifact from a stopped parser context creates no usable cache', async () => {
  const f = await setup(); await writeFile(join(f.directory, 'a'), 'a')
  const [grant] = await f.access.grant([f.directory], { scope: 'persistent', kind: 'directory' })
  const ref = await f.access.reference(grant.id, 'a', f.context)
  const artifacts = new ToolArtifactStore(f.store, f.lifetime.signal, f.access)
  const stop = new AbortController(); stop.abort()
  await expect(artifacts.put(Buffer.from('late'), { conversationId: f.context.conversationId, sourceFileId: ref.id }, 'image/png', { ...f.context, signal: stop.signal })).rejects.toThrow()
  const { DatabaseSync } = await import('node:sqlite')
  const inspected = new DatabaseSync(join(f.root, 'db.sqlite'))
  expect(inspected.prepare('SELECT COUNT(*) AS count FROM tool_artifacts').get()).toEqual({ count: 0 })
  inspected.close()
})


it('preserves document MIME metadata for the downstream parser instead of labelling DOCX as text', async () => {
  const f = await setup(); const path = join(f.directory, 'report.docx'); await writeFile(path, 'placeholder package')
  const [grant] = await f.access.grant([path], { scope: 'conversation', kind: 'file', conversationId: f.context.conversationId })
  expect((await f.access.reference(grant.id, '', f.context)).mimeType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
})

import { modelToolResultText } from '../src/core/tools/result-format'
import type { ToolResult } from '../src/shared/types'

function deliveredPage(result: ToolResult): Record<string, any> {
  const text = modelToolResultText(result)
  expect(text.length).toBeLessThanOrEqual(30_000)
  expect(text.startsWith('Structured result: ')).toBe(true)
  const json = text.replace(/\n\[tool result truncated\]$/, '').slice('Structured result: '.length)
  return JSON.parse(json)
}

it.each(['中'.repeat(30_001), ('中"\\\n\t😀').repeat(5000) + '末'])('roundtrips long escaped text through the actual model formatter without skipped characters', async content => {
  const f = await setup(); const path = join(f.directory, 'model-text.txt'); await writeFile(path, content)
  const [grant] = await f.access.grant([path], { scope: 'conversation', kind: 'file', conversationId: f.context.conversationId })
  const ref = await f.access.reference(grant.id, '', f.context)
  let offset = 0; let combined = ''; let pages = 0
  do {
    const result = await f.registry.execute('read_text', { fileId: ref.id, offset }, f.context)
    expect(result.isError).not.toBe(true)
    const page = deliveredPage(result)
    expect(page.range).toEqual({ offset, length: page.text.length })
    expect(page.source.id).toBe(ref.id)
    combined += page.text
    if (!page.truncated) { expect(page.nextCursor).toBeUndefined(); break }
    expect(Number(page.nextCursor)).toBe(offset + page.text.length)
    expect(Number(page.nextCursor)).toBeGreaterThan(offset)
    offset = Number(page.nextCursor)
    expect(++pages).toBeLessThan(20)
  } while (true)
  expect(combined).toBe(content)
})

it.each(['list_files', 'search_files', 'search_text'] as const)('enumerates all 101 long-name matches through %s model pages with no partial JSON or gaps', async name => {
  const f = await setup()
  const names = Array.from({ length: 101 }, (_, index) => `${String(index).padStart(3, '0')}-${'long'.repeat(15)}-".txt`)
  const match = 'needle "\\\n'
  for (const entry of names) await writeFile(join(f.directory, entry), match)
  const [grant] = await f.access.grant([f.directory], { scope: 'persistent', kind: 'directory' })
  let cursor: string | undefined; const seen: string[] = []; let pages = 0
  do {
    const result = await f.registry.execute(name, { grantId: grant.id, ...(name === 'list_files' ? {} : { query: name === 'search_files' ? 'long' : match }), ...(cursor ? { cursor } : {}) }, f.context)
    expect(result.isError).not.toBe(true)
    const page = deliveredPage(result)
    expect(page.entries.length).toBeGreaterThan(0)
    expect(page.entries.length).toBeLessThanOrEqual(100)
    seen.push(...page.entries.map((entry: any) => entry.name))
    cursor = page.nextCursor
    expect(++pages).toBeLessThan(10)
  } while (cursor)
  expect(seen).toEqual(names)
  expect(new Set(seen).size).toBe(101)
})

it('keeps real directory permission errors path-free at the model formatter boundary', async () => {
  const f = await setup(); await writeFile(join(f.directory, 'private.txt'), 'secret')
  const [grant] = await f.access.grant([f.directory], { scope: 'persistent', kind: 'directory' })
  const { chmod } = await import('node:fs/promises')
  await chmod(f.directory, 0)
  try {
    const result = await f.registry.execute('list_files', { grantId: grant.id }, f.context)
    expect(result.isError).toBe(true)
    const wire = modelToolResultText(result)
    expect(wire).toMatch(/权限/)
    expect(wire).not.toContain(f.directory)
    expect(wire).not.toContain('her-files-')
  } finally { await chmod(f.directory, 0o700) }
})

it('keeps a near-cap search page valid after nonmatches advance the cursor from 99 to 100', async () => {
  const f = await setup()
  const names = Array.from({ length: 60 }, (_, index) => `${String(index).padStart(3, '0')}-needle-${'a'.repeat(180)}`)
  for (const name of names) await mkdir(join(f.directory, name))
  const [grant] = await f.access.grant([f.directory], { scope: 'persistent', kind: 'directory' })
  const baseline = await f.registry.execute('search_files', { grantId: grant.id, query: 'needle' }, f.context)
  const basePage = deliveredPage(baseline)
  expect(basePage.entries).toHaveLength(60)
  // Calibrate real fixture names to a wire boundary; expected results below come from the filesystem names.
  // Directory DTOs avoid inode/version-dependent size, and each added ASCII character appears twice.
  const boundary: ToolResult = { ...baseline, truncated: true, structuredContent: {
    ...basePage, scanned: 60, truncated: true, nextCursor: `${'0'.repeat(64)}:60`
  } }
  let padding = Math.floor((30_000 - modelToolResultText(boundary).length) / 2)
  for (let index = 0; index < names.length && padding > 0; index++) {
    const extra = Math.min(padding, 255 - names[index].length)
    const previous = names[index]; names[index] += 'x'.repeat(extra); padding -= extra
    await rename(join(f.directory, previous), join(f.directory, names[index]))
  }
  expect(padding).toBe(0)
  boundary.structuredContent!.entries = names.map(name => ({ name, relativePath: name, kind: 'directory' }))
  expect(modelToolResultText(boundary).length).toBeGreaterThanOrEqual(29_999)
  deliveredPage(boundary)
  for (let index = 60; index < 100; index++) await mkdir(join(f.directory, `${String(index).padStart(3, '0')}-skip`))
  const later = '100-needle-' + 'z'.repeat(180); await mkdir(join(f.directory, later))

  const matches: string[] = []; let cursor: string | undefined; let advanced = 0; let pages = 0
  do {
    const result = await f.registry.execute('search_files', { grantId: grant.id, query: 'needle', ...(cursor ? { cursor } : {}) }, f.context)
    expect(result.isError).not.toBe(true)
    const page = deliveredPage(result)
    matches.push(...page.entries.map((entry: any) => entry.name))
    cursor = page.nextCursor
    if (cursor) {
      const next = Number(cursor.split(':')[1]); expect(next).toBeGreaterThan(advanced); advanced = next
    }
    expect(++pages).toBeLessThan(5)
  } while (cursor)
  expect(matches).toEqual([...names, later])
  expect(new Set(matches).size).toBe(61)
})
