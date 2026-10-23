import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { PendingActionNotice } from '../shared/types'

/** Only current, content-free host fingerprints are retained. Mark before dispatch. */
export class DeliveryState {
  private delivered = new Set<string>()
  private usable = true
  constructor(private readonly path: string) {
    try {
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !/^[a-f0-9]{64}$/.test(item))) throw new Error('Invalid delivery state')
      this.delivered = new Set(value)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.usable = false }
  }
  has(key: string): boolean { return !this.usable || this.delivered.has(key) }
  retain(keys: Set<string>): void {
    if (!this.usable || ![...this.delivered].some(key => !keys.has(key))) return
    this.delivered = new Set([...this.delivered].filter(key => keys.has(key)))
    this.save()
  }
  mark(key: string, runKey: string): boolean {
    if (!this.usable) return false
    this.delivered.add(key)
    this.delivered.add(runKey)
    return this.save()
  }
  private save(): boolean {
    try {
      writeFileSync(this.path + '.tmp', JSON.stringify([...this.delivered]), { mode: 0o600 })
      renameSync(this.path + '.tmp', this.path)
      return true
    } catch { this.usable = false; return false }
  }
}
interface NotifierDependencies {
  permission(): Promise<string>
  fingerprint(notice: PendingActionNotice): string | null
  runFingerprint(notice: PendingActionNotice): string | null
  delivery: DeliveryState
  updateTray(count: number): void
  showNotification(click: () => void): () => void
  resolve(input: { id: string; version: number }): Promise<{ conversationId: string } | null>
  open(notice: PendingActionNotice): void
}
export class PendingWorkNotifier {
  private disposed = false
  private visible = true
  private current = new Map<string, PendingActionNotice>()
  private attempted = new Set<string>()
  private inFlight = new Map<string, Promise<void>>()
  private closers = new Map<string, () => void>()
  constructor(private readonly deps: NotifierDependencies) {}
  async update(items: PendingActionNotice[], windowVisible: boolean): Promise<void> {
    if (this.disposed) return
    this.visible = windowVisible
    this.current = new Map(items.flatMap(item => { const key = this.deps.fingerprint(item); return key ? [[key, item] as const] : [] }))
    const keys = new Set(this.current.keys())
    const retained = new Set(keys)
    for (const item of this.current.values()) { const runKey = this.deps.runFingerprint(item); if (runKey) retained.add(runKey) }
    this.deps.delivery.retain(retained)
    for (const key of this.attempted) if (!keys.has(key)) this.attempted.delete(key)
    for (const [key, close] of this.closers) if (!keys.has(key)) { close(); this.closers.delete(key) }
    this.deps.updateTray(items.length)
    if (windowVisible) return
    const probes: Promise<void>[] = []
    for (const [key, notice] of this.current) {
      const existing = this.inFlight.get(key)
      if (existing) { probes.push(existing); continue }
      const runKey = this.deps.runFingerprint(notice)
      if (!runKey || this.attempted.has(key) || this.deps.delivery.has(key) || (notice.status === 'paused' && this.deps.delivery.has(runKey))) continue
      this.attempted.add(key)
      const probe = this.notify(key, notice).finally(() => this.inFlight.delete(key))
      this.inFlight.set(key, probe); probes.push(probe)
    }
    await Promise.all(probes)
  }
  dispose(): void { this.disposed = true; for (const close of this.closers.values()) close(); this.closers.clear() }
  private async notify(key: string, notice: PendingActionNotice): Promise<void> {
    try {
      const permission = await this.deps.permission()
      if (this.disposed || !this.current.has(key)) return
      if (this.visible) { this.attempted.delete(key); return }
      const runKey = this.deps.runFingerprint(notice)
      if (permission !== 'authorized' || !runKey || !this.deps.delivery.mark(key, runKey)) return
      const close = this.deps.showNotification(() => { void this.open(notice) })
      this.closers.set(key, close)
    } catch { /* Unknown permission or delivery failure leaves Tray available. */ }
  }
  private async open(notice: PendingActionNotice): Promise<void> {
    if (this.disposed) return
    try {
      const target = await this.deps.resolve({ id: notice.id, version: notice.version })
      if (target && !this.disposed) this.deps.open(notice)
    } catch { /* Stale or unavailable entries cannot navigate. */ }
  }
}
