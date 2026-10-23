import { app } from 'electron'
import { createRequire } from 'node:module'
import { join } from 'node:path'
export type NotificationPermission = 'authorized' | 'denied' | 'not-determined' | 'unknown'
interface NativePermission { query(): Promise<unknown> }
export async function queryNotificationPermission(options: { platform: string; packaged: boolean; load(): NativePermission }): Promise<NotificationPermission> {
  if (options.platform !== 'darwin' || !options.packaged) return 'unknown'
  try {
    const value = await options.load().query()
    return value === 'authorized' || value === 'denied' || value === 'not-determined' ? value : 'unknown'
  } catch { return 'unknown' }
}
export function getNotificationPermission(): Promise<NotificationPermission> {
  return queryNotificationPermission({ platform: process.platform, packaged: app.isPackaged,
    load: () => createRequire(import.meta.url)(join(app.getAppPath(), 'out/native/notification-permission.node')) as NativePermission })
}
