import { expect, it } from 'vitest'
import { createBrowserAdapter } from '../src/core/mcp/browser'
import type { McpConnectionManager } from '../src/core/mcp/manager'
import type { ToolExecutionContext } from '../src/core/tools/types'
import type { ToolResult } from '../src/shared/types'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import { McpRegistryAdapter, mcpToolName } from '../src/core/mcp/registry-adapter'

const page = (url = 'https://example.com/', label = 'Send') => ({ content: [{ type: 'text', text: `### Page\n- Page URL: ${url}\n- Page Title: Form\n### Snapshot\n\`\`\`yaml\n- textbox "Message" [ref=e1]: hello\n- button "${label}" [ref=e2]\n\`\`\`` }] }) as ToolResult
function setup() {
  let revision = 1, ready = true, response = page()
  const manager = { getStatus: () => ({ revision, state: ready ? 'ready' : 'disconnected' }) } as unknown as McpConnectionManager
  const policy = createBrowserAdapter(manager, 'browser')
  const context: ToolExecutionContext = { runId: 'r', conversationId: 'c', callId: 'call', signal: new AbortController().signal }
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const dispatch = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => { calls.push({ name, args: structuredClone(args) }); return structuredClone(response) }
  const execute = (name: string, args: Record<string, unknown>, ctx = context) => policy.execute!(name, args, ctx, dispatch)
  const observe = async () => (await execute('browser_snapshot', {})).meta!.observation_id
  return { policy, context, calls, execute, observe, change: (r: ToolResult) => { response = r }, revision: () => { revision++ }, disconnect: () => { ready = false } }
}
it('binds actual Markdown page and exact refs to Host observations without claiming extension receipts or stable tab IDs', async () => {
  const h = setup(); const id = await h.observe()
  const args = { observation_id: id, target: 'e2' }
  expect(await h.policy.assess!('browser_click', args, h.context)).toMatchObject({ effect: 'unknown', observationId: id, displayTarget: expect.stringContaining('https://example.com/') })
  await expect(h.policy.assess!('browser_click', { ...args, target: 'e99' }, h.context)).rejects.toThrow()
  await expect(h.policy.assess!('browser_click', { ...args, target: 'button' }, h.context)).rejects.toThrow()
  await expect(h.policy.assess!('browser_click', args, { ...h.context, runId: 'other' })).rejects.toThrow()
})
it('rechecks the same full page before dispatch and consumes observation after every action', async () => {
  const h = setup(); const id = await h.observe()
  const args = { observation_id: id, target: 'e1', text: '中文', submit: true }
  expect((await h.policy.assess!('browser_type', args, h.context)).effect).toBe('send')
  await h.execute('browser_type', args)
  expect(h.calls.at(-1)).toEqual({ name: 'browser_type', args: { target: 'e1', text: '中文', submit: true } })
  expect(h.calls.map(c => c.name)).toEqual(['browser_snapshot', 'browser_snapshot', 'browser_type'])
  await expect(h.execute('browser_type', args)).rejects.toThrow()
})
it.each([page('https://other.example/'), page(undefined, 'Delete'), { isError: true, content: [{ type: 'text', text: 'Extension disconnected' }] } as ToolResult])('rejects navigation, changed element meanings and connection errors before dispatch', async response => {
  const h = setup(); const id = await h.observe(); h.change(response)
  await expect(h.execute('browser_click', { observation_id: id, target: 'e2' })).rejects.toThrow()
  expect(h.calls.filter(c => c.name === 'browser_click')).toHaveLength(0)
  await expect(h.policy.assess!('browser_click', { observation_id: id, target: 'e2' }, h.context)).rejects.toThrow()
})
it('does not clear persisted unknown browser actions through a read target or synthetic identity', async () => {
  const h = setup(); let observed = false
  const result = await h.execute('browser_snapshot', {}, { ...h.context, onObserved: () => { observed = true } })
  const read = await h.policy.assess!('browser_snapshot', {}, h.context)
  const action = await h.policy.assess!('browser_click', { observation_id: result.meta!.observation_id, target: 'e2' }, h.context)
  expect(read.target).not.toBe(action.target)
  expect(observed).toBe(false)
  h.revision(); await expect(h.policy.assess!('browser_click', { observation_id: result.meta!.observation_id, target: 'e2' }, h.context)).rejects.toThrow()
})
it('rejects hidden code, WebMCP, local URLs, output paths, raw formatting and nested selectors before reaching server', async () => {
  const h = setup(); const id = await h.observe(); h.calls.length = 0
  for (const [name, args] of [
    ['browser_evaluate', { function: '() => 1' }], ['browser_run_code_unsafe', { code: 'x' }], ['page_send', {}],
    ['browser_snapshot', { filename: '/tmp/x' }], ['browser_snapshot', { _meta: { json: true, cwd: '/tmp' } }],
    ['browser_navigate', { observation_id: id, url: 'javascript:alert(1)' }], ['browser_navigate', { observation_id: id, url: 'file:///etc/passwd' }],
    ['browser_fill_form', { observation_id: id, fields: [{ name: 'x', target: 'input', type: 'textbox', value: 'x' }] }],
    ['browser_take_screenshot', { observation_id: id, filename: '/tmp/overwrite' }]
  ] as [string, Record<string, unknown>][]) await expect(h.execute(name, args)).rejects.toThrow()
  expect(h.calls).toHaveLength(0)
})
it('does not expose unsafe parameters or browser code tools through registry discovery', () => {
  const h = setup(), registry = new SimpleToolRegistry(), adapter = new McpRegistryAdapter(registry, 'Chrome')
  adapter.register('browser', 1, ['browser_snapshot', 'browser_click', 'browser_evaluate', 'dynamic_webmcp'].map(name => ({ name, inputSchema: { type: 'object', properties: { target: { type: 'string' }, filename: { type: 'string' }, _meta: {} } } })), h.policy, () => true, name => (args, ctx) => h.execute(name, args, ctx))
  expect(adapter.definitions().map(d => d.name)).toEqual([mcpToolName('browser', 'browser_snapshot'), mcpToolName('browser', 'browser_click')])
  expect(adapter.definitions()[0].parameters).toMatchObject({ additionalProperties: false, properties: {} })
})
it('blocks page actions on disconnected metadata status and never accepts a screenshot as page identity', async () => {
  const h = setup(); const id = await h.observe(); h.disconnect()
  await expect(h.execute('browser_click', { observation_id: id, target: 'e2' })).rejects.toThrow()
  const other = setup(); other.change({ content: [{ type: 'image', artifactId: 'a', mimeType: 'image/png' }] })
  await expect(other.observe()).rejects.toThrow()
})
it('rejects shifted tab indexes rather than selecting the replacement tab', async () => {
  const h = setup(); h.change({ content: [{ type: 'text', text: '### Result\n- 0: (current) [A](https://a.example/)\n- 1: [B](https://b.example/)' }] })
  const list = await h.execute('browser_tabs', { action: 'list' })
  h.change({ content: [{ type: 'text', text: '### Result\n- 0: (current) [B](https://b.example/)' }] })
  await expect(h.execute('browser_tabs', { action: 'select', index: 1, observation_id: list.meta!.observation_id })).rejects.toThrow()
  expect(h.calls.filter(c => c.args.action === 'select')).toHaveLength(0)
})

import { ToolApprovalService } from '../src/core/tools/approval'
import { HerStore } from '../src/core/storage/store'
import type { TaskRun } from '../src/shared/types'
it('waits for concrete form submission approval and rejects late page drift without remapping approved args', async () => {
  const h = setup(); const id = await h.observe(), registry = new SimpleToolRegistry()
  registry.register({ name: 'type', description: 'type', parameters: { type: 'object' } }, (args, ctx) => h.execute('browser_type', args, ctx), { assess: (args, ctx) => h.policy.assess!('browser_type', args, ctx), validateObservation: h.policy.validateObservation })
  let ready!: (request: import('../src/shared/types').ApprovalRequest) => void
  const request = new Promise<import('../src/shared/types').ApprovalRequest>(resolve => { ready = resolve })
  const approvals = new ToolApprovalService(ready)
  const args = { observation_id: id, target: 'e1', text: 'approved exact 中文', submit: true }
  const pending = registry.execute('type', args, { ...h.context, authorize: (assessment, ctx) => approvals.authorize('call', assessment, ctx) })
  const approval = await request
  expect(approval.summary).toContain('approved exact 中文')
  expect(h.calls.map(c => c.name)).toEqual(['browser_snapshot'])
  h.change(page('https://other.example/'))
  approvals.decide({ approvalId: approval.id, revision: approval.revision, decision: 'approve' })
  expect((await pending).isError).toBe(true)
  expect(h.calls.some(c => c.name === 'browser_type')).toBe(false)
})
it('returns only inline screenshot image and never a filesystem result link', async () => {
  const h = setup(); const id = await h.observe(); let calls = 0
  const result = await h.policy.execute!('browser_take_screenshot', { observation_id: id }, h.context, async () => ++calls === 1 ? page() : { content: [{ type: 'image', artifactId: 'img', mimeType: 'image/png' }, { type: 'text', text: '/host/output.png' }] })
  expect(result.content).toEqual([{ type: 'image', artifactId: 'img', mimeType: 'image/png' }])
})
it('does not replay after cancellation or dispatched server error', async () => {
  const h = setup(); const id = await h.observe(); let mutations = 0
  const dispatch = async (name: string): Promise<ToolResult> => name === 'browser_snapshot' ? page() : (mutations++, { isError: true, content: [{ type: 'text', text: 'Timeout' }] })
  const args = { observation_id: id, target: 'e2' }
  expect((await h.policy.execute!('browser_click', args, h.context, dispatch)).isError).toBe(true)
  await expect(h.policy.execute!('browser_click', args, h.context, dispatch)).rejects.toThrow()
  expect(mutations).toBe(1)
  const other = setup(); const current = await other.observe(); const signal = new AbortController(); signal.abort()
  await expect(other.execute('browser_click', { observation_id: current, target: 'e2' }, { ...other.context, signal: signal.signal })).rejects.toThrow()
  expect(other.calls).toHaveLength(1)
})
it('accepts untitled current pages and deduplicates Result/Open tabs sections from the real public renderer', async () => {
  const h = setup(); h.change({ content: [{ type: 'text', text: '### Page\n- Page URL: about:blank\n### Snapshot\n```yaml\n\n```' }] })
  const id = await h.observe()
  expect((await h.policy.assess!('browser_navigate', { observation_id: id, url: 'https://example.com/' }, h.context)).effect).toBe('unknown')
  const tabs = '- 0: (current) [A](https://a.example/)\n- 1: [B](https://b.example/)'
  h.change({ content: [{ type: 'text', text: `### Result\n${tabs}\n### Open tabs\n${tabs}\n### Page\n- Page URL: https://a.example/\n- Page Title: A` }] })
  const listed = await h.execute('browser_tabs', { action: 'list' })
  expect((await h.policy.assess!('browser_tabs', { action: 'select', index: 1, observation_id: listed.meta!.observation_id }, h.context)).effect).toBe('unknown')
})
