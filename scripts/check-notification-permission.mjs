// Read-only probe inside the packaged Her main process; never changes OS permission.
import { _electron } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const directory = mkdtempSync(join(tmpdir(), 'her-notification-probe-'))
const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && key !== 'ELECTRON_RUN_AS_NODE'))
let application
try {
  application = await _electron.launch({ executablePath: resolve(`release/Her-darwin-${process.arch}/Her.app/Contents/MacOS/Her`), args: [], env: { ...env, HER_DATA_DIR: directory } })
  const page = await application.firstWindow()
  await page.getByRole('button', { name: '设置', exact: true }).waitFor()
  const evidence = await application.evaluate(async ({ app }) => {
    const { createRequire } = process.getBuiltinModule('node:module')
    const { execFileSync } = process.getBuiltinModule('node:child_process')
    const { join } = process.getBuiltinModule('node:path')
    const modulePath = join(app.getAppPath(), 'out/native/notification-permission.node')
    const bundleId = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(process.resourcesPath, '../Info.plist')], { encoding: 'utf8' }).trim()
    const probe = createRequire(join(app.getAppPath(), 'package.json'))(modulePath)
    return { packaged: app.isPackaged, executable: process.execPath, appPath: app.getAppPath(), bundleId, arch: process.arch,
      electron: process.versions.electron, permission: await probe.query(), modulePath, permissionChanged: false }
  })
  if (!evidence.packaged || evidence.bundleId !== 'com.her.desktop') throw new Error('Probe must run in packaged Her')
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  if (application) await application.close()
  rmSync(directory, { recursive: true, force: true })
}
