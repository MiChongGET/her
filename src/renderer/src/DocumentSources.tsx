import { useEffect, useRef, useState } from 'react'
import type { ChatMessage, FileReference } from '../../shared/types'

export function FilePreview({ file, conversationId }: { file: FileReference; conversationId: string }) {
  const [preview, setPreview] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    setPreview(''); setError('')
    void window.her.getFilePreview({ conversationId, fileId: file.id }).then(value => { if (live) setPreview(value.dataUrl) })
      .catch(() => { if (live) setError('图片不可用，请重新选择。') })
    return () => { live = false }
  }, [conversationId, file.id, file.version])
  return preview ? <img className="attachment-thumbnail" src={preview} alt={file.name} /> : <small>{error || '正在加载图片…'}</small>
}

const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const physicalPage = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

export default function DocumentSources({ message, unavailable = [], pending = [], unavailableFileIds = [] }: { message: ChatMessage; unavailable?: string[]; pending?: string[]; unavailableFileIds?: string[] }) {
  const [error, setError] = useState('')
  const generation = useRef(0)
  useEffect(() => { generation.current++; setError(''); return () => { generation.current++ } }, [message.conversationId])
  async function open(fileId: string) {
    const token = generation.current
    try { await window.her.openFileSource({ conversationId: message.conversationId, fileId }) }
    catch (cause) { if (token === generation.current) setError(cause instanceof Error ? cause.message : '无法打开来源。') }
  }
  return <div className="document-sources">
    {message.files?.map(file => <div className="document-source" key={file.id}>
      {file.mimeType.startsWith('image/') && !unavailable.includes(file.grantId) && !pending.includes(file.grantId) && <FilePreview file={file} conversationId={message.conversationId} />}
      <button type="button" disabled={unavailable.includes(file.grantId) || pending.includes(file.grantId)} onClick={() => void open(file.id)} aria-label={`打开来源 ${file.name}`}>{file.name}</button>
      {pending.includes(file.grantId) && <small>正在撤销授权…</small>}
      {unavailable.includes(file.grantId) && <small>授权已撤销，历史保留，后续不能继续读取。</small>}
    </div>)}
    {message.toolCalls?.filter(call => ['read_document', 'inspect_pdf', 'read_pdf_pages', 'read_text'].includes(call.name)).map(call => {
      const result = typeof call.result === 'object' ? call.result : undefined
      const data = record(result?.structuredContent)
      const source = record(data?.source)
      const fileId = typeof source?.fileId === 'string' ? source.fileId : typeof call.arguments.fileId === 'string' ? call.arguments.fileId : undefined
      const authorizedSource = fileId && result?.fileSources?.fileIds?.includes(fileId)
      const blocked = (fileId && unavailableFileIds.includes(fileId)) || [...(message.fileSources?.grants ?? []), ...(result?.fileSources?.grants ?? [])].some(grant => unavailable.includes(grant.id) || pending.includes(grant.id))
      const status = blocked ? '历史结果 · 当前不可继续读取' : call.status === 'cancelled' ? '读取已取消' : call.status === 'failed' || (result?.isError && call.name !== 'read_pdf_pages') ? '读取失败' : ['pending', 'running', 'awaiting_confirmation'].includes(call.status ?? '') ? '正在读取…' : data?.status === 'partial' ? '部分提取' : data?.status === 'empty' ? '未提取到文字' : data?.status === 'ready' ? '已提取文字' : undefined
      return <div className="document-source" key={call.id}>
        {status && <strong>{status}</strong>}
        {authorizedSource && <>
          <button type="button" disabled={!!blocked} onClick={() => void open(fileId)} aria-label={`打开来源 ${typeof source?.name === 'string' ? source.name : '原文件'}`}>{typeof source?.name === 'string' ? source.name : '原文件'}</button>
          {typeof source?.section === 'string' && <span>章节：{source.section}</span>}
          {typeof source?.sheet === 'string' && <span>工作表：{source.sheet}</span>}
          {physicalPage(source?.pageNumber) && <span>物理第 {source.pageNumber} 页</span>}
          {typeof record(data?.range)?.offset === 'number' && typeof record(data?.range)?.length === 'number' && <small>文字范围：{String(record(data?.range)!.offset)} + {String(record(data?.range)!.length)}</small>}
          {typeof data?.text === 'string' && <blockquote>{data.text.slice(0, 500)}{data.text.length > 500 ? '…' : ''}</blockquote>}
          {data?.truncated === true && <small>结果已截断{typeof data.nextCursor === 'string' ? `，后续位置 ${data.nextCursor}` : ''}。</small>}
          {typeof data?.notice === 'string' && <p>{data.notice}</p>}
          {call.name === 'inspect_pdf' && <><p>页面文字可用性（不代表已识别或读懂）</p>{Array.isArray(data?.pages) && data.pages.map((item, index) => { const page = record(item); return physicalPage(page?.pageNumber) ? <span key={index}>物理第 {page.pageNumber} 页：{page.textStatus === 'present' ? '有文字' : page.textStatus === 'empty' ? '无提取文字' : '未知'}</span> : null })}{typeof data?.omittedPages === 'number' && data.omittedPages > 0 && <small>另有 {data.omittedPages} 页未展示。</small>}</>}
          {call.name === 'read_pdf_pages' && <>{Array.isArray(data?.pages) && data.pages.map((item, index) => { const page = record(item); return physicalPage(page?.pageNumber) ? <span key={index}>物理第 {page.pageNumber} 页 · 已渲染，识别结果以模型回答为准</span> : null })}{Array.isArray(data?.failedPages) && data.failedPages.map((item, index) => { const page = record(item); return physicalPage(page?.pageNumber) ? <span key={index}>物理第 {page.pageNumber} 页 · 渲染失败{typeof page.error === 'string' ? `：${page.error}` : ''}</span> : null })}</>}
        </>}
      </div>
    })}
    {error && <p role="alert">{error}</p>}
  </div>
}
