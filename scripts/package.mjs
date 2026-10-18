import { packager } from '@electron/packager'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
if (process.platform !== 'darwin') throw new Error('This package command builds a local macOS application.')
const outputs = await packager({
  dir: root,
  name: 'Her',
  platform: 'darwin',
  arch: process.arch,
  electronVersion: require('electron/package.json').version,
  appBundleId: 'com.her.desktop',
  out: join(root, 'release'),
  overwrite: true,
  prune: true,
  asar: false,
  ignore: [/^\/(?!out(?:\/|$)|node_modules(?:\/|$)|package\.json$).+/, /^\/node_modules\/(?:\.vitest-cache|\.vite)(?:\/|$)/],
  // Small fixed manifests/install instructions only; external runtimes stay separate.
  extraResource: [join(root, 'resources/dependencies'), join(root, 'resources/mcp-web-dependencies')]
})
for (const output of outputs) console.log(join(output, 'Her.app'))
