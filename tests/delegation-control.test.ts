import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { HerStore } from '../src/core/storage/store'
import { AgentHost } from '../src/core/agent/host'
import { ProfileService } from '../src/core/storage/profiles'
import { openConversationHistory } from '../src/core/agent/factory'
import { ChatService } from '../src/core/conversation/chat'
import { startFixtureServer } from './pi-sdk/wire'
import { ResourceQueue } from '../src/core/tools/resources'
import { DelegationService } from '../src/core/delegations/service'
import { ActionLedger } from '../src/core/tools/ledger'
import { WorkspaceService } from '../src/core/conversation/workspace'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import type { ActionDescriptor, ActionDescription, Delegation, DelegationScope } from '../src/core/delegations/types'
import type { ToolExecutionContext } from '../src/core/tools/types'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const scope: DelegationScope = { purpose: '私密工作', objects: ['person:a', 'person:b', 'hotel'], completion: '交付', allowedCapabilities: ['message.send', 'http.read'], origins: [], constraints: {} }
const sendFacts: ActionDescription = { effect: 'send', businessEffect: 'message.send', targetId: 'person:a', target: '小王', capability: 'message.send', confirmation: 'always', opaque: false, dataClasses: [], preview: { fields: [] }, summary: '发送私密正文', actionLabel: '发送' }
const readFacts: ActionDescription = { effect: 'read', targetId: 'hotel', target: '酒店', capability: 'http.read', confirmation: 'scope', opaque: false, dataClasses: ['public'], preview: { fields: [] }, summary: '查询', actionLabel: '查询' }
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'her-control-')), path = join(directory, 'her.sqlite'), store = new HerStore(path)
  const profiles = new ProfileService(store, { encrypt: async value => Buffer.from(value), decrypt: async value => value.toString() })
  const host = new AgentHost(store, profiles, directory), daily = store.ensureDailyConversation()
  cleanup.push(async () => { await host.stopAll(); store.close(); rmSync(directory, { recursive: true, force: true }) })
  const add = (name: string, constraints: DelegationScope['constraints'] = {}) => {
    const conversationId = randomUUID(); store.createWorkConversation(conversationId, randomUUID(), name)
    const d: Delegation = { id: randomUUID(), conversationId, scope: { ...scope, constraints }, revision: 1, status: 'active', resumeRequired: false }
    store.insertDelegation(d); return d
  }
  const a = add('保密甲'), b = add('保密乙'), hotel = add('查询酒店')
  const action = (d: Delegation, facts = sendFacts): ActionDescriptor => ({ ...facts, id: randomUUID(), delegationId: d.id, scopeRevision: d.revision, adapterId: 'compiled', adapterRevision: '1', payloadHash: 'payload' })
  const input = (text: string, conversationId = daily.id) => ({ requestId: randomUUID(), conversationId, profileId: 'missing', content: text })
  const send = (text: string, conversationId = daily.id) => host.send(input(text, conversationId), () => {}, () => {}, 'test').catch(error => error)
  return { directory, path, store, profiles, host, daily, a, b, hotel, action, input, send, add }
}

it('stop_candidates_before_disambiguation synchronously blocks actual registry sends while reads continue', async () => {
  const f = fixture(), registry = new SimpleToolRegistry()
  let sends = 0, reads = 0
  registry.register({ name: 'send', description: 'send', parameters: { type: 'object' } }, async () => { sends++; return { content: [] } }, { describeAction: async () => sendFacts })
  registry.register({ name: 'read', description: 'read', parameters: { type: 'object' } }, async () => { reads++; return { content: [] } }, { describeAction: async () => readFacts })
  const control = f.send('先别发')
  // No await: missing the Host ingress barrier permits a send before classification/credentials resolve.
  expect(f.host.delegations.decide(f.action(f.a))).toBe('deny')
  expect(f.host.delegations.decide(f.action(f.b))).toBe('deny')
  const call = (name: string, d: Delegation) => {
    const context: ToolExecutionContext = { runId: 'run', conversationId: d.conversationId, callId: randomUUID(), signal: new AbortController().signal,
      delegationId: d.id, actionPolicy: f.host.delegations, describeAction: async () => f.action(d), authorize: async () => {} }
    return registry.execute(name, {}, context).catch(error => error)
  }
  await Promise.all([call('send', f.a), call('send', f.b), call('read', f.a), call('read', f.hotel)])
  expect(sends).toBe(0); expect(reads).toBe(2)
  await control
})

it.each(['先别发', '请暂时不要发送', '暂停发送', '先不要发出去'])('restricts supported stop clause %s without stopping same-delegation read', async text => {
  const f = fixture(); await f.send(text, f.a.conversationId)
  expect(f.host.delegations.decide(f.action(f.a))).toBe('deny')
  expect(f.host.delegations.decide(f.action(f.a, readFacts))).toBe('allow')
  expect(f.host.delegations.decide(f.action(f.b))).toBe('confirm')
  expect(f.store.getDelegation(f.a.id)?.status).toBe('active')
})
it.each(['这句‘先别发’怎么改写', '不用停，继续', '不要停，继续吧'])('quoted_stop_is_not_silent_cancel: %s', async text => {
  const f = fixture(); await f.send(text)
  expect(f.host.delegations.decide(f.action(f.a))).toBe('confirm')
  expect(f.store.listPriorityControls().every(value => value.status === 'ordinary')).toBe(true)
  expect(f.store.listDelegations().every(value => value.status === 'active')).toBe(true)
})
it('candidate selection narrows the original set and cannot grant scope', async () => {
  const f = fixture(); await f.send('先别发')
  const control = f.store.listPriorityControls()[0], later = f.add('后来出现')
  await expect(f.host.controls.resolve(control.id, { kind: 'pause', delegationIds: [later.id] })).rejects.toThrow('候选')
  await expect(f.host.controls.resolve(control.id, { kind: 'revise', delegationIds: [f.a.id], scope })).rejects.toThrow('原始')
  await f.host.controls.resolve(control.id, { kind: 'pause', delegationIds: [f.a.id] })
  expect(f.host.delegations.decide(f.action(f.a))).toBe('deny')
  expect(f.host.delegations.decide(f.action(f.b))).toBe('confirm')
  const reopened = new HerStore(f.path)
  try { expect(reopened.listPriorityControls()[0].heldDelegationIds).toEqual([f.a.id]) } finally { reopened.close() }
})
it('budget_revision_invalidates_approval and preserves old denials', async () => {
  const f = fixture(), d = f.add('预算工作', { budget: 900, currency: 'CNY' })
  f.host.delegations.reject(f.action(d))
  await f.send('把预算改成五百', d.conversationId)
  const revised = f.store.getDelegation(d.id)!
  expect(revised).toMatchObject({ revision: 2, resumeRequired: true, scope: { constraints: { budget: 500, currency: 'CNY' } } })
  expect(f.host.delegations.decide(f.action(d, readFacts))).toBe('deny')
  expect(f.store.listDelegationDenials(d.id)[0].withdrawal).toBeUndefined()
})
it('unsupported budget dimension and uncertain recipient remain held, never inventing financial or contact authority', async () => {
  const f = fixture(); await f.send('预算改成500', f.a.conversationId)
  expect(f.store.getDelegation(f.a.id)?.revision).toBe(1)
  expect(f.store.listPriorityControls()[0].status).toBe('waiting')
  await f.send('先别发给小王')
  expect(f.store.listPriorityControls()[1].targetIds).toBeUndefined()
  expect(f.host.delegations.decide(f.action(f.b))).toBe('deny')
})
it('idle control is persisted once in actual Pi history with a host status, no fabricated assistant message', async () => {
  const f = fixture(), input = f.input('先别发')
  const result = await f.host.send(input, () => {}, () => {}, 'test')
  const history = await openConversationHistory(f.directory, f.store.getConversation(f.daily.id)!)
  const actual = history.manager.getEntries().filter(entry => entry.type === 'message')
  expect(actual).toHaveLength(1)
  expect(actual[0]).toMatchObject({ message: { role: 'user', content: [{ type: 'text', text: '先别发' }] } })
  const messages = await f.host.getMessages(f.daily.id)
  expect(messages.map(value => value.id)).toEqual([result.userMessage.id, result.assistantMessage.id])
  expect(messages[1]).toMatchObject({ hostStatus: true })
  expect(f.store.listPriorityControls()[0].history).toBe('written')
})
it('control during actual Pi generation waits for the writer and keeps the original ordinary queue ordered', async () => {
  const f = fixture()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const server = await startFixtureServer('openai', 'text', { beforeReply: () => gate })
  cleanup.push(async () => { release(); await server.close() })
  const profile = await f.profiles.save({ name: 'local', protocol: 'openai', baseUrl: server.baseUrl + '/v1', model: 'test-model', contextWindow: 128000, authMethod: 'none' })
  const events: string[] = [], chat = new ChatService(f.store, f.host, () => {}, event => { if (event.state === 'completed') events.push(event.requestId) })
  const first = { ...f.input('普通问题'), profileId: profile.id }
  await chat.send(first)
  await expect.poll(() => server.requests.length).toBe(1)
  const controlInput = { ...f.input('先别发'), profileId: profile.id }
  await chat.send(controlInput)
  expect(f.store.listPriorityControls().find(value => value.intentId === controlInput.requestId)?.history).toBe('pending')
  const during = await openConversationHistory(f.directory, f.store.getConversation(f.daily.id)!)
  expect(JSON.stringify(during.manager.getEntries())).not.toContain('先别发')
  const ordinary = { ...f.input('这句‘先别发’怎么改写'), profileId: profile.id }
  expect((await chat.send(ordinary)).queued).toBe(true)
  release()
  await expect.poll(() => events.includes(ordinary.requestId), { timeout: 10_000 }).toBe(true)
  const after = await openConversationHistory(f.directory, f.store.getConversation(f.daily.id)!)
  const userTexts = after.manager.getEntries().flatMap(entry => entry.type === 'message' && entry.message.role === 'user' ? [entry.message.content] : [])
  expect(userTexts).toHaveLength(3)
  expect(JSON.stringify(userTexts[1])).toContain('先别发')
  expect(JSON.stringify(userTexts[2])).toContain('怎么改写')
  expect(server.requests).toHaveLength(2)
}, 15_000)

it('an uncertain hold can be clarified ordinary without reviving a previously approved call waiting on resources', async () => {
  const f = fixture(), registry = new SimpleToolRegistry()
  let waiting = false, sends = 0
  const resources = new ResourceQueue(), release = await resources.acquire(['contact'], new AbortController().signal)
  registry.register({ name: 'send', description: 'send', parameters: { type: 'object' } }, async () => { sends++; return { content: [] } },
    { describeAction: async () => sendFacts, resources: () => ['contact'] })
  const call = registry.execute('send', {}, { runId: 'run', conversationId: f.a.conversationId, callId: 'call', signal: new AbortController().signal,
    delegationId: f.a.id, actionPolicy: f.host.delegations, describeAction: async () => f.action(f.a), authorize: async () => {},
    resources, onWaitingResources: value => { waiting = value } }).catch(error => error)
  await expect.poll(() => waiting).toBe(true)
  await f.send('等一下')
  await f.host.controls.resolve(f.store.listPriorityControls()[0].id, { kind: 'ordinary', delegationIds: [] })
  release(); await call
  expect(sends).toBe(0)
})
it('explicit original-topic denial confirmation supplies the actual Host proof while preparation remains inert', async () => {
  const f = fixture(); f.host.delegations.reject(f.action(f.a))
  const denial = f.store.listDelegationDenials(f.a.id)[0]
  await f.send('重新允许这一步', f.a.conversationId)
  const control = f.store.listPriorityControls()[0], intent = f.store.getUserIntent(control.intentId)!
  const card = f.host.prepareDenialRevision(control.id, f.a.conversationId, f.a.id, 1, denial.id)
  expect(() => f.host.delegations.reviseDeniedStep(f.a.id, 1, denial.id, intent.id, [[0, intent.text.length]])).toThrow('可信')
  await expect(f.host.confirmDenialRevision(control.id, f.b.conversationId, card.revision)).rejects.toThrow('失效')
  await f.host.confirmDenialRevision(control.id, f.a.conversationId, card.revision)
  expect(f.store.getDelegation(f.a.id)).toMatchObject({ revision: 2, resumeRequired: true })
  expect(f.store.listDelegationDenials(f.a.id)[0].withdrawal).toMatchObject({ decision: 'withdraw-denial', intentId: intent.id })
  await expect(f.host.confirmDenialRevision(control.id, f.a.conversationId, card.revision)).rejects.toThrow('失效')
})
it('uncertain control selection can restrict the chosen candidate but cannot cancel or grant new scope', async () => {
  const f = fixture(); await f.send('等一下')
  const control = f.store.listPriorityControls()[0]
  await expect(f.host.controls.resolve(control.id, { kind: 'cancel', delegationIds: [f.a.id] })).rejects.toThrow()
  await f.host.controls.resolve(control.id, { kind: 'pause', delegationIds: [f.a.id] })
  expect(f.host.delegations.decide(f.action(f.a))).toBe('deny')
  expect(f.host.delegations.decide(f.action(f.b))).toBe('confirm')
})
it.each([['十万', 100000], ['一万五千', 15000], ['二五', undefined], ['五百二', undefined]] as const)('budget literal %s is exact or stays awaiting verification', async (literal, expected) => {
  const f = fixture(), d = f.add('数值预算', { budget: 900 })
  await f.send(`预算改成${literal}`, d.conversationId)
  const actual = f.store.getDelegation(d.id)!
  if (expected === undefined) expect(actual.revision).toBe(1)
  else expect(actual.scope.constraints.budget).toBe(expected)
})
it('ordinary work calls with no delegation binding cannot evade a candidate hold or smuggle another conversation identity', async () => {
  const f = fixture(), registry = new SimpleToolRegistry(); let sends = 0
  registry.register({ name: 'send', description: 'send', parameters: { type: 'object' } }, async () => { sends++; return { content: [] } }, { describeAction: async () => sendFacts })
  await f.send('先别发', f.a.conversationId)
  await registry.execute('send', { conversationId: f.b.conversationId }, { runId: 'ordinary', conversationId: f.a.conversationId,
    callId: 'ordinary', signal: new AbortController().signal, actionPolicy: f.host.delegations, authorize: async () => {} }).catch(error => error)
  expect(sends).toBe(0)
})
it.each(['known', 'unknown'] as const)('stop_after_dispatch_is_truthful: existing %s result remains and never replays', async outcome => {
  const f = fixture(), registry = new SimpleToolRegistry(), ledger = new ActionLedger(f.store)
  const runId = randomUUID(), requestId = f.store.enqueueInput(f.a.conversationId, '原始运行', null)
  f.store.createTask({ id: runId, conversationId: f.a.conversationId, requestId, generation: 0, status: 'running', serviceId: 'local', modelId: 'local', configRevision: 1, error: null })
  let dispatches = 0, release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  registry.register({ name: 'send', description: 'send', parameters: { type: 'object' } }, async () => {
    dispatches++; await pending
    if (outcome === 'unknown') throw new Error('lost response')
    return { content: [] }
  }, { describeAction: async () => sendFacts })
  const context: ToolExecutionContext = { runId, conversationId: f.a.conversationId, callId: 'dispatched', signal: new AbortController().signal,
    delegationId: f.a.id, actionPolicy: f.host.delegations, describeAction: async () => f.action(f.a), authorize: async () => {}, ledger }
  const execution = registry.execute('send', {}, context)
  await expect.poll(() => dispatches).toBe(1)
  const result = await f.send('先别发')
  expect(result.assistantMessage.content).toContain('已发生的动作不会撤回')
  release(); await execution
  expect(f.store.getToolCall(runId, 'dispatched')?.status).toBe(outcome === 'known' ? 'succeeded' : 'unknown')
  await registry.execute('send', {}, { ...context, callId: 'retry' }).catch(error => error)
  expect(dispatches).toBe(1)
})
it.each(['before-admission', 'approval-wait'] as const)('actual Host Pi %s stops effects and keeps private candidates out of the daily provider and notices', async mode => {
  const directory = mkdtempSync(join(tmpdir(), 'her-control-wire-')), store = new HerStore(join(directory, 'her.sqlite'))
  const daily = store.ensureDailyConversation(), registry = new SimpleToolRegistry(), requests: any[] = []
  let sends = 0, reads = 0, releaseAdmission!: () => void
  const admission = new Promise<void>(resolve => { releaseAdmission = resolve })
  registry.register({ name: 'send', description: 'send', parameters: { type: 'object' } }, async () => { sends++; return { content: [] } },
    { describeAction: async args => ({ ...sendFacts, targetId: String(args.target), target: args.target === 'person:a' ? '私密收件人甲' : '私密收件人乙', preview: { fields: [], finalText: '私密发送正文' } }) })
  registry.register({ name: 'query', description: 'query', parameters: { type: 'object' } }, async () => { reads++; return { content: [{ type: 'text', text: '公开价格' }] } }, { describeAction: async () => readFacts })
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body)
    const isDaily = body.tools.some((tool: any) => tool.function.name === 'delegate_work')
    const lastUser = body.messages.findLastIndex((message: any) => message.role === 'user')
    const raw = body.messages[lastUser]?.content
    const text = typeof raw === 'string' ? raw : raw?.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('') ?? '', previous = body.messages.slice(lastUser + 1).filter((message: any) => message.role === 'tool').length
    const name = isDaily ? previous === 0 && /^托付[甲乙]$/.test(text) ? 'delegate_work' : undefined : previous === 0 ? 'send' : previous === 1 ? 'query' : undefined
    if (mode === 'before-admission' && isDaily && name === 'delegate_work') await admission
    const args = isDaily ? { id: randomUUID(), scope, revision: 1, evidenceSpans: [[0, text.length]] } : { target: text.includes('甲') ? 'person:a' : 'person:b' }
    const delta = name ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${previous}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: '已处理' }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const part of [{ delta, finish_reason: null }, { delta: {}, finish_reason: name ? 'tool_calls' : 'stop' }]) res.write(`data: ${JSON.stringify({ id: 'reply', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, ...part }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const profiles = new ProfileService(store, { encrypt: async value => Buffer.from(value), decrypt: async value => value.toString() })
  const profile = await profiles.save({ name: 'local', protocol: 'openai', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: 'test', contextWindow: 128000, authMethod: 'none' })
  const host = new AgentHost(store, profiles, directory, async () => registry.snapshot(), undefined, undefined, undefined, { resolveScope: () => ({ scope }), revalidate: () => true })
  cleanup.push(async () => { releaseAdmission(); await host.stopAll(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(directory, { recursive: true, force: true }) })
  const done: string[] = [], chat = new ChatService(store, host, () => {}, event => { if (event.state === 'completed') done.push(event.requestId) })
  for (const content of ['托付甲', '托付乙']) {
    const requestId = randomUUID(); await chat.send({ requestId, conversationId: daily.id, profileId: profile.id, content })
    if (mode === 'approval-wait') await expect.poll(() => done.includes(requestId)).toBe(true)
  }
  if (mode === 'approval-wait') await expect.poll(() => store.listDelegations().filter(d => chat.getConversationTask(d.conversationId)?.approval).length).toBe(2)
  const work = store.listDelegations(), approvals = work.map(d => chat.getConversationTask(d.conversationId)!.approval!)
  const pending = chat.send({ requestId: randomUUID(), conversationId: daily.id, profileId: profile.id, content: '先别发' })
  for (const d of work) expect(host.delegations.decide({ ...sendFacts, id: 'next', delegationId: d.id, scopeRevision: d.revision, adapterId: 'compiled', adapterRevision: '1', payloadHash: 'x' })).toBe('deny')
  expect(sends).toBe(0)
  const control = (await pending).controlId!
  expect(control).toBeDefined()
  releaseAdmission()
  expect(host.controls.get(control).status).toBe('waiting')
  for (const request of approvals) await chat.decideApproval({ approvalId: request.id, revision: request.revision, decision: 'approve' })
  await expect.poll(() => reads).toBe(2)
  await expect.poll(() => store.listDelegations().length).toBe(2)
  await expect.poll(() => store.listDelegations().every(d => store.getLatestTask(d.conversationId)?.status === 'completed')).toBe(true)
  expect(sends).toBe(0)
  await chat.send({ requestId: randomUUID(), conversationId: daily.id, profileId: profile.id, content: '普通追问' })
  await expect.poll(() => requests.filter(body => body.tools.some((tool: any) => tool.function.name === 'delegate_work')).length).toBeGreaterThan(4)
  const dailyWire = JSON.stringify(requests.filter(body => body.tools.some((tool: any) => tool.function.name === 'delegate_work')))
  expect(dailyWire).not.toMatch(/私密收件人|私密发送正文/)
  expect(JSON.stringify(new WorkspaceService(store, chat).getPendingActions())).not.toMatch(/私密|person:|purpose|target|scope/)
}, 20_000)
it('opaque effects are held even with forged read and permission arguments; no repeated approval', async () => {
  const f = fixture(), registry = new SimpleToolRegistry(); let dispatches = 0, approvals = 0
  registry.register({ name: 'script', description: 'script', parameters: { type: 'object' } }, async () => { dispatches++; return { content: [] } })
  await f.send('先别发')
  await registry.execute('script', { effect: 'read', target: 'hotel', approved: true }, { runId: 'opaque', conversationId: f.a.conversationId, callId: 'opaque',
    signal: new AbortController().signal, delegationId: f.a.id, actionPolicy: f.host.delegations, describeAction: async () => f.action(f.a), authorize: async () => { approvals++ } }).catch(error => error)
  expect(dispatches).toBe(0); expect(approvals).toBe(0)
})
it('restart and later lifecycle revisions preserve the candidate effect hold while permitting independent reads', async () => {
  const f = fixture(); await f.send('先别发')
  const reopened = new HerStore(f.path)
  try {
    const service = new DelegationService(reopened, { revalidate: () => true })
    const resumed = service.resume(f.a.id, 1)
    expect(service.decide(f.action(resumed))).toBe('deny')
    expect(service.decide(f.action(resumed, readFacts))).toBe('allow')
    expect(reopened.listPriorityControls()[0].status).toBe('waiting')
  } finally { reopened.close() }
})
it('control history waits through actual Pi compaction and remains once after the checkpoint', async () => {
  const f = fixture(); let release!: () => void, requests = 0, block = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const server = await startFixtureServer('openai', 'text', { beforeReply: async () => { requests++; if (block) await gate } })
  cleanup.push(async () => { release(); await server.close() })
  const profile = await f.profiles.save({ name: 'local', protocol: 'openai', baseUrl: server.baseUrl + '/v1', model: 'test-model', contextWindow: 4096, authMethod: 'none' })
  const done: string[] = [], failures: string[] = [], chat = new ChatService(f.store, f.host, () => {}, event => { if (event.state === 'completed') done.push(event.requestId); if (event.state === 'failed') failures.push(event.error ?? 'failure') })
  for (let index = 0; index < 5; index++) {
    const input = { ...f.input(`${index}:` + 'lorem ipsum '.repeat(170), f.a.conversationId), profileId: profile.id }
    await chat.send(input); await expect.poll(() => done.includes(input.requestId) || failures.length > 0, { timeout: 10_000 }).toBe(true); expect(failures).toEqual([])
  }
  const beforeCount = requests; block = true
  const compacting = chat.compact({ conversationId: f.a.conversationId, profileId: profile.id }).catch(error => error)
  await expect.poll(() => requests).toBe(beforeCount + 1)
  const control = await chat.send({ ...f.input('先别发', f.a.conversationId), profileId: profile.id })
  expect(f.host.controls.get(control.controlId!).history).toBe('pending')
  const before = await openConversationHistory(f.directory, f.store.getConversation(f.a.conversationId)!)
  expect(JSON.stringify(before.manager.getEntries())).not.toContain('先别发')
  release(); expect(await compacting).toBeUndefined()
  const after = await openConversationHistory(f.directory, f.store.getConversation(f.a.conversationId)!)
  expect(after.manager.getEntries().filter(entry => entry.type === 'compaction')).toHaveLength(1)
  expect(after.manager.getEntries().filter(entry => entry.type === 'message' && entry.message.role === 'user' && JSON.stringify(entry.message.content).includes('先别发'))).toHaveLength(1)
  expect(f.host.controls.get(control.controlId!).history).toBe('written')
  expect(f.host.delegations.decide(f.action(f.a))).toBe('deny')
}, 20_000)
it('resolved local stop can be corrected as ordinary without canceling the delegation', async () => {
  const f = fixture(); const result = await f.send('先别发', f.a.conversationId)
  await f.host.resolveControl(result.controlId, { kind: 'ordinary', delegationIds: [] })
  expect(f.host.delegations.decide(f.action(f.a))).toBe('confirm')
  expect(f.store.getDelegation(f.a.id)?.status).toBe('active')
})
it('an explicit recipient resolves only from compiled stable identity facts and leaves proven other targets runnable', async () => {
  const f = fixture(), registry = new SimpleToolRegistry(); let writes = 0
  registry.register({ name: 'send', description: 'send', parameters: { type: 'object' } }, async () => { writes++; return { content: [] } },
    { describeAction: async args => ({ ...sendFacts, targetId: String(args.to), target: args.to === 'person:a' ? '小王' : '小李' }) })
  const call = (d: Delegation, to: string) => registry.execute('send', { to }, { runId: 'run', conversationId: d.conversationId, callId: randomUUID(),
    signal: new AbortController().signal, delegationId: d.id, actionPolicy: f.host.delegations, describeAction: async () => f.action(d), authorize: async () => {} }).catch(error => error)
  await call(f.a, 'person:a'); await call(f.b, 'person:b')
  const control = await f.send('先别发给小王')
  expect(f.host.controls.get(control.controlId).status).toBe('resolved')
  await call(f.a, 'person:a'); await call(f.b, 'person:b')
  expect(writes).toBe(3)
  expect(f.store.listDelegationActionFacts().every(value => !('preview' in value) && !('payload' in value))).toBe(true)
})
it('a known unrelated recipient already approved and waiting for resources continues', async () => {
  const f = fixture(), registry = new SimpleToolRegistry(), resources = new ResourceQueue(); let writes = 0, waiting = false
  // Compiled facts observed on an earlier real registry call, without copying its body.
  registry.register({ name: 'known', description: 'known', parameters: { type: 'object' } }, async () => ({ content: [] }), { describeAction: async () => sendFacts })
  await registry.execute('known', {}, { runId: 'known', conversationId: f.a.conversationId, callId: 'known', signal: new AbortController().signal,
    delegationId: f.a.id, actionPolicy: f.host.delegations, describeAction: async () => f.action(f.a), authorize: async () => {} })
  const release = await resources.acquire(['contact'], new AbortController().signal)
  registry.register({ name: 'other', description: 'other', parameters: { type: 'object' } }, async () => { writes++; return { content: [] } },
    { describeAction: async () => ({ ...sendFacts, targetId: 'person:b', target: '小李' }), resources: () => ['contact'] })
  const pending = registry.execute('other', {}, { runId: 'other', conversationId: f.b.conversationId, callId: 'other', signal: new AbortController().signal,
    delegationId: f.b.id, actionPolicy: f.host.delegations, describeAction: async () => f.action(f.b), authorize: async () => {}, resources, onWaitingResources: value => { waiting = value } }).catch(error => error)
  await expect.poll(() => waiting).toBe(true)
  await f.send('先别发给小王')
  release(); await pending
  expect(writes).toBe(1)
})
it('whole-task cancellation blocks unbound ordinary calls in the selected work owner', async () => {
  const f = fixture(), registry = new SimpleToolRegistry(); let writes = 0
  registry.register({ name: 'send', description: 'send', parameters: { type: 'object' } }, async () => { writes++; return { content: [] } }, { describeAction: async () => sendFacts })
  await f.send('取消这件事', f.a.conversationId)
  await registry.execute('send', {}, { runId: 'ordinary', conversationId: f.a.conversationId, callId: 'ordinary', signal: new AbortController().signal,
    actionPolicy: f.host.delegations, authorize: async () => {} }).catch(error => error)
  expect(writes).toBe(0)
})
it('control history waits while actual model-switch credential resolution owns the session', async () => {
  const f = fixture(); await f.host.stopAll()
  let release!: () => void, decrypting = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const profiles = new ProfileService(f.store, { encrypt: async value => Buffer.from(value), decrypt: async value => { decrypting = true; await gate; return value.toString() } })
  const profile = await profiles.save({ name: 'switch', protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'local', contextWindow: 128000, authMethod: 'api-key', apiKey: 'fixture' })
  const host = new AgentHost(f.store, profiles, f.directory)
  cleanup.push(async () => { release(); await host.stopAll() })
  await host.ready()
  const switching = host.switchModel({ conversationId: f.daily.id, profileId: profile.id })
  await expect.poll(() => decrypting).toBe(true)
  const control = await host.send({ ...f.input('先别发'), profileId: profile.id }, () => {}, () => {}, 'test')
  expect(host.controls.get(control.controlId!).history).toBe('pending')
  release(); await switching
  expect(host.controls.get(control.controlId!).history).toBe('written')
  const actual = await openConversationHistory(f.directory, f.store.getConversation(f.daily.id)!)
  expect(actual.manager.getEntries().filter(entry => entry.type === 'message' && entry.message.role === 'user')).toHaveLength(1)
})
it('a previously waiting scope inherits the frozen original-intent hold when its real delegation is created later', async () => {
  const f = fixture(), service = new DelegationService(f.store), intentId = randomUUID()
  f.store.saveUserIntent({ id: intentId, messageId: randomUUID(), conversationId: f.daily.id, text: '旧输入托付', source: 'user', kind: 'unclassified', spans: [] })
  const requestId = f.store.enqueueInput(f.daily.id, '旧输入托付', null, intentId)
  f.store.updateInputStatus(requestId, 'completed')
  service.admitIntent(f.store.getUserIntent(intentId)!, { id: 'late-scope', scope, revision: 1, evidenceSpans: [[0, 5]] })
  await f.send('先别发')
  const late = service.approveScope('late-scope', 1)
  expect(service.decide(f.action(late))).toBe('deny')
  expect(service.decide(f.action(late, readFacts))).toBe('allow')
})
it('a new independent real input after cancellation needs its own approval and does not inherit the old arrangement', async () => {
  const f = fixture(), registry = new SimpleToolRegistry(); let writes = 0, approvals = 0
  await f.send('取消这件事', f.a.conversationId)
  const intent = { id: randomUUID(), messageId: randomUUID(), conversationId: f.a.conversationId, text: '新的独立安排', source: 'user' as const, kind: 'unclassified' as const, spans: [] }
  f.store.saveUserIntent(intent)
  registry.register({ name: 'new_action', description: 'new', parameters: { type: 'object' } }, async () => { writes++; return { content: [] } }, { describeAction: async () => sendFacts })
  await registry.execute('new_action', {}, { runId: 'new', conversationId: f.a.conversationId, callId: 'new', signal: new AbortController().signal,
    intent, actionPolicy: f.host.delegations, authorize: async (_assessment, context) => { expect(f.host.delegations.decide(context.action!, intent)).toBe('confirm'); approvals++ } })
  expect(writes).toBe(1); expect(approvals).toBe(1)
  expect(f.store.getDelegation(f.a.id)?.status).toBe('cancelled')
})
it('model args and descriptor intent claims cannot substitute a new intent or forge the private local-admission closure', async () => {
  const f = fixture(), registry = new SimpleToolRegistry(); let writes = 0, approvals = 0
  const old = { id: randomUUID(), messageId: randomUUID(), conversationId: f.daily.id, text: '旧任务', source: 'user' as const, kind: 'unclassified' as const, spans: [] }
  f.store.saveUserIntent(old); f.store.enqueueInput(f.daily.id, old.text, null, old.id)
  await f.send('先别发')
  registry.register({ name: 'delegate_work', description: 'spoof', parameters: { type: 'object' } }, async () => { writes++; return { content: [] } },
    { describeAction: async () => ({ ...sendFacts, intentId: 'new', conversationId: f.b.conversationId }) })
  const context: ToolExecutionContext = { runId: 'old', conversationId: f.daily.id, callId: 'old', signal: new AbortController().signal, intent: old,
    actionPolicy: f.host.delegations, authorize: async () => { approvals++ } }
  await registry.execute('delegate_work', { intentId: 'new', localAdmission: true, candidate: true, effect: 'read' }, context).catch(error => error)
  registry.register({ name: 'script', description: 'script', parameters: { type: 'object' } }, async () => { writes++; return { content: [] } })
  await registry.execute('script', { approved: true, localAdmission: true }, context).catch(error => error)
  expect(writes).toBe(0); expect(approvals).toBe(0)
})
it('the final deferred dispatch check sees a control accepted while the executor was observing', async () => {
  const f = fixture(), registry = new SimpleToolRegistry(); let observing = false, effects = 0, release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  registry.register({ name: 'deferred', description: 'deferred', parameters: { type: 'object' } }, async (_args, context) => {
    observing = true; await gate; context.markDispatched?.('action'); effects++; return { content: [] }
  }, { describeAction: async () => sendFacts, deferDispatch: true })
  const pending = registry.execute('deferred', {}, { runId: 'deferred', conversationId: f.a.conversationId, callId: 'deferred', signal: new AbortController().signal,
    delegationId: f.a.id, actionPolicy: f.host.delegations, describeAction: async () => f.action(f.a), authorize: async () => {} })
  await expect.poll(() => observing).toBe(true)
  await f.send('先别发')
  release(); expect((await pending).isError).toBe(true); expect(effects).toBe(0)
})
it('restart after Pi append but before the SQLite history acknowledgement does not duplicate the actual user', async () => {
  const f = fixture(), result = await f.send('先别发')
  const control = f.host.controls.get(result.controlId)
  f.store.savePriorityControl({ ...control, history: 'pending' }, control.revision)
  await f.host.stopAll()
  const restarted = new AgentHost(f.store, f.profiles, f.directory)
  cleanup.push(() => restarted.stopAll())
  await restarted.ready()
  const history = await openConversationHistory(f.directory, f.store.getConversation(f.daily.id)!)
  expect(history.manager.getEntries().filter(entry => entry.type === 'message' && entry.message.role === 'user')).toHaveLength(1)
  expect(restarted.controls.get(control.id).history).toBe('written')
})
it('controls arriving while an idle writer is acknowledging earlier history are all drained before it releases ownership', async () => {
  const f = fixture(); await f.host.ready()
  const results: Promise<any>[] = []
  for (let index = 0; index < 12; index++) {
    results.push(f.send('先别发'))
    await Promise.resolve(); await Promise.resolve()
  }
  await Promise.all(results)
  expect(f.store.listPriorityControls().every(value => value.history === 'written')).toBe(true)
  const history = await openConversationHistory(f.directory, f.store.getConversation(f.daily.id)!)
  expect(history.manager.getEntries().filter(entry => entry.type === 'message' && entry.message.role === 'user')).toHaveLength(12)
})

it('a control admitted during an existing writer acknowledgement is not stranded pending', async () => {
  const f = fixture(); await f.host.ready()
  const save = f.store.savePriorityControl.bind(f.store)
  let later: Promise<any> | undefined
  f.store.savePriorityControl = (value, revision) => {
    const result = save(value, revision)
    if (value.history === 'written' && !later) later = f.send('暂缓发送')
    return result
  }
  await f.send('先别发'); await later
  expect(f.store.listPriorityControls().every(value => value.history === 'written')).toBe(true)
  const history = await openConversationHistory(f.directory, f.store.getConversation(f.daily.id)!)
  expect(history.manager.getEntries().filter(entry => entry.type === 'message' && entry.message.role === 'user')).toHaveLength(2)
})
it('an old input still preparing credentials is frozen before it has any queue row or delegation ID', async () => {
  const f = fixture(); await f.host.stopAll()
  let release!: () => void, decrypting = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const profiles = new ProfileService(f.store, { encrypt: async value => Buffer.from(value), decrypt: async value => { decrypting = true; await gate; return value.toString() } })
  const profile = await profiles.save({ name: 'preparing', protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'local', contextWindow: 128000, authMethod: 'api-key', apiKey: 'fixture' })
  const host = new AgentHost(f.store, profiles, f.directory)
  cleanup.push(async () => { release(); await host.stopAll() })
  await host.ready()
  const input = { ...f.input('旧的独立安排'), profileId: profile.id }
  const pending = host.send(input, () => {}, () => {}, 'test').catch(error => error)
  await expect.poll(() => decrypting).toBe(true)
  expect(f.store.getInput(input.requestId)).toBeNull()
  const control = await host.send({ ...f.input('先别发'), profileId: profile.id }, () => {}, () => {}, 'test')
  expect(host.controls.get(control.controlId!).candidateIntentIds).toContain(input.requestId)
  const registry = new SimpleToolRegistry(); let sends = 0, reads = 0
  registry.register({ name: 'send', description: 'send', parameters: { type: 'object' } }, async () => { sends++; return { content: [] } }, { describeAction: async () => sendFacts })
  registry.register({ name: 'read', description: 'read', parameters: { type: 'object' } }, async () => { reads++; return { content: [] } }, { describeAction: async () => readFacts })
  const context: ToolExecutionContext = { runId: 'preparing', conversationId: input.conversationId, callId: randomUUID(), signal: new AbortController().signal,
    intent: f.store.getUserIntent(input.requestId)!, actionPolicy: host.delegations, authorize: async () => {} }
  await registry.execute('send', {}, context).catch(error => error)
  await registry.execute('read', {}, { ...context, callId: randomUUID() })
  expect(sends).toBe(0); expect(reads).toBe(1)
  host.stopRequest(input.requestId); release(); await pending
  expect(host.controls.get(control.controlId!).history).toBe('written')
})
it('a persisted ingress barrier interrupted before interpretation remains safely selectable or releasable', async () => {
  const f = fixture(), response = await f.send('等等，我再想想')
  const control = f.host.controls.get(response.controlId)
  f.store.savePriorityControl({ ...control, status: 'classifying', kind: 'uncertain', revision: control.revision + 1 }, control.revision)
  expect(f.host.delegations.decide(f.action(f.a))).toBe('deny')
  await f.host.resolveControl(control.id, { kind: 'ordinary', delegationIds: [] })
  expect(f.host.delegations.decide(f.action(f.a))).toBe('confirm')
})
it.each(['credentials', 'approval'] as const)('ordinary continuation freezes its original intent during %s and holds later descendants', async mode => {
  const directory = mkdtempSync(join(tmpdir(), 'her-control-continue-')), store = new HerStore(join(directory, 'her.sqlite'))
  const daily = store.ensureDailyConversation(), registry = new SimpleToolRegistry()
  let sends = 0, reads = 0, requests = 0, heldCredentials = false, decrypting = false, release!: () => void
  const credentials = new Promise<void>(resolve => { release = resolve })
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume the local request */ }
    const request = ++requests, name = request === 2 ? 'send' : request === 3 ? 'query' : undefined
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const delta = name ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${request}`, type: 'function', function: { name, arguments: '{}' } }] } : { role: 'assistant', content: '继续核对' }
    res.write(`data: ${JSON.stringify({ id: 'reply', object: 'chat.completion.chunk', model: 'local', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
    if (request === 1) return // The original ordinary task is stopped before any business effect.
    res.write(`data: ${JSON.stringify({ id: 'reply', object: 'chat.completion.chunk', model: 'local', choices: [{ index: 0, delta: {}, finish_reason: name ? 'tool_calls' : 'stop' }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const profiles = new ProfileService(store, { encrypt: async value => Buffer.from(value), decrypt: async value => { if (heldCredentials) { decrypting = true; await credentials }; return value.toString() } })
  const profile = await profiles.save({ name: 'local', protocol: 'openai', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: 'local', contextWindow: 128000, authMethod: 'api-key', apiKey: 'local' })
  registry.register({ name: 'send', description: 'send', parameters: { type: 'object' } }, async () => { sends++; return { content: [] } }, { describeAction: async () => sendFacts })
  registry.register({ name: 'query', description: 'query', parameters: { type: 'object' } }, async () => { reads++; return { content: [] } }, { describeAction: async () => readFacts })
  const host = new AgentHost(store, profiles, directory, async () => registry.snapshot())
  cleanup.push(async () => { release(); await host.stopAll(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(directory, { recursive: true, force: true }) })
  const chat = new ChatService(store, host), originalId = randomUUID()
  await chat.send({ requestId: originalId, conversationId: daily.id, profileId: profile.id, content: '核对后准备发送' })
  await expect.poll(() => requests).toBe(1)
  host.stopRequest(originalId)
  await expect.poll(() => store.getLatestTask(daily.id)?.status).toBe('stopped')
  const originalTask = store.getLatestTask(daily.id)!, nextId = randomUUID()
  heldCredentials = mode === 'credentials'
  const continuing = chat.continueTask({ runId: originalTask.id, requestId: nextId, profileId: profile.id }).catch(error => error)
  if (mode === 'credentials') await expect.poll(() => decrypting).toBe(true)
  else { await continuing; await expect.poll(() => chat.getConversationTask(daily.id)?.approval).toBeDefined() }
  const oldApproval = chat.getConversationTask(daily.id)?.approval
  const controlRequestId = randomUUID()
  const controlling = chat.send({ requestId: controlRequestId, conversationId: daily.id, profileId: profile.id, content: '先别发' }).catch(error => error)
  expect(store.listPriorityControls().find(value => value.intentId === controlRequestId)?.candidateIntentIds).toEqual([originalId])
  const result = await controlling
  expect(result.controlId).toBeDefined()
  expect(store.getUserIntent(nextId)).toBeNull()
  heldCredentials = false; release(); await continuing
  if (oldApproval) await chat.decideApproval({ approvalId: oldApproval.id, revision: oldApproval.revision, decision: 'approve' })
  await expect.poll(() => chat.getConversationTask(daily.id)?.approval?.target).toBe('酒店')
  const readApproval = chat.getConversationTask(daily.id)!.approval!
  await chat.decideApproval({ approvalId: readApproval.id, revision: readApproval.revision, decision: 'approve' })
  await expect.poll(() => store.getLatestTask(daily.id)?.status).toBe('completed')
  expect(sends).toBe(0); expect(reads).toBe(1)
  const service = new DelegationService(store), intent = store.getUserIntent(originalId)!
  service.admitIntent(intent, { id: randomUUID(), scope, revision: 1, evidenceSpans: [[0, intent.text.length]] })
  const late = service.approveScope(store.getIntentControl(originalId)!.id, 1)
  const action: ActionDescriptor = { ...sendFacts, id: 'late', delegationId: late.id, scopeRevision: late.revision, adapterId: 'fixture', adapterRevision: '1', payloadHash: 'x' }
  expect(host.delegations.decide(action)).toBe('deny')
  expect(host.delegations.decide({ ...action, ...readFacts })).toBe('allow')
})
