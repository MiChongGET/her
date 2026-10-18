import { expect, it } from 'vitest'
import { createBrowserAdapter } from '../src/core/mcp/browser'
import type { McpConnectionManager } from '../src/core/mcp/manager'
import { McpRegistryAdapter, mcpToolName } from '../src/core/mcp/registry-adapter'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import { ToolApprovalService } from '../src/core/tools/approval'
import type { ApprovalRequest, ToolResult } from '../src/shared/types'
import type { ToolExecutionContext } from '../src/core/tools/types'

const page: ToolResult = { content: [{ type: 'text', text: '### Page\n- Page URL: https://example.com/\n- Page Title: Form\n### Snapshot\n```yaml\n- button "Submit" [ref=e1]\n```' }] }
function fixture() {
  const registry = new SimpleToolRegistry(), adapter = new McpRegistryAdapter(registry, 'Chrome')
  const requests: ApprovalRequest[] = [], sent: string[] = []
  const approvals = new ToolApprovalService(request => {
    requests.push(request)
    approvals.decide({ approvalId: request.id, revision: request.revision, decision: request.allowConversation ? 'approve-conversation' : 'approve' })
  })
  let available = true
  function connect() {
    adapter.clear()
    const policy = createBrowserAdapter({ getStatus: () => ({ revision: 1, state: 'ready' }) } as unknown as McpConnectionManager, 'chrome')
    adapter.register('chrome', 1, ['browser_snapshot', 'browser_click'].map(name => ({ name, inputSchema: { type: 'object', properties: { target: { type: 'string' } } } })), policy, () => available,
      name => (args, context) => policy.execute!(name, args, context, async remote => { sent.push(remote); return page }))
  }
  connect()
  const context: ToolExecutionContext = { runId: 'run-1', conversationId: 'conversation-1', callId: 'call', signal: new AbortController().signal,
    authorize: (assessment, checked) => approvals.authorize(checked.callId, assessment, checked) }
  const call = (name = 'browser_snapshot', args = {}, ctx = context) => registry.execute(mcpToolName('chrome', name), args, ctx)
  return { registry, requests, sent, approvals, context, call, connect, disconnect: () => { available = false } }
}

it('one conversation grant covers later observations, clicks and subsequent runs without another prompt', async () => {
  const h = fixture()
  const first = await h.call()
  await h.call('browser_click', { observation_id: first.meta!.observation_id, target: 'e1' })
  await h.call('browser_snapshot', {}, { ...h.context, runId: 'run-2' })
  expect(h.sent).toEqual(['browser_snapshot', 'browser_snapshot', 'browser_click', 'browser_snapshot'])
  expect(h.requests).toHaveLength(1)
  expect(h.requests[0].allowConversation).toBe(true)
})

it('another conversation and a reconnected browser each require their own grant', async () => {
  const h = fixture()
  await h.call()
  await h.call('browser_snapshot', {}, { ...h.context, conversationId: 'conversation-2' })
  expect(h.requests).toHaveLength(2)
  h.connect()
  await h.call()
  expect(h.requests).toHaveLength(3)
})

it('conversation approval still rejects changed observations before a click is dispatched', async () => {
  const h = fixture(), first = await h.call()
  await h.call()
  await expect(h.call('browser_click', { observation_id: first.meta!.observation_id, target: 'e1' })).rejects.toThrow(/失效/)
  expect(h.sent).toEqual(['browser_snapshot', 'browser_snapshot'])
  expect(h.requests).toHaveLength(1)
})

it('revoking the conversation grant restores the prompt and restart does not restore grants', async () => {
  const h = fixture()
  await h.call()
  expect(h.approvals.hasConversationApproval('conversation-1')).toBe(true)
  h.approvals.revokeConversation('conversation-1')
  expect(h.approvals.hasConversationApproval('conversation-1')).toBe(false)
  await h.call()
  expect(h.requests).toHaveLength(2)
  expect(new ToolApprovalService().hasConversationApproval('conversation-1')).toBe(false)
})

it('does not offer or inherit browser authorization for an ordinary MCP tool', async () => {
  const h = fixture()
  await h.call()
  h.registry.register({ name: 'other', description: 'Other MCP', parameters: {} }, async () => page)
  await h.registry.execute('other', {}, h.context)
  expect(h.requests).toHaveLength(2)
  expect(h.requests[1].allowConversation).toBeUndefined()
})
