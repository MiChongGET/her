import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, expect, test, type ElectronApplication } from '@playwright/test'

test('missing tools expose real Host setup, safe install actions and an honest recheck', async ({}, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), 'her-install-guidance-'))
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
  const executablePath = process.env.HER_TEST_APP_EXECUTABLE
  let app: ElectronApplication | undefined
  try {
    app = await _electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [resolve('.')] }), env: { ...env, HOME: directory, HER_DATA_DIR: join(directory, 'data') } })
    const page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible()
    const host = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, resources: app.isPackaged ? process.resourcesPath : app.getAppPath() + '/resources' }))
    // Real dependency inspection + IPC. An empty HOME supplies no installed parser.
    const initial = await page.evaluate(() => window.her.checkPresetDependencies('markitdown', ''))
    expect(initial[0].status).toBe('missing')
    expect(initial[0].setup?.command).toBe(`sh '${host.resources}/dependencies/markitdown/install.sh'`)
    expect(existsSync(join(host.resources, 'dependencies/markitdown/install.sh'))).toBe(true)
    expect(existsSync(join(host.resources, 'mcp-web-dependencies/package-lock.json'))).toBe(true)
    // Native permission policy must permit this button; querying never touches the OS clipboard.
    expect(await page.evaluate(async () => (await navigator.permissions.query({ name: 'clipboard-write', allowWithoutGesture: false } as unknown as PermissionDescriptor)).state)).toBe('granted')
    expect(await page.evaluate(async () => (await navigator.permissions.query({ name: 'clipboard-read' } as unknown as PermissionDescriptor)).state)).toBe('denied')
    // Own app only: avoid opening a real browser or changing the user's clipboard.
    await app.evaluate(({ shell }) => {
      const state = globalThis as unknown as { installationLinks: string[] }
      state.installationLinks = []
      shell.openExternal = async url => { state.installationLinks.push(url) }
    })
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as unknown as { copiedInstallCommand: string }).copiedInstallCommand = text } } })
    })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('tab', { name: 'MCP 工具', exact: true }).click()
    await page.getByLabel('MCP 名称', { exact: true }).fill('安装时保留的草稿')
    await page.locator('.mcp-presets').getByRole('combobox').selectOption('markitdown')
    await page.getByRole('button', { name: '检查预设依赖', exact: true }).click()
    const diagnostics = page.getByRole('list', { name: '预设依赖检查' })
    await expect(diagnostics.getByText('未安装', { exact: true })).toBeVisible()
    const command = diagnostics.getByLabel('MarkItDown 安装命令', { exact: true })
    await expect(command).toHaveText(initial[0].setup!.command!)
    await diagnostics.getByRole('button', { name: '查看 uv 安装步骤', exact: true }).click()
    expect(await app.evaluate(() => (globalThis as unknown as { installationLinks: string[] }).installationLinks)).toEqual(['https://docs.astral.sh/uv/getting-started/installation/'])
    await diagnostics.getByRole('button', { name: '复制 MarkItDown 安装命令', exact: true }).click()
    await expect(diagnostics.getByRole('status')).toHaveText('已复制，请在终端运行，完成后重新检查。')
    expect(await page.evaluate(() => (window as unknown as { copiedInstallCommand: string }).copiedInstallCommand)).toBe(initial[0].setup!.command)
    await expect(diagnostics.getByText('未安装', { exact: true })).toBeVisible()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(850, 620))
    await command.scrollIntoViewIfNeeded()
    expect(await page.getByRole('dialog', { name: '设置', exact: true }).evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    await expect(page.getByRole('button', { name: '保存 MCP 服务', exact: true })).toBeInViewport()
    await page.screenshot({ path: testInfo.outputPath('missing-parser-install-guidance.png'), animations: 'disabled' })
    // Simulated completed install at the diagnostic boundary; no installer or fixture executable runs.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('her:mcp-dependencies')
      ipcMain.handle('her:mcp-dependencies', () => [{ component: 'MarkItDown', status: 'ready', message: '模拟安装后依赖已就绪' }])
    })
    await page.getByRole('button', { name: '重新检查依赖', exact: true }).click()
    await expect(diagnostics.getByText('已就绪', { exact: true })).toBeVisible()
    await expect(diagnostics.getByRole('button')).toHaveCount(0)
    await expect(page.getByLabel('MCP 名称', { exact: true })).toHaveValue('安装时保留的草稿')
    writeFileSync(testInfo.outputPath('host-guidance.json'), JSON.stringify({ ...host, initial, recheck: 'simulated diagnostic boundary; no installation performed' }, null, 2))
  } finally {
    await app?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
