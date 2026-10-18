import { useEffect, useRef, useState } from 'react'
import type { ApprovalDecisionInput, ChatMessage, TaskEvent, UnknownToolCall } from '../../shared/types'

const callLabels = { pending: '待执行', awaiting_confirmation: '等待确认', running: '执行中', succeeded: '已完成', failed: '失败', cancelled: '已取消', unknown: '结果未知' }
const labels = { running: '执行中', awaiting_confirmation: '等待确认', paused: '已暂停', stopped: '已停止', completed: '已完成', failed: '未完成' }
export default function TaskStatus({ task, message, canContinue, onContinue, onStop }: { task: TaskEvent; message?: ChatMessage; canContinue: boolean; onContinue(): void; onStop(): void }) {
  const [error, setError] = useState('')
  const [deciding, setDeciding] = useState(false)
  const [autoRevoked, setAutoRevoked] = useState(false)
  const [acknowledged, setAcknowledged] = useState<string[]>([])
  const [resolved, setResolved] = useState<string[]>([])
  const [resolving, setResolving] = useState(false)
  const identity = `${task.conversationId}:${task.run.id}`
  const currentIdentity = useRef(identity); currentIdentity.current = identity
  const unresolved = (task.unknownCalls ?? []).filter(call => !resolved.includes(`${call.runId}:${call.callId}:${call.revision}`))
  const inactive = ['paused', 'stopped', 'failed', 'completed'].includes(task.run.status)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  async function decide(decision: ApprovalDecisionInput['decision']) {
    if (!task.approval || deciding) return
    setDeciding(true); setError('')
    try { await window.her.decideToolApproval({ approvalId: task.approval.id, revision: task.approval.revision, decision }) }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '确认失败，请刷新任务。') }
    finally { if (alive.current) setDeciding(false) }
  }
  async function revokeAutoApproval() {
    if (deciding) return
    setDeciding(true); setError('')
    try {
      await window.her.revokeConversationApprovals(task.conversationId)
      if (alive.current && currentIdentity.current === identity) setAutoRevoked(true)
    } catch (cause) { if (alive.current && currentIdentity.current === identity) setError(cause instanceof Error ? cause.message : '关闭自动操作失败。') }
    finally { if (alive.current && currentIdentity.current === identity) setDeciding(false) }
  }
  async function resolveUnknown(call: UnknownToolCall, decision: 'handled' | 'abandoned') {
    const key = `${call.runId}:${call.callId}:${call.revision}`
    if (resolving || !inactive || !acknowledged.includes(key)) return
    setResolving(true); setError('')
    try {
      await window.her.resolveUnknownToolCall({ conversationId: task.conversationId, runId: call.runId, callId: call.callId, revision: call.revision, decision })
      if (alive.current && currentIdentity.current === identity) setResolved(previous => [...previous, key])
    } catch (cause) { if (alive.current && currentIdentity.current === identity) setError(cause instanceof Error ? cause.message : '处理失败，请刷新任务。') }
    finally { if (alive.current && currentIdentity.current === identity) setResolving(false) }
  }
  return <section className="task-status" aria-label="任务状态">
    <details className="task-records"><summary title="展开或收起执行记录"><strong>{labels[task.run.status]}</strong><span> · 已调用 {task.run.toolCallsCount} 个工具 · {task.run.model}</span></summary>
      {message?.toolCalls?.map(call => <p key={call.id}>{call.assessment?.summary ?? '工具步骤'} · {call.status ? callLabels[call.status] : '历史状态未知'}{call.status === 'unknown' ? '：结果未知，不能重复执行。' : ''}{call.dispatchPhase === 'preflight' ? '（观察预检可能已关闭或重建崩溃标签；最终动作未派发）' : ''}{call.resolution ? ` · 用户已${call.resolution.decision === 'handled' ? '处理' : '放弃'}；原动作仍为结果未知` : ''}</p>)}
    </details>
    {unresolved.map(call => {
      const key = `${call.runId}:${call.callId}:${call.revision}`
      return <div className="task-approval" key={key}><p>{call.summary}</p>{call.dispatchPhase === 'preflight' && <p>未知效果发生在观察预检，最终动作尚未派发。</p>}
        {inactive ? <><label className="checkbox-field"><input type="checkbox" checked={acknowledged.includes(key)} onChange={event => setAcknowledged(previous => event.target.checked ? [...previous, key] : previous.filter(item => item !== key))} />我已在目标应用核对或处理此动作；解除阻塞不表示成功，也不授权重放。</label>
          <button className="secondary-button" disabled={resolving || !acknowledged.includes(key)} onClick={() => void resolveUnknown(call, 'handled')}>已处理，解除阻塞</button>
          <button className="secondary-button" disabled={resolving || !acknowledged.includes(key)} onClick={() => void resolveUnknown(call, 'abandoned')}>放弃此动作，解除阻塞</button></> : <p>请先停止任务，再人工处理未知动作。</p>}
      </div>
    })}
    {resolved.length > 0 && <p>已记录人工处理。原动作仍为结果未知；继续时需要新观察和新确认，不会自动重放。</p>}
    {task.browserAutoApproved && !autoRevoked && <div className="task-approval"><p>本轮对话已允许浏览器自动操作，包括点击、输入和提交。</p><button className="secondary-button" disabled={deciding} onClick={() => void revokeAutoApproval()}>关闭浏览器自动操作</button></div>}
    {task.approval && <div className="task-approval"><p>操作目标：{task.approval.target}</p><p>{task.approval.summary}</p><button className="secondary-button" disabled={deciding} onClick={() => void decide('approve')}>允许这次操作</button>{task.approval.allowConversation && <><button className="secondary-button" disabled={deciding} onClick={() => void decide('approve-conversation')}>本轮对话自动允许浏览器操作</button><p>此对话后续的浏览器读取、点击、输入和提交将自动执行；可随时关闭。应用重启或 MCP 连接重建后失效。</p></>}<button className="secondary-button" disabled={deciding} onClick={() => void decide('reject')}>拒绝这次操作</button></div>}
    {['running', 'awaiting_confirmation'].includes(task.run.status) && <button className="secondary-button" onClick={onStop}>停止任务</button>}
    {canContinue && <button className="secondary-button" disabled={resolving} onClick={onContinue}>继续任务</button>}
    {['paused', 'stopped', 'failed'].includes(task.run.status) && <p>已完成的步骤和部分结果保留。停止不会撤销已发生的操作。</p>}
    {error && <p role="alert">{error}</p>}
  </section>
}

export function ArtifactPreview({ id, conversationId }: { id: string; conversationId: string }) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const generation = useRef(0)
  useEffect(() => { generation.current++; setUrl(''); setError(''); setLoading(false); return () => { generation.current++ } }, [id, conversationId])
  async function preview() {
    const version = ++generation.current
    setLoading(true)
    try { const result = await window.her.getArtifactPreview(id, conversationId); if (version === generation.current) setUrl(result.dataUrl) }
    catch (cause) { if (version === generation.current) setError(cause instanceof Error ? cause.message : '图片无法读取。') }
    finally { if (version === generation.current) setLoading(false) }
  }
  return <div>{url ? <img className="tool-preview" src={url} alt="工具图片" /> : <button className="secondary-button" disabled={loading} onClick={() => void preview()}>查看工具图片</button>}{error && <p role="alert">{error}</p>}</div>
}
