import { useEffect, useRef, useState } from 'react'
import type { ApprovalDecisionInput, ChatMessage, TaskEvent, UnknownToolCall } from '../../shared/types'

const callLabels = { pending: '待执行', awaiting_confirmation: '等待确认', running: '执行中', succeeded: '已完成', failed: '失败', cancelled: '已取消', unknown: '结果未知' }
const labels = { queued: '排队中', waiting_approval: '等待确认', waiting_resource: '正在等待资源', compacting: '正在压缩', retrying: '正在重试', stopping: '正在停止', interrupted: '已中断', running: '执行中', awaiting_confirmation: '等待确认', paused: '已暂停', stopped: '已停止', completed: '已完成', failed: '未完成' }
export default function TaskStatus({ task, message, canContinue, onContinue, onStop }: { task: TaskEvent; message?: ChatMessage; canContinue: boolean; onContinue(): void; onStop(): void }) {
  const [error, setError] = useState('')
  const [deciding, setDeciding] = useState(false)
  const decidingRef = useRef(false)
  const [acknowledged, setAcknowledged] = useState<string[]>([])
  const [resolved, setResolved] = useState<string[]>([])
  const [resolving, setResolving] = useState(false)
  const identity = `${task.conversationId}:${task.run.id}`
  const currentIdentity = useRef(identity); currentIdentity.current = identity
  const unresolved = (task.unknownCalls ?? []).filter(call => !resolved.includes(`${call.runId}:${call.callId}:${call.revision}`))
  const inactive = ['paused', 'stopped', 'failed', 'completed', 'interrupted'].includes(task.run.status)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  async function decide(decision: ApprovalDecisionInput['decision']) {
    if (!task.approval || decidingRef.current) return
    decidingRef.current = true; setDeciding(true); setError('')
    try { await window.her.decideToolApproval({ approvalId: task.approval.id, revision: task.approval.revision, decision }) }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '确认失败，请刷新任务。') }
    finally { if (alive.current) { decidingRef.current = false; setDeciding(false) } }
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
    {task.approval && <div className="task-approval" aria-label="动作确认卡">
      <p>目的：{task.approval.purpose}</p><p>操作目标：{task.approval.target}</p><p>{task.approval.summary}</p>
      {task.approval.preview.fields.map((field, index) => <p key={index}>{field.label}：{field.value}</p>)}
      {task.approval.preview.recipient && <p>收件人：{task.approval.preview.recipient}</p>}
      {task.approval.preview.finalText !== undefined && <div><strong>最终正文</strong><pre className="action-final-text">{task.approval.preview.finalText}</pre></div>}
      {task.approval.dataClasses.length > 0 && <p>涉及资料：{task.approval.dataClasses.join('、')}</p>}
      {task.approval.providerName && <p>实际传输服务：{task.approval.providerName}</p>}
      {task.approval.preview.transferDestination && <p>传输目的地：{task.approval.preview.transferDestination}</p>}
      <p>范围：{task.approval.scopeSummary}</p><p>可拒绝此步骤；需要暂缓或取消整件委托时，请使用委托卡。已发生的操作不会撤销。</p>
      <details><summary>技术记录</summary><p>运行 {task.approval.runId} · 调用 {task.approval.callId} · 版本 {task.approval.revision}</p></details>
      <button className="secondary-button" disabled={deciding} onClick={() => void decide('approve')}>{task.approval.actionLabel}</button>
      <button className="secondary-button" disabled={deciding} onClick={() => void decide('reject')}>拒绝这次操作</button>
    </div>}
    {['running', 'awaiting_confirmation', 'waiting_approval', 'waiting_resource', 'compacting', 'retrying', 'stopping'].includes(task.run.status) && <button className="secondary-button" onClick={onStop}>停止任务</button>}
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

function ScopeDetails({ scope }: { scope: import('../../shared/types').DelegationScopeView }) {
  return <div className="delegation-scope"><p>目的：{scope.purpose}</p><p>对象：{scope.objects.join('、')}</p>
    <p>完成条件：{scope.completion}</p><p>能力范围：{scope.allowedCapabilities.join('、')}</p>
    {scope.origins.length > 0 && <p>允许来源：{scope.origins.join('、')}</p>}
    {Object.entries(scope.constraints).map(([key, value]) => <p key={key}>{key}：{value}</p>)}
  </div>
}

/** Mounted only after WorkspaceService has selected the original work topic. */
export function DelegationCards({ conversationId, refreshKey }: { conversationId: string; refreshKey: string }) {
  const [details, setDetails] = useState<import('../../shared/types').DelegationDetails | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [tick, setTick] = useState(0)
  const generation = useRef(0), acting = useRef(false)
  useEffect(() => {
    const current = ++generation.current
    setDetails(null); setBusy(false); acting.current = false
    void window.her.getDelegationDetails(conversationId).then(value => {
      if (current === generation.current && value.conversationId === conversationId) setDetails(value)
    }).catch(cause => { if (current === generation.current) setError(cause instanceof Error ? cause.message : '卡片读取失败，请重新进入话题。') })
    return () => { generation.current++ }
  }, [conversationId, refreshKey, tick])
  async function act(action: () => Promise<void>) {
    if (acting.current) return
    acting.current = true; setBusy(true); setError('')
    const current = generation.current
    try { await action() }
    catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : '卡片已变化，请重新核对。') }
    finally { if (current === generation.current) { acting.current = false; setBusy(false); setTick(value => value + 1) } }
  }
  if (!details || details.conversationId !== conversationId) return error ? <p role="alert">{error}</p> : null
  return <section className="delegation-cards" aria-label="原话题委托卡">
    {details.scopes.map(scope => <div className="task-approval" key={scope.id} aria-label="委托范围确认"><ScopeDetails scope={scope.scope} />
      <p>确认仅授予以上范围。付款、预订、提交资料等动作仍需逐次确认；可在委托卡暂缓或取消。</p>
      <button className="secondary-button" disabled={busy} onClick={() => void act(() => window.her.approveDelegationScope(scope.id, scope.revision))}>确认此委托范围</button>
      <button className="secondary-button" disabled={busy} onClick={() => void act(() => window.her.rejectDelegationScope(scope.id, scope.revision))}>拒绝此范围</button>
    </div>)}
    {details.delegations.map(delegation => <div className="task-approval" key={delegation.id} aria-label="委托控制卡">
      <p>委托状态：{{ active: '进行中', paused: '已暂缓', cancelled: '已取消', completed: '已完成' }[delegation.status]}{delegation.resumeRequired ? ' · 等待明确继续' : ''}</p>
      <ScopeDetails scope={delegation.scope} />
      {['active', 'paused'].includes(delegation.status) && <>
        <p>授权不代表系统权限或工具已就绪。缺少能力时等待就绪；重启后仍需明确继续。取消或暂缓不会撤销已发生的操作。</p>
        {delegation.status === 'active' && <button className="secondary-button" disabled={busy} onClick={() => void act(() => window.her.pauseDelegation(delegation.id, delegation.revision))}>暂缓委托</button>}
        <button className="secondary-button" disabled={busy} onClick={() => void act(() => window.her.cancelDelegation(delegation.id, delegation.revision))}>取消委托</button>
        {delegation.resumeControls.length > 0 && <p>明确继续会解除这件委托已确认的整体暂停；发送限制、拒绝步骤和其他话题的控制保持有效。</p>}
        {delegation.canResume && <button className="secondary-button" disabled={busy} onClick={() => void act(() => window.her.resumeDelegation(delegation.id, delegation.revision, delegation.resumeControls))}>明确继续委托</button>}
      </>}
    </div>)}
    {details.controls.map(control => {
      const binding = { conversationId, controlId: control.id, revision: control.revision }
      const choice = control.kind === 'uncertain' ? 'pause' : control.kind
      return <div className="task-approval" key={control.id} aria-label="原话题控制确认">
        <p>请核对当前话题的控制对象。其他话题仍保留各自的待处理状态。</p>
        {control.hasOwnedInputs && <p>此控制还阻塞了本话题的普通输入。下方解除按钮只移除此控制对本卡列出委托及本话题普通输入的阻塞；其他控制、话题、委托状态及拒绝步骤保持有效。</p>}
        {control.candidates.map(candidate => <div key={candidate.delegationId}>
          <p>{candidate.purpose}</p>
          {candidate.currentRevision !== candidate.scopeRevision && <p>委托版本已变化，请核对当前范围。解除此控制只移除此处阻塞，原有范围、拒绝与动作确认继续有效。</p>}
          {control.kind === 'withdraw' ? candidate.denials.map(denial => {
            const selected = control.selection?.delegationId === candidate.delegationId && control.selection.denialId === denial.id
            return <div key={denial.id}><p>已拒绝步骤：{denial.businessEffect ?? denial.capability}</p><p>对象：{denial.target}</p><p>涉及资料：{denial.dataClasses.join('、') || '未声明'}</p>
              {selected ? <><p>明确撤回只修改这一步的拒绝，不会立即执行。之后仍需明确继续，特殊动作仍需新确认。</p>
                <button className="secondary-button" disabled={busy || candidate.currentRevision !== candidate.scopeRevision} onClick={() => void act(() => window.her.confirmDelegationDenial(binding))}>明确撤回此步骤的拒绝</button></>
                : <button className="secondary-button" disabled={busy || candidate.currentRevision !== candidate.scopeRevision} onClick={() => void act(() => window.her.prepareDelegationDenial({ ...binding, delegationId: candidate.delegationId, scopeRevision: candidate.scopeRevision, denialId: denial.id }))}>选择此拒绝步骤</button>}
            </div>
          }) : !control.resolution && <button className="secondary-button" disabled={busy || candidate.currentRevision !== candidate.scopeRevision || (choice === 'revise' && control.budget === undefined)} onClick={() => void act(() => window.her.resolveDelegationControl({ ...binding, kind: choice as 'pause' | 'cancel' | 'revise', delegationIds: [candidate.delegationId] }))}>
            {choice === 'pause' ? '暂缓这个候选' : choice === 'cancel' ? '取消这个候选' : `将此候选预算改为 ${control.budget ?? '待核实'}`}</button>}
        </div>)}
        <button className="secondary-button" disabled={busy} onClick={() => void act(() => window.her.resolveDelegationControl({ ...binding, kind: 'ordinary', delegationIds: [], candidateRevisions: control.candidates.map(candidate => ({ delegationId: candidate.delegationId, currentRevision: candidate.currentRevision })), ...(control.hasOwnedInputs ? { releaseOwnedInputs: true } : {}) }))}>{control.kind === 'withdraw' ? '保留拒绝，放弃此修改' : '此控制不针对当前话题，解除此处阻塞'}</button>
      </div>
    })}
    {error && <p role="alert">{error}</p>}
  </section>
}
