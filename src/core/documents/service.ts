import { createHash, randomUUID } from 'node:crypto'
import { extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DocumentChunk, DocumentReference, ToolResult } from '../../shared/types'
import { FileAccessService } from '../files/access'
import { FileAccessError, fileEntryError } from '../files/errors'
import { HerStore } from '../storage/store'
import { SimpleToolRegistry } from '../tools/registry'
import { fitsModelToolResult } from '../tools/result-format'
import type { ToolExecutionContext } from '../tools/types'
import { abortable } from '../tools/abort'
import { DocumentCache } from './cache'

export interface DocumentParser {
  version: string
  configuration: string
  validate(): void
  convert(uri: string, context: ToolExecutionContext): Promise<string>
}
const MAX_EXTRACTED = 16 * 1024 * 1024
const output = (chunk: DocumentChunk): ToolResult => ({ content: [], structuredContent: { ...chunk }, truncated: chunk.truncated, fileSources: { fileIds: [chunk.source.fileId] } })

export class DocumentService {
  private readonly cache: DocumentCache
  private readonly stopped = new AbortController()
  private readonly active = new Set<Promise<DocumentReference>>()
  constructor(private readonly store: HerStore, private readonly files: FileAccessService, private readonly parser: () => DocumentParser) {
    this.cache = new DocumentCache(store.documentDirectory)
  }
  extract(fileId: string, context: ToolExecutionContext): Promise<DocumentReference> {
    this.stopped.signal.throwIfAborted()
    const checked = { ...context, signal: AbortSignal.any([context.signal, this.stopped.signal]) }
    const operation = this.extractOwned(fileId, checked)
    this.active.add(operation)
    void operation.then(() => this.active.delete(operation), () => this.active.delete(operation))
    return operation
  }
  async shutdown(): Promise<void> {
    this.stopped.abort(new Error('文档读取正在停止。'))
    await Promise.allSettled([...this.active])
  }
  private async extractOwned(fileId: string, context: ToolExecutionContext): Promise<DocumentReference> {
    const { reference: file } = await this.files.resolve(fileId, context)
    context.signal.throwIfAborted()
    this.files.validateSources({ fileIds: [fileId] }, context)
    const parser = this.parser()
    const validate = () => { this.files.validateSources({ fileIds: [fileId] }, context); parser.validate() }
    validate()
    const cacheKey = createHash('sha256').update(JSON.stringify([file.id, file.version, parser.version, parser.configuration])).digest('hex')
    const cached = this.store.findDocument(context.conversationId, cacheKey)
    if (cached && await this.cache.read(cached.reference.id) !== undefined) { validate(); return cached.reference }
    const extension = extname(file.name).toLowerCase()
    if (!['.pdf', '.docx', '.pptx', '.xlsx', '.txt', '.md'].includes(extension)) throw new FileAccessError('此文档格式暂不支持，请使用文本读取或转换为 PDF、DOCX、PPTX、XLSX。')
    const bytes = await this.files.readBytes(fileId, context)
    validate()
    const id = randomUUID()
    this.store.beginDocumentFiles(id, context.conversationId)
    try {
      const path = await this.cache.stage(id, bytes, extension); validate()
      const text = await abortable(parser.convert(pathToFileURL(path).href, context), context.signal)
      validate()
      if (typeof text !== 'string' || text.length > MAX_EXTRACTED) throw new FileAccessError('提取结果超过本地缓存上限，请拆分文档。')
      const reference: DocumentReference = { id, fileId, version: file.version, parserVersion: parser.version,
        status: !text.trim() ? 'empty' : extension === '.pdf' ? 'partial' : 'ready' }
      await this.cache.write(id, text); validate()
      await this.cache.removeStaging(id); validate()
      this.store.saveDocument({ reference, conversationId: context.conversationId, cacheKey })
      return reference
    } catch (error) {
      await this.cache.remove(id)
      // After stop/quit, only filesystem cleanup may finish; the DB may already be
      // closed by the existing five-second deadline. Pending ownership survives.
      if (!context.signal.aborted && !this.stopped.signal.aborted) {
        try { this.files.validateSources(undefined, context); this.store.forgetDocumentFiles(id) } catch { /* durable owner remains for recovery */ }
      }
      context.signal.throwIfAborted()
      throw error
    }
  }

  async read(documentId: string, input: { offset?: number; length?: number; query?: string }, context: ToolExecutionContext): Promise<DocumentChunk> {
    this.stopped.signal.throwIfAborted()
    context = { ...context, signal: AbortSignal.any([context.signal, this.stopped.signal]) }
    context.signal.throwIfAborted()
    const parser = this.parser()
    parser.validate()
    const stored = this.store.getDocument(documentId)
    if (!stored || stored.conversationId !== context.conversationId) throw new FileAccessError('文档引用已失效，请重新选择文件。')
    const reference = await this.extract(stored.reference.fileId, context)
    const text = await this.cache.read(reference.id)
    if (text === undefined) throw new FileAccessError('文档缓存已丢失，请重新读取。')
    const file = (await this.files.resolve(reference.fileId, context)).reference
    let offset = input.offset ?? 0; const length = input.length ?? 30_000
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 30_000) throw new FileAccessError('读取范围不正确。')
    offset = Math.min(offset, text.length)
    if (input.query !== undefined) offset = text.indexOf(input.query, offset)
    const found = offset >= 0; if (!found) offset = text.length
    const workbook = extname(file.name).toLowerCase() === '.xlsx'
    let section: string | undefined
    for (const heading of text.matchAll(workbook ? /^## (.+)$/gm : /^#{1,6} (.+)$/gm)) {
      if (heading.index > offset) break
      section = heading[1].slice(0, 500)
    }
    const source = { fileId: file.id, name: file.name, ...(section ? workbook ? { sheet: section } : { section } : {}) }
    const page = (size: number): DocumentChunk => ({ documentId: reference.id, status: reference.status, source,
      ...(reference.status === 'empty' ? { notice: '未提取到文字；扫描件需按页视觉识别。' } : reference.status === 'partial' ? { notice: 'PDF 仅返回解析器提取到的文字，可能遗漏扫描页、图表或版式；不提供物理页码，也不保证完整。' } : {}),
      ...(!found ? { notice: '未找到查询文字。' } : {}), text: text.slice(offset, offset + size), range: { offset, length: size },
      truncated: offset + size < text.length, ...(offset + size < text.length ? { nextCursor: String(offset + size) } : {}) })
    let low = 0; let high = Math.min(length, text.length - offset)
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (fitsModelToolResult(output(page(mid)))) low = mid; else high = mid - 1 }
    const chunk = page(low)
    if (!fitsModelToolResult(output(chunk)) || (!low && offset < text.length)) throw new FileAccessError('文档来源信息超过返回上限。')
    this.files.validateSources({ fileIds: [file.id] }, context); parser.validate()
    return chunk
  }
}

export function registerDocumentTools(registry: SimpleToolRegistry, service: DocumentService): void {
  registry.register({ name: 'read_document', description: 'Extract authorized PDF/DOCX/PPTX/XLSX and read a segment. Use numeric nextCursor as offset. Offsets are UTF-16 units. PDF may be partial; no OCR or formula recalculation.', parameters: {
    type: 'object', additionalProperties: false, required: ['fileId'], properties: { fileId: { type: 'string', minLength: 1 }, offset: { type: 'integer', minimum: 0 }, length: { type: 'integer', minimum: 1, maximum: 30000 }, query: { type: 'string', minLength: 1, maxLength: 1000 } }
  } }, async (args, context) => {
    try {
      const ref = await service.extract(args.fileId as string, context)
      return output(await service.read(ref.id, args, context))
    } catch (error) { context.signal.throwIfAborted(); throw fileEntryError(error) }
  }, { timeoutMs: 120000, assess: async args => ({ effect: 'read', target: `file:${args.fileId}`, summary: '提取已授权文档的文字片段' }) })
}
