import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cpSync, mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { HerStore } from '../src/core/storage/store'
import { PresetDependencies } from '../src/core/mcp/dependencies'
import { McpConfigService } from '../src/core/mcp/config'
import { McpConnectionManager } from '../src/core/mcp/manager'
import { createWebSearchAdapter } from '../src/core/mcp/web-search'
import { HttpComparison } from '../src/core/delegations/http-comparison'
import { DelegationService } from '../src/core/delegations/service'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import { ToolArtifactStore } from '../src/core/tools/artifacts'
import { ToolApprovalService } from '../src/core/tools/approval'
import type { ToolExecutionContext } from '../src/core/tools/types'
import { applyHerPatch, packageHash } from '../resources/mcp-web-dependencies/apply-her-patch.mjs'
import patch from '../resources/mcp-web-dependencies/her-request-patch.json'

it.skipIf(process.env.HER_TEST_COMPANION_HTTP_LIVE !== '1')('reads three public hotel sources through the real pinned MCP with no browser fallback or redirect authority', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'her-companion-http-live-'))
  const source = join(homedir(), '.local/share/her/dependencies/web-tools-v1/node_modules')
  const modules = join(directory, '.local/share/her/dependencies/web-tools-v1/node_modules')
  mkdirSync(modules, { recursive: true }); mkdirSync(join(directory, '.local/bin'), { recursive: true })
  symlinkSync(process.execPath, join(directory, '.local/bin/node'))
  for (const entry of readdirSync(source)) {
    if (entry === 'open-websearch') cpSync(join(source, entry), join(modules, entry), { recursive: true })
    else symlinkSync(join(source, entry), join(modules, entry))
  }
  const root = join(modules, 'open-websearch')
  expect(await packageHash(root)).toBe(patch.upstreamTreeSha256)
  const deps = new PresetDependencies({ home: directory })
  expect(await deps.webRequestConfinement()).toBe(false)
  await applyHerPatch(root); expect(await deps.webRequestConfinement()).toBe(true)
  const redirectProbe = await promisify(execFile)(process.execPath, [resolve('tests/helpers/http-redirect-probe.mjs'), root], { env: { ...process.env, SEARCH_MODE: 'request', ALLOWED_SEARCH_ENGINES: 'bing', USE_PROXY: 'false' } })
  writeFileSync('experiments/companion-browser/http-redirect-result.json', redirectProbe.stdout)
  expect(await applyHerPatch(root)).toBe(patch.revision)
  expect(await packageHash(root)).toBe(patch.patchedTreeSha256)
  const store = new HerStore(join(directory, 'her.sqlite')), registry = new SimpleToolRegistry(), artifacts = new ToolArtifactStore(store)
  const config = new McpConfigService(store, { encrypt: async value => Buffer.from(value), decrypt: async value => value.toString() })
  const preset = await deps.webPreset('open-websearch'), saved = await config.save({ ...preset, enabled: true })
  const producer = new HttpComparison(store, { available: () => true, serviceRevision: id => id === saved.id ? String(saved.revision) : null })
  const manager: McpConnectionManager = new McpConnectionManager(config, registry, artifacts, async current => {
    await deps.verifyWebPreset(current, 'open-websearch')
    const policy = createWebSearchAdapter(manager, current.id, { comparison: producer, requestConfinement: await deps.webRequestConfinement() })
    const execute = policy.execute!
    return { ...policy, execute: (name, args, context, dispatch) => execute(name, args, context, async (...parameters) => {
      const result = await dispatch(...parameters)
      if (result.isError) console.log(JSON.stringify({ upstreamFailure: result.content }))
      return result
    }) }
  })
  const service = new DelegationService(store, producer), daily = store.ensureDailyConversation()
  const pages = [
    ['新加坡莱佛士酒店', 'https://www.raffles.com/singapore/'],
    ['伦敦莱佛士酒店', 'https://www.raffles.com/london/'],
    ['巴黎莱佛士酒店', 'https://www.raffles.com/paris/']
  ]
  const text = `请比较下面三家酒店的公开页面，整理来源对照表：\n${pages.map(page => page.join(' ')).join('\n')}`
  const intent = { id: 'live-intent', messageId: 'live-message', conversationId: daily.id, text, source: 'user' as const, kind: 'unclassified' as const, spans: [] }
  store.saveUserIntent(intent)
  const admitted = service.admitIntent(intent, { id: 'live-proposal', revision: 1, evidenceSpans: [[0, text.length]], scope: { purpose: '', objects: [], completion: '', allowedCapabilities: [], origins: [], constraints: {} } })
  const delegation = service.get(admitted.delegationId!)
  store.enqueueInput(delegation.conversationId, text, null, 'live-request')
  store.createTask({ id: 'live-run', conversationId: delegation.conversationId, requestId: 'live-request', generation: 1, status: 'running', serviceId: 'fixture', modelId: 'fixture', configRevision: 1, error: null }, { delegationId: delegation.id, scopeRevision: 1 })
  let prompts = 0
  const approvals = new ToolApprovalService(() => { prompts++; throw new Error('Unexpected action confirmation') })
  const context: ToolExecutionContext = { runId: 'live-run', conversationId: delegation.conversationId, callId: 'live-call', signal: new AbortController().signal, delegationId: delegation.id, intent, actionPolicy: service,
    describeAction: async () => ({ id: '', delegationId: delegation.id, scopeRevision: 1, adapterId: '', adapterRevision: '', payloadHash: '', effect: 'unknown', targetId: '', capability: '', opaque: true, confirmation: 'always', dataClasses: [] }),
    authorize: (assessment, ctx) => approvals.authorize(ctx.callId, assessment, ctx) }
  const receipts: unknown[] = []
  try {
    await manager.connect(saved.id)
    for (const [index, [name, url]] of pages.entries()) {
      const result = await manager.call(saved.id, 'fetchWebContent', { url, maxChars: 2000, renderMode: 'request', readability: false }, { ...context, callId: `read-${index}` })
      console.log(JSON.stringify({ probe: url, isError: !!result.isError, result: result.isError ? result.content : undefined }))
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      expect(result.structuredContent).toMatchObject({ url, finalUrl: url, retrievalMethod: 'request' })
      expect(String(result.structuredContent?.content).length).toBeGreaterThan(100)
      receipts.push({ name, url, finalUrl: result.structuredContent?.finalUrl, title: result.structuredContent?.title, method: result.structuredContent?.retrievalMethod, characters: String(result.structuredContent?.content).length })
    }
    expect(prompts).toBe(0)
    const evidence = store.listHttpEvidence(delegation.id, 1)
    expect(evidence.filter(value => value.kind === 'receipt')).toHaveLength(3)
    expect(evidence.filter(value => value.kind === 'table')).toHaveLength(1)
    expect(producer.validateCompletion(delegation)).toBeNull()
    const summary = { time: new Date().toISOString(), upstreamVersion: patch.upstreamVersion, patchedRevision: patch.revision, treeHash: await packageHash(root), prompts, receipts,
      evidence: evidence.map(value => ({ id: value.id, kind: value.kind, refs: value.refs, contentHash: value.contentHash })), browserFallback: 'request-only source branches; actual retrievalMethod=request; no browser APIs invoked by this probe' }
    writeFileSync('experiments/companion-browser/http-live-result.json', JSON.stringify(summary, null, 2) + '\n')
    console.log(JSON.stringify(summary))
    writeFileSync(join(root, 'build/index.js'), '// tampered after live connection verification')
    expect(await deps.webRequestConfinement()).toBe(false)
    await expect(applyHerPatch(root)).rejects.toThrow('upstream')
  } finally { await manager.shutdown(); await artifacts.shutdown(); await deps.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true }) }
}, 120_000)
