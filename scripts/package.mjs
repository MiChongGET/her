import { packager } from '@electron/packager'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
if (process.platform !== 'darwin') throw new Error('This package command builds a local macOS application.')
const electronZipDir = process.env.HER_ELECTRON_ZIP_DIR
if (electronZipDir) {
  const archive = `electron-v${require('electron/package.json').version}-darwin-${process.arch}.zip`
  const bytes = await readFile(join(electronZipDir, archive))
  if (createHash('sha256').update(bytes).digest('hex') !== require('electron/checksums.json')[archive]) throw new Error('Cached Electron archive checksum mismatch')
}
await access(join(root, 'out/native/notification-permission.node'))
const outputs = await packager({
  dir: root,
  electronZipDir,
  name: 'Her',
  platform: 'darwin',
  arch: process.arch,
  electronVersion: require('electron/package.json').version,
  appBundleId: 'com.her.desktop',
  icon: join(root, 'resources/branding/her-final/her-app-icon.icns'),
  out: join(root, 'release'),
  overwrite: true,
  prune: true,
  asar: false,
  ignore: [/^\/(?!out(?:\/|$)|node_modules(?:\/|$)|package\.json$).+/, /^\/node_modules\/(?:\.vitest-cache|\.vite|\.cache\/her-notification-permission)(?:\/|$)/],
  // Skill documents and fixed install resources; external runtimes stay separate.
  extraResource: [join(root, 'resources/dependencies'), join(root, 'resources/mcp-web-dependencies'), join(root, 'src/core/skills/ego-browser'), join(root, 'resources/branding/her-final/native-icons')]
})
for (const output of outputs) console.log(join(output, 'Her.app'))
