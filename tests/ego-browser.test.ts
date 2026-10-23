import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { EgoBrowserTools } from '../src/core/tools/ego-browser'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import { ActionLedger } from '../src/core/tools/ledger'
import { ResourceQueue } from '../src/core/tools/resources'
import { ToolArtifactStore } from '../src/core/tools/artifacts'
import { HerStore } from '../src/core/storage/store'
import type { ToolExecutionContext } from '../src/core/tools/types'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close() })
const guide = (body = 'Use the official taskSpace API.') => `[ego-browser:skill] ego-browser usage guide v2.1.0\n${body}\n[ego-browser:skill] end of guide v2.1.0\n`

function fixture(text = guide(), options: { lifetime?: AbortSignal; isEnabled?: () => boolean; artifacts?: ToolArtifactStore } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'her-ego-'))
  cleanup.push(() => rmSync(home, { recursive: true, force: true }))
  const cli = join(home, '.local/bin/ego-browser')
  mkdirSync(join(home, '.local/bin'), { recursive: true })
  writeFileSync(cli, readFileSync(resolve('tests/helpers/fake-ego-cli.mjs'), 'utf8').replace('#!__NODE__', '#!' + process.execPath))
  chmodSync(cli, 0o755)
  writeFileSync(join(home, 'guide.txt'), text)
  const tools = new EgoBrowserTools({ home, ...options }), registry = new SimpleToolRegistry()
  tools.register(registry)
  cleanup.push(() => tools.shutdown())
  const context: ToolExecutionContext = { runId: 'run', conversationId: 'conversation', callId: '', signal: new AbortController().signal, authorize: async () => {} }
  const call = (name: string, args: Record<string, unknown>, overrides: Partial<ToolExecutionContext> = {}) => registry.execute(name, args, { ...context, callId: randomUUID(), ...overrides })
  const calls = () => existsSync(join(home, 'calls.jsonl')) ? readFileSync(join(home, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
  return { home, cli, tools, registry, context, call, calls }
}

it('requires a complete contiguous official guide in the same run and passes code as one exact argument', async () => {
  const f = fixture(guide('x'.repeat(48_001)))
  expect(await f.call('ego_browser_run', { code: 'console.log("blocked")' })).toMatchObject({ isError: true })
  expect(f.calls()).toEqual([])
  const first = await f.call('ego_browser_guide', {})
  expect(first.structuredContent).toMatchObject({ offset: 0, nextOffset: 24000, complete: false })
  expect(await f.call('ego_browser_guide', { offset: 48000 })).toMatchObject({ isError: true })
  expect(await f.call('ego_browser_run', { code: 'console.log("blocked")' })).toMatchObject({ isError: true })
  await f.call('ego_browser_guide', { offset: 24000 })
  expect((await f.call('ego_browser_guide', { offset: 48000 })).structuredContent).toMatchObject({ nextOffset: null, complete: true })
  expect(f.calls()).toHaveLength(1)
  const code = 'console.log("literal `backticks` $(touch INJECTED) \\\"quoted\\\" 中文")'
  const result = await f.call('ego_browser_run', { code })
  expect(result.isError).not.toBe(true)
  expect(f.calls().at(-1).args).toEqual(['nodejs', '-e', code])
  expect(result.content).toEqual([{ type: 'text', text: 'literal `backticks` $(touch INJECTED) "quoted" 中文\n' }])
  // macOS adds its own text encoding entry when Node starts.
  expect(Object.keys(f.calls().at(-1).env).filter(key => key !== '__CF_USER_TEXT_ENCODING').sort()).toEqual(['HOME', 'PATH'])
  expect(f.calls().at(-1).env).toMatchObject({ HOME: f.home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' })
  expect(await f.call('ego_browser_run', { code }, { runId: 'other-run' })).toMatchObject({ isError: true })
  expect(await f.call('ego_browser_run', { code }, { conversationId: 'other-conversation' })).toMatchObject({ isError: true })
})

it('closes CLI stdin so official nodejs -e evaluation can start after EOF', async () => {
  const f = fixture(), controller = new AbortController()
  await f.call('ego_browser_guide', {})
  const timer = setTimeout(() => controller.abort(new Error('fixture still waiting for stdin EOF')), 1000)
  try {
    const result = await f.call('ego_browser_run', { code: 'console.log("EOF reached")' }, { signal: controller.signal })
    expect(result.content).toEqual([{ type: 'text', text: 'EOF reached\n' }])
    expect(f.calls().filter(call => call.args[0] === 'nodejs')).toHaveLength(1)
  } finally { clearTimeout(timer) }
})

it('invalidates authorization when rereading or receiving an incomplete runtime guide', async () => {
  const f = fixture()
  await f.call('ego_browser_guide', {})
  writeFileSync(join(f.home, 'guide.txt'), guide('long'.repeat(10_000)))
  await f.call('ego_browser_guide', {})
  expect(await f.call('ego_browser_run', { code: 'console.log("blocked")' })).toMatchObject({ isError: true })
  writeFileSync(join(f.home, 'guide.txt'), '[ego-browser:skill] ego-browser usage guide v2.1.0\ntruncated /private/token')
  const result = await f.call('ego_browser_guide', {})
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result)).not.toContain('/private/token')
  expect(await f.call('ego_browser_run', { code: 'console.log("blocked")' })).toMatchObject({ isError: true })
})

it('reference documents preserve runtime authorization and a newer run replaces the old cached guide', async () => {
  const f = fixture()
  await f.call('ego_browser_guide', {})
  expect((await f.call('ego_browser_guide', { document: 'install' })).isError).not.toBe(true)
  expect((await f.call('ego_browser_guide', { document: 'clearing-state' })).isError).not.toBe(true)
  expect((await f.call('ego_browser_run', { code: 'console.log("document read")' })).isError).not.toBe(true)
  await f.call('ego_browser_guide', {}, { runId: 'next-run' })
  expect(await f.call('ego_browser_run', { code: 'console.log("stale")' })).toMatchObject({ isError: true })
  expect((await f.call('ego_browser_run', { code: 'console.log("current")' }, { runId: 'next-run' })).isError).not.toBe(true)
})

it('rejects invalid input and binds approval to exact code without a conversation grant', async () => {
  const f = fixture(), authorize = vi.fn<NonNullable<ToolExecutionContext['authorize']>>(async () => {})
  for (const [name, args] of [
    ['ego_browser_run', { code: '' }], ['ego_browser_run', { code: 'x'.repeat(32001) }],
    ['ego_browser_run', { code: 'x', command: 'sh' }], ['ego_browser_guide', { offset: -1 }],
    ['ego_browser_guide', { offset: 0.5 }], ['ego_browser_guide', { document: 'anything' }]
  ] as const) expect(await f.call(name, args, { authorize })).toMatchObject({ isError: true })
  expect(authorize).not.toHaveBeenCalled()
  await f.call('ego_browser_guide', {})
  const code = 'console.log("approved exactly")'
  await expect(f.call('ego_browser_run', { code }, { authorize: undefined })).rejects.toThrow('需要用户确认')
  await f.call('ego_browser_run', { code }, { authorize })
  expect(authorize.mock.calls[0][0]).toMatchObject({ effect: 'unknown', target: 'browser:ego-lite:script' })
  expect(authorize.mock.calls[0][0].summary).toContain(code)
  expect(authorize.mock.calls[0][1].approvalBinding?.allowAllOperations).toBeUndefined()
  expect(authorize.mock.calls[0][1].approvalBinding?.conversationScope).toBeUndefined()
})

it('rechecks CLI identity and enabled state immediately before dispatch', async () => {
  let enabled = true
  const f = fixture(guide(), { isEnabled: () => enabled }), dispatch = vi.fn()
  await f.call('ego_browser_guide', {})
  const replacement = join(f.home, 'replacement')
  copyFileSync(f.cli, replacement); chmodSync(replacement, 0o755)
  renameSync(f.cli, f.cli + '.old')
  const { symlinkSync } = await import('node:fs')
  symlinkSync(replacement, f.cli)
  expect(await f.call('ego_browser_run', { code: 'console.log("no")' }, { onDispatch: dispatch })).toMatchObject({ isError: true })
  expect(dispatch).not.toHaveBeenCalled()
  await f.call('ego_browser_guide', {})
  const snapshot = f.registry.snapshot()
  enabled = false
  expect(f.registry.getDefinitions()).toEqual([])
  await expect(snapshot.execute('ego_browser_run', { code: 'console.log("no")' }, { ...f.context, onDispatch: dispatch })).rejects.toThrow('失效')
  expect(dispatch).not.toHaveBeenCalled()
})

it('cancels only its own CLI and quarantines scripts across conversations without replay', async () => {
  const f = fixture(), store = new HerStore(':memory:'), ledger = new ActionLedger(store)
  cleanup.push(() => store.close())
  const conversationId = randomUUID(), runId = randomUUID(), requestId = randomUUID()
  store.createConversation(conversationId, randomUUID(), 'ego')
  store.enqueueInput(conversationId, 'go', null, requestId)
  store.createTask({ id: runId, conversationId, requestId, generation: 0, status: 'running', serviceId: 's', modelId: 'm', configRevision: 1, error: null })
  const context = { runId, conversationId, ledger, resources: new ResourceQueue() }
  await f.call('ego_browser_guide', {}, context)
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  cleanup.push(() => { unrelated.kill('SIGKILL') })
  const controller = new AbortController(), callId = randomUUID()
  const pending = f.call('ego_browser_run', { code: 'setInterval(() => {}, 1000)' }, { ...context, callId, signal: controller.signal })
  const rejected = expect(pending).rejects.toThrow('stop')
  await expect.poll(() => f.calls().length).toBe(2)
  const childPid = f.calls()[1].pid
  controller.abort(new Error('stop')); await rejected
  await expect.poll(() => { try { process.kill(childPid, 0); return true } catch { return false } }).toBe(false)
  expect(store.getToolCall(runId, callId)).toMatchObject({ status: 'unknown', dispatchPhase: 'action' })
  expect(ledger.quarantined()).toEqual(['browser:ego-lite:script'])
  await f.call('ego_browser_guide', {}, { ...context, conversationId: 'other' })
  expect(ledger.quarantined()).toEqual(['browser:ego-lite:script'])
  await expect(f.call('ego_browser_run', { code: 'console.log("no replay")' }, { ...context, conversationId: 'other' })).rejects.toThrow('结果未知')
  f.tools.forceCloseOwnedProcesses()
  expect(unrelated.exitCode).toBeNull()
  expect(() => process.kill(unrelated.pid!, 0)).not.toThrow()
  expect(f.calls().filter(call => call.args[0] === 'nodejs')).toHaveLength(1)
})

it('sanitizes CLI errors and stops active calls on lifetime shutdown', async () => {
  const lifetime = new AbortController(), f = fixture(guide(), { lifetime: lifetime.signal })
  await f.call('ego_browser_guide', {})
  const error = await f.call('ego_browser_run', { code: 'throw new Error("/private/credential secret-token")' })
  expect(error.isError).toBe(true)
  expect(JSON.stringify(error)).not.toMatch(/private|credential|secret-token/)
  const pending = f.call('ego_browser_run', { code: 'setInterval(() => {}, 1000)' })
  await expect.poll(() => f.calls().length).toBe(3)
  lifetime.abort()
  const stopped = await pending
  expect(stopped).toMatchObject({ isError: true })
  expect(JSON.stringify(stopped)).toContain('已取消')
  await f.tools.shutdown()
  expect(f.registry.getDefinitions()).toEqual([])
  expect(f.calls()).toHaveLength(3)
})

it('disabling kills active CLI calls, clears guide authorization, and permits a fresh guide after reenable', async () => {
  let enabled = true
  const f = fixture(guide(), { isEnabled: () => enabled })
  await f.call('ego_browser_guide', {})
  const pending = f.call('ego_browser_run', { code: 'setInterval(() => {}, 1000)' })
  await expect.poll(() => f.calls().length).toBe(2)
  enabled = false
  f.tools.disable()
  const disabled = await pending
  expect(disabled).toMatchObject({ isError: true })
  expect(JSON.stringify(disabled)).toContain('已停用')
  enabled = true
  expect(await f.call('ego_browser_run', { code: 'console.log("blocked")' })).toMatchObject({ isError: true })
  await f.call('ego_browser_guide', {})
  expect((await f.call('ego_browser_run', { code: 'console.log("enabled")' })).content).toEqual([{ type: 'text', text: 'enabled\n' }])
})

it('disabling invalidates a pending approval even after reenable and rereading the same run guide', async () => {
  let enabled = true, approvalRequested = false, approve!: () => void
  const approval = new Promise<void>(resolve => { approve = resolve })
  const f = fixture(guide(), { isEnabled: () => enabled })
  await f.call('ego_browser_guide', {})
  const pending = f.call('ego_browser_run', { code: 'console.log("stale approval")' }, {
    authorize: async () => { approvalRequested = true; await approval }
  })
  await expect.poll(() => approvalRequested).toBe(true)
  enabled = false
  f.tools.disable()
  enabled = true
  await f.call('ego_browser_guide', {})
  const rejected = expect(pending).rejects.toThrow('失效')
  approve()
  await rejected
  expect(f.calls().map(call => call.args)).toEqual([['skill'], ['skill']])
  expect((await f.call('ego_browser_run', { code: 'console.log("fresh approval")' })).isError).not.toBe(true)
})

it('serializes CLI execution across conversations using the shared browser resource', async () => {
  const f = fixture(), resources = new ResourceQueue(), waiting = vi.fn()
  await f.call('ego_browser_guide', {}, { resources })
  await f.call('ego_browser_guide', {}, { conversationId: 'other', resources })
  const first = f.call('ego_browser_run', { code: 'import { existsSync } from "node:fs"; while (!existsSync(process.env.HOME + "/release")) await new Promise(resolve => setTimeout(resolve, 10)); console.log("first")' }, { resources })
  await expect.poll(() => f.calls().length).toBe(3)
  const second = f.call('ego_browser_run', { code: 'console.log("second")' }, { conversationId: 'other', resources, onWaitingResources: waiting })
  await expect.poll(() => waiting.mock.calls.length).toBe(1)
  expect(f.calls()).toHaveLength(3)
  writeFileSync(join(f.home, 'release'), '')
  expect((await first).isError).not.toBe(true)
  expect((await second).isError).not.toBe(true)
  expect(waiting.mock.calls).toEqual([[true], [false]])
})

const screenshotBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

function screenshotFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'her-ego-artifacts-'))
  const store = new HerStore(join(directory, 'her.sqlite'))
  store.createConversation('conversation', randomUUID(), 'ego')
  store.createConversation('other', randomUUID(), 'other')
  cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  const artifacts = new ToolArtifactStore(store)
  cleanup.push(() => artifacts.shutdown())
  return { ...fixture(guide(), { artifacts }), artifacts, store }
}

it.each(['log', 'error'])('imports a fresh temporary screenshot from console.%s as an owned image and preserves ordinary stdout', async method => {
  const f = screenshotFixture(), path = join(f.home, 'screenshot.png')
  await f.call('ego_browser_guide', {})
  const result = await f.call('ego_browser_run', { code: `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(path)}, Buffer.from(${JSON.stringify(screenshotBytes.toString('base64'))}, "base64"));
console.log("before"); console.${method}(JSON.stringify({ screenshot: ${JSON.stringify(path)} })); console.log("after");` })
  expect(result.isError).not.toBe(true)
  expect(result.content.find(part => part.type === 'text')).toEqual({ type: 'text', text: 'before\nafter\n' })
  const image = result.content.find(part => part.type === 'image')
  expect(image).toMatchObject({ type: 'image', mimeType: 'image/png' })
  if (image?.type !== 'image') throw new Error('missing screenshot')
  expect(Buffer.from(await f.artifacts.read(image.artifactId, f.context))).toEqual(screenshotBytes)
  await expect(f.artifacts.read(image.artifactId, { ...f.context, conversationId: 'other' })).rejects.toThrow('无权')
  expect(JSON.stringify(result)).not.toContain(path)
  expect(existsSync(path)).toBe(true)
})

it('returns successful official CLI console output written to stderr', async () => {
  const f = fixture()
  await f.call('ego_browser_guide', {})
  const result = await f.call('ego_browser_run', { code: 'console.log("stdout"); console.error("@21 button Continue")' })
  expect(result.isError).not.toBe(true)
  expect(result.content).toEqual([{ type: 'text', text: 'stdout\n@21 button Continue\n' }])
})

it('reports safe exit-code, output-limit and launch failures without exposing CLI output or paths', async () => {
  const f = fixture()
  await f.call('ego_browser_guide', {})
  const exited = await f.call('ego_browser_run', { code: 'console.error("/private/credential token-secret"); process.exitCode = 27' })
  expect(exited.isError).toBe(true)
  expect(JSON.stringify(exited)).toContain('退出码 27')
  expect(JSON.stringify(exited)).not.toMatch(/private|credential|token-secret/)
  const oversized = await f.call('ego_browser_run', { code: 'process.stdout.write("x".repeat(4 * 1024 * 1024 + 1))' })
  expect(oversized.isError).toBe(true)
  expect(JSON.stringify(oversized)).toContain('输出超过 4 MiB')
  writeFileSync(f.cli, '#!/definitely-missing-ego-interpreter\n')
  const launch = await f.call('ego_browser_run', { code: 'console.log("do not expose this code")' })
  expect(launch.isError).toBe(true)
  expect(JSON.stringify(launch)).toContain('无法启动')
  expect(JSON.stringify(launch)).not.toMatch(/definitely-missing|do not expose|her-ego-/)
})

it('classifies the 45-second limit separately from cancellation without retrying the CLI', async () => {
  const f = fixture()
  await f.call('ego_browser_guide', {})
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let dispatched!: () => void
  const started = new Promise<void>(resolve => { dispatched = resolve })
  const pending = f.call('ego_browser_run', { code: 'setInterval(() => {}, 1000)' }, { onDispatch: dispatched })
  await started
  await vi.advanceTimersByTimeAsync(45_000)
  const result = await pending
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result)).toContain('超时（45 秒）')
  expect(JSON.stringify(result)).not.toContain('setInterval')
  expect(f.calls().filter(call => call.args[0] === 'nodejs').length).toBeLessThanOrEqual(1)
})

it('rejects screenshots outside canonical temp, symlinks, stale files, invalid PNGs and excessive image counts', async () => {
  const f = screenshotFixture(), outside = mkdtempSync(join(homedir(), '.her-ego-outside-'))
  cleanup.push(() => rmSync(outside, { recursive: true, force: true }))
  const outsidePath = join(outside, 'outside.png'), link = join(f.home, 'link.png'), stale = join(f.home, 'stale.png'), invalid = join(f.home, 'invalid.png')
  writeFileSync(outsidePath, screenshotBytes)
  symlinkSync(outsidePath, link)
  writeFileSync(stale, screenshotBytes); utimesSync(stale, new Date(0), new Date(0))
  writeFileSync(invalid, 'not a PNG')
  await f.call('ego_browser_guide', {})
  for (const path of [outsidePath, link, stale, invalid, 'relative.png']) {
    const result = await f.call('ego_browser_run', { code: `console.log(JSON.stringify({ screenshot: ${JSON.stringify(path)} }))` })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).not.toContain(path)
  }
  const fresh = join(f.home, 'fresh.png')
  const many = await f.call('ego_browser_run', { code: `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(fresh)}, Buffer.from(${JSON.stringify(screenshotBytes.toString('base64'))}, "base64")); for (let i = 0; i < 5; i++) console.log(JSON.stringify({ screenshot: ${JSON.stringify(fresh)} }))` })
  expect(many.isError).toBe(true)
  const oversized = await f.call('ego_browser_run', { code: `import { writeFileSync } from "node:fs"; const bytes = Buffer.alloc(10 * 1024 * 1024 + 1); Buffer.from(${JSON.stringify(screenshotBytes.toString('base64'))}, "base64").copy(bytes); writeFileSync(${JSON.stringify(fresh)}, bytes); console.log(JSON.stringify({ screenshot: ${JSON.stringify(fresh)} }))` })
  expect(oversized.isError).toBe(true)
})

it('only imports explicit one-key JSON screenshot lines and reports unavailable artifact storage clearly', async () => {
  const f = fixture()
  await f.call('ego_browser_guide', {})
  const ordinary = await f.call('ego_browser_run', { code: 'console.log(JSON.stringify({ screenshot: "/untrusted.png", other: true })); console.log("{ screenshot: \'ordinary text\' }")' })
  expect(ordinary.isError).not.toBe(true)
  expect(ordinary.content.every(part => part.type === 'text')).toBe(true)
  const image = await f.call('ego_browser_run', { code: 'console.log(JSON.stringify({ screenshot: "/untrusted.png" }))' })
  expect(image.isError).toBe(true)
  expect(JSON.stringify(image)).toContain('图片存储')
  expect(JSON.stringify(image)).not.toContain('/untrusted.png')
})
