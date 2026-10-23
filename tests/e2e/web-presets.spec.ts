import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { _electron, expect, test } from '@playwright/test'

// Actual installed search dependency and Electron IPC, with no tools/call.
test('verified optional search can be added in isolated Electron and stays disabled', async () => {
  test.skip(!process.env.HER_TEST_WEB_PRESETS, 'Requires explicitly provisioned fixed web-tools-v1 dependencies')
  const directory = mkdtempSync(join(tmpdir(), 'her-web-presets-'))
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
  const app = await _electron.launch({ ...(process.env.HER_TEST_APP_EXECUTABLE ? { executablePath: process.env.HER_TEST_APP_EXECUTABLE, args: [] } : { args: [resolve('out/main/index.js')] }), env: { ...env, HER_DATA_DIR: directory } })
  try {
    const page = await app.firstWindow()
    await page.locator('.sidebar-more summary').click(); await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('tab', { name: 'MCP 工具' }).click()
    await page.getByRole('combobox', { name: /预设/ }).selectOption('open-websearch')
    await page.getByRole('button', { name: '检查预设依赖', exact: true }).click()
    await expect(page.getByRole('button', { name: '添加已验证预设' })).toBeEnabled()
    await page.getByRole('button', { name: '添加已验证预设' }).click()
    await expect(page.getByRole('button', { name: '可选搜索 · open-webSearch · 已停用' })).toBeVisible()
    expect((await page.evaluate(() => window.her.listMcpServices()))[0].enabled).toBe(false)
    expect((await page.evaluate(() => window.her.listMcpPresets())).map(preset => preset.id)).toEqual(['peekaboo', 'markitdown', 'open-websearch'])
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }) }
})
