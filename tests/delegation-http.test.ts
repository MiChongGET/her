import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { HerStore } from '../src/core/storage/store'
import { DelegationService } from '../src/core/delegations/service'
import { HttpComparison } from '../src/core/delegations/http-comparison'
import type { DelegationProposal, UserIntent } from '../src/core/delegations/types'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach(fn => fn()))
const text = '请比较下面三家酒店的公开页面，整理来源对照表：\n甲酒店 https://hotel-a.example/\n乙酒店 https://hotel-b.example/\n丙酒店 https://hotel-c.example/'
function fixture(available = true, request = text) {
  const dir = mkdtempSync(join(tmpdir(), 'her-http-comparison-')), store = new HerStore(join(dir, 'db.sqlite'))
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const intent: UserIntent = { id: 'intent', messageId: 'message', conversationId: store.ensureDailyConversation().id, text: request, source: 'user', kind: 'unclassified', spans: [] }
  store.saveUserIntent(intent)
  let serviceRevision = '1'
  const producer = new HttpComparison(store, { available: () => available, serviceRevision: id => id === 'search' ? serviceRevision : null })
  const service = new DelegationService(store, producer)
  const proposal: DelegationProposal = { id: 'proposal', revision: 1, evidenceSpans: [[0, text.length]], scope: {
    purpose: '模型候选不能扩权', objects: ['https://evil.example/'], completion: '任何成功', allowedCapabilities: ['submit'], origins: [], constraints: {} } }
  return { store, intent, producer, service, proposal, changeServiceRevision: (value: string) => { serviceRevision = value } }
}
it('resolves only the literal original user request and derives exact page objects rather than proposal authority', () => {
  const f = fixture(), result = f.service.admitIntent(f.intent, f.proposal)
  expect(result.status).toBe('ready')
  const scope = f.service.get(result.delegationId!).scope
  expect(scope.objects).toEqual(['https://hotel-a.example/', 'https://hotel-b.example/', 'https://hotel-c.example/'])
  expect(scope.allowedCapabilities).toEqual(['http.read'])
  expect(scope.constraints).toEqual({ renderMode: 'request', redirectPolicy: 'error' })
  expect(scope.completion).toBe('交付三家酒店公开页面的来源对照表')
  expect(scope.objects).not.toContain('https://evil.example/')
})
it('unavailable redirect confinement cannot auto-admit even an exact supported request', () => {
  const f = fixture(false)
  expect(f.service.admitIntent(f.intent, f.proposal).status).toBe('needs-confirmation')
})
it.each(['帮我比较三家酒店', text.replace('整理来源对照表', '推荐最便宜酒店'), text + '\n并预订甲酒店'])('unsupported or wider intent remains unapproved: %s', request => {
  const f = fixture(true, request)
  expect(f.producer.resolveScope(f.intent, f.proposal)).toBeNull()
})

it('three reads alone never complete; exact persisted source table delivery is required', () => {
  const f = fixture(), admitted = f.service.admitIntent(f.intent, f.proposal), delegation = f.service.get(admitted.delegationId!)
  f.store.enqueueInput(delegation.conversationId, 'compare', null, 'request')
  f.store.createTask({ id: 'run', requestId: 'request', conversationId: delegation.conversationId, generation: 1, status: 'running', serviceId: 'model', modelId: 'model', configRevision: 1, error: null }, { delegationId: delegation.id, scopeRevision: 1 })
  let table: string | undefined
  for (const [index, url] of delegation.scope.objects.entries()) {
    table = f.producer.recordRead({ runId: 'run', conversationId: delegation.conversationId, callId: `call-${index}`, signal: new AbortController().signal, delegationId: delegation.id,
      action: { id: `call-${index}`, delegationId: delegation.id, scopeRevision: 1, adapterId: 'http', adapterRevision: '1', effect: 'read', targetId: url, payloadHash: `payload-${index}`, providerId: 'search', dataClasses: ['public-web'], capability: 'http.read', confirmation: 'scope', opaque: false } },
    { url, finalUrl: url, title: `Observed hotel ${index + 1}`, content: `Public excerpt ${index + 1}`, retrievalMethod: 'request' })
  }
  expect(table).toContain('| 甲酒店 | Observed hotel 1 | Public excerpt 1 | https://hotel-a.example/ |')
  expect(f.producer.validateCompletion(delegation)).toBeNull()
  f.store.updateTaskStatus('run', 'completed')
  f.producer.recordDelivery(delegation, 'run', 'pi-message', '比较完成')
  expect(f.producer.validateCompletion(delegation)).toBeNull()
  f.producer.recordDelivery(delegation, 'run', 'pi-message', `以下是来源对照表：\n${table}`)
  expect(f.producer.validateCompletion(delegation)).toMatchObject({ delegationId: delegation.id, scopeRevision: 1, condition: delegation.scope.completion })
  f.changeServiceRevision('2')
  expect(f.producer.validateCompletion(delegation)).toBeNull()
  f.changeServiceRevision('1')
  const source = f.store.listHttpEvidence(delegation.id, 1).find(value => value.kind === 'receipt')!
  f.store.deleteHttpEvidence(source.id)
  expect(f.producer.validateCompletion(delegation)).toBeNull()
  f.store.saveHttpEvidence(source)
  expect(f.service.complete(delegation.id, 1).status).toBe('completed')
})

it('http_hotel_comparison_stays_in_delegation', async () => {
  const { SimpleToolRegistry } = await import('../src/core/tools/registry')
  const { ToolApprovalService } = await import('../src/core/tools/approval')
  const { createWebSearchAdapter } = await import('../src/core/mcp/web-search')
  const f = fixture(true, text + '\n搜索词：“酒店比较”'), admitted = f.service.admitIntent(f.intent, f.proposal), delegation = f.service.get(admitted.delegationId!)
  f.store.enqueueInput(delegation.conversationId, 'compare', null, 'request')
  f.store.createTask({ id: 'run', requestId: 'request', conversationId: delegation.conversationId, generation: 1, status: 'running', serviceId: 'model', modelId: 'model', configRevision: 1, error: null }, { delegationId: delegation.id, scopeRevision: 1 })
  const policy = createWebSearchAdapter({} as never, 'search', { comparison: f.producer, requestConfinement: true }), registry = new SimpleToolRegistry()
  const requests: string[] = [], sent: Record<string, unknown>[] = []
  const approvals = new ToolApprovalService(request => { requests.push(request.target); approvals.decide({ approvalId: request.id, revision: request.revision, decision: 'reject' }) })
  registry.register({ name: 'fetch', description: 'fetch', parameters: { type: 'object' } },
    (args, context) => policy.execute!('fetchWebContent', args, context, async (_name, actual) => {
      sent.push(actual)
      return { content: [{ type: 'text', text: JSON.stringify({ url: actual.url, finalUrl: actual.url, title: 'Hotel', content: 'Public excerpt', retrievalMethod: 'request' }) }] }
    }), { revision: '1', assess: (args, context) => policy.assess!('fetchWebContent', args, context), describeAction: (args, context) => policy.describeAction!('fetchWebContent', args, context) })
  const context = { runId: 'run', conversationId: delegation.conversationId, callId: 'call', signal: new AbortController().signal, delegationId: delegation.id, intent: f.intent, actionPolicy: f.service,
    describeAction: async () => ({ id: '', delegationId: delegation.id, scopeRevision: 1, adapterId: '', adapterRevision: '', payloadHash: '', effect: 'unknown' as const, targetId: '', capability: '', opaque: true, confirmation: 'always' as const, dataClasses: [] }),
    authorize: (assessment: import('../src/shared/types').ActionAssessment, ctx: import('../src/core/tools/types').ToolExecutionContext) => approvals.authorize(ctx.callId, assessment, ctx) }
  registry.register({ name: 'search', description: 'search', parameters: { type: 'object' } },
    (args, ctx) => policy.execute!('search', args, ctx, async () => ({ content: [{ type: 'text', text: JSON.stringify({ query: '酒店比较', engines: ['bing'], totalResults: 2, partialFailures: [], results: [
      { title: 'Hotel', url: 'https://hotel-a.example/', description: 'Approved result', source: 'Bing', engine: 'bing' },
      { title: 'OUTSIDE_RESULT', url: 'https://outside.example/', description: 'OUTSIDE_SNIPPET', source: 'Bing', engine: 'bing' }
    ] }) }] })), { revision: '1', assess: (args, ctx) => policy.assess!('search', args, ctx), describeAction: (args, ctx) => policy.describeAction!('search', args, ctx) })
  const searched = await registry.execute('search', { query: '酒店比较' }, context)
  expect(JSON.stringify(searched)).toContain('Approved result')
  expect(JSON.stringify(searched)).not.toContain('OUTSIDE_')
  for (const url of delegation.scope.objects.filter(value => value.startsWith('https:'))) {
    const result = await registry.execute('fetch', { url, maxChars: 1000, renderMode: 'request' }, context)
    expect(result.isError).not.toBe(true)
  }
  expect(sent).toHaveLength(3)
  expect(sent.every(args => args.renderMode === 'request' && args.redirectPolicy === 'error')).toBe(true)
  expect(requests).toHaveLength(0)
  await expect(registry.execute('fetch', { url: 'https://outside.example/', maxChars: 1000, renderMode: 'request' }, context)).rejects.toThrow('拒绝')
  expect(sent).toHaveLength(3)
  registry.register({ name: 'submit', description: 'submit', parameters: { type: 'object' } }, async args => { sent.push(args); return { content: [] } })
  await expect(registry.execute('submit', { email: 'fictional@example.test' }, context)).rejects.toThrow('拒绝')
  expect(sent).toHaveLength(3)
  expect(f.producer.validateCompletion(delegation)).toBeNull()
  expect(f.store.listHttpEvidence(delegation.id, 1).filter(value => value.kind === 'receipt')).toHaveLength(3)
})

it('Host completes only after the real final Pi reply delivers the controlled source table', async () => {
  const { createServer } = await import('node:http')
  const { ProfileService } = await import('../src/core/storage/profiles')
  const { AgentHost } = await import('../src/core/agent/host')
  const { ChatService } = await import('../src/core/conversation/chat')
  const { SimpleToolRegistry } = await import('../src/core/tools/registry')
  const { createWebSearchAdapter } = await import('../src/core/mcp/web-search')
  const f = fixture(), registry = new SimpleToolRegistry()
  const policy = createWebSearchAdapter({} as never, 'search', { comparison: f.producer, requestConfinement: true })
  registry.register({ name: 'http_read', description: 'read', parameters: { type: 'object', properties: { url: { type: 'string' }, maxChars: { type: 'number' }, renderMode: { type: 'string' } } } },
    (args, context) => policy.execute!('fetchWebContent', args, context, async (_name, actual) => ({ content: [{ type: 'text', text: JSON.stringify({ url: actual.url, finalUrl: actual.url, title: 'Hotel', content: 'Source facts', retrievalMethod: 'request' }) }] })),
    { revision: '1', assess: (args, context) => policy.assess!('fetchWebContent', args, context), describeAction: (args, context) => policy.describeAction!('fetchWebContent', args, context) })
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const daily = body.tools?.some((tool: any) => tool.function.name === 'delegate_work'), previous = body.messages.filter((message: any) => message.role === 'tool')
    let name: string | undefined, args: unknown, answer = '已接纳'
    if (daily && !previous.length) { name = 'delegate_work'; args = f.proposal }
    else if (!daily && previous.length < 3) { name = 'http_read'; args = { url: ['https://hotel-a.example/', 'https://hotel-b.example/', 'https://hotel-c.example/'][previous.length], renderMode: 'request', maxChars: 1000 } }
    else if (!daily) {
      const last = previous.at(-1).content
      const serialized = typeof last === 'string' ? last : last.map((part: any) => part.text ?? '').join('')
      const result = JSON.parse(serialized.split('\n')[0])
      answer = result.sourceComparisonTable
      if (typeof answer !== 'string') throw new Error('source table absent from actual tool result')
    }
    const delta = name ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${previous.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: answer }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const part of [{ delta, finish_reason: null }, { delta: {}, finish_reason: name ? 'tool_calls' : 'stop' }]) res.write(`data: ${JSON.stringify({ id: 'response', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, ...part }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const profiles = new ProfileService(f.store, { encrypt: async value => Buffer.from(value), decrypt: async value => value.toString() })
  const profile = await profiles.save({ name: 'local', protocol: 'openai', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: 'test', contextWindow: 128000, authMethod: 'none' })
  const dir = mkdtempSync(join(tmpdir(), 'her-http-host-'))
  const host = new AgentHost(f.store, profiles, dir, async () => registry.snapshot(), undefined, undefined, undefined, f.producer)
  const done: string[] = [], chat = new ChatService(f.store, host, () => {}, event => { if (event.state === 'completed' || event.state === 'failed') done.push(event.state) })
  try {
    await chat.send({ requestId: 'daily-http', conversationId: f.intent.conversationId, profileId: profile.id, content: text })
    for (let i = 0; i < 400 && done.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10))
    expect(done).toEqual(['completed', 'completed'])
    const control = f.store.listDelegationControls()[0], delegation = f.store.getDelegation(control.delegationId!)!
    expect(delegation.status).toBe('completed')
    const delivery = f.store.listHttpEvidence(delegation.id, 1).find(value => value.kind === 'delivery')!
    expect(delivery.messageId).toBeTruthy()
    expect(delivery.runId).toBe(f.store.getLatestTask(delegation.conversationId)!.id)
  } finally { await host.stopAll(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }) }
}, 15_000)
