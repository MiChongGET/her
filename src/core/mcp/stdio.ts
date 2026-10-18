import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { deserializeMessage, serializeMessage, type Transport } from '@modelcontextprotocol/client'
import { getDefaultEnvironment } from '@modelcontextprotocol/client/stdio'

// SDK 2.3.1's ReadBuffer silently skips JSON SyntaxError. The Host requires every
// stdout line to be a protocol frame, so own this small transport boundary.
export class StrictStdioTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: Transport['onmessage']
  readonly stderr = new PassThrough()
  private child?: ChildProcessWithoutNullStreams
  private closing?: Promise<void>
  private exited?: Promise<void>
  private buffer = Buffer.alloc(0)
  private started = false

  constructor(private readonly options: { command: string; args?: string[]; cwd?: string; env?: Record<string, string>; maxBufferSize: number }) {}
  get pid(): number | null { return this.child?.pid ?? null }

  async start(): Promise<void> {
    if (this.started) throw new Error('MCP transport already started')
    this.started = true
    const child = spawn(this.options.command, this.options.args ?? [], { cwd: this.options.cwd, env: { ...getDefaultEnvironment(), ...this.options.env }, stdio: 'pipe', shell: false, windowsHide: true })
    this.child = child
    this.exited = new Promise(resolve => {
      child.once('exit', () => { this.child = undefined; this.onclose?.(); resolve() })
      child.once('error', () => { this.child = undefined; resolve() })
    })
    child.stderr.pipe(this.stderr)
    child.stdin.on('error', error => this.onerror?.(error))
    child.stdout.on('error', error => this.onerror?.(error))
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.closing) return
      try {
        if (this.buffer.length + chunk.length > this.options.maxBufferSize) throw new Error('MCP frame exceeds wire limit')
        this.buffer = Buffer.concat([this.buffer, chunk])
        let end: number
        while ((end = this.buffer.indexOf(10)) !== -1) {
          const line = this.buffer.subarray(0, end).toString('utf8').replace(/\r$/, '')
          this.buffer = this.buffer.subarray(end + 1)
          this.onmessage?.(deserializeMessage(line))
        }
      } catch (error) { this.buffer = Buffer.alloc(0); this.onerror?.(error as Error); void this.close() }
    })
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  }

  async send(message: Parameters<Transport['send']>[0]): Promise<void> {
    if (!this.child || this.closing) throw new Error('MCP transport closed')
    await new Promise<void>((resolve, reject) => this.child!.stdin.write(serializeMessage(message), error => error ? reject(error) : resolve()))
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closing = (async () => {
      const child = this.child
      if (!child) return
      child.stdin.end()
      await this.waitForExit(2000)
      if (this.child === child) { child.kill('SIGTERM'); await this.waitForExit(2000) }
      if (this.child === child) { child.kill('SIGKILL'); await this.exited }
      this.buffer = Buffer.alloc(0)
      this.stderr.destroy()
    })()
    return this.closing
  }

  forceClose(): void { this.child?.kill('SIGKILL') }

  private async waitForExit(timeout: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([this.exited, new Promise<void>(resolve => { timer = setTimeout(resolve, timeout) })]) }
    finally { clearTimeout(timer) }
  }
}
