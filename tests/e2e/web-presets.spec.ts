import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { _electron, expect, test } from '@playwright/test'

// Actual installed dependencies and Electron IPC, with no tools/call and no Chrome consent automation.
test('verified web presets can be added in isolated Electron; search stays disabled and Chrome readiness remains metadata-only', async () => {
  test.skip(!process.env.HER_TEST_WEB_PRESETS, 'Requires explicitly provisioned fixed web-tools-v1 dependencies')
  const directory = mkdtempSync(join(tmpdir(), 'her-web-presets-'))
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
  const app = await _electron.launch({ args: [resolve('out/main/index.js')], env: { ...env, HER_DATA_DIR: directory } })
  try {
    const page = await app.firstWindow()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('tab', { name: 'MCP 工具' }).click()
    await page.getByRole('combobox', { name: /预设/ }).selectOption('open-websearch')
    await page.getByRole('button', { name: '检查预设依赖', exact: true }).click()
    await expect(page.getByRole('button', { name: '添加已验证预设' })).toBeEnabled()
    await page.getByRole('button', { name: '添加已验证预设' }).click()
    await expect(page.getByRole('button', { name: '可选搜索 · open-webSearch · 已停用' })).toBeVisible()
    expect((await page.evaluate(() => window.her.listMcpServices()))[0].enabled).toBe(false)
    await page.getByRole('combobox', { name: /预设/ }).selectOption('playwright')
    await page.getByRole('button', { name: '检查预设依赖', exact: true }).click()
    await expect(page.getByRole('button', { name: '添加已验证预设' })).toBeEnabled()
    await page.getByRole('button', { name: '添加已验证预设' }).click()
    await expect(page.getByText(/工具就绪仅表示 MCP 元数据已连接/)).toBeVisible()
    await page.getByRole('button', { name: '测试 MCP 连接', exact: true }).click()
    await expect(page.getByText('连接成功，发现 11 个工具。', { exact: true })).toBeVisible()
    await page.screenshot({ path: resolve('.superpowers/sdd/2026-10-15-her-tools-v1/T08-presets-electron.png') })
    const browser = (await page.evaluate(() => window.her.listMcpServices())).find(item => item.presetId === 'playwright')!
    expect(browser.args).toContain('--extension'); expect(browser.args).toContain('--no-webmcp'); expect(browser.args).toContain('--snapshot-mode')
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }) }
})
