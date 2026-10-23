import { useEffect, useRef, useState } from 'react'
import type { ChatMessage, TopicHandoffOperation, TopicHandoffPreview } from '../../shared/types'

export interface HandoffResume {
  sourceConversationId: string
  preview: TopicHandoffPreview
  operationId: string
  operation: TopicHandoffOperation | null
}

interface Props {
  sourceConversationId: string
  messages: ChatMessage[]
  resume?: HandoffResume | null
  onResume(value: HandoffResume | null): void
  onCreated(conversationId: string): void
  onClose(): void
}

function statusText(operation: TopicHandoffOperation) {
  if (operation.status === 'created') return '背景已保存，正在打开话题。'
  if (operation.status === 'preparing') return '仍在核实这次保存，请继续核实。'
  return operation.errorCode === 'source-changed' ? '日常来源已变化，请重新选择。' : operation.errorCode === 'receiver-changed' ? '模型服务已变化，请重新预览。' : '保存未完成，请核实后重试。'
}

export default function TopicHandoffDialog({ sourceConversationId, messages, resume, onResume, onCreated, onClose }: Props) {
  const options = messages.filter(message => (message.role === 'user' || message.role === 'assistant') && message.status === 'complete' && !message.hostStatus)
  const [selected, setSelected] = useState<string[]>(() => {
    const pairedUser = options.findLastIndex((message, index) => message.role === 'user' && options[index + 1]?.role === 'assistant')
    const lastUser = pairedUser >= 0 ? pairedUser : options.findLastIndex(message => message.role === 'user')
    if (lastUser < 0) return []
    const reply = options[lastUser + 1]
    return [options[lastUser].id, ...(reply?.role === 'assistant' ? [reply.id] : [])]
  })
  const [preview, setPreview] = useState<TopicHandoffPreview | null>(resume?.preview ?? null)
  const [operationId, setOperationId] = useState<string | null>(resume?.operationId ?? null)
  const [operation, setOperation] = useState<TopicHandoffOperation | null>(resume?.operation ?? null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const busyRef = useRef(false)
  const operationIdRef = useRef(resume?.operationId ?? null)
  const startedRef = useRef(false)

  useEffect(() => {
    if (!startedRef.current && !resume?.preview && selected.length) {
      startedRef.current = true
      void makePreview(selected)
    }
  }, [])

  async function makePreview(ids = selected) {
    setLoading(true); setError('')
    try { setPreview(await window.her.previewTopicHandoff({ conversationId: sourceConversationId, messageIds: ids })) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '无法预览，请重试。') }
    finally { setLoading(false) }
  }

  async function confirm() {
    if (!preview || busyRef.current) return
    busyRef.current = true
    const id = operationIdRef.current ?? crypto.randomUUID()
    operationIdRef.current = id
    setOperationId(id); setLoading(true); setError('')
    onResume({ sourceConversationId, preview, operationId: id, operation })
    try {
      const result = await window.her.commitTopicHandoff({ operationId: id, previewId: preview.id, digest: preview.digest })
      setOperation(result)
      onResume({ sourceConversationId, preview, operationId: id, operation: result })
      if (result.status === 'created' && result.conversationId) onCreated(result.conversationId)
    } catch {
      try {
        const result = await window.her.getTopicHandoffOperation(id)
        setOperation(result)
        onResume({ sourceConversationId, preview, operationId: id, operation: result })
        setError(result ? '' : '结果暂时无法确认。请核实这次操作，不要重新创建。')
        if (result?.status === 'created' && result.conversationId) onCreated(result.conversationId)
      } catch { setError('结果暂时无法确认。请核实这次操作，不要重新创建。') }
    } finally { busyRef.current = false; setLoading(false) }
  }

  async function verify() {
    if (!operationId || busyRef.current) return
    busyRef.current = true
    setLoading(true); setError('')
    try {
      const result = await window.her.getTopicHandoffOperation(operationId)
      setOperation(result)
      if (preview) onResume({ sourceConversationId, preview, operationId, operation: result })
      if (!result) setError('尚未查到这次操作，请稍后继续核实。')
      else if (result.status === 'created' && result.conversationId) onCreated(result.conversationId)
    } catch { setError('无法核实这次操作，请稍后再试。') }
    finally { busyRef.current = false; setLoading(false) }
  }

  return <div className="handoff-backdrop"><section className="handoff-dialog" role="dialog" aria-modal="true" aria-labelledby="handoff-title">
    <header><div><h2 id="handoff-title">把这件事单独聊聊</h2><p>只带上这几句话，其他日常留在原处。</p></div><button aria-label="关闭" onClick={onClose}>×</button></header>
    {!preview ? <div className="handoff-body">
      {loading && <p role="status">正在核对最近的交流…</p>}
      {!loading && <p>选择想带入的话，最多六条；来源或服务许可不明的内容会在预览中省略。</p>}
      {options.length === 0 ? <p>日常里还没有可选择的交流。</p> : options.map(message => <label key={message.id} className="handoff-option"><input type="checkbox" checked={selected.includes(message.id)} disabled={loading || (!selected.includes(message.id) && selected.length >= 6)} onChange={event => setSelected(previous => event.target.checked ? [...previous, message.id] : previous.filter(id => id !== message.id))} /><span>{message.content}<small>{message.role === 'user' ? '你' : 'Samantha'} · 来自日常{selected.includes(message.id) ? ' · 本次选定内容' : ''}</small></span></label>)}
    </div> : <div className="handoff-body">{preview.excerpts.map(item => <blockquote key={item.messageId}>{item.text}<small>{item.role === 'user' ? '你' : 'Samantha'} · 来自日常 · 本次选定内容</small></blockquote>)}
      {preview.omittedCount > 0 && <p className="handoff-omitted">另有 {preview.omittedCount} 条因来源或服务许可无法核实而省略，请重新选择其他交流。</p>}
      {!!preview.crossServiceReplyCount && <p className="handoff-transfer">其中 {preview.crossServiceReplyCount} 条 Samantha 回复来自其他模型服务；确认后会作为背景提供给「{preview.receiverLabel}」。</p>}
      <p className="handoff-warning"><span aria-hidden="true">ⓘ</span><span>只保存上面展示的背景，不自动发送新消息；不转移附件授权，也不形成长期记忆。</span></p>
    </div>}
    {operation && <p className="handoff-state" role="status">{statusText(operation)}</p>}{error && <p className="handoff-error" role="alert">{error}</p>}
    <footer><button className="handoff-quiet-button" onClick={onClose}>留在日常</button>{!preview ? <button className="primary-button" disabled={loading || selected.length === 0} onClick={() => void makePreview()}>{loading ? '正在预览…' : '预览背景'}</button> : <>{!operationId && <button className="text-button" onClick={() => setPreview(null)}>重新选择</button>}{operation?.status === 'created' && operation.conversationId ? <button className="primary-button" onClick={() => onCreated(operation.conversationId!)}>打开这个话题</button> : <button className="primary-button" disabled={loading || (operation?.status === 'failed' && operation.errorCode !== 'storage-failed')} onClick={() => void (operationId && operation?.errorCode !== 'storage-failed' ? verify() : confirm())}>{loading ? '正在核实…' : operation?.errorCode === 'storage-failed' ? '重试这次保存' : operationId ? '核实这次保存' : '确认并另开话题'}</button>}</>}</footer>
  </section></div>
}
