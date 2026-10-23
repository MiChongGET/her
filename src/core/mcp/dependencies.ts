import { execFile, type ChildProcess } from 'node:child_process'
import { access, readFile, realpath, readdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { createHash } from 'node:crypto'
import { abortable } from '../tools/abort'
import { McpPrerequisiteError } from './errors'
import { dependencySetup } from './dependency-setup'
import type { DependencyCheck, McpTransportConfig, SaveMcpServiceInput } from '../../shared/types'
import { PEEKABOO_ARGS, PEEKABOO_ENV, PEEKABOO_SHA256, PEEKABOO_VERSION, PRESETS, OPEN_WEBSEARCH_ENV } from './presets'

import markitdownVersions from './markitdown-versions.json'
import { MARKITDOWN_ENV, MARKITDOWN_VERSION } from './presets'
import webReleases from './web-release-integrity.json'
import webRequestPatch from '../../../resources/mcp-web-dependencies/her-request-patch.json'

type ProbeRunner = (path: string, args: string[]) => Promise<string>
interface DependencyOptions {
  home?: string
  run?: ProbeRunner
  lifetime?: AbortSignal
  resourcesRoot?: string
  verifyPackage?: (root: string, name: string) => Promise<boolean>
  verifyNative?: (path: string) => Promise<boolean>
}

// Main-process service. Never use renderer paths or the login-shell PATH to discover/launch a preset.
export class PresetDependencies {
  private readonly home: string
  private readonly runner: ProbeRunner
  private readonly cancelled = new AbortController()
  private readonly owned = new Map<ChildProcess, Promise<void>>()
  private readonly lifetime?: AbortSignal
  private readonly resourcesRoot?: string
  private readonly stop = () => {
    this.cancelled.abort(this.lifetime?.reason ?? new Error('依赖检查已停止。'))
    this.forceCloseOwnedProcesses()
  }
  private readonly verifyPackage: (root: string, name: string) => Promise<boolean>
  private readonly verifyNative: (path: string) => Promise<boolean>
  constructor(options: DependencyOptions = {}) {
    this.home = options.home ?? homedir(); this.runner = options.run ?? ((path, args) => this.executeProbe(path, args))
    this.lifetime = options.lifetime
    this.resourcesRoot = options.resourcesRoot
    if (this.lifetime?.aborted) this.stop()
    else this.lifetime?.addEventListener('abort', this.stop, { once: true })
    this.verifyPackage = options.verifyPackage ?? verifyWebPackage
    this.verifyNative = options.verifyNative ?? (async path => createHash('sha256').update(await readFile(path)).digest('hex') === PEEKABOO_SHA256)
  }
  // Diagnostic probes are read-only: kill promptly rather than let them outlive quit.
  forceCloseOwnedProcesses(): void {
    for (const child of this.owned.keys()) child.kill('SIGKILL')
  }
  async shutdown(): Promise<void> {
    this.stop()
    this.lifetime?.removeEventListener('abort', this.stop)
    await Promise.all(this.owned.values())
  }
  private async run(path: string, args: string[]): Promise<string> {
    this.cancelled.signal.throwIfAborted()
    const output = await abortable(this.runner(path, args), this.cancelled.signal)
    this.cancelled.signal.throwIfAborted()
    return output
  }
  private executeProbe(path: string, args: string[]): Promise<string> {
    this.cancelled.signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const child = execFile(path, args, { timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024,
        env: { HOME: this.home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } }, (error, stdout) => error ? reject(error) : resolve(stdout))
      this.owned.set(child, new Promise<void>(closed => child.once('close', () => { this.owned.delete(child); closed() })))
    })
  }
  nativePath(): string { return join(this.home, '.local/share/her/dependencies/peekaboo-4.9.3/peekaboo') }

  async checkPresetDependencies(presetId: string, _serviceId: string): Promise<DependencyCheck[]> {
    const checks = await this.checkDependencies(presetId)
    return checks.map(check => {
      const setup = dependencySetup(presetId, check, this.resourcesRoot)
      return setup ? { ...check, setup } : check
    })
  }

  private async checkDependencies(presetId: string): Promise<DependencyCheck[]> {
    this.cancelled.signal.throwIfAborted()
    const preset = PRESETS.find(item => item.id === presetId)
    if (!preset) throw new Error('未知预设。')
    if (presetId === 'markitdown') {
      const command = await this.executable([join(this.markitdownRoot(), 'bin/markitdown-mcp')])
      if (!command) return [{ component: 'MarkItDown', status: 'missing', message: preset.guidance }]
      try {
        if (command !== join(this.markitdownRoot(), 'bin/markitdown-mcp') || await realpath(this.markitdownRoot()) !== this.markitdownRoot() ||
            !(await readFile(command, 'utf8')).startsWith('#!' + join(this.markitdownRoot(), 'bin/python'))) throw new Error('runtime path mismatch')
        const probe = JSON.parse(await this.run(join(this.markitdownRoot(), 'bin/python'), ['-I', '-c',
          'import json,sys,platform; from importlib.metadata import distributions; import markitdown,markitdown_mcp,pandas,openpyxl,mammoth,pdfminer,pdfplumber,pptx,magika,onnxruntime; print(json.dumps({"python":platform.python_version(),"prefix":sys.prefix,"base":sys.base_prefix,"packages":{d.metadata["Name"].lower().replace("_","-").replace(".","-"):d.version for d in distributions()}}))']))
        const expected = Object.fromEntries(Object.entries(markitdownVersions).map(([name, version]) => [name.toLowerCase().replace(/[_.]+/g, '-'), version]))
        if (probe.python !== '3.13.13' || probe.prefix !== this.markitdownRoot() || String(probe.base).includes('.superpowers') ||
            Object.keys(probe.packages).length !== Object.keys(expected).length || Object.entries(expected).some(([name, version]) => probe.packages[name] !== version)) throw new Error('runtime mismatch')
        this.cancelled.signal.throwIfAborted()
        return [{ component: 'MarkItDown', status: 'ready', resolvedPath: command, version: MARKITDOWN_VERSION, message: '独立 CPython 3.13.13 与 74 个固定运行时版本及格式导入校验通过。' }]
      } catch { this.cancelled.signal.throwIfAborted(); return [{ component: 'MarkItDown', status: 'incompatible', message: preset.guidance }] }
    }
    if (presetId === 'peekaboo') {
      const resolvedPath = await this.executable([this.nativePath()])
      if (!resolvedPath) return [{ component: 'Peekaboo', status: 'missing', message: preset.guidance }]
      if (!await this.verifyNative(resolvedPath)) return [{ component: 'Peekaboo', status: 'incompatible', message: '原生二进制校验不匹配。' + preset.guidance }]
      let version: string | undefined
      try { version = (await this.run(resolvedPath, ['--version'])).match(/^Peekaboo (\d+\.\d+\.\d+)(?:\s|$)/)?.[1] } catch { this.cancelled.signal.throwIfAborted() /* non-cancellation errors reported below */ }
      if (version !== PEEKABOO_VERSION) return [{ component: 'Peekaboo', status: 'incompatible', version, message: '需要已验证的 Peekaboo 4.9.3。' }]
      const checks: DependencyCheck[] = [{ component: 'Peekaboo', status: 'ready', resolvedPath, version, message: '已校验固定发布包的原生程序；宿主为本地进程，前台输入已由 Her 启用。' }]
      try {
        const result = JSON.parse(await this.run(resolvedPath, ['permissions', 'status', '--no-remote', '--json']))
        if (result.success !== true || result.data?.source !== 'local') throw new Error('host')
        for (const name of ['Screen Recording', 'Accessibility', 'Event Synthesizing']) {
          const permission = result.data.permissions?.find((item: { name: string }) => item.name === name)
          checks.push({ component: name, status: permission?.isGranted === true ? 'ready' : 'permission_required', message: permission?.isGranted === true ? '当前 Her 子进程报告已授权；实际截图和输入仍需验证。' : '请在系统设置 → 隐私与安全性中向实际 Her 宿主授予权限，然后重新检查。' })
        }
      } catch { this.cancelled.signal.throwIfAborted(); checks.push({ component: 'macOS 权限', status: 'permission_required', message: '无法读取本地宿主权限，请检查实际 Her 的屏幕录制和辅助功能授权。' }) }
      this.cancelled.signal.throwIfAborted()
      return checks
    }
    const checks: DependencyCheck[] = []
    const components = [['Node.js', 'node', 20, 18, 1] as const]
    for (const [component, command, major, minor, patch] of components) {
      const resolvedPath = await this.executable([join(this.home, '.local/bin', command), `/opt/homebrew/bin/${command}`, `/usr/local/bin/${command}`])
      if (!resolvedPath) { checks.push({ component, status: 'missing', message: preset.guidance }); continue }
      try {
        const version = (await this.run(resolvedPath, ['--version'])).match(/(\d+)\.(\d+)\.\d+/)?.[0]
        const numbers = version?.split('.').map(Number) ?? []
        checks.push({ component, resolvedPath, version, status: numbers[0] > major || numbers[0] === major && (numbers[1] > minor || numbers[1] === minor && numbers[2] >= patch) ? 'ready' : 'incompatible', message: preset.guidance })
      } catch { this.cancelled.signal.throwIfAborted(); checks.push({ component, status: 'incompatible', message: preset.guidance }) }
    }
    checks.push({ component: 'npm', status: await this.executable(['/opt/homebrew/bin/npm', '/usr/local/bin/npm']) ? 'ready' : 'missing', message: 'npm 随 Node.js 安装；GUI 不使用终端 PATH，不会自动 npx 下载。' })
    if (presetId === 'open-websearch') {
      const names = ['open-websearch'] as const
      for (const name of names) {
        const root = join(this.webRoot(), 'node_modules', name)
        let present = false, valid = false
        try { await access(join(root, 'package.json')); present = true; valid = await this.verifyPackage(root, name) } catch { /* report missing or incompatible below */ }
        checks.push({ component: name, status: valid ? 'ready' : present ? 'incompatible' : 'missing', version: webReleases[name].version,
          ...(valid ? { resolvedPath: join(root, webReleases[name].cli) } : {}), message: valid ? '固定发布包内容校验通过；实际检索结果以工具调用为准。' : preset.guidance })
      }
    } else checks.push({ component: preset.name, status: 'incompatible', message: preset.guidance + ' 当前仅提供依赖诊断，执行适配尚未接入。' })
    this.cancelled.signal.throwIfAborted()
    return checks
  }

  async verifyPeekaboo(config: McpTransportConfig & { env?: Record<string, string> }): Promise<string> {
    this.cancelled.signal.throwIfAborted()
    if (config.transport !== 'stdio' || !config.command || !isAbsolute(config.command) || config.cwd ||
        JSON.stringify(config.args) !== JSON.stringify(PEEKABOO_ARGS) ||
        JSON.stringify(Object.entries(config.env ?? {}).sort()) !== JSON.stringify(Object.entries(PEEKABOO_ENV).sort())) throw new McpPrerequisiteError('Peekaboo 预设启动绑定不匹配，请恢复预设的命令参数和环境变量，并清空工作目录。')
    const expected = await this.executable([this.nativePath()])
    if (!expected || await realpath(config.command) !== expected) throw new McpPrerequisiteError('Peekaboo 预设原生路径未验证，请检查固定版本的安装路径。')
    const checks = await this.checkPresetDependencies('peekaboo', '')
    const permissions = checks.filter(check => check.status === 'permission_required')
    if (permissions.length) throw new McpPrerequisiteError(`Peekaboo 缺少 macOS 权限：${permissions.map(check => check.component).join('、')}。请在系统设置 → 隐私与安全性中检查屏幕录制和辅助功能，为实际运行宿主授权（开发版为 Electron，安装版为 Her），然后重新检查依赖并测试连接。`)
    if (checks.some(check => check.status !== 'ready')) throw new McpPrerequisiteError(checks.find(check => check.status !== 'ready')!.message)
    return expected
  }
  markitdownRoot(): string { return join(this.home, '.local/share/her/dependencies/markitdown-0.1.8') }
  async markitdownPreset(): Promise<SaveMcpServiceInput> {
    const [check] = await this.checkPresetDependencies('markitdown', '')
    if (check.status !== 'ready' || !check.resolvedPath) throw new Error(check.message)
    return { name: '文档读取 · MarkItDown', presetId: 'markitdown', enabled: true, transport: 'stdio', command: check.resolvedPath, args: [], secretValues: MARKITDOWN_ENV }
  }
  async verifyMarkItDown(config: McpTransportConfig & { env?: Record<string, string> }): Promise<void> {
    const expected = await this.markitdownPreset()
    if (config.transport !== 'stdio' || config.cwd || config.command !== expected.command || JSON.stringify(config.args) !== '[]' ||
        JSON.stringify(Object.entries(config.env ?? {}).sort()) !== JSON.stringify(Object.entries(MARKITDOWN_ENV).sort())) throw new Error('MarkItDown 预设路径、参数或插件配置不匹配，请重新添加预设。')
    this.cancelled.signal.throwIfAborted()
  }
  webRoot(): string { return join(this.home, '.local/share/her/dependencies/web-tools-v1') }
  async webRequestConfinement(): Promise<boolean> {
    try { return await webPackageHash(join(this.webRoot(), 'node_modules/open-websearch')) === webRequestPatch.patchedTreeSha256 } catch { return false }
  }
  async webPreset(presetId: 'open-websearch'): Promise<SaveMcpServiceInput> {
    const checks = await this.checkPresetDependencies(presetId, '')
    const required = checks.filter(check => check.component !== 'npm')
    if (required.some(check => check.status !== 'ready')) throw new Error(required.find(check => check.status !== 'ready')!.message)
    const node = required.find(check => check.component === 'Node.js')!.resolvedPath!
    const cli = required.find(check => check.component === 'open-websearch')!.resolvedPath!
    const preset = PRESETS.find(item => item.id === presetId)!
    return { name: preset.name, presetId, enabled: preset.defaultEnabled, transport: 'stdio', command: node,
      args: [cli],
      secretValues: OPEN_WEBSEARCH_ENV }
  }
  async verifyWebPreset(config: McpTransportConfig & { env?: Record<string, string> }, presetId: 'open-websearch'): Promise<void> {
    this.cancelled.signal.throwIfAborted()
    const expected = await this.webPreset(presetId)
    if (config.transport !== 'stdio' || !config.command || !isAbsolute(config.command) || config.cwd ||
        await realpath(config.command) !== expected.command || JSON.stringify(config.args) !== JSON.stringify(expected.args) ||
        JSON.stringify(Object.entries(config.env ?? {}).sort()) !== JSON.stringify(Object.entries(expected.secretValues ?? {}).sort())) throw new Error('网页预设程序、参数或环境绑定不匹配，请重新添加已验证预设。')
    this.cancelled.signal.throwIfAborted()
  }
  private async executable(paths: string[]): Promise<string | undefined> {
    for (const path of paths) try { await access(path, constants.X_OK); return await realpath(path) } catch { /* try known installation location */ }
    return undefined
  }
}

// Digest the actual published distribution, including runtime code and package metadata.
// npm's nested dependencies are outside each package tree; the installation lock fixes their resolution.
async function verifyWebPackage(root: string, name: string): Promise<boolean> {
  const release = webReleases[name as keyof typeof webReleases]
  if (!release) return false
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (metadata.name !== name || metadata.version !== release.version) return false
  const digest = await webPackageHash(root)
  return digest === release.sha256 || name === 'open-websearch' && digest === webRequestPatch.patchedTreeSha256
}

async function webPackageHash(root: string): Promise<string> {
  const rows: string[] = []
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      if (entry.isSymbolicLink()) throw new Error('Package symlinks are not verified')
      const relative = prefix + entry.name, path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path, relative + '/')
      else if (entry.isFile()) rows.push(relative + '\0' + createHash('sha256').update(await readFile(path)).digest('hex') + '\n')
      else throw new Error('Unsupported package entry')
    }
  }
  await visit(root, '')
  return createHash('sha256').update(rows.sort().join('')).digest('hex')
}
