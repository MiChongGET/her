interface ShutdownDependencies {
  lifetime: AbortController
  stop(): void
  drain(): Promise<unknown>
  forceClose(): void
  close(): void
}

/** One deadline for the whole quit; lifetime fences remain active after DB close. */
export function createShutdown(deps: ShutdownDependencies): () => Promise<void> {
  let pending: Promise<void> | undefined
  return () => {
    if (pending) return pending
    deps.lifetime.abort(new Error('应用正在退出。'))
    deps.stop()
    pending = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          deps.drain().catch(() => {}),
          new Promise<void>(resolve => { timer = setTimeout(resolve, 5000) })
        ])
      } finally {
        clearTimeout(timer)
        deps.forceClose()
        deps.close()
      }
    })()
    return pending
  }
}
