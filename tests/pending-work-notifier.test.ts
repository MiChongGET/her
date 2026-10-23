import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { PendingWorkNotifier, DeliveryState } from '../src/main/pending-work-notifier'
import type { PendingActionNotice } from '../src/shared/types'
const notice: PendingActionNotice = { id: 'opaque', version: 1, status: 'waiting_approval' }
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })))
function setup() {
 const dir = mkdtempSync(join(tmpdir(), 'her-notices-')); dirs.push(dir)
 const path = join(dir, 'delivery.json')
 const permission = vi.fn(async (): Promise<string> => 'authorized')
 const showNotification = vi.fn((_click: () => void) => () => {})
 const updateTray = vi.fn()
 const resolve = vi.fn(async () => ({ conversationId: 'daily' }))
 const open = vi.fn()
 const fingerprint = vi.fn((item: PendingActionNotice) => 'a'.repeat(63) + item.version)
 const deps = { runFingerprint: () => 'f'.repeat(64), permission, showNotification, updateTray, resolve, open, fingerprint, delivery: new DeliveryState(path) }
 return { ...deps, path, notifier: new PendingWorkNotifier(deps), deps }
}
test.each(['unknown', 'denied', 'not-determined'])('unknown_or_denied_permission_only_updates_tray: %s', async value => {
 const s = setup(); s.permission.mockResolvedValue(value)
 await s.notifier.update([notice], false)
 expect(s.showNotification).not.toHaveBeenCalled(); expect(s.updateTray).toHaveBeenCalledWith(1)
})
test('probe failure only updates Tray', async () => { const s=setup(); s.permission.mockRejectedValue(new Error('probe')); await s.notifier.update([notice], false); expect(s.showNotification).not.toHaveBeenCalled() })
test('same_wait_is_not_repeated and restart uses private stable identity', async () => {
 const s=setup(); await s.notifier.update([notice], false); await s.notifier.update([notice], false)
 expect(s.showNotification).toHaveBeenCalledTimes(1); expect(s.permission).toHaveBeenCalledTimes(1)
 s.notifier.dispose()
 const restarted = new PendingWorkNotifier({ ...s.deps, delivery: new DeliveryState(s.path) })
 await restarted.update([{ ...notice, id: 'new-process-id' }], false)
 expect(s.showNotification).toHaveBeenCalledTimes(1)
 expect(readFileSync(s.path, 'utf8')).not.toContain('opaque')
 await restarted.update([], false); expect(JSON.parse(readFileSync(s.path,'utf8'))).toEqual([])
})
test('permission_is_checked_before_each_new_notice', async () => {
 const s=setup(); await s.notifier.update([notice], false); s.permission.mockResolvedValue('denied')
 await s.notifier.update([{ ...notice, version: 2 }], false)
 expect(s.permission).toHaveBeenCalledTimes(2); expect(s.showNotification).toHaveBeenCalledTimes(1)
})
test('stale_notice_click_is_harmless', async () => {
 const s=setup(); await s.notifier.update([notice], false); s.resolve.mockResolvedValue(null as never)
 await s.showNotification.mock.calls[0][0](); expect(s.open).not.toHaveBeenCalled()
})
test('valid click delegates opaque navigation after live resolution', async () => {
 const s=setup(); await s.notifier.update([notice], false); await s.showNotification.mock.calls[0][0]()
 expect(s.resolve).toHaveBeenCalledWith({ id: notice.id, version: notice.version }); expect(s.open).toHaveBeenCalledWith(notice)
})
test.each(['visible','removed','disposed'])('late permission cannot notify when %s', async change => {
 const s=setup(); let finish!: (value:string)=>void
 s.permission.mockImplementation(() => new Promise(resolve => { finish=resolve }))
 const pending=s.notifier.update([notice],false)
 if(change==='disposed') s.notifier.dispose(); else void s.notifier.update(change==='removed'?[]:[notice],change==='visible')
 finish('authorized'); await pending; expect(s.showNotification).not.toHaveBeenCalled()
})
test('visible window does not consume delivery and repeated updates share pending probe', async () => {
 const s=setup(); await s.notifier.update([notice],true); expect(s.permission).not.toHaveBeenCalled()
 let finish!: (value:string)=>void; s.permission.mockImplementation(() => new Promise(resolve=>{finish=resolve}))
 const a=s.notifier.update([notice],false); const b=s.notifier.update([notice],false)
 finish('authorized'); await Promise.all([a,b]); expect(s.permission).toHaveBeenCalledTimes(1); expect(s.showNotification).toHaveBeenCalledTimes(1)
})

test('restart interruption of delivered approval does not nag but new approval still can', async () => {
 const s=setup(); await s.notifier.update([notice],false); s.notifier.dispose()
 const restarted = new PendingWorkNotifier({ ...s.deps, delivery: new DeliveryState(s.path) })
 await restarted.update([{ ...notice, id: 'restored', status:'paused', version:2 }],false)
 expect(s.showNotification).toHaveBeenCalledTimes(1)
 await restarted.update([{ ...notice, id:'new-call', version:3 }],false)
 expect(s.showNotification).toHaveBeenCalledTimes(2)
})

test('unwritable persistent delivery state fails closed to Tray', async () => {
 const s=setup(); const notifier = new PendingWorkNotifier({ ...s.deps, delivery: new DeliveryState(join(s.path, 'missing', 'state')) })
 await notifier.update([notice],false)
 expect(s.showNotification).not.toHaveBeenCalled(); expect(s.updateTray).toHaveBeenCalledWith(1)
})
