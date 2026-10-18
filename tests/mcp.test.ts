import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { McpConnectionManager } from '../src/core/mcp/manager'
import { mcpToolName, type McpServicePolicy } from '../src/core/mcp/registry-adapter'
import { McpConfigService } from '../src/core/mcp/config'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import { ToolArtifactStore } from '../src/core/tools/artifacts'
import { HerStore } from '../src/core/storage/store'
import type { ToolExecutionContext } from '../src/core/tools/types'
import { startMockHttp, type MockOptions } from './helpers/mock-mcp'
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client'
import { ToolApprovalService } from '../src/core/tools/approval'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function setup(options: MockOptions = {}, transport: 'stdio' | 'http' = 'stdio', allowedTools?: string[], policy?: McpServicePolicy) {
  const dir = mkdtempSync(join(tmpdir(), 'her-mcp-'))
  const store = new HerStore(join(dir, 'db.sqlite'))
  cleanup.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const config = new McpConfigService(store, { encrypt: async text => Buffer.from(text), decrypt: async bytes => bytes.toString() })
  let http: Awaited<ReturnType<typeof startMockHttp>> | undefined
  if (transport === 'http') { http = await startMockHttp(options); cleanup.push(http.close) }
  const saved = await config.save({ name: 'mock', enabled: true, ...(http ? { transport: 'streamable-http' as const, url: http.url } : { transport: 'stdio' as const, command: process.execPath, args: [resolve('tests/helpers/mock-mcp.ts'), '--stdio', JSON.stringify(options)] }), secretValues: transport === 'stdio' ? { TOKEN: 'never-reveal-this-secret' } : { Authorization: options.token ?? 'private-http-header' } })
  const registry = new SimpleToolRegistry()
  const artifacts = new ToolArtifactStore(store)
  const manager = new McpConnectionManager(config, registry, artifacts, () => policy ?? ({ allowedTools }))
  cleanup.push(() => manager.shutdown())
  const conversation = store.createConversation()
  const context: ToolExecutionContext = { conversationId: conversation.id, runId: 'run', callId: 'call', signal: new AbortController().signal, authorize: async () => {} }
  return { manager, registry, config, artifacts, saved, context, http, store }
}

describe('MCP host', () => {
  it('the saved all-conversation switch skips approval for this service and disabling it invalidates old snapshots', async () => {
    const { manager, registry, config, saved, context } = await setup({}, 'http')
    const allowed = await config.save({ ...saved, expectedRevision: saved.revision, allowAllOperations: true })
    await manager.connect(saved.id)
    let prompts = 0
    const approvals = new ToolApprovalService(request => {
      prompts++; approvals.decide({ approvalId: request.id, revision: request.revision, decision: 'approve' })
    })
    const authorized = { ...context, authorize: (assessment: import('../src/shared/types').ActionAssessment, ctx: ToolExecutionContext) => approvals.authorize(ctx.callId, assessment, ctx) }
    const snapshot = registry.snapshot()
    await manager.call(saved.id, 'echo', {}, authorized)
    await manager.call(saved.id, 'echo', {}, { ...authorized, conversationId: 'another-conversation', runId: 'another-run' })
    expect(prompts).toBe(0)
    await config.save({ ...allowed, expectedRevision: allowed.revision, allowAllOperations: false })
    await expect(snapshot.execute(mcpToolName(saved.id, 'echo'), {}, authorized)).rejects.toThrow(/失效/)
    await manager.connect(saved.id)
    await manager.call(saved.id, 'echo', {}, authorized)
    expect(prompts).toBe(1)
  })

  it.each(['stdio', 'http'] as const)('discovers every page and shares connection over %s', async transport => {
    const { manager, registry, saved, context, http } = await setup({ token: 'static-token' }, transport)
    await Promise.all([manager.connect(saved.id), manager.connect(saved.id)])
    const defs = await manager.listTools(saved.id)
    expect(defs).toHaveLength(2)
    expect(new Set(defs.map(d => d.name)).size).toBe(2)
    expect(defs.every(d => /^[A-Za-z0-9_-]{1,64}$/.test(d.name))).toBe(true)
    expect(registry.getDefinitions()).toEqual(defs)
    expect(await manager.call(saved.id, 'other.name', {}, context)).toMatchObject({ content: [{ type: 'text', text: 'other' }] })
    expect(manager.getStatus(saved.id)).toMatchObject({ state: 'ready', toolCount: 2 })
    if (http) expect(http.requests.filter(r => r.method === 'initialize')).toHaveLength(1)
  })

  it('routes direct calls through schema and default unknown approval, ignoring readOnlyHint', async () => {
    const { manager, saved, context } = await setup()
    await manager.connect(saved.id)
    expect(await manager.call(saved.id, 'echo', { value: 'wrong' }, context)).toMatchObject({ isError: true })
    await expect(manager.call(saved.id, 'echo', {}, { ...context, authorize: undefined })).rejects.toThrow(/确认/)
    const effects: string[] = []
    await manager.call(saved.id, 'echo', {}, { ...context, authorize: async assessment => { effects.push(assessment.effect) } })
    expect(effects).toEqual(['unknown'])
  })

  it.each(['stdio', 'http'] as const)('stores owned images and preserves error/meta/structured data over %s', async transport => {
    const { manager, saved, context, artifacts, store } = await setup({}, transport)
    await manager.connect(saved.id)
    const result = await manager.call(saved.id, 'echo', { value: 1 }, context)
    expect(result).toMatchObject({ structuredContent: { count: 7 }, meta: { source: 'mock' }, content: [{ type: 'text', text: 'hello' }, { type: 'image', mimeType: 'image/png' }, { type: 'resource_link', uri: 'file:///private/never-read' }] })
    const image = result.content[1]; if (image.type !== 'image') throw new Error('missing image')
    expect(Buffer.from(await artifacts.read(image.artifactId, context)).toString()).toBe('image-data')
    await expect(artifacts.read(image.artifactId, { ...context, conversationId: store.createConversation().id })).rejects.toThrow(/无权/)
    expect(await manager.call(saved.id, 'echo', { value: 2 }, context)).toMatchObject({ isError: true, content: [{ text: 'failed' }] })
    const unknown = await manager.call(saved.id, 'echo', { value: 3 }, context)
    expect(unknown.isError).toBe(true)
    expect(JSON.stringify(unknown)).toMatch(/协议|内容|content|schema/i)
  })

  it('accepts an actual 10 MiB image frame and rejects the next byte', async () => {
    const { manager, saved, context, store } = await setup()
    await manager.connect(saved.id)
    const result = await manager.call(saved.id, 'echo', { value: 7 }, context)
    const image = result.content[0]; expect(image.type).toBe('image')
    if (image.type === 'image') expect(store.getArtifact(image.artifactId)?.byteLength).toBe(10 * 1024 * 1024)
    expect(await manager.call(saved.id, 'echo', { value: 8 }, context)).toMatchObject({ isError: true })
  })

  it.each([401, 403])('surfaces static HTTP auth %s without exposing credentials', async authStatus => {
    const { manager, saved } = await setup({ authStatus }, 'http')
    await expect(manager.connect(saved.id)).rejects.toThrow(/认证|授权|OAuth/)
    expect(JSON.stringify(manager.getStatus(saved.id))).not.toMatch(/private-http-header/)
    expect(manager.getStatus(saved.id)).toMatchObject({ state: 'error', toolCount: 0 })
  })

  it('fails malformed stdio before registration and bounds/redacts diagnostics', async () => {
    const { manager, saved, registry } = await setup({ invalidStdout: true })
    await expect(manager.connect(saved.id)).rejects.toThrow()
    expect(registry.getDefinitions()).toEqual([])
    const status = JSON.stringify(manager.getStatus(saved.id))
    expect(status).not.toContain('never-reveal-this-secret')
    expect(status.length).toBeLessThan(5000)
    expect(manager.getStatus(saved.id).state).toBe('error')
  })

  it('rejects duplicate remote names without leaving partial registration', async () => {
    const { manager, saved, registry } = await setup({ duplicate: true })
    await expect(manager.connect(saved.id)).rejects.toThrow(/重复|冲突/)
    expect(registry.getDefinitions()).toEqual([])
  })

  it('reports stale observation refusal without misclassifying it as duplicate tool names', async () => {
    const { manager, saved, context, http } = await setup({}, 'http', undefined, {
      execute: async () => { throw new Error('观察已失效或目标发生变化，请重新观察后再决定，不能重复未知动作。') }
    })
    await manager.connect(saved.id)
    const result = await manager.call(saved.id, 'echo', {}, context)
    expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/观察已失效.*重新观察/) }] })
    expect(JSON.stringify(result)).not.toMatch(/工具名称重复|工具名称冲突/)
    expect(http!.requests.filter(request => request.method === 'tools/call')).toHaveLength(0)
  })

  it('does not expose details appended to a stale observation diagnostic', async () => {
    const { manager, saved, context } = await setup({}, 'http', undefined, {
      execute: async () => { throw new Error('观察已失效或目标发生变化，请重新观察后再决定，不能重复未知动作。 private-runtime-secret') }
    })
    await manager.connect(saved.id)
    const result = await manager.call(saved.id, 'echo', {}, context)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).not.toContain('private-runtime-secret')
  })

  it.each([
    ['Chrome 观察已失效，请重新读取页面或标签列表；不要重复未知动作。', /Chrome.*观察已失效/],
    ['MCP 工具清单已失效。', /工具清单.*失效/]
  ] as const)('preserves the fixed browser or catalog diagnostic: %s', async (message, expected) => {
    const { manager, saved, context } = await setup({}, 'http', undefined, { execute: async () => { throw new Error(message) } })
    await manager.connect(saved.id)
    expect(await manager.call(saved.id, 'echo', {}, context)).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(expected) }] })
  })

  it('identifies an SDK timeout without exposing its details or suggesting a protocol failure', async () => {
    const { manager, saved, context } = await setup({}, 'http', undefined, {
      execute: async () => { throw new SdkError(SdkErrorCode.RequestTimeout, 'private-runtime-secret') }
    })
    await manager.connect(saved.id)
    const result = await manager.call(saved.id, 'echo', {}, context)
    expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/超时.*Chrome.*扩展/) }] })
    expect(JSON.stringify(result)).not.toMatch(/private-runtime-secret|JSON Schema|OAuth/)
  })

  it('redacts untrusted discovery errors even when they resemble preset diagnostics', async () => {
    const { manager, saved } = await setup({}, 'http', undefined, {
      parameters: () => { throw new Error('Peekaboo 权限检查失败 private-runtime-secret') }
    })
    await expect(manager.connect(saved.id)).rejects.toThrow(/MCP.*协议/)
    expect(JSON.stringify(manager.getStatus(saved.id))).not.toContain('private-runtime-secret')
  })

  it('allowlist excludes advertisement and direct dispatch', async () => {
    const { manager, saved, context } = await setup({}, 'stdio', ['echo'])
    await manager.connect(saved.id)
    expect(await manager.listTools(saved.id)).toHaveLength(1)
    await expect(manager.call(saved.id, 'other.name', {}, context)).rejects.toThrow()
  })

  it('config changes synchronously invalidate snapshots and pending approval before disconnect', async () => {
    const { manager, config, saved, context, registry } = await setup()
    await manager.connect(saved.id)
    const snapshot = registry.snapshot()
    let release!: () => void
    let entered!: () => void
    const ready = new Promise<void>(r => { entered = r })
    const pending = snapshot.execute(snapshot.getDefinitions()[0].name, {}, { ...context, authorize: async () => { entered(); await new Promise<void>(r => { release = r }) } })
    await ready
    await config.save({ ...saved, expectedRevision: saved.revision, enabled: false })
    expect(registry.getDefinitions()).toEqual([])
    release()
    await expect(pending).rejects.toThrow(/失效/)
    expect(manager.getStatus(saved.id).state).toBe('disconnected')
  })

  it('late initialize cannot register after config replacement', async () => {
    const { manager, config, saved, registry } = await setup({ initDelay: 150 })
    const pending = manager.connect(saved.id)
    const rejected = expect(pending).rejects.toThrow()
    await new Promise(r => setTimeout(r, 40))
    await config.save({ ...saved, expectedRevision: saved.revision, enabled: false })
    await rejected
    expect(registry.getDefinitions()).toEqual([])
  })

  it.each(['stdio', 'http'] as const)('changed catalogs invalidate old snapshots over %s', async transport => {
    const { manager, saved, registry, context } = await setup({}, transport)
    await manager.connect(saved.id)
    const snapshot = registry.snapshot()
    await manager.call(saved.id, 'echo', { value: 4 }, context)
    await expect.poll(() => registry.getRevisions()).not.toEqual(snapshot.getRevisions())
    await expect(snapshot.execute(snapshot.getDefinitions()[0].name, {}, context)).rejects.toThrow(/失效/)
    expect(await manager.listTools(saved.id)).toHaveLength(2)
    await expect(manager.call(saved.id, 'echo', {}, context)).rejects.toThrow()
    expect(await manager.call(saved.id, 'new-tool', {}, context)).toMatchObject({ content: [{ text: 'other' }] })
  })

  it('revalidates an unchanged list notification without losing the in-flight result or replaying the call', async () => {
    const { manager, saved, registry, context } = await setup({ catalogChange: 'none' })
    await manager.connect(saved.id)
    const snapshot = registry.snapshot()
    const revisions = snapshot.getRevisions()
    expect(await manager.call(saved.id, 'echo', { value: 4 }, context)).toMatchObject({ content: [{ text: 'changed' }] })
    expect(manager.getStatus(saved.id)).toMatchObject({ state: 'ready', toolCount: 2 })
    expect(registry.getRevisions()).toEqual(revisions)
    expect(await snapshot.execute(mcpToolName(saved.id, 'echo'), {}, context)).toMatchObject({ content: [{ text: '2' }] })
  })

  it('invalidates an old approval when the notified catalog changes a schema under the same tool name', async () => {
    const { manager, saved, registry, context } = await setup({ catalogChange: 'schema' })
    await manager.connect(saved.id)
    const snapshot = registry.snapshot()
    const oldCall = snapshot.execute(mcpToolName(saved.id, 'echo'), {}, { ...context, authorize: async () => {
      await manager.call(saved.id, 'echo', { value: 4 }, context)
    } })
    await expect(oldCall).rejects.toThrow(/失效/)
    await manager.listTools(saved.id)
    expect(await manager.call(saved.id, 'echo', { value: 1 }, context)).toMatchObject({ isError: true })
    expect(await manager.call(saved.id, 'echo', { value: 'new schema' }, context)).toMatchObject({ content: [{ text: '2' }] })
  })

  it('cancels dispatched HTTP call without replay and rejects a pre-aborted next call', async () => {
    const { manager, saved, context, http } = await setup({}, 'http')
    await manager.connect(saved.id)
    const controller = new AbortController()
    const pending = manager.call(saved.id, 'echo', { value: 5 }, { ...context, signal: controller.signal })
    await expect.poll(() => http!.requests.filter(r => r.method === 'tools/call').length).toBe(1)
    controller.abort()
    await expect(pending).rejects.toThrow()
    await expect(manager.call(saved.id, 'echo', {}, { ...context, signal: controller.signal })).rejects.toThrow()
    expect(http!.requests.filter(r => r.method === 'tools/call')).toHaveLength(1)
  })

  it('disconnect closes owned stdio child and does not replay an in-flight action', async () => {
    const { manager, saved, context, registry } = await setup()
    await manager.connect(saved.id)
    const owned = manager.getOwnedProcesses()
    expect(owned).toHaveLength(1)
    const result = await manager.call(saved.id, 'echo', { value: 6 }, context)
    expect(result.isError).toBe(true)
    expect(registry.getDefinitions()).toEqual([])
    await manager.shutdown()
    expect(manager.getOwnedProcesses()).toEqual([])
    expect(() => process.kill(owned[0].pid, 0)).toThrow()
  })

  it.each(['http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2019-09/schema'])('uses the shared input gate for %s', async schema => {
    const { manager, saved, context } = await setup({ schema })
    await manager.connect(saved.id)
    expect(await manager.call(saved.id, 'echo', { value: 'no' }, context)).toMatchObject({ isError: true })
    expect(await manager.call(saved.id, 'echo', {}, context)).toMatchObject({ content: [{ text: '1' }] })
  })

  it('validates same-id schemas independently across registrations', async () => {
    const { registry, context } = await setup()
    const parameters = { $id: 'https://example.test/shared', type: 'object', properties: { value: { type: 'integer' } }, required: ['value'] }
    registry.register({ name: 'first', description: '', parameters }, async () => ({ content: [{ type: 'text', text: 'first' }] }))
    registry.register({ name: 'second', description: '', parameters: { ...parameters, properties: { value: { type: 'string' } } } }, async () => ({ content: [{ type: 'text', text: 'second' }] }))
    expect(await registry.execute('second', { value: 1 }, context)).toMatchObject({ isError: true })
    expect(await registry.execute('second', { value: 'ok' }, context)).toMatchObject({ content: [{ text: 'second' }] })
    expect(await registry.execute('first', { value: 'ok' }, context)).toMatchObject({ isError: true })
  })

  it('does not overwrite even an unavailable registered name on collision', async () => {
    const { manager, registry, saved } = await setup()
    const name = mcpToolName(saved.id, 'echo')
    let available = false
    registry.register({ name, description: 'existing owner', parameters: { type: 'object' } }, async () => ({ content: [] }), { isAvailable: () => available })
    await expect(manager.connect(saved.id)).rejects.toThrow(/冲突/)
    available = true
    expect(registry.getDefinitions()).toMatchObject([{ description: 'existing owner' }])
  })

  it('keeps identical remote names distinct across services and stable after reconnect', async () => {
    const { manager, config, registry, saved, context } = await setup()
    const second = await config.save({ ...saved, id: undefined })
    await Promise.all([manager.connect(saved.id), manager.connect(second.id)])
    const before = (await manager.listTools(saved.id)).map(tool => tool.name)
    expect(new Set(registry.getDefinitions().map(tool => tool.name)).size).toBe(4)
    await manager.disconnect(saved.id)
    await manager.connect(saved.id)
    expect((await manager.listTools(saved.id)).map(tool => tool.name)).toEqual(before)
    expect(await manager.call(second.id, 'echo', {}, context)).toMatchObject({ content: [{ text: '1' }] })
  })

  it('rejects unsupported input dialect instead of advertising an unvalidated tool', async () => {
    const { manager, saved, registry } = await setup({ schema: 'https://example.test/unsupported-schema' })
    await expect(manager.connect(saved.id)).rejects.toThrow(/Schema|协议/)
    expect(registry.getDefinitions()).toEqual([])
  })

  it('explicit disconnect aborts pending calls and leaves no replay on reconnect', async () => {
    const { manager, saved, context, http } = await setup({}, 'http')
    await manager.connect(saved.id)
    const pending = manager.call(saved.id, 'echo', { value: 5 }, context)
    await expect.poll(() => http!.requests.filter(r => r.method === 'tools/call').length).toBe(1)
    await manager.disconnect(saved.id)
    expect(await pending).toMatchObject({ isError: true })
    await manager.connect(saved.id)
    expect(http!.requests.filter(r => r.method === 'tools/call')).toHaveLength(1)
  })


  it('shutdown force fallback signals only its owned stubborn child', async () => {
    const { manager, saved } = await setup({ holdOpen: true })
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    cleanup.push(() => new Promise<void>(resolve => { unrelated.once('exit', () => resolve()); unrelated.kill() }))
    await manager.connect(saved.id)
    const pid = manager.getOwnedProcesses()[0].pid
    const closing = manager.shutdown()
    manager.forceCloseOwnedProcesses()
    await closing
    expect(() => process.kill(pid, 0)).toThrow()
    expect(() => process.kill(unrelated.pid!, 0)).not.toThrow()
    await expect(manager.connect(saved.id)).rejects.toThrow(/关闭/)
  })


  it.each(['stdio', 'http'] as const)('rejects async output discovery before approval or action over %s', async transport => {
    const { manager, saved, context, registry, http } = await setup({ outputs: { echo: {
      schema: { $async: true, type: 'object', properties: { value: { type: 'integer' } }, required: ['value'] },
      value: { value: 'invalid-integer' }
    } } }, transport)
    let authorized = 0
    let dispatched = 0
    let rejected: unknown
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown) => { unhandled.push(error) }
    process.on('unhandledRejection', onUnhandled)
    try {
      try { await manager.connect(saved.id) } catch (error) { rejected = error }
      const result = await manager.call(saved.id, 'echo', {}, { ...context,
        authorize: async () => { authorized++ }, onDispatch: () => { dispatched++ }
      }).catch(error => ({ isError: true, content: [{ type: 'text', text: error.message }] }))
      await new Promise<void>(resolve => setImmediate(resolve))
      expect.soft(rejected).toBeInstanceOf(Error)
      expect.soft(manager.getStatus(saved.id).state).toBe('error')
      expect.soft(registry.getDefinitions()).toEqual([])
      expect.soft(result.isError).toBe(true)
      expect.soft(authorized).toBe(0)
      expect.soft(dispatched).toBe(0)
      expect.soft(unhandled).toEqual([])
      if (http) expect.soft(http.requests.filter(request => request.method === 'tools/call')).toHaveLength(0)
    } finally { process.removeListener('unhandledRejection', onUnhandled) }
  })

  it.each(['http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2019-09/schema', 'https://json-schema.org/draft/2020-12/schema'])('validates synchronous output and preserves literal $async data: %s', async $schema => {
    const value = { count: 7, literal: { $async: true }, choice: { $async: true } }
    const schema = { $schema, type: 'object', properties: {
      count: { type: 'integer' }, literal: { const: { $async: true } }, choice: { enum: [{ $async: true }] },
      optional: { default: { $async: true } }
    }, required: ['count', 'literal', 'choice'] }
    const { manager, saved, context } = await setup({ outputs: {
      echo: { schema, value }, 'other.name': { schema, value: { ...value, count: 'invalid' } }
    } }, 'http')
    await manager.connect(saved.id)
    expect(await manager.call(saved.id, 'echo', {}, context)).toMatchObject({ structuredContent: value })
    expect(await manager.call(saved.id, 'other.name', {}, context)).toMatchObject({ isError: true })
  })

  it('isolates output schemas sharing an id across discovered tools', async () => {
    const { manager, saved, context } = await setup({ outputs: {
      echo: { schema: { $id: 'https://example.test/output', type: 'object', properties: { value: { type: 'integer' } } }, value: { value: 7 } },
      'other.name': { schema: { $id: 'https://example.test/output', type: 'object', properties: { value: { type: 'string' } } }, value: { value: 'valid string' } }
    } }, 'http')
    await manager.connect(saved.id)
    expect(await manager.call(saved.id, 'echo', {}, context)).toMatchObject({ structuredContent: { value: 7 } })
    expect(await manager.call(saved.id, 'other.name', {}, context)).toMatchObject({ structuredContent: { value: 'valid string' } })
  })

})

it('custom MCP approval identifies the configured service, remote operation and args while retaining stable recovery identity', async () => {
  const { manager, saved, context } = await setup({}, 'http')
  await manager.connect(saved.id)
  let assessment: import('../src/shared/types').ActionAssessment | undefined
  await manager.call(saved.id, 'echo', { value: 0 }, { ...context, authorize: async value => { assessment = value } })
  expect(assessment).toMatchObject({ effect: 'unknown', target: mcpToolName(saved.id, 'echo'), displayTarget: 'mock / echo' })
  expect(assessment?.summary).toContain('mock')
  expect(assessment?.summary).toContain('echo')
  expect(assessment?.summary).toContain('"value":0')
  expect(assessment?.summary).not.toContain(mcpToolName(saved.id, 'echo'))
})

it('rejects a late preset result transformation after the runtime configuration was invalidated', async () => {
  let release!: () => void
  let reached!: () => void
  const entered = new Promise<void>(resolve => { reached = resolve })
  const blocked = new Promise<void>(resolve => { release = resolve })
  const s = await setup({}, 'stdio', undefined, { execute: async (name, args, _context, dispatch) => {
    const result = await dispatch(name, args)
    reached(); await blocked
    return result
  } })
  await s.manager.connect(s.saved.id)
  const pending = s.manager.call(s.saved.id, 'other.name', {}, s.context)
  await entered
  await s.config.save({ ...s.saved, expectedRevision: s.saved.revision, enabled: false })
  release()
  expect(await pending).toMatchObject({ isError: true })
})
