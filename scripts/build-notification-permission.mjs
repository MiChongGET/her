import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('..', import.meta.url))
const output = join(root, 'out/native/notification-permission.node')
if (process.platform !== 'darwin') {
  await rm(output, { force: true })
  console.log('Notification permission: unsupported platform, Tray only')
} else {
  const version = require('electron/package.json').version
  // Pinned official Electron headers: change this pin together with Electron upgrades.
  const hashes = { '44.7.0': 'bb2b300b13850a976343a506c05aad5716bda0c43511add122ecd1959383ddd0' }
  const expected = hashes[version]
  if (!expected) throw new Error('Pin the official Electron header SHA256 before upgrading Electron')
  const cache = join(root, 'node_modules/.cache/her-notification-permission', version)
  await mkdir(cache, { recursive: true })
  const archive = join(cache, 'headers.tar.gz')
  let bytes
  try { bytes = await readFile(archive) } catch {
    const response = await fetch(`https://electronjs.org/headers/v${version}/node-v${version}-headers.tar.gz`)
    if (!response.ok) throw new Error('Electron headers unavailable')
    bytes = Buffer.from(await response.arrayBuffer())
  }
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Electron header SHA256 mismatch')
  await writeFile(archive, bytes)
  execFileSync('tar', ['-xzf', archive, '-C', cache])
  await mkdir(join(root, 'out/native'), { recursive: true })
  execFileSync('xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-fblocks', '-shared', '-undefined', 'dynamic_lookup',
    '-arch', process.arch === 'arm64' ? 'arm64' : 'x86_64', '-mmacosx-version-min=12.0', '-DNAPI_VERSION=8',
    '-I', join(cache, `node_headers/include/node`), '-framework', 'Foundation', '-framework', 'UserNotifications',
    join(root, 'native/notification-permission/permission.mm'), '-o', output], { stdio: 'inherit' })
  console.log(`Notification permission: Electron ${version}, ${process.arch}, Node-API 8 → ${output}`)
}
