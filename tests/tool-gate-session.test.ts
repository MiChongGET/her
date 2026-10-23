import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHerAgentSession } from '../src/core/agent/factory'
import { createGatedTools } from '../src/core/tools/gate'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import { ToolApprovalService } from '../src/core/tools/approval'
import type { ActionAssessment, ApprovalRequest } from '../src/shared/types'
import type { StoredConversation } from '../src/core/storage/store'
import { startFixtureServer, TOOL_NAME, type Protocol } from './pi-sdk/wire'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

async function run(protocol: Protocol, effect: ActionAssessment['effect'], decision?: 'approve' | 'reject', declared: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'her-tool-gate-')); directories.push(directory)
  const server = await startFixtureServer(protocol, ['tool', 'text'])
  const dispatched: unknown[] = []
  const registry = new SimpleToolRegistry()
  registry.register({ name: TOOL_NAME, description: 'report', parameters: { ...declared, type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } },
    async args => { dispatched.push(args); return { content: [{ type: 'text', text: 'recorded' }] } },
    { assess: async () => ({ effect, target: 'connection', summary: 'report' }) })
  const controller = new AbortController()
  const conversation = { id: randomUUID(), piSessionId: randomUUID() } as StoredConversation
  const provider = { id: 'gate', name: 'gate', protocol, baseUrl: server.baseUrl + '/v1', model: 'test-model', apiKey: 'fixture-key', customHeaders: {} }
  const requests: ApprovalRequest[] = []
  const approvals = new ToolApprovalService(request => { requests.push(request); if (decision) queueMicrotask(() => approvals.decide({ approvalId: request.id, revision: request.revision, decision })) })
  const tools = createGatedTools(registry.snapshot(), { runId: 'run', conversationId: conversation.id, signal: controller.signal,
    ...(decision ? { authorize: (assessment, context) => approvals.authorize(context.callId, assessment, context) } : {}) })
  const connection = await createHerAgentSession(provider, conversation, directory, 'test', controller.signal, undefined, tools)
  try {
    await connection.session.prompt('report')
    const results = connection.session.messages.filter(message => message.role === 'toolResult') as { isError: boolean; content: { text: string }[] }[]
    return { dispatched, approvalRequests: requests, results, active: connection.session.getActiveToolNames(), requests: server.requests.length }
  } finally { connection.session.dispose(); await server.close() }
}

describe('Pi session through the Her tool gate', () => {
  for (const protocol of ['openai', 'anthropic', 'openai-responses'] as const) {
    it(`${protocol}: exposes only gated tools and executes an allowed read call once`, async () => {
      const r = await run(protocol, 'read', 'approve')
      expect(r.active).toEqual([TOOL_NAME])
      expect(r.dispatched).toEqual([{ ok: true }])
      expect(r.results.map(result => result.isError)).toEqual([false])
    })

    it(`${protocol}: a non-read call is not dispatched without approval and the model sees the failure`, async () => {
      const r = await run(protocol, 'send')
      expect(r.dispatched).toEqual([])
      expect(r.results).toHaveLength(1)
      expect(r.results[0].isError).toBe(true)
      expect(r.results[0].content[0].text).toContain('需要用户确认')
    })
  }

  it('openai: an approved non-read call is dispatched exactly once after the request is emitted', async () => {
    const r = await run('openai', 'send', 'approve')
    expect(r.approvalRequests).toHaveLength(1)
    expect(r.dispatched).toEqual([{ ok: true }])
    expect(r.results.map(result => result.isError)).toEqual([false])
  })

  it('openai: a rejected non-read call is never dispatched and the model sees the refusal', async () => {
    const r = await run('openai', 'send', 'reject')
    expect(r.dispatched).toEqual([])
    expect(r.results[0].isError).toBe(true)
    expect(r.results[0].content[0].text).toContain('拒绝')
  })

  it('openai: an MCP-style schema declaring JSON Schema 2020-12 still reaches the executor', async () => {
    const r = await run('openai', 'read', 'approve', { $schema: 'https://json-schema.org/draft/2020-12/schema' })
    expect(r.dispatched).toEqual([{ ok: true }])
    expect(r.results.map(result => result.isError)).toEqual([false])
  })
})

