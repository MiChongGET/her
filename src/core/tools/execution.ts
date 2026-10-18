import type { ApprovalRequest, TaskRun, ToolCallRecord, ToolResult } from '../../shared/types'
import { HerStore } from '../storage/store'
import { ApprovalError, ToolApprovalService } from './approval'
import type { ToolRegistry } from './types'
import type { CollectedToolCall } from './result-format'

export class TaskPausedError extends Error {}

export class TaskExecution {
  readonly signal: AbortSignal
  private readonly deadline = new AbortController()
  private timer?: ReturnType<typeof setTimeout>
  private activeSince = performance.now()
  private waiting = false
  private finished = false
  private activeRecord?: ToolCallRecord
  private readonly records: ToolCallRecord[] = []
  private readonly unknownTargets: Set<string>
  private readonly recoveryTargets: Set<string>

  constructor(
    readonly run: TaskRun,
    private readonly store: HerStore,
    readonly tools: ToolRegistry,
    private readonly approvals: ToolApprovalService,
    parentSignal: AbortSignal,
    private readonly changed: (record?: ToolCallRecord, approval?: ApprovalRequest) => void,
    unknownTargets: string[] = [],
    private readonly validateRuntime: () => boolean = () => true,
    private readonly modelSupportsVision?: boolean,
  ) {
    this.signal = AbortSignal.any([parentSignal, this.deadline.signal])
    this.unknownTargets = new Set(unknownTargets)
    this.recoveryTargets = new Set([...unknownTargets, ...store.getResolvedToolTargets(run.conversationId)])
    run.toolRevisions = tools.getRevisions()
    this.store.saveTaskRun(run)
    this.armDeadline()
  }

  private account(): void {
    const now = performance.now()
    if (!this.waiting) this.run.activeMs += Math.max(0, Math.floor(now - this.activeSince))
    this.activeSince = now
  }

  private armDeadline(): void {
    clearTimeout(this.timer)
    if (!this.waiting && !this.finished) this.timer = setTimeout(() => {
      this.deadline.abort(new TaskPausedError('已达到 10 分钟活动时间上限，可以继续任务。'))
    }, Math.max(0, 600_000 - this.run.activeMs))
  }

  checkBudget(): void {
    this.signal.throwIfAborted()
    this.account()
    if (this.run.activeMs >= 600_000) throw new TaskPausedError('已达到 10 分钟活动时间上限，可以继续任务。')
  }

  prepare(call: CollectedToolCall): ToolCallRecord {
    if (this.records.some(record => record.id === call.id)) throw new Error('服务返回重复的工具调用 ID，已停止这次回答。')
    const record: ToolCallRecord = { ...structuredClone(call), runId: this.run.id, status: 'pending' }
    this.records.push(record)
    this.store.saveToolCall(record)
    this.changed(record)
    return record
  }

  async execute(record: ToolCallRecord): Promise<ToolResult> {
    if (this.finished || record.status !== 'pending' || !this.records.includes(record)) throw new Error('工具调用不可重复执行。')
    if (this.activeRecord) throw new Error('任务内工具必须串行执行。')
    this.activeRecord = record
    let confirmedNoEffect = false
    try {
      this.checkBudget()
      if (this.run.toolCallsCount >= 40) throw new TaskPausedError('已达到 40 次工具调用上限，可以继续任务。')
      let observedTarget: string | undefined
      const result = await this.tools.execute(record.name, record.arguments, {
        runId: this.run.id, conversationId: this.run.conversationId, callId: record.id,
        signal: this.signal, modelSupportsVision: this.modelSupportsVision, validateRuntime: this.validateRuntime,
        authorize: async (assessment, context) => {
          record.assessment = structuredClone(assessment)
          this.store.saveToolCall(record)
          if (assessment.effect !== 'read' && this.unknownTargets.size > 0) {
            throw new TaskPausedError('上次动作结果未知，请先重新观察受影响的目标；无法确认时需要用户处理。')
          }
          if (assessment.effect === 'read' || (assessment.effect === 'interact' && context.observationValidated && !this.recoveryTargets.has(assessment.target) && !this.recoveryTargets.has('*'))) return
          await this.approvals.authorize(record.id, assessment, context)
        },
        onApproval: approval => {
          if (this.finished) return
          this.account()
          this.waiting = !!approval
          this.run.status = approval ? 'awaiting_confirmation' : 'running'
          record.status = approval ? 'awaiting_confirmation' : 'pending'
          this.store.saveToolCall(record)
          this.store.saveTaskRun(this.run)
          this.armDeadline()
          this.changed(record, approval)
        },
        onObserved: target => { if (!this.finished && !this.signal.aborted && this.validateRuntime()) observedTarget = target },
        onNoEffect: () => { this.checkBudget(); confirmedNoEffect = true },
        onAttempt: () => {
          this.checkBudget()
          this.run.toolCallsCount++
          this.store.saveTaskRun(this.run)
        },
        onPreflightComplete: () => {
          this.checkBudget()
          record.dispatchPhase = 'preflight-completed'
          record.status = 'pending'
          this.store.saveToolCall(record)
          this.changed(record)
        },
        onDispatch: (assessment, phase) => {
          this.checkBudget()
          record.assessment = structuredClone(assessment)
          record.status = 'running'
          record.startedAt = new Date().toISOString()
          if (phase) record.dispatchPhase = phase
          this.store.saveToolCall(record)
          this.store.saveTaskRun(this.run)
          this.changed(record)
        }
      })
      this.signal.throwIfAborted()
      record.result = result
      record.status = result.isError ? (record.startedAt && !confirmedNoEffect && record.dispatchPhase !== 'preflight-completed' && record.assessment?.effect !== 'read' ? 'unknown' : 'failed') : 'succeeded'
      if (record.status === 'unknown' && record.dispatchPhase === 'preflight') result.content.push({ type: 'text', text: '观察预检可能已关闭或重建崩溃标签，结果未知；最终动作未派发。请人工核对并通过任务入口处理，禁止自动重试。' })
      if (record.status === 'unknown') {
        this.unknownTargets.add(record.assessment?.target ?? '*')
        this.recoveryTargets.add(record.assessment?.target ?? '*')
      }
      if (record.status === 'succeeded' && record.assessment?.effect === 'read') {
        if (observedTarget && this.validateRuntime()) record.assessment.target = observedTarget
        this.unknownTargets.delete(record.assessment.target)
      }
      return result
    } catch (error) {
      if (this.finished) throw error
      record.status = record.startedAt && !confirmedNoEffect && record.dispatchPhase !== 'preflight-completed' && record.assessment?.effect !== 'read' ? 'unknown'
        : this.signal.aborted || error instanceof ApprovalError || error instanceof TaskPausedError ? 'cancelled' : 'failed'
      if (record.status === 'unknown') {
        this.unknownTargets.add(record.assessment?.target ?? '*')
        this.recoveryTargets.add(record.assessment?.target ?? '*')
      }
      record.result = { isError: true, content: [{ type: 'text', text: record.status === 'unknown' ? (record.dispatchPhase === 'preflight' ? '浏览器预检可能已关闭或重建崩溃标签，结果未知；最终动作未派发。' : '动作已派发但结果未知；禁止自动重放。') : error instanceof Error ? error.message : '动作已停止。' }] }
      throw error
    } finally {
      this.activeRecord = undefined
      if (!this.finished) {
        record.finishedAt = new Date().toISOString()
        this.store.saveToolCall(record)
        this.changed(record)
      }
    }
  }

  hasUnknownResults(): boolean { return this.unknownTargets.size > 0 }

  finish(status: TaskRun['status']): void {
    if (this.finished) return
    this.account()
    this.finished = true
    clearTimeout(this.timer)
    this.run.status = status
    for (const record of this.records) {
      if (record.status === 'pending' || record.status === 'awaiting_confirmation' || record.status === 'running') {
        record.status = record.status === 'running' && record.assessment?.effect !== 'read' ? 'unknown' : 'cancelled'
        record.finishedAt = new Date().toISOString()
        this.store.saveToolCall(record)
      }
    }
    this.store.saveTaskRun(this.run)
    this.changed()
  }
}
