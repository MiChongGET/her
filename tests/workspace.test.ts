import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HerStore } from '../src/core/storage/store'
import { ChatService } from '../src/core/conversation/chat'
import type { AgentHost } from '../src/core/agent/host'
import { WorkspaceService } from '../src/core/conversation/workspace'
import type { ChatMessage, TaskEvent, WorkspaceSelection } from '../src/shared/types'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
const message = (conversationId: string, content: string): ChatMessage => ({ id: randomUUID(), conversationId, role: 'user', content, status: 'complete', createdAt: new Date().toISOString() })
const task = (conversationId: string, status: TaskEvent['run']['status'] = 'waiting_approval'): TaskEvent => ({
  conversationId, requestId: 'request-1', runId: 'run-1', generation: 1, seq: 1,
  run: { id: 'run-1', requestId: 'request-1', conversationId, assistantMessageId: 'assistant-1', status, providerId: 'p', model: 'm', activeMs: 1, toolCallsCount: 1 },
  ...(status === 'waiting_approval' ? { approval: { purpose: '执行请求', preview: { fields: [] }, dataClasses: [], scopeSummary: '本次', actionLabel: '确认', id: 'approval-1', runId: 'run-1', callId: 'call-1', revision: 'revision-1', target: '对象秘密哨兵', summary: '审批秘密哨兵' } } : {})
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'her-workspace-'))
  const store = new HerStore(join(directory, 'her.sqlite'))
  cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  const daily = store.ensureDailyConversation().id
  // Persisted pre-workspace IDs are not necessarily UUIDs.
  const work = 'legacy-compatible-work'
  store.createWorkConversation(work, randomUUID(), '标题秘密哨兵')
  store.createConversation('history', randomUUID(), '日常')
  store.replaceMessageProjection(work, [{ entryId: 'private', message: message(work, '正文秘密哨兵') }], 'private')
  const tasks = new Map<string, TaskEvent>(), reads: string[] = []
  let readMessages = async (id: string) => store.getMessages(id)
  // Only the Pi/Host boundary is doubled; storage and ChatService are real.
  const host = {
    getActiveRequest: () => null,
    getMessages: (id: string) => { if (!store.hasConversation(id)) throw new Error('unexpected message owner'); reads.push(id); return readMessages(id) },
    getConversationTask: (id: string) => { if (!store.hasConversation(id)) throw new Error('unexpected task owner'); return tasks.get(id) ?? null }
  } as unknown as AgentHost
  const chat = new ChatService(store, host)
  const workspace = new WorkspaceService(store, chat)
  return { store, chat, daily, work, tasks, reads, workspace, delayRead: (read: typeof readMessages) => { readMessages = read } }
}

describe('selection-scoped workspace', () => {
  it('memory_selection_has_no_conversation_authority', async () => {
    const f = fixture()
    const snapshot = await f.workspace.select({ section: 'memory' })
    expect(snapshot.selection).toEqual({ section: 'memory' })
    expect(snapshot.conversation).toBeNull()
    expect(snapshot.topic).toBeNull()
    expect(snapshot.messages).toEqual([])
    expect(snapshot.task).toBeNull()
    expect(snapshot.workItems).toEqual([])
    expect(f.reads).toEqual([])
    expect(() => f.workspace.assertSelected(f.work)).toThrow()
    const event = { requestId: 'request-1', conversationId: f.work, message: message(f.work, 'private'), done: false }
    expect(f.workspace.routeChat(event)).toBeNull()
    await expect(f.workspace.select({ section: 'memory', conversationId: f.work })).rejects.toThrow()
  })

  it('failed_detail_read_has_no_execution_authority', async () => {
    const f = fixture()
    f.delayRead(async () => { throw new Error('read failed') })
    await expect(f.workspace.select({ section: 'work', conversationId: f.work })).rejects.toThrow('read failed')
    expect(() => f.workspace.assertSelected(f.work)).toThrow()
    expect(f.workspace.routeTask(task(f.work))).toBeNull()
  })

  it('daily_snapshot_and_overview_exclude_private_content', async () => {
    const f = fixture(); f.tasks.set(f.work, task(f.work))
    const snapshot = await f.workspace.select({ section: 'daily' })
    const notices = f.workspace.getPendingActions()
    expect(snapshot.selection).toEqual({ section: 'daily', conversationId: f.daily })
    expect(snapshot.workItems).toEqual([])
    expect(snapshot.conversation?.id).toBe(f.daily)
    expect(snapshot.topic?.kind).toBe('daily')
    expect(f.reads).toEqual([f.daily])
    expect(notices).toHaveLength(1)
    expect(Object.keys(notices[0]).sort()).toEqual(['id', 'status', 'version'])
    const serialized = JSON.stringify([snapshot, notices])
    for (const secret of ['标题秘密哨兵', '正文秘密哨兵', '对象秘密哨兵', '审批秘密哨兵', f.work, 'run-1']) expect(serialized).not.toContain(secret)
    expect(await f.workspace.resolvePendingAction({ id: notices[0].id, version: notices[0].version })).toEqual({ conversationId: f.work })
    // Resolving a notice locates the original topic but grants no detail authority.
    expect(() => f.workspace.assertSelected(f.work)).toThrow()
  })

  it('work list contains only real topics without loading details or inferring kind from titles', async () => {
    const f = fixture()
    const list = await f.workspace.select({ section: 'work' })
    expect(list.conversation).toBeNull(); expect(list.topic).toBeNull()
    expect(list.messages).toEqual([]); expect(list.task).toBeNull(); expect(f.reads).toEqual([])
    expect(list.workItems.map(item => item.conversation.id)).toEqual([f.work])
    expect(list.workItems.find(item => item.conversation.id === f.work)?.topic?.kind).toBe('work')
    const detail = await f.workspace.select({ section: 'work', conversationId: f.work })
    expect(detail.messages.map(item => item.content)).toEqual(['正文秘密哨兵'])
    expect(() => f.workspace.assertSelected(f.work)).not.toThrow()
    await expect(f.workspace.select({ section: 'work', conversationId: f.daily })).rejects.toThrow()
    await expect(f.workspace.select({ section: 'daily', conversationId: 'history' })).rejects.toThrow()
  })

  it('late_detail_read_cannot_cross_selection', async () => {
    const f = fixture()
    let finish!: (messages: ChatMessage[]) => void
    f.delayRead(id => id === f.work ? new Promise(resolve => { finish = resolve }) : Promise.resolve(f.store.getMessages(id)))
    const late = f.workspace.select({ section: 'work', conversationId: f.work })
    const rejection = expect(late).rejects.toThrow('界面已切换。')
    const current = await f.workspace.select({ section: 'daily' })
    finish([message(f.work, '迟到秘密哨兵')]); await rejection
    expect(current.messages).toEqual([])
    expect(() => f.workspace.assertSelected(f.work)).toThrow()
    expect(() => f.workspace.assertSelected(f.daily)).not.toThrow()
  })

  it('background_task_details_never_reach_daily and all routed events carry the current selection version', async () => {
    const f = fixture(), privateTask = task(f.work)
    const daily = await f.workspace.select({ section: 'daily' })
    const chatEvent = { requestId: 'request-1', conversationId: f.work, message: message(f.work, '事件秘密哨兵'), done: false, task: privateTask }
    const request = { requestId: 'request-1', conversationId: f.work, state: 'failed' as const, error: '错误秘密哨兵' }
    expect(f.workspace.routeTask(privateTask)).toBeNull()
    expect(f.workspace.routeChat(chatEvent)).toBeNull()
    expect(f.workspace.routeRequest(request)).toBeNull()
    const selected = await f.workspace.select({ section: 'work', conversationId: f.work })
    expect(selected.version).toBeGreaterThan(daily.version)
    expect(f.workspace.routeTask(privateTask)).toEqual({ selectionVersion: selected.version, event: privateTask })
    expect(f.workspace.routeChat(chatEvent)).toEqual({ selectionVersion: selected.version, event: chatEvent })
    expect(f.workspace.routeRequest(request)).toEqual({ selectionVersion: selected.version, event: request })
    expect(f.workspace.routeChat({ ...chatEvent, task: task(f.daily) })).toBeNull()
    expect(f.workspace.routeChat({ ...chatEvent, message: message(f.daily, '错误归属秘密哨兵') })).toBeNull()
    expect(f.workspace.routeTask({ ...privateTask, run: { ...privateTask.run, conversationId: f.daily } })).toBeNull()
    await f.workspace.select({ section: 'work' })
    expect(f.workspace.routeTask(privateTask)).toBeNull()
  })

  it('stale_pending_never_opens_another_topic or a handled/deleted topic', async () => {
    const f = fixture(), event = task(f.work); f.tasks.set(f.work, event)
    const original = f.workspace.getPendingActions()[0]
    expect(await f.workspace.resolvePendingAction({ id: original.id, version: original.version + 1 })).toBeNull()
    event.seq = 999; event.run.activeMs = 9000
    expect(f.workspace.getPendingActions()).toEqual([original])
    event.approval!.revision = 'revision-2'
    expect(await f.workspace.resolvePendingAction({ id: original.id, version: original.version })).toBeNull()
    const revised = f.workspace.getPendingActions()[0]
    expect(revised.version).toBeGreaterThan(original.version)
    f.tasks.delete(f.work); f.tasks.set('history', { ...event, conversationId: 'history', run: { ...event.run, conversationId: 'history' } })
    expect(await f.workspace.resolvePendingAction({ id: revised.id, version: revised.version })).toBeNull()
    const moved = f.workspace.getPendingActions()[0]
    expect(await f.workspace.resolvePendingAction({ id: moved.id, version: moved.version })).toEqual({ conversationId: 'history' })
    f.tasks.get('history')!.run.status = 'running'; delete f.tasks.get('history')!.approval
    expect(await f.workspace.resolvePendingAction({ id: moved.id, version: moved.version })).toBeNull()
    f.tasks.set(f.work, task(f.work)); const restored = f.workspace.getPendingActions().find(notice => notice.status === 'waiting_approval')!
    f.store.trashConversation(f.work)
    expect(await f.workspace.resolvePendingAction({ id: restored.id, version: restored.version })).toBeNull()
  })

  it('derives only actionable statuses and invalidates on unknown identity or paused status changes', async () => {
    const f = fixture()
    for (const status of ['queued', 'running', 'waiting_resource', 'compacting', 'retrying', 'stopping', 'completed'] as const) {
      f.tasks.set(f.work, task(f.work, status)); expect(f.workspace.getPendingActions()).toEqual([])
    }
    for (const status of ['paused', 'stopped', 'failed', 'interrupted'] as const) {
      f.tasks.set(f.work, task(f.work, status)); expect(f.workspace.getPendingActions()[0].status).toBe('paused')
    }
    const paused = f.workspace.getPendingActions()[0]
    f.tasks.set(f.work, task(f.work, 'stopped'))
    expect(await f.workspace.resolvePendingAction({ id: paused.id, version: paused.version })).toBeNull()
    const unknown = task(f.work, 'completed')
    unknown.unknownCalls = [{ runId: 'run-1', callId: 'call-1', revision: 'u1', summary: '未知秘密哨兵' }]
    f.tasks.set(f.work, unknown)
    const notice = f.workspace.getPendingActions()[0]
    expect(notice.status).toBe('unknown'); expect(JSON.stringify(notice)).not.toContain('未知秘密哨兵')
    unknown.unknownCalls[0].revision = 'u2'
    expect(await f.workspace.resolvePendingAction({ id: notice.id, version: notice.version })).toBeNull()
  })

  it('revokes authority and drops late details after deletion', async () => {
    const f = fixture(); await f.workspace.select({ section: 'work', conversationId: f.work })
    f.store.trashConversation(f.work)
    expect(() => f.workspace.assertSelected(f.work)).toThrow()
    expect(f.workspace.routeTask(task(f.work))).toBeNull()
    await expect(f.workspace.select({ section: 'work', conversationId: f.work })).rejects.toThrow()
  })

  it('validates selection, identifiers, positive safe integer versions and unknown fields', async () => {
    const f = fixture()
    for (const input of [null, [], { section: 'other' }, { section: 'daily', extra: true }, { section: 'work', conversationId: '' }, { section: 'work', conversationId: 'x'.repeat(129) }, { section: 'daily', conversationId: 2 }]) {
      await expect(f.workspace.select(input as WorkspaceSelection)).rejects.toThrow()
    }
    for (const input of [null, [], { id: '', version: 1 }, { id: 'x', version: 0 }, { id: 'x', version: -1 }, { id: 'x', version: 1.5 }, { id: 'x', version: Infinity }, { id: 'x', version: NaN }, { id: 'x', version: Number.MAX_SAFE_INTEGER + 1 }, { id: 'x', version: 1, extra: true }]) {
      await expect(f.workspace.resolvePendingAction(input as { id: string; version: number })).rejects.toThrow()
    }
    expect(() => f.workspace.assertSelected('')).toThrow()
  })
})

it('work metadata listing requires work selection, reads no details, and never changes event versions', async () => {
  const f = fixture()
  expect(() => f.workspace.listWorkItems()).toThrow()
  await f.workspace.select({ section: 'daily' })
  expect(() => f.workspace.listWorkItems()).toThrow()
  const selected = await f.workspace.select({ section: 'work', conversationId: f.work })
  const messages = vi.spyOn(f.chat, 'getMessages'), tasks = vi.spyOn(f.chat, 'getConversationTask'), active = vi.spyOn(f.chat, 'getActiveRequest')
  const request = { conversationId: f.work, requestId: 'live', state: 'started' as const }
  const before = f.workspace.routeRequest(request)
  const items = f.workspace.listWorkItems()
  expect(items.map(item => item.conversation.id)).toEqual([f.work])
  expect(items.every(item => Object.keys(item).sort().join(',') === 'conversation,topic')).toBe(true)
  expect(JSON.stringify(items)).not.toContain('正文秘密哨兵')
  expect(messages).not.toHaveBeenCalled(); expect(tasks).not.toHaveBeenCalled(); expect(active).not.toHaveBeenCalled()
  expect(f.workspace.routeRequest(request)).toEqual(before)
  expect(f.workspace.routeRequest(request)?.selectionVersion).toBe(selected.version)
  vi.spyOn(f.store, 'listConversations').mockImplementationOnce(() => { throw new Error('list failed') })
  expect(() => f.workspace.listWorkItems()).toThrow('list failed')
  expect(f.workspace.routeRequest(request)).toEqual(before)
  expect(() => f.workspace.assertSelected(f.work)).not.toThrow()
})

it('private notification fingerprint survives recreated workspace and notice inbox validates exact version', async () => {
 const f=fixture(); f.tasks.set(f.daily,task(f.daily))
 const notice=f.workspace.getPendingActions()[0]
 const key=f.workspace.notificationFingerprint(notice)
 expect(key).toMatch(/^[a-f0-9]{64}$/)
 const restored = { ...f.tasks.get(f.daily)!, generation: undefined, seq: undefined }
 f.tasks.set(f.daily, restored)
 const restarted=new WorkspaceService(f.store,f.chat)
 const newNotice=restarted.getPendingActions()[0]
 expect(newNotice.id).not.toBe(notice.id)
 expect(restarted.notificationFingerprint(newNotice)).toBe(key)
 f.tasks.set(f.daily,task(f.daily))
 f.workspace.queuePendingActionOpen(notice)
 expect(await f.workspace.getPendingActionOpen()).toEqual(notice)
 f.workspace.ackPendingActionOpen({id:notice.id,version:notice.version+1})
 expect(await f.workspace.getPendingActionOpen()).toEqual(notice)
 f.workspace.ackPendingActionOpen({ id: notice.id, version: notice.version })
 expect(await f.workspace.getPendingActionOpen()).toBeNull()
 f.workspace.queuePendingActionOpen(notice); f.tasks.clear()
 expect(await f.workspace.getPendingActionOpen()).toBeNull()
})
