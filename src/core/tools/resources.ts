interface Waiter {
  keys: string[]
  grant: (release: () => void) => void
}

/**
 * Serializes tool steps that touch the same resource key (`desktop`, `write:<target>`, `mcp:<service>`).
 * A request holds all of its keys at once and is granted only when none is held or wanted by an earlier
 * waiter, so each key is FIFO and multi-key requests cannot deadlock. Callers acquire after approval,
 * so waiting for a person never holds a resource.
 */
export class ResourceQueue {
  private readonly held = new Set<string>()
  private waiters: Waiter[] = []

  acquire(keys: readonly string[], signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason)
    const sorted = [...new Set(keys)].sort()
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { keys: sorted, grant: release => { signal.removeEventListener('abort', cancel); resolve(release) } }
      const cancel = () => {
        this.waiters = this.waiters.filter(item => item !== waiter)
        reject(signal.reason)
        this.schedule()
      }
      signal.addEventListener('abort', cancel, { once: true })
      this.waiters.push(waiter)
      this.schedule()
    })
  }

  private schedule(): void {
    const blocked = new Set<string>()
    const remaining: Waiter[] = []
    for (const waiter of this.waiters) {
      if (waiter.keys.some(key => this.held.has(key) || blocked.has(key))) {
        for (const key of waiter.keys) blocked.add(key)
        remaining.push(waiter)
        continue
      }
      for (const key of waiter.keys) this.held.add(key)
      let released = false
      waiter.grant(() => {
        if (released) return
        released = true
        for (const key of waiter.keys) this.held.delete(key)
        this.schedule()
      })
    }
    this.waiters = remaining
  }
}
