import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HerStore } from '../src/core/storage/store'
import { FileAccessService } from '../src/core/files/access'
import { ToolArtifactStore } from '../src/core/tools/artifacts'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import { PdfService, registerPdfTools, type PdfRenderer } from '../src/core/documents/pdf'
import { modelToolResultText } from '../src/core/tools/result-format'
const cleanup: (() => void)[] = []
afterEach(() => { vi.restoreAllMocks(); cleanup.splice(0).reverse().forEach(fn => fn()) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'her-pdf-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const store = new HerStore(join(root, 'db')); cleanup.push(() => store.close())
  const files = new FileAccessService(store)
  const controller = new AbortController()
  const context = { conversationId: (() => { const id = randomUUID(); store.createConversation(id, randomUUID(), 't'); return id })(), runId: 'run', callId: 'call', authorize: async () => {}, signal: controller.signal, modelSupportsVision: true }
  const path = join(root, 'mixed.pdf'); await writeFile(path, await readFile('tests/fixtures/documents/mixed.pdf'))
  const [grant] = await files.grant([path], { kind: 'file', scope: 'conversation', conversationId: context.conversationId })
  const file = await files.reference(grant.id, '', context)
  const artifacts = new ToolArtifactStore(store, undefined, files)
  const execute = vi.fn<PdfRenderer['execute']>(async (bytes, request) => {
    expect(Buffer.from(bytes)).toEqual(await readFile(path))
    return request.kind === 'inspect' ? { pageCount: 3, pages: [{ pageNumber: 1, textStatus: 'present' }, { pageNumber: 2, textStatus: 'empty' }, { pageNumber: 3, textStatus: 'present' }] }
      : { pages: request.pageNumbers.map(pageNumber => ({ pageNumber, bytes: new Uint8Array([137,80,78,71]), width: 1545, height: 1999 })), failures: [] }
  })
  const renderer = { execute, shutdown: async () => {} }
  const service = new PdfService(files, artifacts, renderer)
  const registry = new SimpleToolRegistry(); registerPdfTools(registry, service)
  return { root, store, files, controller, context, path, grant, file, artifacts, execute, service, registry }
}
it('reports physical mixed/header text without claiming image understanding and preserves requested order/source ownership', async () => {
  const f = await setup()
  const info = await f.registry.execute('inspect_pdf', { fileId: f.file.id }, f.context)
  expect(info.structuredContent).toMatchObject({ pageCount: 3, pages: [{pageNumber:1,textStatus:'present'}, {pageNumber:2,textStatus:'empty'}, {pageNumber:3,textStatus:'present'}] })
  expect(modelToolResultText(info)).toContain('不代表')
  const pages = await f.service.render(f.file.id, [3,2], f.context)
  expect(pages.map(page => page.pageNumber)).toEqual([3,2])
  expect(pages[0].image).toMatchObject({ conversationId: f.context.conversationId, sourceFileId: f.file.id, mimeType: 'image/png' })
  await f.files.revoke(f.grant.id)
  await expect(f.artifacts.read(pages[0].image.id, f.context)).rejects.toThrow()
  await expect(f.service.render(f.file.id, [2], f.context)).rejects.toThrow()
})
it.each([[],[0],[-1],[1.5],[1,2,3,4],[1,1]].map(pages => [pages]))('rejects invalid batches %j before rendering', async pages => {
  const f = await setup(); await expect(f.service.render(f.file.id, pages, f.context)).rejects.toThrow(); expect(f.execute).not.toHaveBeenCalled()
})
it('rejects text-only or unknown current-run vision before reading/rendering', async () => {
  const f = await setup()
  for (const modelSupportsVision of [false, undefined]) {
    const result = await f.registry.execute('read_pdf_pages', { fileId: f.file.id, pageNumbers: [2] }, { ...f.context, modelSupportsVision })
    expect(result.isError).toBe(true); expect(modelToolResultText(result)).toContain('切换'); expect(result.content.some(b => b.type === 'image')).toBe(false)
  }
  expect(f.execute).not.toHaveBeenCalled()
})
it.each(['revoke','change','stop','purge'] as const)('discards late render after %s', async action => {
  const f = await setup()
  f.execute.mockImplementationOnce(async () => {
    if (action === 'revoke') await f.files.revoke(f.grant.id)
    if (action === 'change') await writeFile(f.path, 'new content')
    if (action === 'stop') f.controller.abort()
    if (action === 'purge') { f.store.trashConversation(f.context.conversationId); f.store.purgeConversation(f.context.conversationId) }
    return { pages: [{ pageNumber: 1, bytes: new Uint8Array([1]), width: 1, height: 1 }], failures: [] }
  })
  await expect(f.service.render(f.file.id, [1], f.context)).rejects.toThrow()
})
it('preserves successful page images and explicit failed physical pages without claiming read completion', async () => {
  const f = await setup()
  f.execute.mockResolvedValueOnce({ pages: [{ pageNumber: 3, bytes: new Uint8Array([1]), width: 2, height: 2 }], failures: [{ pageNumber: 2, error: '页面无法渲染。' }] })
  const result = await f.registry.execute('read_pdf_pages', { fileId: f.file.id, pageNumbers: [3,2] }, f.context)
  expect(result.isError).toBe(true); expect(result.content.filter(b => b.type === 'image')).toHaveLength(1)
  expect(result.structuredContent).toMatchObject({ renderedPages: [3], failedPages: [{pageNumber:2,error:'页面无法渲染。'}] })
  expect(result.fileSources).toEqual({ fileIds: [f.file.id] }); expect(modelToolResultText(result)).toContain('尚未')
})
it('bounds complete metadata entries for a many-page inspection without silent JSON truncation', async () => {
  const f = await setup(); f.execute.mockResolvedValueOnce({ pageCount: 20000, pages: Array.from({length:20000}, (_,i) => ({pageNumber:i+1,textStatus:'unknown' as const})) })
  const result = await f.registry.execute('inspect_pdf', {fileId:f.file.id}, f.context)
  expect(modelToolResultText(result).length).toBeLessThanOrEqual(30000)
  expect(result.structuredContent?.pageCount).toBe(20000); expect(result.structuredContent?.omittedPages).toBeGreaterThan(0)
  expect(result.truncated).toBe(true)
})
it('rechecks task authority after artifact IO and rejects shutdown work', async () => {
  const f = await setup(); const put = f.artifacts.put.bind(f.artifacts)
  vi.spyOn(f.artifacts, 'put').mockImplementationOnce(async (...args) => { const image = await put(...args); f.controller.abort(); return image })
  await expect(f.service.render(f.file.id, [1], f.context)).rejects.toThrow()
  await f.service.shutdown(); await expect(f.service.inspect(f.file.id, { ...f.context, signal: new AbortController().signal })).rejects.toThrow()
})
it('rejects wrong dimensions, duplicate renderer pages, and unrequested output before artifact publication', async () => {
  for (const pages of [
    [{pageNumber:1,bytes:new Uint8Array([1]),width:2001,height:10}],
    [{pageNumber:2,bytes:new Uint8Array([1]),width:10,height:10}],
    [{pageNumber:1,bytes:new Uint8Array([1]),width:10,height:10},{pageNumber:1,bytes:new Uint8Array([1]),width:10,height:10}]
  ]) {
    const f = await setup(); f.execute.mockResolvedValueOnce({pages,failures:[]})
    await expect(f.service.render(f.file.id,[1],f.context)).rejects.toThrow('无效')
  }
})
it('drops uncooperative renderer completion immediately after stop', async () => {
  const f=await setup(); let release!:(value:any)=>void; let entered!:()=>void
  const started=new Promise<void>(resolve=>{entered=resolve})
  f.execute.mockImplementationOnce(async()=>{entered();return new Promise(resolve=>{release=resolve})})
  const pending=f.service.render(f.file.id,[1],f.context); await started; f.controller.abort()
  await expect(pending).rejects.toThrow(); release({pages:[{pageNumber:1,bytes:new Uint8Array([1]),width:10,height:10}],failures:[]})
})
it('rechecks authority at the final tool publication boundary after service promises settle', async () => {
  const f=await setup(); const inspect=f.service.inspect.bind(f.service)
  vi.spyOn(f.service,'inspect').mockImplementationOnce(async(...args)=>{const result=await inspect(...args);await f.files.revoke(f.grant.id);return result})
  const result=await f.registry.execute('inspect_pdf',{fileId:f.file.id},f.context)
  expect(result.isError).toBe(true); expect(result.structuredContent).toBeUndefined()
  const g=await setup(); const render=g.service.render.bind(g.service)
  vi.spyOn(g.service,'render').mockImplementationOnce(async(...args)=>{const result=await render(...args);await g.files.revoke(g.grant.id);return result})
  const images=await g.registry.execute('read_pdf_pages',{fileId:g.file.id,pageNumbers:[1]},g.context)
  expect(images.isError).toBe(true); expect(images.content.some(b=>b.type==='image')).toBe(false)
})
it('retains allowed page images and reports the exact oversized physical page and PNG cap', async () => {
  const f = await setup()
  f.execute.mockResolvedValueOnce({ pages: [
    { pageNumber: 1, bytes: new Uint8Array([137,80,78,71]), width: 2000, height: 2000 },
    { pageNumber: 2, bytes: new Uint8Array(10 * 1024 * 1024 + 1), width: 2000, height: 2000 },
    { pageNumber: 3, bytes: new Uint8Array([137,80,78,71]), width: 2000, height: 2000 }
  ], failures: [] })
  const result = await f.registry.execute('read_pdf_pages', { fileId: f.file.id, pageNumbers: [1,2,3] }, f.context)
  expect(result.isError).toBe(true)
  expect(result.content.filter(block => block.type === 'image')).toHaveLength(2)
  expect(result.structuredContent).toMatchObject({ renderedPages: [1,3], failedPages: [{ pageNumber: 2, error: expect.stringContaining('10 MiB') }] })
  expect(result.fileSources).toEqual({ fileIds: [f.file.id] })
})
it.each(['stop','revoke','change','purge','quit'] as const)('never returns partial oversized-page success after %s during artifact publication', async action => {
  const f = await setup()
  f.execute.mockResolvedValueOnce({ pages: [
    { pageNumber: 1, bytes: new Uint8Array([137,80,78,71]), width: 2000, height: 2000 },
    { pageNumber: 2, bytes: new Uint8Array(10 * 1024 * 1024 + 1), width: 2000, height: 2000 }
  ], failures: [] })
  const put = f.artifacts.put.bind(f.artifacts)
  vi.spyOn(f.artifacts, 'put').mockImplementationOnce(async (...args) => {
    const image = await put(...args)
    if (action === 'stop') f.controller.abort()
    if (action === 'revoke') await f.files.revoke(f.grant.id)
    if (action === 'change') await writeFile(f.path, 'changed version')
    if (action === 'purge') { f.store.trashConversation(f.context.conversationId); f.store.purgeConversation(f.context.conversationId) }
    if (action === 'quit') await f.service.shutdown()
    return image
  })
  const pending = f.registry.execute('read_pdf_pages', { fileId: f.file.id, pageNumbers: [1,2] }, f.context)
  if (action === 'stop') await expect(pending).rejects.toThrow()
  else {
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.content.some(block => block.type === 'image')).toBe(false)
    expect(result.structuredContent).toBeUndefined()
  }
})
