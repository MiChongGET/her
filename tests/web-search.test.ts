import { expect, it } from 'vitest'
import { createWebSearchAdapter } from '../src/core/mcp/web-search'
import type { McpConnectionManager } from '../src/core/mcp/manager'
import type { ToolExecutionContext } from '../src/core/tools/types'
import type { ToolResult } from '../src/shared/types'
const context: ToolExecutionContext = { runId: 'r', conversationId: 'c', callId: 'call', signal: new AbortController().signal }
const policy = createWebSearchAdapter({} as McpConnectionManager, 'search')
const hit = { title: 'Docs', url: 'https://example.com/', description: 'Actual excerpt', source: 'Bing', engine: 'bing' }
const result = (results: unknown[], partialFailures: unknown[] = []): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify({ query: 'docs', engines: ['bing'], totalResults: results.length, results, partialFailures }) }] })
it('preserves source and engine while normalizing wire description to snippet', async () => {
  const value = await policy.execute!('search', { query: 'docs' }, context, async () => result([hit]))
  expect(value.structuredContent).toMatchObject({ status: 'success', results: [{ title: 'Docs', url: 'https://example.com/', snippet: 'Actual excerpt', source: 'Bing', engine: 'bing' }] })
})
it('distinguishes engine failure, partial success and successful zero results', async () => {
  const failure = [{ engine: 'bing', code: 'blocked', message: 'CAPTCHA' }]
  const all = await policy.execute!('search', { query: 'docs' }, context, async () => result([], failure))
  expect(all.isError).toBe(true); expect(all.structuredContent).toMatchObject({ status: 'failed', partialFailures: failure })
  expect((await policy.execute!('search', { query: 'docs' }, context, async () => result([hit], failure))).structuredContent).toMatchObject({ status: 'partial', partialFailures: failure })
  expect((await policy.execute!('search', { query: 'docs' }, context, async () => result([]))).structuredContent).toMatchObject({ status: 'empty' })
})
it.each([{ content: [{ type: 'text', text: 'not JSON' }] }, { content: [{ type: 'text', text: '{}' }] }, { isError: true, content: [{ type: 'text', text: 'Search failed: blocked' }] }] as ToolResult[])('reports malformed or explicit failures without inventing zero results', async wire => {
  expect((await policy.execute!('search', { query: 'docs' }, context, async () => wire)).isError).toBe(true)
})
it('forces request-only fetch in schema and dispatch, rejects fallback and credential/url overrides', async () => {
  let dispatched: Record<string, unknown> | undefined
  const wire = async (_name: string, args: Record<string, unknown>): Promise<ToolResult> => { dispatched = args; return { content: [{ type: 'text', text: JSON.stringify({ url: args.url, finalUrl: args.url, title: '', contentType: 'text/plain', retrievalMethod: 'request', truncated: false, content: 'Public docs' }) }] } }
  const fetched = await policy.execute!('fetchWebContent', { url: 'https://example.com/', renderMode: 'request', maxChars: 1000 }, context, wire)
  expect(fetched.isError).not.toBe(true); expect(dispatched?.renderMode).toBe('request')
  for (const args of [{ url: 'https://example.com/', renderMode: 'auto' }, { url: 'https://example.com/' }, { url: 'file:///tmp/private', renderMode: 'request' }, { url: 'https://a:b@example.com/', renderMode: 'request' }, { url: 'https://example.com/', renderMode: 'request', headers: { cookie: 'x' } }]) await expect(policy.execute!('fetchWebContent', args, context, wire)).rejects.toThrow()
  expect(policy.parameters!('fetchWebContent', { properties: { renderMode: { enum: ['auto', 'browser', 'request'] } } })).toMatchObject({ required: ['url', 'renderMode', 'maxChars'], properties: { renderMode: { enum: ['request'] } } })
})
it('rejects alternate engines and unverified retrieval tools at dispatch', async () => {
  const dispatch = async (): Promise<ToolResult> => { throw new Error('must not dispatch') }
  await expect(policy.execute!('search', { query: 'q', engines: ['unknown'] }, context, dispatch)).rejects.toThrow(/允许/)
  await expect(policy.execute!('fetchGithubReadme', { url: 'ssh://host/repo' }, context, dispatch)).rejects.toThrow(/允许/)
})

it('requires a bounded explicit fetch budget before dispatch so wire JSON survives the Host text limit', async () => {
  for (const maxChars of [undefined, 200000]) {
    let sent = false
    await expect(policy.execute!('fetchWebContent', { url: 'https://example.com/', renderMode: 'request', ...(maxChars ? { maxChars } : {}) }, context, async () => { sent = true; return result([]) })).rejects.toThrow()
    expect(sent).toBe(false)
  }
})

it('withholds mismatched response provenance instead of attributing another page to the requested URL', async () => {
  const value = await policy.execute!('fetchWebContent', { url: 'https://example.com/', renderMode: 'request', maxChars: 1000 }, context,
    async () => ({ content: [{ type: 'text', text: JSON.stringify({ url: 'https://other.test/', finalUrl: 'https://other.test/', title: 'Other', content: 'OUTSIDE_SECRET', retrievalMethod: 'request' }) }] }))
  expect(value.isError).toBe(true)
  expect(JSON.stringify(value)).not.toContain('OUTSIDE_SECRET')
})

it('rechecks a delegated final URL and withholds out-of-scope redirect content', async () => {
  const action = { id: 'action', delegationId: 'delegation', scopeRevision: 1, adapterId: 'http', adapterRevision: '1', effect: 'read' as const,
    targetId: 'https://example.com/', payloadHash: 'hash', dataClasses: [], capability: 'http.read', confirmation: 'scope' as const, opaque: false, origin: 'https://example.com' }
  const scoped: ToolExecutionContext = { ...context, delegationId: 'delegation', action,
    actionPolicy: { assertCurrent: () => {}, reject: () => {}, decide: candidate => candidate.origin === 'https://example.com' ? 'allow' : 'confirm' } }
  const value = await policy.execute!('fetchWebContent', { url: 'https://example.com/', renderMode: 'request', maxChars: 1000 }, scoped,
    async () => ({ content: [{ type: 'text', text: JSON.stringify({ url: 'https://example.com/', finalUrl: 'https://outside.test/', title: 'Other', content: 'OUTSIDE_SECRET', retrievalMethod: 'request' }) }] }))
  expect(value.isError).toBe(true)
  expect(JSON.stringify(value)).not.toContain('OUTSIDE_SECRET')
})

it('preserves an exactly approved original-page result even when the runtime requires per-call confirmation', async () => {
  const action = { id: 'action', delegationId: 'delegation', scopeRevision: 1, adapterId: 'http', adapterRevision: '1', effect: 'read' as const,
    targetId: 'https://example.com/', payloadHash: 'hash', dataClasses: [], capability: 'http.read', confirmation: 'always' as const, opaque: false, origin: 'https://example.com' }
  const scoped: ToolExecutionContext = { ...context, delegationId: 'delegation', action,
    actionPolicy: { assertCurrent: () => {}, reject: () => {}, decide: () => 'confirm' } }
  const result = await policy.execute!('fetchWebContent', { url: 'https://example.com/', renderMode: 'request', maxChars: 1000 }, scoped,
    async () => ({ content: [{ type: 'text', text: JSON.stringify({ url: 'https://example.com/', finalUrl: 'https://example.com/', title: 'Approved', content: 'Exact approved page', retrievalMethod: 'request' }) }] }))
  expect(result.isError).not.toBe(true)
  expect(JSON.stringify(result)).toContain('Exact approved page')
})
