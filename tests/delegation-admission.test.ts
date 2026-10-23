import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { HerStore } from '../src/core/storage/store'
import { ProfileService } from '../src/core/storage/profiles'
import { AgentHost } from '../src/core/agent/host'
import { ChatService } from '../src/core/conversation/chat'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import { WorkspaceService } from '../src/core/conversation/workspace'
import { DelegationService } from '../src/core/delegations/service'
import type { DelegationProducers, DelegationProposal, DelegationScope } from '../src/core/delegations/types'
import type { ChatEvent, RequestEvent } from '../src/shared/types'
import { fixtureWire, TOOL_NAME } from './pi-sdk/wire'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const scope: DelegationScope = { purpose: '酒店私密比较', objects: ['hotel:a', 'hotel:b'], completion: '比较表已保存', allowedCapabilities: ['http.read'], origins: ['https://example.test'], constraints: {} }
const proposal: DelegationProposal = { id: 'proposal', revision: 1, scope, evidenceSpans: [[0, 4]] }
const waitFor = async (condition: () => boolean) => { for (let i = 0; i < 300; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 10)) } throw new Error('fixture timed out') }

async function fixture(producers: DelegationProducers = {}, candidate = proposal, registry?: SimpleToolRegistry) {
  const directory = mkdtempSync(join(tmpdir(), 'her-admission-')), store = new HerStore(join(directory, 'her.sqlite'))
  const profiles = new ProfileService(store, { encrypt: async text => Buffer.from(text), decrypt: async bytes => bytes.toString() })
  const requests: Record<string, any>[] = []
  let workDispatchCount = 0
  let onWork: (() => void | Promise<void>) | undefined
  let onState: ((event: RequestEvent) => void) | undefined
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body)
    const daily = body.tools?.some((tool: any) => tool.function.name === 'delegate_work')
    if (!daily) { workDispatchCount++; await onWork?.() }
    const first = daily && !body.messages.some((message: any) => message.role === 'tool')
    const wire = first ? fixtureWire('openai', 'multi-tool').replaceAll(TOOL_NAME, 'delegate_work')
      .replaceAll('{\\"ok\\":true}', JSON.stringify(candidate).replaceAll('"', '\\"'))
      .replaceAll('{\\"ok\\":false}', JSON.stringify({ ...candidate, id: 'duplicate-proposal' }).replaceAll('"', '\\"')) : fixtureWire('openai', registry && !daily && !body.messages.some((message: any) => message.role === 'tool') ? 'tool' : 'text')
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(wire)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const profile = await profiles.save({ name: 'fixture', protocol: 'openai', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'test-model', contextWindow: 128000, authMethod: 'none' })
  const host = new AgentHost(store, profiles, directory, registry ? async () => registry.snapshot() : undefined, undefined, undefined, undefined, producers)
  const events: ChatEvent[] = [], states: RequestEvent[] = []
  const chat = new ChatService(store, host, event => events.push(event), event => { states.push(event); onState?.(event) })
  const workspace = new WorkspaceService(store, chat), daily = store.ensureDailyConversation().id
  await workspace.select({ section: 'daily' })
  cleanups.push(async () => { await host.stopAll(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(directory, { recursive: true, force: true }) })
  const send = () => chat.send({ requestId: randomUUID(), conversationId: daily, profileId: profile.id, content: '比较这两家酒店' })
  return { host, chat, workspace, store, daily, profile, profiles, directory, events, states, requests, send, dispatchCount: () => workDispatchCount, beforeWorkReply: (callback: () => void | Promise<void>) => { onWork = callback }, observeRequests: (callback: (event: RequestEvent) => void) => { onState = callback } }
}

it('daily_request_admits_work_without_switching_daily', async () => {
  // Injected trusted producer verifies wiring; production semantic resolution is unavailable in B1.
  const f = await fixture({ resolveScope: intent => intent.text === '比较这两家酒店' ? { scope } : null })
  const result = await f.send()
  await waitFor(() => f.states.filter(state => state.state === 'completed').length === 2)
  const controls = f.store.listDelegationControls()
  expect(controls).toHaveLength(1)
  expect(f.dispatchCount()).toBe(1)
  expect(result.userMessage.conversationId).toBe(f.daily)
  const control = controls[0], task = f.store.getLatestTask(control.conversationId)!
  expect(f.store.getDelegationForRun(task.id)?.id).toBe(control.delegationId)
  expect(f.host.delegations.get(control.delegationId!).status).toBe('active')
  expect(f.store.getDelegationInput(task.requestId)?.intentId).toBe(control.intentId)
  expect(f.store.getUserIntent(control.intentId)?.kind).toBe('delegate')
  expect(f.workspace.routeChat(f.events.find(event => event.conversationId === control.conversationId)!)).toBeNull()
  expect(() => f.workspace.assertSelected(f.daily)).not.toThrow()
  const dailyFollowup = f.requests.find(body => body.messages.some((message: any) => message.role === 'tool'))!
  const results = dailyFollowup.messages.filter((message: any) => message.role === 'tool')
  expect(results).toHaveLength(2)
  expect(JSON.stringify(results)).not.toContain(control.conversationId)
  expect(JSON.stringify(results)).not.toContain('酒店私密比较')
  expect(JSON.stringify(results)).not.toContain(control.delegationId!)
})

it('proposal_cannot_expand_user_authority_and_ambiguous_scope_waits_before_run', async () => {
  const f = await fixture({}, { ...proposal, scope: { ...scope, allowedCapabilities: ['submit.personal-data'] } })
  await f.send()
  await waitFor(() => f.states.some(state => state.state === 'completed'))
  expect(f.dispatchCount()).toBe(0)
  const control = f.store.listDelegationControls()[0]
  expect(control.status).toBe('waiting')
  expect(control.delegationId).toBeUndefined()
  expect(f.store.getLatestTask(control.conversationId)).toBeNull()
  const notices = f.workspace.getPendingActions()
  expect(notices).toHaveLength(1)
  expect(Object.keys(notices[0]).sort()).toEqual(['id', 'status', 'version'])
  expect(JSON.stringify(notices)).not.toContain(control.conversationId)
  expect(await f.workspace.resolvePendingAction({ id: notices[0].id, version: notices[0].version })).toEqual({ conversationId: control.conversationId })
  expect(() => f.workspace.assertSelected(control.conversationId)).toThrow()
  const d = f.chat.approveDelegationScope(control.id, 1)
  expect(f.chat.approveDelegationScope(control.id, 1).id).toBe(d.id)
  await waitFor(() => f.dispatchCount() === 1)
  expect(f.store.listDelegationControls()).toHaveLength(1)
  expect(f.workspace.getPendingActions().some(notice => notice.status === 'waiting_approval')).toBe(false)
})

it('rejected_candidate_grants_nothing_and_invalid_evidence_cannot_admit', async () => {
  const f = await fixture()
  await f.send(); await waitFor(() => f.store.listDelegationControls().length === 1)
  const control = f.store.listDelegationControls()[0]
  f.host.delegations.rejectScope(control.id, 1)
  expect(() => f.host.delegations.approveScope(control.id, 1)).toThrow()
  expect(f.dispatchCount()).toBe(0)
  expect(f.workspace.getPendingActions()).toHaveLength(0)
  const raw = f.store.getUserIntent(control.intentId)!
  expect(() => new DelegationService(f.store).admitIntent({ ...raw, text: 'forged' }, proposal)).toThrow()
})

it('raw_intent_is_saved_unclassified_and_model_cannot_choose_its_message_id', async () => {
  const f = await fixture({}, { ...proposal, messageId: 'forged' } as DelegationProposal)
  const result = await f.send()
  const dailyInput = f.store.getLatestTask(f.daily)!.requestId
  expect(f.store.getUserIntent(dailyInput)).toMatchObject({ messageId: result.userMessage.id, source: 'user', kind: 'unclassified', text: '比较这两家酒店' })
  await waitFor(() => f.states.some(state => ['completed', 'failed'].includes(state.state)))
  expect(f.store.listDelegationControls()).toHaveLength(0)
  expect(f.dispatchCount()).toBe(0)
})

it('continuation_revalidates_current_scope_preserves_intent_and_attaches_new_run', async () => {
  let allowed = false
  const f = await fixture({ resolveScope: () => ({ scope }), revalidate: () => allowed })
  await f.send(); await waitFor(() => f.states.filter(state => state.state === 'completed').length === 2)
  const control = f.store.listDelegationControls()[0], task = f.store.getLatestTask(control.conversationId)!
  f.store.updateTaskStatus(task.id, 'interrupted')
  const d = f.host.delegations.get(control.delegationId!)
  f.host.delegations.pause(d.id, d.revision)
  const input = { runId: task.id, requestId: randomUUID(), profileId: f.profile.id }
  await expect(f.chat.continueTask(input)).rejects.toThrow('重新核对')
  expect(f.dispatchCount()).toBe(1)
  allowed = true
  await f.chat.continueTask(input)
  await waitFor(() => f.dispatchCount() === 2)
  const next = f.store.getLatestTask(control.conversationId)!
  expect(next.continuationOf).toBe(task.id)
  expect(f.store.getDelegationForRun(next.id)?.id).toBe(d.id)
  expect(f.store.getDelegationInput(next.requestId)?.intentId).toBe(control.intentId)
  expect(next.id).not.toBe(task.id)
  expect(f.host.delegations.get(d.id)).toMatchObject({ status: 'active', resumeRequired: false })
})

it('paused_delegation_without_a_run_remains_findable_from_daily', async () => {
  const f = await fixture()
  await f.send(); await waitFor(() => f.states.some(state => state.state === 'completed'))
  const control = f.store.listDelegationControls()[0]
  // No producer dispatch: lifecycle service grants and pauses without creating a fake task.
  const service = new DelegationService(f.store)
  const d = service.approveScope(control.id, 1)
  service.pause(d.id, 1)
  expect(f.store.getLatestTask(d.conversationId)).toBeNull()
  const notices = f.workspace.getPendingActions()
  expect(notices).toHaveLength(1)
  expect(notices[0].status).toBe('paused')
  expect(await f.workspace.resolvePendingAction({ id: notices[0].id, version: notices[0].version })).toEqual({ conversationId: d.conversationId })
})


it('cancelled_delegation_invalidates_the_running_host_before_next_tool_dispatch', async () => {
  let actions = 0
  const registry = new SimpleToolRegistry()
  registry.register({ name: TOOL_NAME, description: 'local fixture read', parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } },
    async () => { actions++; return { content: [{ type: 'text', text: 'observed' }] } },
    { assess: async () => ({ effect: 'read', target: 'fixture', summary: 'read fixture' }) })
  const f = await fixture({ resolveScope: () => ({ scope }) }, proposal, registry)
  f.beforeWorkReply(() => {
    const d = f.host.delegations.get(f.store.listDelegationControls()[0].delegationId!)
    if (d.status === 'active') f.chat.cancelDelegation(d.id, d.revision)
  })
  await f.send()
  await waitFor(() => f.states.filter(state => ['completed', 'failed', 'cancelled'].includes(state.state)).length === 2)
  expect(actions).toBe(0)
  const d = f.store.listDelegations()[0]
  expect(f.store.getLatestTask(d.conversationId)?.status).toBe('stopped')
})

it('explicit_resume_of_proven_unstarted_admission_reuses_intent_once', async () => {
  const f = await fixture({ revalidate: () => true })
  await f.send(); await waitFor(() => f.states.some(state => state.state === 'completed'))
  const control = f.store.listDelegationControls()[0]
  await f.host.stopAll()
  const replacement = new AgentHost(f.store, f.profiles, f.directory, undefined, undefined, undefined, undefined, { revalidate: () => true })
  cleanups.push(() => replacement.stopAll())
  // A real missing event sink fails before Host.sendInput and before any business run exists.
  replacement.delegations.approveScope(control.id, 1)
  const paused = replacement.delegations.get(f.store.getDelegationControl(control.id)!.delegationId!)
  expect(paused.status).toBe('paused')
  expect(f.store.getTaskByRequest(control.requestId)).toBeNull()
  const chat = new ChatService(f.store, replacement)
  await chat.resumeDelegation(paused.id, paused.revision)
  await expect(chat.resumeDelegation(paused.id, paused.revision)).rejects.toThrow()
  await waitFor(() => f.dispatchCount() === 1)
  const task = f.store.getLatestTask(paused.conversationId)!
  expect(f.store.getDelegationInput(task.requestId)?.intentId).toBe(control.intentId)
  expect(f.store.listTopicInfo().filter(topic => topic.kind === 'work')).toHaveLength(1)
  await waitFor(() => f.store.getTask(task.id)?.status === 'completed')
  // A fresh B7 card may continue an unfinished commission after its first run completes.
  const currentRevision = replacement.delegations.get(paused.id).revision
  await chat.resumeDelegation(paused.id, currentRevision)
  await expect(chat.resumeDelegation(paused.id, currentRevision)).rejects.toThrow()
  await waitFor(() => f.dispatchCount() === 2 && f.store.getLatestTask(paused.conversationId)?.status === 'completed')
  const continued = f.store.getLatestTask(paused.conversationId)!
  expect(continued.continuationOf).toBe(task.id)
  expect(f.store.getDelegationForRun(continued.id)?.id).toBe(paused.id)
  expect(f.store.getDelegationInput(continued.requestId)?.intentId).toBe(control.intentId)
  expect(f.store.listTopicInfo().filter(topic => topic.kind === 'work')).toHaveLength(1)
  replacement.delegations.cancel(paused.id, replacement.delegations.get(paused.id).revision)
  await expect(chat.resumeDelegation(paused.id, replacement.delegations.get(paused.id).revision)).rejects.toThrow()
})

it('terminal_delegation_hides_stopped_pending_but_preserves_unknown_action', async () => {
  const f = await fixture({ resolveScope: () => ({ scope }) })
  await f.send(); await waitFor(() => f.states.filter(state => state.state === 'completed').length === 2)
  const d = f.host.delegations.get(f.store.listDelegationControls()[0].delegationId!), task = f.store.getLatestTask(d.conversationId)!
  f.store.updateTaskStatus(task.id, 'stopped')
  f.host.delegations.cancel(d.id, d.revision)
  expect(f.workspace.getPendingActions()).toHaveLength(0)
  await expect(f.chat.continueTask({ runId: task.id, requestId: randomUUID(), profileId: f.profile.id })).rejects.toThrow('已经结束')
  f.store.insertToolCall({ taskId: task.id, callId: 'unknown-call', toolName: 'fixture-action', args: '{}', effect: 'unknown', target: 'fixture-target' })
  f.store.updateToolCall(task.id, 'unknown-call', { status: 'unknown' })
  f.store.quarantineTarget('fixture-target', d.conversationId, task.id, 'unknown-call')
  expect(f.workspace.getPendingActions().map(notice => notice.status)).toEqual(['unknown'])
})

it('run_scope_revision_remains_the_admitted_revision_after_scope_changes', async () => {
  const f = await fixture({ resolveScope: () => ({ scope }) })
  await f.send(); await waitFor(() => f.states.filter(state => state.state === 'completed').length === 2)
  const d = f.host.delegations.get(f.store.listDelegationControls()[0].delegationId!), task = f.store.getLatestTask(d.conversationId)!
  f.store.updateTaskStatus(task.id, 'stopped')
  f.host.delegations.revise(d.id, 1, { ...scope, constraints: { nights: 2 } })
  expect(f.chat.getConversationTask(d.conversationId)?.run.scopeRevision).toBe(1)
})

it('completed_run_with_unfinished_delegation_is_visible_and_explicitly_continuable', async () => {
  const f = await fixture({ resolveScope: () => ({ scope }), revalidate: () => true })
  await f.send(); await waitFor(() => f.states.filter(state => state.state === 'completed').length === 2)
  const d = f.host.delegations.get(f.store.listDelegationControls()[0].delegationId!), first = f.store.getLatestTask(d.conversationId)!
  expect(first.status).toBe('completed')
  expect(d.status).toBe('active')
  expect(f.chat.getConversationTask(d.conversationId)?.run).toMatchObject({ id: first.id, status: 'completed', delegationId: d.id, scopeRevision: 1 })
  const notices = f.workspace.getPendingActions()
  expect(notices).toHaveLength(1)
  expect(notices[0].status).toBe('paused')
  expect(await f.workspace.resolvePendingAction({ id: notices[0].id, version: notices[0].version })).toEqual({ conversationId: d.conversationId })
  expect(() => f.workspace.assertSelected(d.conversationId)).toThrow()
  const dailyTask = f.store.getLatestTask(f.daily)!
  await expect(f.chat.continueTask({ runId: dailyTask.id, requestId: randomUUID(), profileId: f.profile.id })).rejects.toThrow()
  await f.chat.continueTask({ runId: first.id, requestId: randomUUID(), profileId: f.profile.id })
  await waitFor(() => f.states.filter(state => state.state === 'completed').length === 3)
  const second = f.store.getLatestTask(d.conversationId)!
  expect(second.continuationOf).toBe(first.id)
  expect(f.store.getDelegationRun(second.id)).toEqual({ delegationId: d.id, scopeRevision: 2 })
  expect(f.store.getDelegationInput(second.requestId)?.intentId).toBe(f.store.getDelegationInput(first.requestId)?.intentId)
  expect(f.dispatchCount()).toBe(2)
  f.host.delegations.cancel(d.id, 2)
  await expect(f.chat.continueTask({ runId: second.id, requestId: randomUUID(), profileId: f.profile.id })).rejects.toThrow()
  expect(f.workspace.getPendingActions()).toHaveLength(0)
})

it('current delegation card continues after a later completed ordinary turn using current history and original intent', async () => {
  const f = await fixture({ resolveScope: () => ({ scope }), revalidate: () => true })
  await f.send(); await waitFor(() => f.states.filter(state => state.state === 'completed').length === 2)
  const d = f.store.listDelegations()[0], first = f.store.getLatestDelegationTask(d.id)!
  const original = f.store.getDelegationInput(first.requestId)!
  await f.workspace.select({ section: 'work', conversationId: d.conversationId })
  await f.chat.send({ requestId: randomUUID(), conversationId: d.conversationId, profileId: f.profile.id, content: '这条普通问答应保留在当前历史中' })
  await waitFor(() => f.states.filter(state => state.state === 'completed').length === 3)
  const ordinary = f.store.getLatestTask(d.conversationId)!
  expect(f.store.getDelegationForRun(ordinary.id)).toBeNull()
  expect(f.chat.getDelegationDetails(d.conversationId).delegations[0].canResume).toBe(true)
  expect(f.workspace.getPendingActions()).toHaveLength(1)
  // The old run-level shortcut does not acquire the current card's authority.
  await expect(f.chat.continueTask({ runId: first.id, requestId: randomUUID(), profileId: f.profile.id })).rejects.toThrow()
  await f.chat.resumeDelegation(d.id, d.revision, () => f.workspace.assertSelected(d.conversationId))
  await waitFor(() => f.states.filter(state => state.state === 'completed').length === 4)
  const continued = f.store.getLatestTask(d.conversationId)!
  expect(continued.continuationOf).toBe(first.id)
  expect(f.store.getDelegationForRun(continued.id)?.id).toBe(d.id)
  expect(f.store.getDelegationInput(continued.requestId)).toEqual(original)
  expect(JSON.stringify(f.requests.at(-1))).toContain('这条普通问答应保留在当前历史中')
  expect(JSON.stringify(f.requests.at(-1))).toContain(`继续完成当前已确认范围内的委托：${scope.purpose}`)
  expect(f.store.listTopicInfo().filter(topic => topic.kind === 'work')).toHaveLength(1)
})

it.each(['stopped', 'failed', 'interrupted'] as const)('%s delegation remains discoverable after a later completed ordinary turn', async status => {
  const f = await fixture({ resolveScope: () => ({ scope }) })
  await f.send(); await waitFor(() => f.states.filter(state => state.state === 'completed').length === 2)
  const d = f.store.listDelegations()[0], original = f.store.getLatestDelegationTask(d.id)!
  // Seed the persisted final status produced by normal stop/failure/recovery; D stays active.
  f.store.updateTaskStatus(original.id, status)
  expect(f.workspace.getPendingActions()).toHaveLength(1) // The existing task notice is not duplicated.
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  f.beforeWorkReply(() => waiting)
  await f.chat.send({ requestId: randomUUID(), conversationId: d.conversationId, profileId: f.profile.id, content: '随后独立普通问答' })
  await waitFor(() => f.dispatchCount() === 2)
  expect(f.chat.getPendingDelegationActions().some(entry => entry.id === `delegation:${d.id}`)).toBe(false)
  release()
  await waitFor(() => f.states.filter(state => state.state === 'completed').length === 3)
  expect(f.store.getDelegationForRun(f.store.getLatestTask(d.conversationId)!.id)).toBeNull()
  expect(f.chat.getDelegationDetails(d.conversationId).delegations[0].canResume).toBe(true)
  const notices = f.workspace.getPendingActions()
  expect(notices).toHaveLength(1)
  expect(Object.keys(notices[0]).sort()).toEqual(['id', 'status', 'version'])
  expect(notices[0].status).toBe('paused')
  expect(JSON.stringify(notices)).not.toMatch(/酒店|私密|hotel:/)
  expect(await f.workspace.resolvePendingAction({ id: notices[0].id, version: notices[0].version })).toEqual({ conversationId: d.conversationId })
})

it('delegation continuation notice preserves owner terminal run and unknown recovery exclusions', async () => {
  const f = await fixture({ resolveScope: () => ({ scope }) })
  await f.send(); await waitFor(() => f.states.filter(state => state.state === 'completed').length === 2)
  const d = f.store.listDelegations()[0], original = f.store.getLatestDelegationTask(d.id)!
  f.store.updateTaskStatus(original.id, 'failed')
  const otherOwner = randomUUID(); f.store.createWorkConversation(otherOwner, randomUUID(), '另一个私密话题')
  const addRun = (owner: string, delegationId?: string) => {
    const requestId = f.store.enqueueInput(owner, '已完成普通问答', null), id = randomUUID()
    f.store.createTask({ id, conversationId: owner, requestId, generation: 0, status: 'completed', serviceId: f.profile.id, modelId: 'test-model', configRevision: 1, error: null }, delegationId ? { delegationId, scopeRevision: 1 } : undefined)
    f.store.updateInputStatus(requestId, 'completed')
    return id
  }
  const otherRun = addRun(otherOwner)
  expect(f.chat.getPendingDelegationActions().some(entry => entry.id === `delegation:${d.id}`)).toBe(false)
  expect(f.workspace.getPendingActions()).toHaveLength(1) // Only D's old task notice, not the other owner.
  const ordinary = addRun(d.conversationId)
  const ownNotice = () => f.chat.getPendingDelegationActions().filter(entry => entry.id === `delegation:${d.id}`)
  expect(ownNotice()).toHaveLength(1)
  f.store.updateTaskStatus(ordinary, 'running')
  expect(ownNotice()).toHaveLength(0)
  f.store.updateTaskStatus(ordinary, 'completed')
  for (const status of ['completed', 'cancelled'] as const) {
    const current = f.store.getDelegation(d.id)!
    f.store.updateDelegation({ ...current, status, revision: current.revision + 1 }, current.revision)
    expect(ownNotice()).toHaveLength(0)
  }
  const terminal = f.store.getDelegation(d.id)!
  f.store.updateDelegation({ ...terminal, status: 'active', revision: terminal.revision + 1 }, terminal.revision)
  f.store.quarantineTarget(scope.objects[0], otherOwner, otherRun, 'scope-quarantine')
  expect(ownNotice()).toHaveLength(0)
  f.store.releaseTarget(scope.objects[0], 'observed')
  f.store.insertToolCall({ taskId: original.id, callId: 'unknown-call', toolName: 'fixture-action', args: '{}', effect: 'unknown', target: scope.objects[0] })
  f.store.updateToolCall(original.id, 'unknown-call', { status: 'unknown' })
  expect(ownNotice()).toHaveLength(0)
  const unknown = f.workspace.getPendingActions()
  expect(unknown.map(notice => notice.status)).toEqual(['unknown'])
  expect(await f.workspace.resolvePendingAction({ id: unknown[0].id, version: unknown[0].version })).toEqual({ conversationId: d.conversationId })
  const call = f.store.listUnresolvedToolCalls(d.conversationId)[0]
  f.store.resolveToolCall({ conversationId: d.conversationId, ...call, decision: 'abandoned' })
  const sibling = { ...f.store.getDelegation(d.id)!, id: randomUUID(), revision: 1 }
  f.store.insertDelegation(sibling)
  addRun(d.conversationId, sibling.id)
  f.store.updateDelegation({ ...sibling, status: 'completed', revision: 2 }, 1)
  expect(ownNotice()).toHaveLength(0)
  expect(f.workspace.getPendingActions()).toHaveLength(0)
})


it('queued_delegation_admission_failure_is_persisted_before_publication_and_explicitly_resumed_once', async () => {
  const workId = randomUUID()
  const f = await fixture({ resolveScope: () => ({ scope, topicId: workId }), revalidate: () => true })
  f.store.createWorkConversation(workId, randomUUID(), '已有私密工作')
  const savedB = f.store.getService(f.profile.id)!
  const profileA = await f.profiles.save({ name: 'profile A', protocol: 'openai', baseUrl: savedB.baseUrl, model: 'test-model', contextWindow: 128000, authMethod: 'none' })
  let releaseA!: () => void
  const heldA = new Promise<void>(resolve => { releaseA = resolve })
  f.beforeWorkReply(async () => { if (f.dispatchCount() === 1) await heldA })
  const requestA = randomUUID()
  await f.chat.send({ requestId: requestA, conversationId: workId, profileId: profileA.id, content: '已有工作' })
  await waitFor(() => f.dispatchCount() === 1)
  await f.send()
  await waitFor(() => f.states.some(state => state.conversationId === f.daily && state.state === 'completed'))
  const original = f.store.listDelegationControls()[0]
  await waitFor(() => f.store.getInput(original.requestId)?.status === 'pending')
  expect(original.conversationId).toBe(workId)
  expect(f.store.getTaskByRequest(original.requestId)).toBeNull()
  const failureReads: { dispatch: string; status: string; notices: ReturnType<WorkspaceService['getPendingActions']> }[] = []
  f.observeRequests(event => {
    if (event.requestId === original.requestId && event.state === 'failed') failureReads.push({
      dispatch: f.store.getDelegationControl(original.id)!.dispatch,
      status: f.host.delegations.get(original.delegationId!).status,
      notices: f.workspace.getPendingActions()
    })
  })
  f.profiles.delete(f.profile.id)
  releaseA()
  await waitFor(() => failureReads.length > 0)
  expect(failureReads).toHaveLength(1)
  expect(failureReads[0]).toMatchObject({ dispatch: 'failed', status: 'paused' })
  expect(failureReads[0].notices).toHaveLength(1)
  const notice = failureReads[0].notices[0]
  expect(Object.keys(notice).sort()).toEqual(['id', 'status', 'version'])
  expect(notice.status).toBe('paused')
  expect(await f.workspace.resolvePendingAction({ id: notice.id, version: notice.version })).toEqual({ conversationId: workId })
  expect(f.store.getInput(original.requestId)?.status).toBe('cancelled')
  expect(f.store.getTaskByRequest(original.requestId)).toBeNull()
  expect(f.store.getLatestTask(workId)?.requestId).toBe(requestA)
  expect(f.dispatchCount()).toBe(1)
  const persisted = new HerStore(join(f.directory, 'her.sqlite'))
  expect(persisted.getDelegationControl(original.id)?.dispatch).toBe('failed')
  expect(persisted.getDelegation(original.delegationId!)?.status).toBe('paused')
  persisted.close()
  const intent = f.store.getUserIntent(original.intentId)!
  f.host.delegations.admitIntent(intent, { ...proposal, id: 'repeat-after-failure' })
  f.chat.approveDelegationScope(original.id, original.revision)
  expect(f.dispatchCount()).toBe(1)
  expect(f.store.getDelegationControl(original.id)?.requestId).toBe(original.requestId)
  f.store.saveService(savedB)
  const paused = f.host.delegations.get(original.delegationId!)
  await f.chat.resumeDelegation(paused.id, paused.revision)
  await expect(f.chat.resumeDelegation(paused.id, paused.revision)).rejects.toThrow()
  await waitFor(() => f.dispatchCount() === 2 && f.store.getLatestTask(workId)?.status === 'completed')
  const resumed = f.store.getLatestTask(workId)!
  expect(resumed.requestId).not.toBe(original.requestId)
  expect(f.store.getDelegationInput(resumed.requestId)).toEqual({ intentId: original.intentId, delegationId: paused.id })
  expect(f.store.getDelegationForRun(resumed.id)?.id).toBe(paused.id)
  expect(f.store.listDelegationControls()).toHaveLength(1)
  expect(f.store.listTopicInfo().filter(topic => topic.kind === 'work')).toHaveLength(1)
  f.host.delegations.admitIntent(intent, { ...proposal, id: 'repeat-after-resume' })
  f.chat.approveDelegationScope(original.id, original.revision)
  expect(f.dispatchCount()).toBe(2)
})
