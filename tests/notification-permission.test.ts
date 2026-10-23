import { expect, test, vi } from 'vitest'
vi.mock('electron', () => ({ app: { isPackaged: true, getAppPath: () => '/app' } }))
import { queryNotificationPermission } from '../src/main/notification-permission'
test.each(['authorized','denied','not-determined','unknown','provisional', null])('permission maps explicit status only: %s', async value => {
 expect(await queryNotificationPermission({ platform:'darwin', packaged:true, load:()=>({query: async()=>value}) })).toBe(['authorized','denied','not-determined'].includes(value as string)?value:'unknown')
})
test('development and unsupported hosts never load native module', async () => {
 const load=vi.fn(); expect(await queryNotificationPermission({ platform:'darwin',packaged:false,load })).toBe('unknown')
 expect(await queryNotificationPermission({ platform:'linux',packaged:true,load })).toBe('unknown'); expect(load).not.toHaveBeenCalled()
})
test('native load and query failures are unknown', async () => {
 expect(await queryNotificationPermission({ platform:'darwin',packaged:true,load:()=>{throw new Error('load')} })).toBe('unknown')
 expect(await queryNotificationPermission({ platform:'darwin',packaged:true,load:()=>({query:async()=>{throw new Error('query')}}) })).toBe('unknown')
})
