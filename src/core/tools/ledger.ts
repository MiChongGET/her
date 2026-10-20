import type { HerStore } from '../storage/store'
import type { ActionAssessment } from '../../shared/types'

export class LedgerError extends Error {}

export type DispatchPhase = 'none' | 'preflight' | 'preflight-completed' | 'action'

/**
 * Durable record of external actions. The record is written before dispatch and a failed write stops
 * the action; an outcome that cannot be confirmed quarantines the target until it is observed or the
 * user resolves it. Nothing here replays an action.
 */
export class ActionLedger {
  constructor(private readonly store: HerStore) {}

  /** Call at start-up: a call left unsettled by a crash is unknown if it was dispatched, cancelled if not. */
  recover(): void {
    for (const call of this.store.listUnsettledToolCalls()) {
      const dispatched = call.dispatchedAt !== null && call.dispatchPhase !== 'preflight-completed'
      if (dispatched && call.effect !== 'read') {
        this.store.updateToolCall(call.taskId, call.callId, { status: 'unknown', error: '应用中断，动作结果未知。' })
        this.store.quarantineTarget(call.target, call.conversationId, call.taskId, call.callId)
      } else this.store.updateToolCall(call.taskId, call.callId, { status: 'cancelled' })
    }
  }

  assertTargetFree(assessment: ActionAssessment): void {
    if (assessment.effect !== 'read' && this.store.isTargetQuarantined(assessment.target)) {
      throw new LedgerError('这个目标上次动作的结果未知，请重新观察或由你处理后再继续。')
    }
  }

  /** Records intent. Throws if the target is quarantined, the call id was seen before, or the write fails. */
  begin(taskId: string, callId: string, toolName: string, args: Record<string, unknown>, assessment: ActionAssessment): void {
    this.assertTargetFree(assessment)
    try {
      this.store.insertToolCall({ taskId, callId, toolName, args: JSON.stringify(args), effect: assessment.effect, target: assessment.target })
    } catch { throw new LedgerError('无法写入动作记录，动作未执行。') }
  }

  /** Must succeed before the wire call; otherwise the action is not sent. */
  dispatched(taskId: string, callId: string, phase: 'preflight' | 'action'): void {
    try { this.store.updateToolCall(taskId, callId, { status: 'running', phase, dispatched: true }) }
    catch { throw new LedgerError('无法写入动作记录，动作未执行。') }
  }

  preflightCompleted(taskId: string, callId: string): void {
    this.store.updateToolCall(taskId, callId, { status: 'pending', phase: 'preflight-completed' })
  }

  succeeded(taskId: string, callId: string): void { this.store.updateToolCall(taskId, callId, { status: 'succeeded' }) }
  failed(taskId: string, callId: string, error: string): void { this.store.updateToolCall(taskId, callId, { status: 'failed', error }) }
  cancelled(taskId: string, callId: string): void { this.store.updateToolCall(taskId, callId, { status: 'cancelled' }) }

  /** Outcome unknown: isolate the target. A failed write is repaired by recover() because the row stays running. */
  unknown(taskId: string, callId: string, conversationId: string, target: string, error: string): void {
    try {
      this.store.updateToolCall(taskId, callId, { status: 'unknown', error })
      this.store.quarantineTarget(target, conversationId, taskId, callId)
    } catch { /* recover() reclassifies the still-running row on the next start */ }
  }

  /** A result that arrived after the call was already settled; recorded for review, never acted on. */
  audit(taskId: string, callId: string, late: unknown): void {
    try { this.store.auditLateResult(taskId, callId, JSON.stringify({ late: true, result: late }).slice(0, 20_000)) }
    catch { /* the store may already be closed during shutdown */ }
  }

  /** True once this target has been through an unknown outcome and released; its next interaction needs explicit approval. */
  recovered(target: string): boolean { return this.store.isTargetRecovered(target) }

  /** A successful fresh read of the same target is the only automatic way out. */
  observed(target: string): void { this.store.releaseTarget(target, 'observed') }
  resolve(target: string, resolution: 'handled' | 'abandoned'): boolean { return this.store.releaseTarget(target, resolution) }
  quarantined(): string[] { return this.store.listQuarantinedTargets() }
}
