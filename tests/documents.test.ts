import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, readFile, readdir, unlink } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HerStore } from '../src/core/storage/store'
import { FileAccessService } from '../src/core/files/access'
import { DocumentService, registerDocumentTools, type DocumentParser } from '../src/core/documents/service'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import { modelToolResultText } from '../src/core/tools/result-format'
const cleanups: (() => void)[] = []
afterEach(() => { vi.restoreAllMocks(); cleanups.splice(0).reverse().forEach(fn => fn()) })
async function setup(text = '# Heading\nhello', extension = '.docx') {
  const root = await mkdtemp(join(tmpdir(), 'her-docs-')); cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const store = new HerStore(join(root, 'db.sqlite')); cleanups.push(() => store.close())
  const lifetime = new AbortController(); const access = new FileAccessService(store, lifetime.signal)
  const context = { conversationId: (() => { const id = randomUUID(); store.createConversation(id, randomUUID(), 't'); return id })(), runId: 'r', callId: 'c', signal: new AbortController().signal }
  const path = join(root, 'source' + extension); await writeFile(path, 'authorized bytes')
  const [grant] = await access.grant([path], { scope: 'conversation', kind: 'file', conversationId: context.conversationId })
  const file = await access.reference(grant.id, '', context)
  const convert = vi.fn(async (uri: string) => { expect(fileURLToPath(uri)).not.toBe(path); expect(await readFile(fileURLToPath(uri), 'utf8')).toBe('authorized bytes'); return text })
  const parser: DocumentParser = { version: 'test-v1', configuration: 'rev1', validate: () => {}, convert }
  const service = new DocumentService(store, access, () => parser)
  const registry = new SimpleToolRegistry(); registerDocumentTools(registry, service)
  return { root, store, access, lifetime, context, path, grant, file, parser, convert, service, registry }
}
it('stages authorized bytes, caches across service instances, keeps provenance and no guessed pages', async () => {
  const f = await setup(); const ref = await f.service.extract(f.file.id, f.context)
  expect(ref.status).toBe('ready')
  const reopened = new HerStore(join(f.root, 'db.sqlite')); cleanups.push(() => reopened.close())
  const service = new DocumentService(reopened, new FileAccessService(reopened), () => f.parser)
  expect(await service.extract(f.file.id, f.context)).toEqual(ref); expect(f.convert).toHaveBeenCalledTimes(1)
  const result = await f.registry.execute('read_document', { fileId: f.file.id }, f.context)
  expect(result.fileSources).toEqual({ fileIds: [f.file.id] })
  expect(result.structuredContent).toMatchObject({ text: '# Heading\nhello', source: { fileId: f.file.id, section: 'Heading' } })
  expect(JSON.stringify(result)).not.toContain('pageNumber'); expect(JSON.stringify(result)).not.toContain(f.root)
  expect(await readdir(join(f.store.documentDirectory, 'staging'))).toEqual([])
})
it('invalidates parser/config cache and restores missing cache only through current authorization', async () => {
  const f = await setup(); const first = await f.service.extract(f.file.id, f.context)
  f.parser.version = 'test-v2'; const second = await f.service.extract(f.file.id, f.context); expect(second.id).not.toBe(first.id)
  f.parser.configuration = 'rev2'; const third = await f.service.extract(f.file.id, f.context); expect(third.id).not.toBe(second.id)
  await unlink(join(f.store.documentDirectory, third.id + '.json')); await f.service.read(third.id, {}, f.context)
  expect(f.convert).toHaveBeenCalledTimes(4)
  await f.access.revoke(f.grant.id); await expect(f.service.read(third.id, {}, f.context)).rejects.toThrow()
  expect(f.convert).toHaveBeenCalledTimes(4)
})
it('rejects cross-conversation, changed source, and every late parse publication', async () => {
  for (const action of ['revoke', 'change', 'stop', 'quit', 'purge', 'config'] as const) {
    const f = await setup(); const cancel = new AbortController(); const context = { ...f.context, signal: cancel.signal }
    f.convert.mockImplementation(async () => {
      if (action === 'revoke') await f.access.revoke(f.grant.id)
      if (action === 'change') await writeFile(f.path, 'changed')
      if (action === 'stop') cancel.abort()
      if (action === 'quit') f.lifetime.abort()
      if (action === 'purge') { f.store.trashConversation(context.conversationId); f.store.purgeConversation(context.conversationId) }
      if (action === 'config') f.parser.validate = () => { throw new Error('stale configuration') }
      return 'secret'
    })
    await expect(f.service.extract(f.file.id, context)).rejects.toThrow()
    expect((await readdir(f.store.documentDirectory)).filter(name => name.endsWith('.json'))).toEqual([])
  }
  const f = await setup(); const doc = await f.service.extract(f.file.id, f.context)
  await expect(f.service.read(doc.id, {}, { ...f.context, conversationId: (() => { const id = randomUUID(); f.store.createConversation(id, randomUUID(), 't'); return id })() })).rejects.toThrow()
  await writeFile(f.path, 'changed'); await expect(f.service.extract(f.file.id, f.context)).rejects.toThrow()
})
it('paginates the final wire JSON without loss, including escaping and late query matches', async () => {
  const text = ('中文"\\\n').repeat(12000) + 'needle'
  const f = await setup(text); let offset = 0; let joined = ''
  do {
    const result = await f.registry.execute('read_document', { fileId: f.file.id, offset }, f.context)
    const wire = modelToolResultText(result); expect(wire.length).toBeLessThanOrEqual(30000)
    const page = JSON.parse(wire.replace(/^Structured result: /, '').replace(/\n\[tool result truncated\]$/, ''))
    joined += page.text; expect(page.range).toEqual({ offset, length: page.text.length })
    offset = page.nextCursor === undefined ? -1 : Number(page.nextCursor)
  } while (offset >= 0)
  expect(joined).toBe(text)
  const result = await f.registry.execute('read_document', { fileId: f.file.id, query: 'needle' }, f.context)
  expect(result.structuredContent).toMatchObject({ text: 'needle', range: { offset: text.length - 6, length: 6 } })
})
it('reports empty and partial PDF honestly, rejects failed conversion without caching, and purges only owned cache', async () => {
  const f = await setup('', '.pdf'); expect((await f.service.extract(f.file.id, f.context)).status).toBe('empty')
  f.parser.configuration = 'new'; f.convert.mockResolvedValue('fallback or mixed PDF text')
  const doc = await f.service.extract(f.file.id, f.context); expect(doc.status).toBe('partial')
  f.parser.configuration = 'failed'; f.convert.mockRejectedValue(new Error('corrupt/encrypted'))
  await expect(f.service.extract(f.file.id, f.context)).rejects.toThrow()
  f.store.trashConversation(f.context.conversationId); f.store.purgeConversation(f.context.conversationId)
  expect(await readFile(f.path, 'utf8')).toBe('authorized bytes')
  expect((await readdir(f.store.documentDirectory)).filter(name => name.endsWith('.json'))).toEqual([])
})

import { DocumentCache } from '../src/core/documents/cache'
it('rechecks authority after asynchronous cache hits and writes before returning any content', async () => {
  const f = await setup(); const ref = await f.service.extract(f.file.id, f.context)
  const originalRead = DocumentCache.prototype.read
  vi.spyOn(DocumentCache.prototype, 'read').mockImplementationOnce(async function (this: DocumentCache, id) {
    const text = await originalRead.call(this, id); await f.access.revoke(f.grant.id); return text
  })
  await expect(f.service.read(ref.id, {}, f.context)).rejects.toThrow()
  vi.restoreAllMocks()
  const g = await setup()
  const originalWrite = DocumentCache.prototype.write
  vi.spyOn(DocumentCache.prototype, 'write').mockImplementationOnce(async function (this: DocumentCache, id, text) {
    await originalWrite.call(this, id, text); g.lifetime.abort()
  })
  await expect(g.service.extract(g.file.id, g.context)).rejects.toThrow()
  expect((await readdir(g.store.documentDirectory)).filter(name => name.endsWith('.json'))).toEqual([])
})
it('outer read_document owns a 120-second timeout and drops a noncooperative late parser', async () => {
  const f = await setup(); let release!: (text: string) => void; let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  f.convert.mockImplementation(async () => { entered(); return new Promise<string>(resolve => { release = resolve }) })
  vi.useFakeTimers()
  try {
    const pending = f.registry.execute('read_document', { fileId: f.file.id }, f.context)
    await started; await vi.advanceTimersByTimeAsync(119999)
    let finished = false; void pending.then(() => { finished = true })
    expect(finished).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toMatchObject({ isError: true })
    release('late secret'); vi.useRealTimers()
    // Allow owned staging cleanup, without waiting for the cancelled parser to publish.
    for (let n = 0; n < 50 && (await readdir(join(f.store.documentDirectory, 'staging'))).length; n++) await new Promise(resolve => setTimeout(resolve, 5))
    expect((await readdir(f.store.documentDirectory)).filter(name => name.endsWith('.json'))).toEqual([])
    expect(await readdir(join(f.store.documentDirectory, 'staging'))).toEqual([])
  } finally { vi.useRealTimers() }
})

import { DatabaseSync } from 'node:sqlite'
