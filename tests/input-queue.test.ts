import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HerStore } from '../src/core/storage/store'

const directories: string[] = [], stores: HerStore[] = []
afterEach(() => { for (const store of stores.splice(0)) try { store.close() } catch { /* closed */ } for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }) })
function open(path?: string) {
  if (!path) { const d = mkdtempSync(join(tmpdir(), 'her-queue-')); directories.push(d); path = join(d, 'her.sqlite') }
  const store = new HerStore(path); stores.push(store)
  return { store, path }
}
const conversation = (store: HerStore) => { const id = randomUUID(); store.createConversation(id, randomUUID(), 't'); return id }

describe('persistent input queue', () => {
  it('lists pending inputs oldest first and keeps each conversation separate', () => {
    const { store } = open(), a = conversation(store), b = conversation(store)
    const first = store.enqueueInput(a, 'one', null), second = store.enqueueInput(a, 'two', null), other = store.enqueueInput(b, 'other', null)
    expect(store.listPendingInputs(a).map(item => item.id)).toEqual([first, second])
    expect(store.listPendingInputs(b).map(item => item.id)).toEqual([other])
    expect(store.getPendingInput(a)?.id).toBe(first)
  })

  it('remembers the model choice and message id given when queued', () => {
    const { store } = open(), a = conversation(store)
    const id = store.enqueueInput(a, 'hi', null, randomUUID(), { profileId: 'p', model: 'm', userMessageId: 'u1' })
    expect(store.getInput(id)).toMatchObject({ profileId: 'p', model: 'm', userMessageId: 'u1', status: 'pending' })
  })

  it('lets exactly one caller claim a request', () => {
    const { store } = open(), a = conversation(store)
    const id = store.enqueueInput(a, 'hi', null)
    expect([store.claimInput(id), store.claimInput(id)]).toEqual([true, false])
    expect(store.getInput(id)).toMatchObject({ status: 'running' })
    expect(store.listPendingInputs(a)).toEqual([])
  })

  it('a withdrawn request can never be claimed, and a claimed one can no longer be withdrawn', () => {
    const { store } = open(), a = conversation(store)
    const withdrawn = store.enqueueInput(a, 'no', null), started = store.enqueueInput(a, 'yes', null)
    expect(store.cancelPendingInput(withdrawn)).toBe(true)
    expect(store.claimInput(withdrawn)).toBe(false)
    expect(store.getInput(withdrawn)).toMatchObject({ status: 'cancelled' })
    expect(store.claimInput(started)).toBe(true)
    expect(store.cancelPendingInput(started)).toBe(false)
    expect(store.getInput(started)).toMatchObject({ status: 'running' })
  })

  it('reports which conversations still hold pending input', () => {
    const { store } = open(), a = conversation(store), b = conversation(store)
    store.enqueueInput(a, 'x', null)
    store.cancelPendingInput(store.enqueueInput(b, 'y', null))
    expect(store.listConversationsWithPendingInput()).toEqual([a])
  })

  it('after a crash, running work is interrupted and pending input is kept, nothing is resumed', () => {
    const { store, path } = open(), a = conversation(store)
    const running = store.enqueueInput(a, 'running', null), waiting = store.enqueueInput(a, 'waiting', null)
    store.claimInput(running)
    const taskId = randomUUID()
    store.createTask({ id: taskId, conversationId: a, requestId: running, generation: 0, status: 'running', serviceId: 's', modelId: 'm', configRevision: 1, error: null })
    store.close()
    const reopened = open(path).store
    expect(reopened.markInterruptedRuns()).toBe(1)
    expect(reopened.getTask(taskId)).toMatchObject({ status: 'interrupted' })
    expect(reopened.getInput(running)).toMatchObject({ status: 'cancelled' })
    expect(reopened.getInput(waiting)).toMatchObject({ status: 'pending' })
    expect(reopened.markInterruptedRuns()).toBe(0)
  })

  it('links a continuation attempt to the task it continues', () => {
    const { store } = open(), a = conversation(store)
    const first = store.enqueueInput(a, 'one', null), second = store.enqueueInput(a, 'continue', null)
    store.createTask({ id: 't1', conversationId: a, requestId: first, generation: 0, status: 'stopped', serviceId: 's', modelId: 'm', configRevision: 1, error: null })
    store.createTask({ id: 't2', conversationId: a, requestId: second, generation: 0, status: 'running', serviceId: 's', modelId: 'm', configRevision: 1, error: null, continuationOf: 't1' })
    expect(store.getTask('t1')?.continuationOf).toBeNull()
    expect(store.getTask('t2')?.continuationOf).toBe('t1')
  })
})
