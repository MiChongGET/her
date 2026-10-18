import type { ArtifactReference, PdfInspection, PdfRenderReply, PdfRequest, ToolResult } from '../../shared/types'
import { FileAccessService } from '../files/access'
import { FileAccessError, fileEntryError } from '../files/errors'
import { ToolArtifactStore } from '../tools/artifacts'
import { abortable } from '../tools/abort'
import { SimpleToolRegistry } from '../tools/registry'
import { fitsModelToolResult } from '../tools/result-format'
import type { ToolExecutionContext } from '../tools/types'

export interface PdfRenderer {
  execute(bytes: Uint8Array, request: PdfRequest, signal: AbortSignal): Promise<PdfInspection | PdfRenderReply>
  shutdown(): Promise<void>
}
export interface PdfPageImage { pageNumber: number; image: ArtifactReference; width: number; height: number }
class PartialPdfError extends FileAccessError {
  constructor(readonly pages: PdfPageImage[], readonly failures: PdfRenderReply['failures']) { super('部分页面无法渲染，尚未完整读取。') }
}
export class PdfService {
  private readonly stopped = new AbortController()
  constructor(private readonly files: FileAccessService, private readonly artifacts: ToolArtifactStore, private readonly renderer: PdfRenderer) {}
  private context(context: ToolExecutionContext): ToolExecutionContext {
    const checked = { ...context, signal: AbortSignal.any([context.signal, this.stopped.signal]) }
    checked.signal.throwIfAborted(); return checked
  }
  assertReadable(fileId: string, context: ToolExecutionContext): void { this.stopped.signal.throwIfAborted(); this.files.validateSources({ fileIds: [fileId] }, context) }
  private async execute(fileId: string, request: PdfRequest, context: ToolExecutionContext): Promise<PdfInspection | PdfRenderReply> {
    const bytes = await this.files.readBytes(fileId, context)
    this.assertReadable(fileId, context)
    const reply = await abortable(this.renderer.execute(new Uint8Array(bytes), request, context.signal), context.signal)
    this.assertReadable(fileId, context)
    return reply
  }
  async inspect(fileId: string, context: ToolExecutionContext): Promise<PdfInspection> {
    context = this.context(context)
    return await this.execute(fileId, { kind: 'inspect' }, context) as PdfInspection
  }
  async render(fileId: string, pageNumbers: number[], context: ToolExecutionContext): Promise<PdfPageImage[]> {
    context = this.context(context)
    if (context.modelSupportsVision !== true) throw new FileAccessError('当前任务模型未启用视觉能力；尚未读取页面图像，请切换支持图片的模型后继续。')
    if (!Array.isArray(pageNumbers) || !pageNumbers.length || pageNumbers.length > 3 || new Set(pageNumbers).size !== pageNumbers.length || pageNumbers.some(n => !Number.isSafeInteger(n) || n < 1)) throw new FileAccessError('每次请选择 1 到 3 个不同的物理页码，从 1 开始。')
    const reply = await this.execute(fileId, { kind: 'render', pageNumbers }, context) as PdfRenderReply
    const pages: PdfPageImage[] = []
    const failures = [...reply.failures]
    for (const page of reply.pages) {
      if (!pageNumbers.includes(page.pageNumber) || pages.some(p => p.pageNumber === page.pageNumber) || !Number.isInteger(page.width) || !Number.isInteger(page.height) || page.width < 1 || page.height < 1 || Math.max(page.width, page.height) > 2000) throw new FileAccessError('PDF 页面渲染结果无效。')
      this.assertReadable(fileId, context)
      if (page.bytes.byteLength > 10 * 1024 * 1024) {
        failures.push({ pageNumber: page.pageNumber, error: '页面 PNG 超过 10 MiB，尚未读取该页图像。' })
        continue
      }
      const image = await this.artifacts.put(page.bytes, { conversationId: context.conversationId, sourceFileId: fileId }, 'image/png', context)
      this.assertReadable(fileId, context)
      pages.push({ pageNumber: page.pageNumber, image, width: page.width, height: page.height })
    }
    this.assertReadable(fileId, context)
    if (failures.length) throw new PartialPdfError(pages, failures)
    return pages
  }
  async shutdown(): Promise<void> { this.stopped.abort(new Error('PDF 读取正在停止。')); await this.renderer.shutdown() }
}
const notice = '文字存在不代表图表或扫描图像已理解。图像仅供当前模型识别，尚未保证读取或识别成功。物理页码从 1 开始。'
export function registerPdfTools(registry: SimpleToolRegistry, service: PdfService): void {
  const properties = { fileId: { type: 'string', minLength: 1 } }
  registry.register({ name: 'inspect_pdf', description: 'Inspect authorized PDF physical page text availability, not OCR. Images/charts can still require read_pdf_pages.', parameters: { type: 'object', additionalProperties: false, required: ['fileId'], properties } }, async (args, context) => {
    try {
      const info = await service.inspect(args.fileId as string, context)
      const output = (count: number): ToolResult => ({ content: [{type:'text',text:notice}], structuredContent: {pageCount:info.pageCount,pages:info.pages.slice(0,count),omittedPages:info.pages.length-count}, ...(count < info.pages.length ? {truncated:true} : {}), fileSources:{fileIds:[args.fileId as string]} })
      let low = 0; let high = info.pages.length
      while (low < high) { const mid = Math.ceil((low + high) / 2); if (fitsModelToolResult(output(mid))) low = mid; else high = mid - 1 }
      service.assertReadable(args.fileId as string, context)
      return output(low)
    } catch (error) { context.signal.throwIfAborted(); throw fileEntryError(error) }
  }, { timeoutMs:120000, assess:async args => ({effect:'read',target:`file:${args.fileId}`,summary:'检查 PDF 物理页文字可用性'}) })
  registry.register({ name:'read_pdf_pages', description:'Render 1–3 authorized PDF physical pages for the CURRENT vision model. Rendered pages are not proof of understanding. Report missing/uncertain pages.', parameters:{type:'object',additionalProperties:false,required:['fileId','pageNumbers'],properties:{...properties,pageNumbers:{type:'array',minItems:1,maxItems:3,uniqueItems:true,items:{type:'integer',minimum:1}}}} }, async (args, context) => {
    let pages: PdfPageImage[]; let failures: PdfRenderReply['failures'] = []
    try { pages = await service.render(args.fileId as string, args.pageNumbers as number[], context) }
    catch (error) {
      context.signal.throwIfAborted()
      if (!(error instanceof PartialPdfError)) throw fileEntryError(error)
      pages = error.pages; failures = error.failures
    }
    try { service.assertReadable(args.fileId as string, context) } catch (error) { context.signal.throwIfAborted(); throw fileEntryError(error) }
    return { content:[{type:'text',text:notice}, ...pages.flatMap(page => [{type:'text' as const,text:`物理页 ${page.pageNumber}`},{type:'image' as const,artifactId:page.image.id,mimeType:'image/png'}])], structuredContent:{renderedPages:pages.map(p => p.pageNumber),failedPages:failures,pages:pages.map(({pageNumber,width,height}) => ({pageNumber,width,height}))}, ...(failures.length ? {isError:true} : {}), fileSources:{fileIds:[args.fileId as string]} }
  }, {timeoutMs:120000,assess:async args => ({effect:'read',target:`file:${args.fileId}`,summary:'渲染 PDF 选定物理页供当前模型识别'})})
}
