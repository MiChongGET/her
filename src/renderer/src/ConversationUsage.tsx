import { useEffect, useRef, useState } from 'react'
import type { ChatMessage, ConversationContextUsage } from '../../shared/types'
import { Icon } from './Visuals'

const exact = (value: number) => value.toLocaleString('en-US')
const measured = (message: ChatMessage) => message.usage?.input != null && message.usage.output != null

interface Props {
  conversationId: string | null
  profileId?: string
  model?: string
  messages: ChatMessage[]
  refreshKey: number
  busy: boolean
  compacting: boolean
  compactFailed: boolean
  onCompact: () => Promise<boolean>
  onStopCompaction: () => Promise<unknown>
}

export default function ConversationUsage({ conversationId, profileId, model, messages, refreshKey, busy, compacting, compactFailed, onCompact, onStopCompaction }: Props) {
  const [context, setContext] = useState<{ key: string; usage: ConversationContextUsage | null; failed?: boolean }>()
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState('')
  const details = useRef<HTMLDetailsElement>(null)
  const key = `${conversationId ?? ''}:${profileId ?? ''}:${model ?? ''}`
  useEffect(() => {
    let current = true
    setContext(undefined)
    if (conversationId && profileId) void window.her.getConversationContext({ conversationId, profileId, model }).then(usage => {
      if (current) setContext({ key, usage })
    }).catch(() => { if (current) setContext({ key, usage: null, failed: true }) })
    return () => { current = false }
  }, [key, conversationId, profileId, model, refreshKey, busy])
  useEffect(() => { if (busy) setNotice('') }, [busy])
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (details.current && !details.current.contains(event.target as Node)) details.current.open = false }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [])
  useEffect(() => { if (details.current) details.current.open = false }, [key])

  const assistants = messages.filter(message => message.role === 'assistant')
  const latest = assistants.at(-1)
  const round = latest && measured(latest) ? latest.usage!.input! + latest.usage!.output! : null
  const total = assistants.reduce((sum, message) => sum + (message.usage?.input ?? 0) + (message.usage?.output ?? 0), 0)
  const incomplete = assistants.some(message => !measured(message))
  const usage = context?.key === key ? context.usage : null
  const compressing = compacting || pending
  const tokens = compressing ? null : usage?.tokens ?? null
  const percent = tokens !== null && usage?.contextWindow ? tokens / usage.contextWindow * 100 : null
  const percentage = percent === null ? '' : percent > 0 && percent < 0.1 ? '<0.1%' : `${Math.round(percent)}%`
  const contextLabel = compressing ? '压缩中' : context?.failed ? '暂不可用' : tokens === null ? '待统计' : percentage

  async function compact() {
    setPending(true); setNotice('')
    try { if (await onCompact()) setNotice('上下文已压缩，历史消息仍可查看') }
    finally { setPending(false) }
  }

  return <div className="conversation-usage" role="group" aria-label="Token 用量与上下文" data-ui>
    <details className="usage-details" ref={details} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); details.current!.open = false; details.current!.querySelector('summary')?.focus() }
    }}>
      <summary className="usage-summary" aria-label="查看 token 用量与上下文" title={`上下文${contextLabel} · 点击查看用量与压缩`}>
        <span className={`context-meter ${percent !== null && percent >= 80 ? 'context-high' : ''} ${compressing ? 'context-compacting' : ''}`}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle className="context-track" cx="12" cy="12" r="9" /><circle className="context-fill" cx="12" cy="12" r="9" pathLength="100" strokeDasharray={`${Math.min(100, Math.max(0, percent ?? 0))} 100`} /></svg>
          <span>{percentage || '—'}</span>
        </span>
      </summary>
      <div className="usage-popover">
        <h3>会话信息 <span>tokens</span></h3>
        <dl>
          <div><dt>本轮输入</dt><dd>{latest?.usage?.input == null ? '未知' : exact(latest.usage.input)}</dd></div>
          <div><dt>本轮输出</dt><dd>{latest?.usage?.output == null ? '未知' : exact(latest.usage.output)}</dd></div>
          <div><dt>本轮合计</dt><dd>{round === null ? '未知' : exact(round)}</dd></div>
          <div><dt>会话累计</dt><dd>{incomplete ? total ? `至少 ${exact(total)}` : '未知' : exact(total)}</dd></div>
        </dl>
        <p>含本轮工具往返的模型用量；未报告的计数为未知，不含独立压缩请求。</p>
        <h3>上下文窗口 <span>{contextLabel}</span></h3>
        <div className="context-progress" aria-hidden="true"><span style={{ width: `${Math.min(100, Math.max(0, percent ?? 0))}%` }} /></div>
        <dl>
          <div><dt>估算占用 / 窗口</dt><dd>{tokens === null ? `待统计 / ${usage?.contextWindow ? exact(usage.contextWindow) : '—'}` : `${exact(tokens)} / ${exact(usage!.contextWindow)}`}</dd></div>
          <div><dt>预计剩余</dt><dd>{tokens === null ? '待统计' : `${exact(Math.max(0, usage!.contextWindow - tokens))} tokens`}</dd></div>
        </dl>
        <p>{tokens === null ? '首次请求或压缩后，等待模型报告新的用量。' : '按上次请求估算，不含草稿。接近上限时自动压缩，累计用量保留。'}</p>
        {profileId && conversationId && (compressing
          ? <button type="button" className="compact-button compact-stop" onClick={() => void onStopCompaction()}><span className="stop-square" />停止压缩</button>
          : <button type="button" className="compact-button" disabled={busy} title={busy ? '当前任务结束后可压缩上下文' : '压缩较早的上下文，保留完整聊天记录'} onClick={() => void compact()}><Icon name="compact" />{compactFailed ? '重试压缩' : '压缩上下文'}</button>)}
        {(notice || compressing) && <p className="usage-notice" role="status">{compressing ? '正在压缩上下文…' : notice}</p>}
      </div>
    </details>
  </div>
}
