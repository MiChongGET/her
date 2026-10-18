import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, copyFile } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { McpConnectionManager } from '../src/core/mcp/manager'
import { McpConfigService } from '../src/core/mcp/config'
import { PresetDependencies } from '../src/core/mcp/dependencies'
import { HerStore } from '../src/core/storage/store'
import { FileAccessService } from '../src/core/files/access'
import { DocumentService, registerDocumentTools } from '../src/core/documents/service'
import { ToolArtifactStore } from '../src/core/tools/artifacts'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import { mcpToolName } from '../src/core/mcp/registry-adapter'
import { createMarkItDownParser, MARKITDOWN_POLICY } from '../src/core/documents/markitdown'
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
it.runIf(process.env.HER_TEST_MARKITDOWN === '1')('permanent pinned runtime: private MCP converts real formats through authorized wrapper', async () => {
  const root = await mkdtemp(join(tmpdir(), 'her-real-docs-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const store = new HerStore(join(root, 'db.sqlite')); cleanup.push(() => store.close())
  const dependencies = new PresetDependencies(); cleanup.push(() => dependencies.shutdown())
  const checks = await dependencies.checkPresetDependencies('markitdown', '')
  expect(checks.every(check => check.status === 'ready')).toBe(true)
  const configs = new McpConfigService(store, { encrypt: async text => Buffer.from(text), decrypt: async data => data.toString() })
  const saved = await configs.save(await dependencies.markitdownPreset())
  expect(saved.command).not.toContain('.superpowers')
  const registry = new SimpleToolRegistry(); const files = new FileAccessService(store)
  const manager = new McpConnectionManager(configs, registry, new ToolArtifactStore(store, undefined, files), async config => {
    await dependencies.verifyMarkItDown(config); return MARKITDOWN_POLICY
  }); cleanup.push(() => manager.shutdown())
  const service = new DocumentService(store, files, () => createMarkItDownParser(configs, manager))
  registerDocumentTools(registry, service)
  const context = { conversationId: store.createConversation().id, runId: 'run', callId: 'call', signal: new AbortController().signal,
    authorize: vi.fn(async () => {}), onAttempt: vi.fn(), onDispatch: vi.fn() }
  await manager.connect(saved.id)
  expect(await manager.listTools(saved.id)).toEqual([])
  expect(registry.getDefinitions().map(tool => tool.name)).toEqual(['read_document'])
  await expect(manager.call(saved.id, 'convert_to_markdown', { uri: 'file:///etc/passwd' }, context)).rejects.toThrow()
  expect(await registry.execute(mcpToolName(saved.id, 'convert_to_markdown'), { uri: 'file:///etc/passwd' }, context)).toMatchObject({ isError: true })
  const expectations = JSON.parse(await readFile(resolve('tests/fixtures/documents/expectations.json'), 'utf8')) as Record<string, string[]>
  for (const [name, markers] of Object.entries(expectations)) {
    const path = join(root, name); await copyFile(resolve('tests/fixtures/documents', name), path)
    const [grant] = await files.grant([path], { scope: 'conversation', kind: 'file', conversationId: context.conversationId })
    const file = await files.reference(grant.id, '', context)
    context.authorize.mockClear(); context.onAttempt.mockClear(); context.onDispatch.mockClear()
    const result = await registry.execute('read_document', { fileId: file.id }, context)
    expect(result.isError, JSON.stringify(result)).not.toBe(true)
    for (const marker of markers) expect(String(result.structuredContent?.text).replaceAll('\\_', '_')).toContain(marker)
    expect(result.structuredContent?.status).toBe(name === 'scanned.pdf' ? 'empty' : name.endsWith('.pdf') ? 'partial' : 'ready')
    expect(context.authorize).toHaveBeenCalledTimes(1); expect(context.onAttempt).toHaveBeenCalledTimes(1); expect(context.onDispatch).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(result)).not.toContain('pageNumber')
    if (name.endsWith('.xlsx')) {
      expect(result.structuredContent?.text).toContain('NaN')
      expect(result.structuredContent?.source).toMatchObject({ sheet: 'Revenue' })
      const costs = await registry.execute('read_document', { fileId: file.id, query: 'XLSX\\_MARKER\\_735' }, context)
      expect(costs.structuredContent?.source).toMatchObject({ sheet: 'Costs' })
    }
    await files.revoke(grant.id)
    expect(await registry.execute('read_document', { fileId: file.id }, context)).toMatchObject({ isError: true })
  }
  for (const name of ['corrupt.pdf', 'encrypted.pdf', 'long.txt']) {
    const path = join(root, name); await copyFile(resolve('tests/fixtures/documents', name), path)
    const [grant] = await files.grant([path], { scope: 'conversation', kind: 'file', conversationId: context.conversationId })
    const file = await files.reference(grant.id, '', context)
    const result = await registry.execute('read_document', { fileId: file.id }, context)
    if (name === 'encrypted.pdf') expect(result.isError).toBe(true)
    else if (name === 'corrupt.pdf') expect(result.structuredContent?.status).toBe('partial')
    else { expect(result.truncated).toBe(true); expect(Number(result.structuredContent?.nextCursor)).toBeGreaterThan(0) }
  }
  await manager.shutdown(); expect(manager.getOwnedProcesses()).toEqual([])
}, 120000)

it('private seam hides raw tool, validates input/output, preserves full cache text and checks revisions/cancel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'her-private-docs-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const store = new HerStore(join(root, 'db.sqlite')); cleanup.push(() => store.close())
  const configs = new McpConfigService(store, { encrypt: async text => Buffer.from(text), decrypt: async data => data.toString() })
  const registry = new SimpleToolRegistry()
  const manager = new McpConnectionManager(configs, registry, new ToolArtifactStore(store), config => config.name === 'trusted' ? MARKITDOWN_POLICY : { allowedTools: [] })
  cleanup.push(() => manager.shutdown())
  const context = { conversationId: store.createConversation().id, runId: 'r', callId: 'c', signal: new AbortController().signal, authorize: vi.fn(async () => {}), onAttempt: vi.fn(), onDispatch: vi.fn() }
  for (const mode of ['', 'invalid-output', 'delay', 'untrusted']) {
    const config = await configs.save({ name: mode === 'untrusted' ? 'custom' : 'trusted', enabled: true, transport: 'stdio', command: process.execPath, args: [resolve('tests/helpers/document-mcp.ts'), mode] })
    await manager.connect(config.id)
    expect(await manager.listTools(config.id)).toEqual([])
    await expect(manager.call(config.id, 'convert_to_markdown', { uri: 'file:///x' }, context)).rejects.toThrow()
    await expect(manager.convertDocument(config.id, 'https://example.com', context)).rejects.toThrow()
    if (!mode) expect((await manager.convertDocument(config.id, 'file:///host-owned', context)).length).toBe(60000)
    else if (mode === 'delay') {
      const pending = manager.convertDocument(config.id, 'file:///host-owned', context)
      const rejected = expect(pending).rejects.toThrow()
      await configs.save({ ...config, enabled: false, expectedRevision: config.revision }); await rejected
    } else await expect(manager.convertDocument(config.id, 'file:///host-owned', context)).rejects.toThrow()
  }
  expect(context.authorize).not.toHaveBeenCalled(); expect(context.onAttempt).not.toHaveBeenCalled(); expect(context.onDispatch).not.toHaveBeenCalled()
})
