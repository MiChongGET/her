export interface SseEvent {
  event: string
  data: string
}

export async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  beginRead: () => void,
  endRead: () => void
): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let event = ''
  let data: string[] = []
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })

  function line(value: string): SseEvent | undefined {
    if (!value) {
      const result = data.length ? { event, data: data.join('\n') } : undefined
      event = ''
      data = []
      return result
    }
    if (value.startsWith(':')) return
    const colon = value.indexOf(':')
    const field = colon < 0 ? value : value.slice(0, colon)
    const content = colon < 0 ? '' : value.slice(colon + 1).replace(/^ /, '')
    if (field === 'data') data.push(content)
    if (field === 'event') event = content
  }

  try {
    while (true) {
      signal.throwIfAborted()
      beginRead()
      let result: ReadableStreamReadResult<Uint8Array>
      try { result = await reader.read() } finally { endRead() }
      signal.throwIfAborted()
      buffer += result.done ? decoder.decode() : decoder.decode(result.value, { stream: true })
      while (true) {
        const boundary = /\r\n|\r|\n/.exec(buffer)
        if (!boundary || (!result.done && boundary[0] === '\r' && boundary.index === buffer.length - 1)) break
        const parsed = line(buffer.slice(0, boundary.index))
        buffer = buffer.slice(boundary.index + boundary[0].length)
        if (parsed) yield parsed
      }
      if (result.done) {
        if (buffer) line(buffer)
        const parsed = line('')
        if (parsed) yield parsed
        return
      }
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
