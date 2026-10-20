export const MAX_TOOL_CALLS = 40
export const MAX_ACTIVE_MS = 600_000

export class RunLimitError extends Error {}

/**
 * Per-run budget: 40 tool calls and 10 minutes of active time. Time spent waiting for a person
 * (approval) is not active, so a prompt left open never uses up the budget.
 */
export class RunLimits {
  private calls = 0
  private activeMs = 0
  private since: number | undefined
  private timer?: ReturnType<typeof setTimeout>
  private finished = false

  constructor(private readonly onLimit: (error: RunLimitError) => void, private readonly now: () => number = Date.now,
    private readonly maxCalls = MAX_TOOL_CALLS, private readonly maxActiveMs = MAX_ACTIVE_MS) {}

  get toolCalls(): number { return this.calls }
  get elapsedMs(): number { return this.activeMs + (this.since === undefined ? 0 : this.now() - this.since) }

  start(): void { this.resume() }

  /** Counts a call before it is dispatched; the call over the limit is refused and never runs. */
  attempt(): void {
    if (this.calls >= this.maxCalls) throw new RunLimitError(`已达到 ${this.maxCalls} 次工具调用上限，可以继续任务。`)
    this.calls++
  }

  pause(): void {
    if (this.since === undefined) return
    this.activeMs += this.now() - this.since
    this.since = undefined
    clearTimeout(this.timer)
  }

  resume(): void {
    if (this.finished || this.since !== undefined) return
    this.since = this.now()
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.pause()
      this.onLimit(new RunLimitError('已达到 10 分钟活动时间上限，可以继续任务。'))
    }, Math.max(0, this.maxActiveMs - this.activeMs))
  }

  stop(): void { this.pause(); this.finished = true }
}
