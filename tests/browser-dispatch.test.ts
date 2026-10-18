import { expect, it } from 'vitest'
import { createBrowserAdapter } from '../src/core/mcp/browser'
import type { McpConnectionManager } from '../src/core/mcp/manager'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import { ToolApprovalService } from '../src/core/tools/approval'
import { TaskExecution } from '../src/core/tools/execution'
import { HerStore } from '../src/core/storage/store'
import type { ToolResult, TaskRun } from '../src/shared/types'
const page = (title = 'Form'): ToolResult => ({ content: [{ type: 'text', text: `### Page\n- Page URL: https://example.com/\n- Page Title: ${title}\n### Snapshot\n\`\`\`yaml\n- button "Send" [ref=e1]\n\`\`\`` }] })
function fixture(mode: 'drift' | 'preflight-error' | 'action-error' | 'success') {
  const store = new HerStore(':memory:'), conversation = store.createConversation()
  const manager = { getStatus: () => ({ revision: 1, state: 'ready' }) } as unknown as McpConnectionManager
  const policy = createBrowserAdapter(manager, 'b'), registry = new SimpleToolRegistry(), sent: string[] = [], approvalsSeen: string[] = []
  let reads = 0
  for (const name of ['browser_snapshot', 'browser_click']) registry.register({ name, description: name, parameters: { type: 'object' } }, (args, context) => policy.execute!(name, args, context, async (remote, _args, phase) => {
    context.markDispatched?.(phase ?? 'action'); sent.push(remote)
    const result = remote === 'browser_snapshot' ? (++reads > 1 && mode === 'preflight-error' ? { isError: true, content: [] } as ToolResult : page(reads > 1 && mode === 'drift' ? 'Changed' : 'Form')) : mode === 'action-error' ? { isError: true, content: [] } as ToolResult : page()
    if (phase === 'preflight' && !result.isError) context.completePreflight?.()
    return result
  }), { assess: (args, context) => policy.assess!(name, args, context), validateObservation: policy.validateObservation, deferDispatch: policy.deferDispatch })
  const approvals = new ToolApprovalService(approval => { approvalsSeen.push(approval.summary); approvals.decide({ approvalId: approval.id, revision: approval.revision, decision: 'approve' }) })
  const run: TaskRun = { id: 'run', requestId: 'r', conversationId: conversation.id, assistantMessageId: 'm', status: 'running', providerId: 'p', model: 'm', toolCallsCount: 0, activeMs: 0 }
  const task = new TaskExecution(run, store, registry, approvals, new AbortController().signal, () => {})
  const call = (id: string, name: string, args: Record<string, unknown>) => task.execute(task.prepare({ id, name, arguments: args }))
  return { store, task, run, call, sent, approvalsSeen, close: () => { task.finish('stopped'); store.close() } }
}
it('confirms reset-capable first snapshot and discloses current-content-only hidden reconnect boundary', async () => {
  const h = fixture('success')
  try {
    await h.call('observe', 'browser_snapshot', {})
    expect(h.approvalsSeen).toHaveLength(1)
    expect(h.approvalsSeen[0]).toMatch(/崩溃.*关闭|关闭.*崩溃/)
    expect(h.approvalsSeen[0]).toContain('无法区分')
  } finally { h.close() }
})
it('successful preflight then drift is a failed bounded attempt, never an unknown final click', async () => {
  const h = fixture('drift')
  try {
    const observed = await h.call('observe', 'browser_snapshot', {})
    await h.call('click', 'browser_click', { observation_id: observed.meta!.observation_id, target: 'e1' })
    expect(h.store.listToolCalls('run').at(-1)).toMatchObject({ status: 'failed', dispatchPhase: 'preflight-completed' })
    expect(h.task.hasUnknownResults()).toBe(false); expect(h.sent).not.toContain('browser_click'); expect(h.run.toolCallsCount).toBe(2)
    const fresh = await h.call('again', 'browser_snapshot', {})
    await h.call('retry-new-approved', 'browser_click', { observation_id: fresh.meta!.observation_id, target: 'e1' })
    expect(h.sent.filter(x => x === 'browser_click')).toHaveLength(1)
  } finally { h.close() }
})
it.each(['preflight-error', 'action-error'] as const)('preserves true unknown effects with accurate phase: %s', async mode => {
  const h = fixture(mode)
  try {
    const observed = await h.call('observe', 'browser_snapshot', {})
    const result = await h.call('click', 'browser_click', { observation_id: observed.meta!.observation_id, target: 'e1' })
    if (mode === 'preflight-error') expect(JSON.stringify(result)).toContain('最终动作未派发')
    expect(h.store.listToolCalls('run').at(-1)).toMatchObject({ status: 'unknown', dispatchPhase: mode === 'preflight-error' ? 'preflight' : 'action' })
    expect(h.task.hasUnknownResults()).toBe(true)
    expect(h.sent.includes('browser_click')).toBe(mode === 'action-error')
  } finally { h.close() }
})

import { startMockHttp } from './helpers/mock-mcp'
import { McpConnectionManager as Manager } from '../src/core/mcp/manager'
import { McpConfigService } from '../src/core/mcp/config'
import { ToolArtifactStore } from '../src/core/tools/artifacts'
import { mcpToolName } from '../src/core/mcp/registry-adapter'
it.each(['drift', 'error', 'cancel', 'final-error'] as const)('real MCP manager marks the actual wire phase, not executor entry: %s', async mode => {
  const remote = await startMockHttp(), store = new HerStore(':memory:'), conversation = store.createConversation(), registry = new SimpleToolRegistry()
  const configs = new McpConfigService(store, { encrypt: async text => Buffer.from(text), decrypt: async bytes => bytes.toString() })
  const manager = new Manager(configs, registry, new ToolArtifactStore(store), () => ({ deferDispatch: true, allowedTools: ['echo'], assess: async () => ({ effect: 'unknown', target: 'browser:b:action', summary: 'approved preflight reset and click' }), execute: async (_name, _args, _context, dispatch) => {
    const preflight = await dispatch('echo', { value: mode === 'error' ? 2 : mode === 'cancel' ? 5 : 0 }, 'preflight')
    if (preflight.isError) return preflight
    if (mode === 'drift') throw new Error('changed page')
    return dispatch('echo', { value: 2 })
  } }))
  const saved = await configs.save({ name: 'fixture', enabled: true, transport: 'streamable-http', url: remote.url })
  await manager.connect(saved.id)
  const approvals = new ToolApprovalService(a => approvals.decide({ approvalId: a.id, revision: a.revision, decision: 'approve' }))
  const run: TaskRun = { id: 'run', requestId: 'r', conversationId: conversation.id, assistantMessageId: 'm', status: 'running', providerId: 'p', model: 'm', toolCallsCount: 0, activeMs: 0 }
  const controller = new AbortController(), task = new TaskExecution(run, store, registry, approvals, controller.signal, () => {})
  try {
    const pending = task.execute(task.prepare({ id: 'call', name: mcpToolName(saved.id, 'echo'), arguments: {} }))
    if (mode === 'cancel') {
      const captured = pending.catch(() => {})
      while (!remote.requests.some(r => r.method === 'tools/call')) await new Promise(resolve => setTimeout(resolve, 5))
      controller.abort(); await captured
    } else await pending
    expect(store.listToolCalls('run')[0]).toMatchObject({ status: mode === 'drift' ? 'failed' : 'unknown', dispatchPhase: mode === 'drift' ? 'preflight-completed' : mode === 'final-error' ? 'action' : 'preflight' })
    expect(remote.requests.filter(r => r.method === 'tools/call')).toHaveLength(mode === 'final-error' ? 2 : 1)
    expect(run.toolCallsCount).toBe(1)
  } finally { task.finish('stopped'); await manager.shutdown(); await remote.close(); store.close() }
})
it('cannot close a crashed tab through an unconfirmed observation and rejected approval consumes no attempt budget', async () => {
  const store = new HerStore(':memory:'), conversation = store.createConversation(), registry = new SimpleToolRegistry()
  const policy = createBrowserAdapter({ getStatus: () => ({ revision: 1, state: 'ready' }) } as unknown as McpConnectionManager, 'b')
  let tabClosed = false
  registry.register({ name: 'snapshot', description: 'snapshot', parameters: {} }, (args, ctx) => policy.execute!('browser_snapshot', args, ctx, async () => { tabClosed = true; return page() }), { assess: (args, ctx) => policy.assess!('browser_snapshot', args, ctx), deferDispatch: true })
  const approval = new ToolApprovalService(a => approval.decide({ approvalId: a.id, revision: a.revision, decision: 'reject' }))
  const run: TaskRun = { id: 'reject', requestId: 'r', conversationId: conversation.id, assistantMessageId: 'm', status: 'running', providerId: 'p', model: 'm', toolCallsCount: 0, activeMs: 0 }
  const task = new TaskExecution(run, store, registry, approval, new AbortController().signal, () => {})
  try {
    await expect(task.execute(task.prepare({ id: 'snapshot', name: 'snapshot', arguments: {} }))).rejects.toThrow()
    expect(tabClosed).toBe(false); expect(run.toolCallsCount).toBe(0); expect(task.hasUnknownResults()).toBe(false)
  } finally { task.finish('stopped'); store.close() }
})
