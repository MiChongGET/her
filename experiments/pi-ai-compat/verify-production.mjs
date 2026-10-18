import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const experiment = dirname(fileURLToPath(import.meta.url))
const root = resolve(experiment, '../..')
const before = JSON.parse(await readFile(join(experiment, 'results/production-before.json'), 'utf8'))
const changed = []
for (const [path, expected] of Object.entries(before)) {
  const bytes = await readFile(join(root, path)).catch(() => null)
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== expected) changed.push(path)
}
async function sourceFiles(path) {
  const entries = await readdir(join(root, path), { withFileTypes: true })
  return (await Promise.all(entries.map(entry => entry.isDirectory()
    ? sourceFiles(join(path, entry.name)) : [join(path, entry.name)]))).flat()
}
const added = (await sourceFiles('src')).filter(path => !(path in before))
const result = {
  checkedAt: new Date().toISOString(), trackedFiles: Object.keys(before).length,
  changed, added, unchanged: changed.length === 0 && added.length === 0,
  scope: 'Production src tree, package.json, package-lock.json, Electron/Vitest/TypeScript configuration',
}
await writeFile(join(experiment, 'results/production-integrity.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result))
if (!result.unchanged) process.exitCode = 1
