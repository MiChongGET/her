// Run after npm run build. Uses only constant fixtures and an isolated Electron instance.
import { build } from 'esbuild'
import { loadConfigFromFile } from 'vite'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const evidence = process.env.HER_PDF_TEST_EVIDENCE || await mkdtemp(join(tmpdir(), 'her-pdf-evidence-'))
const development = process.argv.includes('--development')
if (development) {
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, join(root, 'electron.vite.config.ts'))
  const hook = loaded.config.renderer.plugins.find(plugin => plugin.name === 'her-local-pdf-assets').configureServer
  await hook()
}
const cache = join(root, 'node_modules/.cache')
await mkdir(cache, { recursive: true })
const runtime = await mkdtemp(join(cache, 'her-pdf-test-'))
const entry = join(runtime, 'main.mjs')
await build({ entryPoints: [join(root, 'tests/helpers/pdf-electron.ts')], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: entry })
const executable = join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const child = spawn(executable, [entry], { env: { ...process.env, HER_PDF_TEST_ROOT: root, HER_PDF_TEST_EVIDENCE: evidence, HER_PDF_TEST_DEVELOPMENT: development ? '1' : '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
child.stdout.on('data', data => { log += data; process.stdout.write(data) })
child.stderr.on('data', data => { log += data; process.stderr.write(data) })
const deadline = setTimeout(() => child.kill('SIGTERM'), 60000)
const code = await new Promise((done, fail) => { child.once('error', fail); child.once('exit', code => done(code)) })
clearTimeout(deadline)
await writeFile(join(evidence, 'launch.log'), log)
let gone = false
try { process.kill(child.pid, 0) } catch { gone = true }
await writeFile(join(evidence, 'cleanup.json'), JSON.stringify({ pid: child.pid, exitCode: code, mainProcessGone: gone }, null, 2))
await rm(runtime, { recursive: true, force: true })
console.log(JSON.stringify({ evidence, exitCode: code, mainProcessGone: gone }))
process.exitCode = code === 0 && gone ? 0 : 1
