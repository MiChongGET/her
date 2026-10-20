// Task 1.5: run Pi 1.3.0 inside a real Electron main process, built with electron-vite and
// packaged with the same @electron/packager options as scripts/package.mjs. Production files are untouched.
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { packager } from '@electron/packager'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')
const results = join(here, '..', 'results')
const require = createRequire(join(root, 'package.json'))
const work = await mkdtemp(join(tmpdir(), 'her-pi130-electron-'))
const summary = { observedAt: new Date().toISOString(), work, runs: [] }

function run(command, args, options = {}) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd: options.cwd ?? root, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', data => { out += data })
    child.stderr.on('data', data => { out += data })
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeout ?? 180000)
    child.on('error', fail)
    child.on('exit', code => { clearTimeout(timer); done({ code, out }) })
  })
}

async function launch(label, executable, args) {
  const resultPath = join(results, `electron-${label}.json`)
  const env = { ...process.env, HER_PI_PROBE_RESULT: resultPath, HOME: join(work, 'home') }
  for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_PATH', 'NODE_OPTIONS']) delete env[name]
  await mkdir(env.HOME, { recursive: true })
  await rm(resultPath, { force: true })
  const exit = await run(executable, [...args, '--user-data-dir=' + join(work, 'userdata-' + label)], { cwd: work, env, timeout: 60000 })
  let observation
  try { observation = JSON.parse(await readFile(resultPath, 'utf8')) } catch { observation = { success: false, error: 'no result written' } }
  observation.exitCode = exit.code
  if (exit.code !== 0) observation.output = exit.out.slice(-4000)
  await writeFile(resultPath, JSON.stringify(observation, null, 2) + '\n')
  summary.runs.push({ label, success: observation.success === true && exit.code === 0 })
  return observation
}

try {
  await mkdir(results, { recursive: true })
  const app = join(work, 'app')
  await mkdir(app)
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  await writeFile(join(app, 'package.json'), JSON.stringify({ ...pkg, name: 'her-pi-probe', main: 'out/main/index.js', scripts: {}, devDependencies: {} }, null, 2))
  await cp(join(root, 'package-lock.json'), join(app, 'package-lock.json'))
  await writeFile(join(app, 'electron.vite.config.mjs'),
    `export default { main: { build: { rollupOptions: { input: { index: ${JSON.stringify(join(here, 'probe.ts'))} } } } } }\n`)
  const install = await run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: app, timeout: 600000 })
  if (install.code !== 0) throw new Error('npm ci failed: ' + install.out.slice(-2000))
  // electron-vite and electron come from the Her dev tree; the app dir only holds production deps.
  const build = await run(process.execPath, [join(root, 'node_modules/electron-vite/bin/electron-vite.js'), 'build', '-c', join(app, 'electron.vite.config.mjs')], { cwd: app })
  if (build.code !== 0) throw new Error('electron-vite build failed: ' + build.out.slice(-2000))

  const electron = join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  summary.built = await launch('built', electron, [app])

  const outputs = await packager({
    dir: app, name: 'HerPiProbe', platform: 'darwin', arch: process.arch,
    electronVersion: require('electron/package.json').version, appBundleId: 'local.her.pi-probe',
    ...(process.env.HER_ELECTRON_ZIP_DIR ? { electronZipDir: process.env.HER_ELECTRON_ZIP_DIR } : {}),
    out: join(work, 'release'), overwrite: true, prune: true, asar: false
  })
  summary.packagedApp = join(outputs[0], 'HerPiProbe.app')
  summary.packaged = await launch('packaged', join(summary.packagedApp, 'Contents/MacOS/HerPiProbe'), [])
  summary.success = summary.runs.every(entry => entry.success)
} catch (error) {
  summary.success = false
  summary.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  await writeFile(join(results, 'electron-summary.json'), JSON.stringify(summary, null, 2) + '\n')
  console.log(JSON.stringify({ success: summary.success, runs: summary.runs, error: summary.error, work }))
}
