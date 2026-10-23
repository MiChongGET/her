import { execFile, type ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, open, realpath } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { extname, isAbsolute, join, relative, sep } from 'node:path'
import installGuide from '../skills/ego-browser/references/install.md?raw'
import clearingGuide from '../skills/ego-browser/references/clearing-state.md?raw'
import type { ToolResult } from '../../shared/types'
import type { ToolArtifactStore } from './artifacts'
import type { SimpleToolRegistry } from './registry'
import type { ToolExecutionContext } from './types'
import { controlledBrowserScript, type ControlledBrowserCommand } from './browser-actions'

interface EgoBrowserOptions {
  home?: string
  lifetime?: AbortSignal
  isEnabled?: () => boolean
  artifacts?: ToolArtifactStore
}

interface RuntimeGuide {
  runId: string
  cli: string
  text: string
  nextOffset: number
}

const PAGE_SIZE = 24_000
const RESOURCE = 'browser:ego-lite'
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const textResult = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })
const failure = (text: string): ToolResult => ({ ...textResult(text), isError: true })
class EgoExecutionError extends Error {}
const executionMessage = (error: unknown) => error instanceof EgoExecutionError ? error.message : 'ego-browser 执行失败。'

/** Official ego-lite skill and CLI entry point. Scripts remain exact, separately approved Node ESM. */
export class EgoBrowserTools {
  private readonly home: string
  private readonly lifetime?: AbortSignal
  private readonly isEnabled: () => boolean
  private readonly artifacts?: ToolArtifactStore
  private readonly cancelled = new AbortController()
  private readonly owned = new Map<ChildProcess, Promise<void>>()
  private readonly guides = new Map<string, RuntimeGuide>()
  private readonly registries = new Set<SimpleToolRegistry>()
  private generation = 0
  private readonly stop = () => {
    this.cancelled.abort()
    this.disable()
  }

  constructor(options: EgoBrowserOptions = {}) {
    this.home = options.home ?? homedir()
    this.lifetime = options.lifetime
    this.isEnabled = options.isEnabled ?? (() => true)
    this.artifacts = options.artifacts
    if (this.lifetime?.aborted) this.stop()
    else this.lifetime?.addEventListener('abort', this.stop, { once: true })
  }

  register(registry: SimpleToolRegistry): void {
    this.registries.add(registry)
    const shared = { isAvailable: () => !this.cancelled.signal.aborted && this.isEnabled(), resources: () => [RESOURCE], deferDispatch: true }
    registry.register({
      name: 'ego_browser_guide',
      description: 'Read the official ego-browser runtime guide before any browser script. Start at offset 0 and continue with each nextOffset until complete. Installation and clearing-state references are also available.',
      parameters: { type: 'object', properties: {
        document: { type: 'string', enum: ['runtime', 'install', 'clearing-state'] },
        offset: { type: 'integer', minimum: 0 }
      }, additionalProperties: false }
    }, (args, context) => this.readGuide(args, context), {
      ...shared, assess: async args => ({ effect: 'read', target: `${RESOURCE}:guide`, summary: `读取 ego-browser 官方说明：${args.document ?? 'runtime'}` })
    })
    registry.register({
      name: 'ego_browser_run',
      description: 'Run exact Node ESM code with the official ego-browser nodejs -e CLI after reading its complete runtime guide in this run. Every script requires approval. Use only the official APIs described by the guide. To return a screenshot image, print one JSON line with console.log(JSON.stringify({screenshot: await page.screenshot()})); use the default temporary path. Her attaches the PNG to the tool result. At most 4 fresh PNG images, 10 MiB each. When the task succeeds and results are obtained, finish the same TaskSpace once in the final round: console.log(JSON.stringify(await task.finish({ keep: [] }))). Check the returned result before reporting closure. Retain pages only if the user explicitly asks. Never finish on failure, stop, unknown outcome or user takeover. Protect user-created and unmanaged tabs; do not claim them for cleanup or exit the browser.',
      parameters: { type: 'object', properties: { code: { type: 'string', minLength: 1, maxLength: 32_000 } }, required: ['code'], additionalProperties: false }
    }, (args, context) => this.runScript(String(args.code), context), {
      ...shared, assess: async args => ({ effect: 'unknown', target: `${RESOURCE}:script`, summary: `执行 ego-browser Node 脚本（可操作浏览器和本机资源）：\n${args.code}` })
    })
  }

  /** Turning the skill off invalidates guides and pending launches without preventing later reenable. */
  disable(): void {
    this.generation++
    this.guides.clear()
    this.forceCloseOwnedProcesses()
    // Replace frozen tool identities so an approval from before disabling cannot revive on reenable.
    for (const registry of this.registries) this.register(registry)
  }

  forceCloseOwnedProcesses(): void {
    for (const child of this.owned.keys()) child.kill('SIGKILL')
  }

  async shutdown(): Promise<void> {
    this.stop()
    this.lifetime?.removeEventListener('abort', this.stop)
    await Promise.all(this.owned.values())
  }

  /** Main-only fixed templates used by capability probes; never accepts model code or grants automatic authority. */
  runControlled(command: ControlledBrowserCommand, context: ToolExecutionContext): Promise<ToolResult> {
    return this.runScript(controlledBrowserScript(command), context)
  }

  private assertActive(context: ToolExecutionContext, generation: number): void {
    if (context.signal.aborted || this.cancelled.signal.aborted) throw new EgoExecutionError('ego-browser 执行已取消。')
    if (!this.isEnabled() || generation !== this.generation || context.validateRuntime?.() === false) {
      throw new EgoExecutionError('ego-browser 技能已停用或设置已变更。')
    }
  }

  private async resolveCli(): Promise<string | undefined> {
    for (const candidate of [join(this.home, '.local/bin/ego-browser'), '/usr/local/bin/ego-browser', '/opt/homebrew/bin/ego-browser']) {
      try { await access(candidate, constants.X_OK); return await realpath(candidate) } catch { /* try the next fixed location */ }
    }
    return undefined
  }

  private async readGuide(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const document = String(args.document ?? 'runtime'), offset = Number(args.offset ?? 0)
    const key = context.conversationId, generation = this.generation
    if (document === 'runtime' && offset === 0) this.guides.delete(key)
    try {
      this.assertActive(context, generation)
      let guide: RuntimeGuide | undefined
      let text: string
      if (document === 'runtime') {
        if (offset === 0) {
          const cli = await this.resolveCli()
          this.assertActive(context, generation)
          if (!cli) return failure('未找到可执行的 ego-browser。请读取 install 说明完成官方安装。')
          text = await this.execute(cli, ['skill'], context, generation)
          this.assertActive(context, generation)
          if (!/^\[ego-browser:skill\] ego-browser usage guide[^\r\n]*\r?\n/.test(text) ||
              !/\r?\n\[ego-browser:skill\] end of guide[^\r\n]*\s*$/.test(text)) {
            return failure('ego-browser 未返回完整的官方运行指南，请修复安装后重新读取。')
          }
          guide = { runId: context.runId, cli, text, nextOffset: 0 }
          this.guides.set(key, guide)
        } else {
          guide = this.guides.get(key)
          if (!guide || guide.runId !== context.runId || guide.nextOffset !== offset || offset >= guide.text.length) return failure('请从 offset 0 开始，并按返回的 nextOffset 连续读取完整运行指南。')
          text = guide.text
        }
      } else text = document === 'install' ? installGuide : clearingGuide
      if (offset > text.length) return failure('说明分页位置无效，请从 offset 0 开始。')
      const end = Math.min(offset + PAGE_SIZE, text.length), complete = end === text.length
      if (guide) guide.nextOffset = end
      const nextOffset = complete ? null : end
      return { content: [
        { type: 'text', text: text.slice(offset, end) },
        { type: 'text', text: complete ? '说明已完整读取。nextOffset: null' : `继续读取 ${document}，nextOffset: ${nextOffset}` }
      ], structuredContent: { document, offset, nextOffset, complete } }
    } catch (error) {
      this.guides.delete(key)
      return failure(`无法读取 ego-browser 官方说明。${executionMessage(error)}`)
    }
  }

  private async runScript(code: string, context: ToolExecutionContext): Promise<ToolResult> {
    const generation = this.generation, key = context.conversationId
    try {
      this.assertActive(context, generation)
      const guide = this.guides.get(key)
      if (!guide || guide.runId !== context.runId || guide.nextOffset !== guide.text.length) return failure('请先在当前会话的本次任务中连续读取完整 ego-browser 运行指南。')
      const cli = await this.resolveCli()
      this.assertActive(context, generation)
      if (!cli || cli !== guide.cli || this.guides.get(key) !== guide) {
        this.guides.delete(key)
        return failure('ego-browser 程序或运行指南已变化，请重新读取完整运行指南。')
      }
      const startedAt = Date.now()
      const stdout = await this.execute(cli, ['nodejs', '-e', code], context, generation, () => context.markDispatched?.('action'))
      this.assertActive(context, generation)
      return await this.scriptResult(stdout, startedAt, context, generation)
    } catch (error) {
      return failure(`${executionMessage(error)}若动作已派发，其结果未知，请确认实际状态后处理，禁止自动重试。`)
    }
  }

  private async scriptResult(stdout: string, startedAt: number, context: ToolExecutionContext, generation: number): Promise<ToolResult> {
    const paths: unknown[] = [], text: string[] = []
    for (const line of stdout.split(/(?<=\n)/)) {
      let parsed: unknown
      try { parsed = JSON.parse(line) } catch { text.push(line); continue }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length === 1 && 'screenshot' in parsed) paths.push(parsed.screenshot)
      else text.push(line)
    }
    if (!paths.length) return textResult(stdout || 'ego-browser 脚本执行完成，没有文本输出。')
    if (!this.artifacts) return failure('ego-browser 截图需要可用的图片存储。脚本已派发，请确认实际状态，禁止自动重试。')
    try {
      if (paths.length > 4) throw new Error('too many screenshots')
      const root = await realpath(tmpdir()), images: Buffer[] = []
      for (const path of paths) {
        this.assertActive(context, generation)
        if (typeof path !== 'string' || !isAbsolute(path) || extname(path).toLowerCase() !== '.png') throw new Error('invalid screenshot path')
        const source = await lstat(path), canonical = await realpath(path)
        const within = relative(root, canonical)
        if (!source.isFile() || !within || within === '..' || within.startsWith('..' + sep) || isAbsolute(within)) throw new Error('screenshot outside temp')
        const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const before = await file.stat()
          if (!before.isFile() || before.dev !== source.dev || before.ino !== source.ino || before.size > MAX_IMAGE_BYTES || before.mtimeMs + 100 < startedAt) throw new Error('invalid screenshot file')
          const bytes = Buffer.alloc(before.size + 1)
          let count = 0
          while (count < bytes.length) {
            this.assertActive(context, generation)
            const chunk = await file.read(bytes, count, bytes.length - count, count)
            if (!chunk.bytesRead) break
            count += chunk.bytesRead
          }
          const after = await file.stat()
          if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('invalid screenshot bytes')
          images.push(bytes.subarray(0, count))
        } finally { await file.close() }
      }
      const result: ToolResult = { content: text.join('') ? [{ type: 'text', text: text.join('') }] : [] }
      for (const bytes of images) {
        this.assertActive(context, generation)
        const reference = await this.artifacts.put(bytes, { conversationId: context.conversationId }, 'image/png', context)
        this.assertActive(context, generation)
        result.content.push({ type: 'image', artifactId: reference.id, mimeType: 'image/png' })
      }
      return result
    } catch (error) {
      if (error instanceof EgoExecutionError) return failure(`${error.message}脚本已派发，请确认实际状态，禁止自动重试。`)
      return failure('ego-browser 截图无法导入：仅接受本次调用生成的系统临时目录内 PNG 文件，最多 4 张且每张不超过 10 MiB。脚本已派发，请确认实际状态，禁止自动重试。')
    }
  }

  private execute(cli: string, args: string[], context: ToolExecutionContext, generation: number, dispatch?: () => void): Promise<string> {
    this.assertActive(context, generation)
    return new Promise((resolve, reject) => {
      dispatch?.()
      this.assertActive(context, generation)
      const timeout = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; timeout.abort() }, 45_000)
      const signal = AbortSignal.any([context.signal, this.cancelled.signal, timeout.signal])
      let child: ChildProcess
      try {
        child = execFile(cli, args, { encoding: 'utf8', killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
          signal, env: { HOME: this.home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } }, (error, stdout, stderr) => {
          clearTimeout(timer)
          if (error) {
            const message = context.signal.aborted || this.cancelled.signal.aborted ? 'ego-browser 执行已取消。'
              : !this.isEnabled() || generation !== this.generation ? 'ego-browser 技能已停用或设置已变更。'
              : timedOut ? 'ego-browser 执行超时（45 秒），已终止本地进程。'
              : error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'ego-browser 输出超过 4 MiB 限制。'
              : typeof error.code === 'number' && Number.isInteger(error.code) ? `ego-browser 异常退出（退出码 ${error.code}）。`
              : ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ENOEXEC', 'EMFILE', 'ENFILE', 'EAGAIN'].includes(String(error.code)) ? '无法启动 ego-browser 本地程序。'
              : error.signal ? 'ego-browser 子进程被终止。' : 'ego-browser 执行失败。'
            reject(new EgoExecutionError(message)); return
          }
          // The official nodejs CLI forwards console output on stderr, even when execution succeeds.
          resolve(args[0] === 'nodejs' && stderr ? stdout + (stdout && !stdout.endsWith('\n') ? '\n' : '') + stderr : stdout)
        })
      } catch {
        clearTimeout(timer)
        reject(new EgoExecutionError('无法启动 ego-browser 本地程序。'))
        return
      }
      this.owned.set(child, new Promise<void>(closed => child.once('close', () => { this.owned.delete(child); closed() })))
      // nodejs -e also reads stdin; EOF is required before the official CLI evaluates the script.
      child.stdin?.end()
    })
  }
}
