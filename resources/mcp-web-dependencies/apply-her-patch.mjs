import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import manifest from './her-request-patch.json' with { type: 'json' }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export async function packageHash(root) {
  const rows = []
  async function visit(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      if (entry.isSymbolicLink()) throw new Error('Package symlinks are not verified')
      const relative = prefix + entry.name, path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path, relative + '/')
      else if (entry.isFile()) rows.push(relative + '\0' + hash(await readFile(path)) + '\n')
      else throw new Error('Unsupported package entry')
    }
  }
  await visit(root, '')
  return hash(rows.sort().join(''))
}
export async function applyHerPatch(root) {
  const current = await packageHash(root)
  if (current === manifest.patchedTreeSha256) return manifest.revision
  if (current !== manifest.upstreamTreeSha256) throw new Error('Refusing unknown upstream package bytes; reinstall from the fixed lock first')
  const writes = []
  for (const file of manifest.files) {
    const path = join(root, file.path), before = await readFile(path)
    if (hash(before) !== file.beforeSha256) throw new Error('Unexpected upstream file hash')
    let after = before.toString('utf8')
    for (const replacement of file.replacements) {
      if (after.split(replacement.before).length !== 2) throw new Error('Unexpected upstream patch context')
      after = after.replace(replacement.before, replacement.after)
    }
    if (hash(after) !== file.afterSha256) throw new Error('Patch output hash mismatch')
    writes.push([path, after])
  }
  for (const [path, after] of writes) await writeFile(path, after)
  if (await packageHash(root) !== manifest.patchedTreeSha256) throw new Error('Patched package verification failed; do not execute it')
  return manifest.revision
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node apply-her-patch.mjs /absolute/path/to/node_modules/open-websearch')
  console.log(await applyHerPatch(resolve(process.argv[2])))
}
