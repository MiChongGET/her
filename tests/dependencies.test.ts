import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { PresetDependencies } from '../src/core/mcp/dependencies'
import { PRESETS, PEEKABOO_ARGS, PEEKABOO_ENV } from '../src/core/mcp/presets'
import { McpConnectionManager } from '../src/core/mcp/manager'
import { McpConfigService } from '../src/core/mcp/config'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import { ToolArtifactStore } from '../src/core/tools/artifacts'
import { HerStore } from '../src/core/storage/store'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })))
function setup(output = 'Peekaboo 4.9.3', granted: boolean | string[] = true) {
  const home = mkdtempSync(join(tmpdir(), 'her-dependency-')); dirs.push(home)
  const path = join(home, '.local/share/her/dependencies/peekaboo-4.9.3/peekaboo')
  mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, 'fake-native', { mode: 0o755 })
  const calls: string[][] = []
  const deps = new PresetDependencies({ home, verifyNative: async () => true, run: async (_path, args) => {
    calls.push(args)
    return args[0] === '--version' ? output : JSON.stringify({ success: true, data: { source: 'local', permissions: ['Screen Recording', 'Accessibility', 'Event Synthesizing'].map(name => ({ name, isGranted: Array.isArray(granted) ? granted.includes(name) : granted })) } })
  } })
  return { deps, calls, path, home }
}
it('has three MCP presets without browser automation and keeps optional search disabled', () => {
  expect(PRESETS.map(p => p.id)).toEqual(['peekaboo', 'markitdown', 'open-websearch'])
  expect(PRESETS.find(p => p.id === 'open-websearch')?.defaultEnabled).toBe(false)
})
it('resolves fixed absolute native executable without terminal PATH and probes only version/permissions', async () => {
  const { deps, calls, path } = setup()
  const checks = await deps.checkPresetDependencies('peekaboo', '')
  expect(checks.find(c => c.component === 'Peekaboo')).toMatchObject({ status: 'ready', resolvedPath: realpathSync(path), version: '4.9.3' })
  expect(calls).toEqual([['--version'], ['permissions', 'status', '--no-remote', '--json']])
})
it('reports missing commands with install guidance without launching anything', async () => {
  const { deps, calls, path } = setup(); rmSync(path)
  expect(await deps.checkPresetDependencies('peekaboo', '')).toEqual(expect.arrayContaining([expect.objectContaining({ component: 'Peekaboo', status: 'missing', message: expect.stringContaining('4.9.3') })]))
  expect(calls).toHaveLength(0)
})
it('rejects wrong binary/version before permissions or preset binding', async () => {
  const { deps, calls, path } = setup('Peekaboo 5.0.0')
  expect((await deps.checkPresetDependencies('peekaboo', ''))[0].status).toBe('incompatible')
  expect(calls).toEqual([['--version']])
  await expect(deps.verifyPeekaboo({ command: path, args: PEEKABOO_ARGS, env: PEEKABOO_ENV, transport: 'stdio' })).rejects.toThrow()
})
it('shows each actual host permission rather than trusting a previous terminal check', async () => {
  const { deps } = setup('Peekaboo 4.9.3', false)
  const checks = await deps.checkPresetDependencies('peekaboo', '')
  expect(checks.filter(c => c.status === 'permission_required').map(c => c.component)).toEqual(['Screen Recording', 'Accessibility', 'Event Synthesizing'])
})
it.each(['permissions', 'binding'] as const)('preserves actionable Peekaboo %s errors before starting MCP', async reason => {
  const { deps, path, home } = setup('Peekaboo 4.9.3', ['Screen Recording'])
  const store = new HerStore(join(home, 'db.sqlite'))
  const configs = new McpConfigService(store, { encrypt: async text => Buffer.from(text), decrypt: async bytes => bytes.toString() })
  const registry = new SimpleToolRegistry()
  const manager = new McpConnectionManager(configs, registry, new ToolArtifactStore(store), async config => {
    await deps.verifyPeekaboo(config)
    return {}
  })
  try {
    const saved = await configs.save({ name: 'Peekaboo', presetId: 'peekaboo', enabled: true, transport: 'stdio', command: path,
      args: reason === 'binding' ? [...PEEKABOO_ARGS, '--allow-temporary-clipboard'] : [...PEEKABOO_ARGS], secretValues: PEEKABOO_ENV })
    const expected = reason === 'permissions' ? /Accessibility.*Event Synthesizing.*系统设置.*辅助功能/ : /Peekaboo.*启动绑定不匹配/
    await expect(manager.connect(saved.id)).rejects.toThrow(expected)
    expect(manager.getStatus(saved.id)).toMatchObject({ state: 'error', toolCount: 0, message: expect.stringMatching(expected) })
    expect(manager.getStatus(saved.id).message).not.toMatch(/OAuth|JSON Schema|sampling/)
    expect(manager.getOwnedProcesses()).toEqual([])
    expect(registry.getDefinitions()).toEqual([])
  } finally { await manager.shutdown(); await deps.shutdown(); store.close() }
})
it('rejects forged preset binding with extra argv/env or wrapper path', async () => {
  const { deps, path } = setup()
  const config = { command: path, args: [...PEEKABOO_ARGS], env: { ...PEEKABOO_ENV }, transport: 'stdio' as const }
  await expect(deps.verifyPeekaboo(config)).resolves.toBe(realpathSync(path))
  await expect(deps.verifyPeekaboo({ ...config, args: [...config.args, '--allow-temporary-clipboard'] })).rejects.toThrow()
  await expect(deps.verifyPeekaboo({ ...config, env: { ...config.env, PEEKABOO_BRIDGE_SOCKET: '/tmp/socket' } })).rejects.toThrow()
  await expect(deps.verifyPeekaboo({ ...config, command: 'peekaboo' })).rejects.toThrow()
})
it('does not execute an unverified binary even when installed under the expected preset path', async () => {
  const { home } = setup(); let called = false
  const deps = new PresetDependencies({ home, run: async () => { called = true; return 'Peekaboo 4.9.3' } })
  expect((await deps.checkPresetDependencies('peekaboo', ''))[0].status).toBe('incompatible')
  expect(called).toBe(false)
})

import { readFileSync, existsSync } from 'node:fs'
import { createShutdown } from '../src/main/shutdown'
it('does not start a permissions probe when lifetime ends during a delayed version check', async () => {
  const { home } = setup()
  const lifetime = new AbortController()
  let release!: () => void
  let started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const calls: string[][] = []
  const deps = new PresetDependencies({ home, lifetime: lifetime.signal, verifyNative: async () => true, run: async (_path, args) => {
    calls.push(args); started(); await gate
    return args[0] === '--version' ? 'Peekaboo 4.9.3' : '{}'
  } })
  const pending = deps.checkPresetDependencies('peekaboo', '')
  const result = pending.then(() => 'completed', () => 'aborted')
  await entered; lifetime.abort(); release()
  expect(await result).toBe('aborted')
  expect(calls).toEqual([['--version']])
})
it('shutdown kills exactly its owned noncooperative probe and never starts a later stage', async () => {
  const { home, path } = setup()
  const ready = join(home, 'probe.pid'), log = join(home, 'probe.log')
  writeFileSync(path, `#!${process.execPath}\nimport fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ')+'\\n'); process.on('SIGTERM', () => {}); fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`, { mode: 0o755 })
  const lifetime = new AbortController()
  const deps = new PresetDependencies({ home, lifetime: lifetime.signal, verifyNative: async () => true })
  const pending = deps.checkPresetDependencies('peekaboo', '').then(() => 'completed', () => 'aborted')
  let pid: number | undefined
  try {
    const deadline = Date.now() + 3000
    while (!existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    pid = Number(readFileSync(ready, 'utf8'))
    process.kill(pid, 'SIGTERM'); await new Promise(resolve => setTimeout(resolve, 20))
    expect(() => process.kill(pid!, 0)).not.toThrow()
    const shutdown = createShutdown({ lifetime, stop: () => {}, drain: () => deps.shutdown(), forceClose: () => deps.forceCloseOwnedProcesses(), close: () => {} })
    await shutdown()
    expect(await pending).toBe('aborted')
    expect(() => process.kill(pid!, 0)).toThrow()
    expect(readFileSync(log, 'utf8')).toBe('--version\n')
    expect(() => process.kill(process.pid, 0)).not.toThrow()
  } finally { if (pid) try { process.kill(pid, 'SIGKILL') } catch { /* already reaped */ } }
})

it('creates pinned direct Node web presets, optional search disabled, and refuses argv/env/cwd impersonation', async () => {
  const { home } = setup()
  const node = join(home, '.local/bin/node'); mkdirSync(join(node, '..'), { recursive: true }); writeFileSync(node, 'test-node', { mode: 0o755 })
  for (const [name, version, cli] of [['open-websearch', '2.2.0', 'build/index.js']]) {
    const root = join(home, '.local/share/her/dependencies/web-tools-v1/node_modules', name)
    mkdirSync(join(root, cli, '..'), { recursive: true }); writeFileSync(join(root, 'package.json'), JSON.stringify({ name, version })); writeFileSync(join(root, cli), '// fixture')
  }
  const deps = new PresetDependencies({ home, run: async () => 'v24.14.0', verifyPackage: async () => true })
  const search = await deps.webPreset('open-websearch')
  expect(search.command).toBe(realpathSync(node)); expect(search.args).toEqual([join(home, '.local/share/her/dependencies/web-tools-v1/node_modules/open-websearch/build/index.js')])
  await expect(deps.verifyWebPreset({ ...search, env: search.secretValues }, 'open-websearch')).resolves.toBeUndefined()
  await expect(deps.verifyWebPreset({ ...search, env: search.secretValues, args: [...search.args!, '--isolated'] }, 'open-websearch')).rejects.toThrow()
  await expect(deps.verifyWebPreset({ ...search, env: { NODE_OPTIONS: '--require /tmp/code' } }, 'open-websearch')).rejects.toThrow()
  await expect(deps.verifyWebPreset({ ...search, env: search.secretValues, cwd: '/tmp' }, 'open-websearch')).rejects.toThrow()
  expect(search.enabled).toBe(false); expect(search.secretValues).toMatchObject({ MODE: 'stdio', SEARCH_MODE: 'request', ALLOWED_SEARCH_ENGINES: 'bing' })
})
it('will not trust package version metadata when the actual installed web program is different', async () => {
  const { home } = setup()
  const root = join(home, '.local/share/her/dependencies/web-tools-v1/node_modules/open-websearch')
  mkdirSync(join(root, 'build'), { recursive: true }); writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'open-websearch', version: '2.2.0' })); writeFileSync(join(root, 'build/index.js'), 'malicious code')
  const deps = new PresetDependencies({ home, run: async () => 'v24.14.0' })
  expect((await deps.checkPresetDependencies('open-websearch', '')).find(c => c.component === 'open-websearch')?.status).toBe('incompatible')
  await expect(deps.webPreset('open-websearch')).rejects.toThrow()
})
it.each([
  ['open-websearch', 'v20.18.0', 'incompatible'], ['open-websearch', 'v20.18.1', 'ready'], ['open-websearch', 'v22.0.0', 'ready']
])('checks locked runtime minimum for %s on %s', async (preset, version, status) => {
  const { home } = setup()
  const node = join(home, '.local/bin/node'); mkdirSync(join(node, '..'), { recursive: true }); writeFileSync(node, 'node', { mode: 0o755 })
  const deps = new PresetDependencies({ home, run: async () => version })
  expect((await deps.checkPresetDependencies(preset, '')).find(check => check.component === 'Node.js')?.status).toBe(status)
})
it('decorates missing diagnostics with fixed setup while retaining the diagnostic fields', async () => {
  const { home, path } = setup(); rmSync(path)
  const deps = new PresetDependencies({ home, resourcesRoot: '/Applications/Her.app/Contents/Resources' })
  const [native] = await deps.checkPresetDependencies('peekaboo', '')
  expect(native).toMatchObject({ component: 'Peekaboo', status: 'missing', message: expect.stringContaining('4.9.3'), setup: { links: [expect.objectContaining({ url: expect.stringContaining('4.9.3') })] } })
  const [document] = await deps.checkPresetDependencies('markitdown', '')
  expect(document.setup?.command).toBe("sh '/Applications/Her.app/Contents/Resources/dependencies/markitdown/install.sh'")
  await deps.shutdown()
})

it.each(['playwright', 'ego-browser'])('does not create a removed or skill-based browser MCP preset: %s', async preset => {
  const { deps, calls } = setup()
  await expect(deps.checkPresetDependencies(preset, '')).rejects.toThrow('未知预设')
  expect(calls).toHaveLength(0)
})

it('cannot confer bounded HTTP authority from a declared patched version or fixture package verifier', async () => {
  const { home } = setup()
  const root = join(home, '.local/share/her/dependencies/web-tools-v1/node_modules/open-websearch')
  mkdirSync(join(root, 'build'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'open-websearch', version: '2.2.0', herRevision: 'her-request-confinement-v1' }))
  writeFileSync(join(root, 'build/index.js'), 'not the approved patch')
  const deps = new PresetDependencies({ home, verifyPackage: async () => true })
  expect(await deps.webRequestConfinement()).toBe(false)
})
