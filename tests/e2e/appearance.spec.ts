import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, expect, test, type ElectronApplication } from '@playwright/test'

async function launch(dataDirectory: string): Promise<ElectronApplication> {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] =>
      entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE')
  )
  env.HER_DATA_DIR = dataDirectory
  return _electron.launch({ args: [resolve('.')], env })
}

test('appearance changes in the Electron window and survives restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'her-appearance-'))
  let app: ElectronApplication | undefined
  try {
    app = await launch(directory)
    let page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '日常', exact: true })).toBeVisible()
    expect((await page.evaluate(() => window.her.getBootstrap())).settings.appearance).toBe('system')
    await page.getByRole('textbox', { name: '消息' }).fill('夜间草稿')
    await page.locator('.sidebar-more summary').click()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('tab', { name: '桌面偏好' }).click()
    await page.getByLabel('唤出快捷键').fill('CommandOrControl+Alt+A')

    await page.getByRole('radio', { name: '深色' }).click({ force: true })
    await expect(page.getByText('外观已保存')).toBeVisible()
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe('rgb(28, 29, 27)')
    expect(await page.locator('.settings-dialog').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(40, 43, 39)')
    await expect(page.getByLabel('唤出快捷键')).toHaveValue('CommandOrControl+Alt+A')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(850, 620))
    await expect(page.getByRole('radio', { name: '深色' })).toBeInViewport()
    await page.getByRole('button', { name: '关闭设置' }).click()
    await expect(page.getByRole('textbox', { name: '消息' })).toHaveValue('夜间草稿')
    expect(await page.locator('.composer').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(40, 43, 39)')
    await page.getByRole('button', { name: '一起在做的事' }).click()
    expect(await page.locator('.chat-main').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(28, 29, 27)')
    await page.locator('.sidebar-more summary').click()
    await page.getByRole('button', { name: '回收站', exact: true }).click()
    expect(await page.locator('.trash-dialog').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(40, 43, 39)')
    await page.getByRole('button', { name: '关闭回收站' }).click()
    await page.locator('.sidebar-more summary').click()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('tab', { name: '桌面偏好' }).click()
    expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark')

    await app.close(); app = undefined
    app = await launch(directory)
    page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '日常', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-appearance'))).toBe('dark')
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe('rgb(28, 29, 27)')
    await page.locator('.sidebar-more summary').click()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('tab', { name: '桌面偏好' }).click()

    await page.getByRole('radio', { name: '浅色' }).click({ force: true })
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe('rgb(248, 247, 243)')
    expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light')

    await page.getByRole('radio', { name: '跟随系统' }).click({ force: true })
    await expect.poll(() => app!.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('system')
    await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark' })
    await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-appearance'))).toBe('dark')
    await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'system' })
    await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-appearance'))).toBe(
      await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors ? 'dark' : 'light'))
    await app.close(); app = undefined

    app = await launch(directory)
    page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '日常', exact: true })).toBeVisible()
    expect((await page.evaluate(() => window.her.getBootstrap())).settings.appearance).toBe('system')
    expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('system')
  } finally {
    await app?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
