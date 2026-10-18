import { cp, mkdir, readFile, writeFile, readdir, lstat, symlink, access, mkdtemp } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir, homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { packager } from '@electron/packager'
import { listPackage } from '@electron/asar'

const packagingDir = dirname(fileURLToPath(import.meta.url))
const experimentDir = dirname(packagingDir)
const root = resolve(experimentDir, '../..')
const resultsDir = join(experimentDir, 'results')
const runId = new Date().toISOString().replaceAll(/[:.]/g, '-')
const workRoot = join(packagingDir, 'work', runId)
const isolatedRoot = await mkdtemp(join(tmpdir(), 'her-pi-package-'))
const rootPackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const electronExe = join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const buildCli = join(root, 'node_modules/electron-vite/bin/electron-vite.js')
const summary = {
  observedAt: new Date().toISOString(), root, workRoot, isolatedRoot,
  changesLimitedTo: 'experiment files and temporary directories',
  signed: false, published: false,
  buildConfig: 'current Her electron.vite.config.ts copied unchanged',
  runs: [],
}
await mkdir(workRoot, { recursive: true })
await mkdir(resultsDir, { recursive: true })

async function inputHashes() {
  const hashes = {}
  for (const path of ['adapter.ts', 'fixtures.ts', 'packaging/probe.ts']) {
    hashes[path] = createHash('sha256').update(await readFile(join(experimentDir, path))).digest('hex')
  }
  return hashes
}

async function sizeOf(path) {
  const stat = await lstat(path)
  if (!stat.isDirectory()) return stat.size
  let total = 0
  for (const name of await readdir(path)) total += await sizeOf(join(path, name))
  return total
}

function command(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const started = performance.now()
    const child = spawn(command, args, { cwd: options.cwd ?? root, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const timeout = setTimeout(() => child.kill('SIGKILL'), options.timeout ?? 120000)
    child.on('error', error => { clearTimeout(timeout); reject(error) })
    child.on('exit', (code, signal) => {
      clearTimeout(timeout)
      resolvePromise({ command, args, code, signal, elapsedMs: performance.now() - started, stdout, stderr })
    })
  })
}

async function linkModules(source, target) {
  await mkdir(target, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      await linkModules(join(source, entry.name), join(target, entry.name))
      continue
    }
    const destination = join(target, entry.name)
    try { await access(destination) } catch { await symlink(join(source, entry.name), destination, 'dir') }
  }
}

async function createCopy(label, withPi) {
  const destination = join(workRoot, label)
  await mkdir(destination)
  for (const path of ['src', 'electron.vite.config.ts', 'tsconfig.json']) {
    await cp(join(root, path), join(destination, path), { recursive: true })
  }
  const packageJson = structuredClone(rootPackage)
  packageJson.name = `her-pi-validation-${label}`
  if (withPi) packageJson.dependencies['@earendil-works/pi-ai'] = '1.2.0'
  await writeFile(join(destination, 'package.json'), JSON.stringify(packageJson, null, 2))
  await linkModules(join(root, 'node_modules'), join(destination, 'node_modules'))
  if (withPi) await linkModules(join(experimentDir, 'node_modules'), join(destination, 'node_modules'))
  const mainPath = join(destination, 'src/main/index.ts')
  let main = await readFile(mainPath, 'utf8')
  const probeImport = withPi
    ? `import { runPackagingProbe } from ${JSON.stringify(join(packagingDir, 'probe.ts'))}\n`
    : `import { writeFileSync as writeProbe } from 'node:fs'\nasync function runPackagingProbe(renderer: { url: string; title: string }) { writeProbe(process.env.HER_PI_PROBE_RESULT!, JSON.stringify({ success: true, mode: 'baseline', observedAt: new Date().toISOString(), versions: process.versions, processType: process.type, isPackaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath, userData: app.getPath('userData'), renderer }, null, 2)); app.exit(0) }\n`
  main = probeImport + main
    .replace("app.setName('Her')", `app.setName('Her Pi Validation ${label}')`)
    .replace("store = new HerStore(join(dataDirectory, 'her.sqlite'))", "store = new HerStore(join(dataDirectory, 'her.sqlite'))\n  store.setSettings({ ...store.getSettings(), shortcut: '' })")
    .replace("await window.loadURL('her://app/index.html')", "await window.loadURL('her://app/index.html')\n    await runPackagingProbe({ url: window.webContents.getURL(), title: window.webContents.getTitle() })")
  await writeFile(mainPath, main)
  const built = await command(process.execPath, [buildCli, 'build'], { cwd: destination })
  await writeFile(join(destination, 'build.log'), built.stdout + '\n' + built.stderr)
  if (built.code !== 0) throw new Error(`${label} build failed: ${built.stderr}`)
  return { path: destination, buildMs: built.elapsedMs, outBytes: await sizeOf(join(destination, 'out')), mainBytes: await sizeOf(join(destination, 'out/main')) }
}

async function runElectron(label, executable, args, mode) {
  const outputPath = join(resultsDir, `electron-${label}.json`)
  const userData = join(isolatedRoot, `userdata-${label}`)
  await mkdir(userData, { recursive: true })
  const env = { ...process.env, HER_DATA_DIR: userData, HER_PI_PROBE_MODE: mode, HER_PI_PROBE_RESULT: outputPath }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  delete env.NODE_PATH
  delete env.NODE_OPTIONS
  const run = await command(executable, args, { cwd: isolatedRoot, env, timeout: 60000 })
  let observation
  try { observation = JSON.parse(await readFile(outputPath, 'utf8')) } catch { observation = { success: false, error: 'No probe result written' } }
  Object.assign(observation, { processExitCode: run.code, processSignal: run.signal, launchToExitMs: run.elapsedMs, stdout: run.stdout, stderr: run.stderr })
  await writeFile(outputPath, JSON.stringify(observation, null, 2) + '\n')
  summary.runs.push({ label, result: outputPath, success: observation.success && run.code === 0 })
  if (!observation.success || run.code !== 0) throw new Error(`${label} failed; see ${outputPath}`)
  return observation
}

try {
  const baseline = await createCopy('baseline', false)
  summary.baseline = baseline
  await runElectron('baseline', electronExe, [baseline.path], 'baseline')
  summary.sourceSha256 = await inputHashes()
  const withPi = await createCopy('with-pi', true)
  if (JSON.stringify(summary.sourceSha256) !== JSON.stringify(await inputHashes())) {
    throw new Error('Experiment source changed while Vite was building; rerun against a stable snapshot')
  }
  summary.withPi = withPi
  summary.outputDeltaBytes = withPi.outBytes - baseline.outBytes
  await runElectron('built-pi', electronExe, [withPi.path], 'pi')

  const stage = join(workRoot, 'stage')
  await mkdir(stage)
  await cp(join(withPi.path, 'out'), join(stage, 'out'), { recursive: true })
  await writeFile(join(stage, 'package.json'), JSON.stringify({ name: 'her-pi-validation', version: rootPackage.version, type: 'module', main: 'out/main/index.js', dependencies: { '@earendil-works/pi-ai': '1.2.0' } }, null, 2))
  const lock = JSON.parse(await readFile(join(experimentDir, 'package-lock.json'), 'utf8'))
  const runtimePackages = Object.entries(lock.packages).filter(([path, metadata]) => path.startsWith('node_modules/') && !metadata.dev)
  for (const [path] of runtimePackages) {
    await mkdir(dirname(join(stage, path)), { recursive: true })
    await cp(join(experimentDir, path), join(stage, path), { recursive: true, dereference: true })
  }
  summary.runtimePackages = runtimePackages.length
  summary.runtimeDependencyBytes = await sizeOf(join(stage, 'node_modules'))
  const zipName = `electron-v${rootPackage.devDependencies.electron}-darwin-${process.arch}.zip`
  const cache = join(homedir(), 'Library/Caches/electron')
  let electronZipDir
  for (const entry of await readdir(cache, { withFileTypes: true })) {
    const candidate = entry.isDirectory() ? join(cache, entry.name) : cache
    try { await access(join(candidate, zipName)); electronZipDir = candidate; break } catch { /* Use normal download if the version is not cached. */ }
  }
  summary.electronZipDir = electronZipDir ?? null
  const packaged = await packager({ dir: stage, name: 'Her Pi Validation', platform: 'darwin', arch: process.arch, electronVersion: rootPackage.devDependencies.electron, electronZipDir, out: join(isolatedRoot, 'bundles'), asar: true, asarIntegrityDigest: false, prune: false, overwrite: false, appBundleId: 'local.her.pi-validation' })
  const appPath = join(packaged[0], 'Her Pi Validation.app')
  const asarPath = join(appPath, 'Contents/Resources/app.asar')
  const asarEntries = listPackage(asarPath)
  summary.packaged = { appPath, asarPath, appBytes: await sizeOf(appPath), asarBytes: await sizeOf(asarPath), entries: asarEntries.length, piEntryIncluded: asarEntries.includes('/node_modules/@earendil-works/pi-ai/dist/index.js'), openAiIncluded: asarEntries.includes('/node_modules/openai/index.mjs'), anthropicIncluded: asarEntries.includes('/node_modules/@anthropic-ai/sdk/index.mjs'), asarIntegrityDigest: false }
  await runElectron('packaged-pi', join(appPath, 'Contents/MacOS/Her Pi Validation'), [], 'packaged-pi')
  summary.success = true
} catch (error) {
  summary.success = false
  summary.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
  process.exitCode = 1
} finally {
  await writeFile(join(resultsDir, 'packaging-results.json'), JSON.stringify(summary, null, 2) + '\n')
  console.log(JSON.stringify({ success: summary.success, results: join(resultsDir, 'packaging-results.json'), workRoot, isolatedRoot }))
}
