import { useEffect, useRef, useState } from 'react'
import type { SystemPromptPart, SystemPromptPreview } from '../../shared/types'

interface Props {
  conversationId?: string
  profileId?: string
  model?: string
  onBusyChange(busy: boolean): void
}

function PromptParts({ parts }: { parts: SystemPromptPart[] }) {
  return <div className="prompt-parts">{parts.map(part => <details key={part.id} className="prompt-part">
    <summary>{part.title}<span className={`prompt-part-status ${part.status}`}>{part.status === 'included' ? '加入提示词' : part.status === 'conditional' ? '条件性加入' : '未加入'}</span></summary>
    <small>{part.source}</small><pre>{part.content}</pre>
  </details>)}</div>
}

export default function SystemPromptSettings({ conversationId, profileId, model, onBusyChange }: Props) {
  const [prompt, setPrompt] = useState('')
  const [defaultPrompt, setDefaultPrompt] = useState('')
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [view, setView] = useState<'draft' | 'actual'>('draft')
  const [preview, setPreview] = useState<SystemPromptPreview | null>(null)
  const [previewedPrompt, setPreviewedPrompt] = useState<string | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const mounted = useRef(true)
  const generation = useRef(0)
  const identity = JSON.stringify([conversationId, profileId, model])
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity

  useEffect(() => {
    mounted.current = true
    Promise.all([window.her.getSystemPrompt(), window.her.getDefaultSystemPrompt()]).then(([saved, fallback]) => {
      if (!mounted.current) return
      setPrompt(saved || fallback); setDefaultPrompt(fallback); setReady(true)
    }).catch(() => { if (mounted.current) setError('系统提示词加载失败，请关闭设置后重试。') })
    return () => { mounted.current = false; generation.current++ }
  }, [])

  useEffect(() => {
    generation.current++
    setPreview(null); setPreviewedPrompt(null); setPreviewBusy(false)
  }, [identity])

  function changePrompt(value: string) {
    generation.current++
    setPrompt(value); setPreviewBusy(false); setNotice('')
  }

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true); onBusyChange(true); setError(''); setNotice('')
    const value = prompt.trim()
    try {
      await window.her.setSystemPrompt(value === defaultPrompt.trim() ? '' : value)
      if (!mounted.current) return
      changePrompt(value || defaultPrompt)
      setNotice('系统提示词已保存')
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '保存失败，请重试。') }
    finally { if (mounted.current) { setBusy(false); onBusyChange(false) } }
  }

  async function refreshPreview() {
    if (typeof window.her.previewSystemPrompt !== 'function') { setError('提示词预览需要完全退出并重新打开 Her。'); return }
    const request = ++generation.current
    const context = identity
    setPreviewBusy(true); setError('')
    try {
      const result = await window.her.previewSystemPrompt({ prompt, conversationId, profileId, model })
      if (!mounted.current || generation.current !== request || currentIdentity.current !== context) return
      setPreview(result); setPreviewedPrompt(prompt)
    } catch (cause) {
      if (mounted.current && generation.current === request && currentIdentity.current === context) {
        setPreview(null); setPreviewedPrompt(null)
        setError(cause instanceof Error ? cause.message : '预览加载失败，请重试。')
      }
    } finally { if (mounted.current && generation.current === request && currentIdentity.current === context) setPreviewBusy(false) }
  }

  return <form className="system-prompt-settings" onSubmit={event => void save(event)}>
    <h3>系统提示词</h3>
    <p className="desktop-intro">定义 Samantha 如何与你交流和办事。这份全局提示词适用于所有话题，已有自定义内容会保留。</p>
    {error && <p className="error-banner" role="alert">{error}</p>}
    {notice && <p className="success-banner" role="status">{notice}</p>}
    <label className="field">当前提示词<textarea aria-label="系统提示词" rows={14} spellCheck={false} maxLength={16384} disabled={!ready || busy} value={prompt} onChange={event => changePrompt(event.target.value)} placeholder="提示词加载后可编辑" />
      <small>全文可编辑，留空使用默认提示词。保存后，下次发送或继续对话时生效，正在运行的任务不受影响。<span className="char-count"> · 已输入 {prompt.length} / 16384 字符</span></small>
    </label>
    <div className="form-actions">
      <button className="primary-button" type="submit" disabled={busy || !ready}>{busy ? '正在保存…' : '保存提示词'}</button>
      <button className="text-button" type="button" disabled={busy || !ready || prompt === defaultPrompt} onClick={() => changePrompt(defaultPrompt)}>恢复默认</button>
    </div>
    <small>恢复默认只修改编辑框，点击保存后才会生效。编辑提示词不会改变工具权限。</small>
    <section className="prompt-preview" aria-label="提示词预览">
      <div className="prompt-preview-header">
        <div className="prompt-preview-tabs" role="tablist" aria-label="提示词预览类别">
          <button type="button" role="tab" aria-selected={view === 'draft'} onClick={() => setView('draft')}>草稿预览</button>
          <button type="button" role="tab" aria-selected={view === 'actual'} onClick={() => { setView('actual'); if (ready) void refreshPreview() }}>最近实际使用</button>
        </div>
        <button className="text-button" type="button" disabled={!ready || previewBusy} onClick={() => void refreshPreview()}>{previewBusy ? '正在加载…' : '刷新预览'}</button>
      </div>
      {view === 'draft' ? <div role="tabpanel" aria-label="草稿预览">
        <p className="prompt-preview-note">预览在本机生成，不发送给模型，也不会连接工具服务。工具集合尚未发现，条件性规则可能在实际请求中加入；聊天历史与工具参数定义单独传递。</p>
        {preview && previewedPrompt === prompt ? <>
          <small>{preview.contextWindow === null ? '尚未选择模型，窗口预算未确认。' : `模型窗口：${preview.contextWindow.toLocaleString()} tokens。`}</small>
          <PromptParts parts={preview.parts} />
        </> : <p className="prompt-preview-empty">{preview ? '草稿已更改，请刷新预览。' : '点击刷新预览，查看各段内容与来源。'}</p>}
      </div> : <div role="tabpanel" aria-label="最近实际使用">
        <p className="prompt-preview-note">来自当前话题已确认派发的模型请求，包含 Her 与 SDK 追加内容，与未保存的草稿独立。记录不代表请求成功完成。</p>
        {preview?.actual ? <>
          <p className="prompt-record-meta">{preview.actual.model} · {new Date(preview.actual.usedAt).toLocaleString()}<br />来源：本地 Pi 会话派发记录</p>
          <label className="field">完整系统文本<textarea aria-label="实际系统提示词" readOnly rows={10} value={preview.actual.text} /></label>
          <small>本次工具：{preview.actual.toolNames.join('、') || '无'}</small>
          <PromptParts parts={preview.actual.parts} />
        </> : <p className="prompt-preview-empty">{previewBusy ? '正在读取实际记录…' : !conversationId ? '请先打开一个话题，再查看实际记录。' : '暂无实际记录。更新后首次模型请求派发时会生成。'}</p>}
      </div>}
    </section>
  </form>
}
