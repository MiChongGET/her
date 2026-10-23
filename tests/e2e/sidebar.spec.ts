import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

async function launch(dataDirectory: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] =>
      entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE')
  )
  env.HER_DATA_DIR = dataDirectory
  const executablePath = process.env.HER_TEST_APP_EXECUTABLE
  const app = await _electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [resolve('.')] }), env })
  const page = await app.firstWindow()
  await expect(page.getByRole('button', { name: '日常', exact: true })).toBeVisible()
  return { app, page }
}

test('desktop: topic list actions open from the keyboard without losing the topic', async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'her-sidebar-groups-'))
  let app: ElectronApplication | undefined
  try {
    const running = await launch(dataDirectory)
    app = running.app
    const page = running.page
    await page.getByRole('button', { name: '一起在做的事', exact: true }).click()
    await page.getByRole('button', { name: '另开一个话题' }).first().click()
    await page.getByRole('button', { name: '返回话题' }).click()
    const topic = page.getByRole('button', { name: '新对话', exact: true })
    const menu = page.getByLabel('新对话的更多操作')
    await expect(topic).toBeVisible()
    await menu.focus()
    await menu.press('Enter')
    await expect(page.getByRole('button', { name: '重命名' })).toBeVisible()
    await expect(topic).toBeVisible()
  } finally {
    await app?.close()
    rmSync(dataDirectory, { recursive: true, force: true })
  }
})

test('desktop: sidebar resizing and visibility preserve room for chat in wide and narrow windows', async ({}, testInfo) => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'her-sidebar-layout-'))
  let app: ElectronApplication | undefined
  try {
    const running = await launch(dataDirectory)
    app = running.app
    const page = running.page
    await page.locator('.sidebar-more summary').click(); await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '添加服务', exact: true }).click()
    await page.getByLabel('服务名称', { exact: true }).fill('侧栏布局验收')
    await page.getByLabel('Base URL', { exact: true }).fill('http://127.0.0.1:11434/v1')
    await page.getByLabel('Model ID', { exact: true }).fill('layout-model')
    await page.getByLabel('认证方式', { exact: true }).selectOption('none')
    await page.getByText('高级选项', { exact: true }).click()
    await page.getByLabel('上下文容量', { exact: true }).fill('128000')
    await page.getByRole('button', { name: '保存服务', exact: true }).click()
    await expect(page.getByText('服务已保存', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '关闭设置', exact: true }).click()
    await page.getByRole('button', { name: '一起在做的事', exact: true }).click()
    await page.getByRole('button', { name: '另开一个话题' }).first().click()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 760))
    const sidebar = page.getByRole('complementary', { name: '会话侧栏', exact: true })
    const separator = page.getByRole('separator', { name: '调整侧栏宽度', exact: true })
    const main = page.getByRole('main')
    await expect(separator).toHaveAttribute('aria-orientation', 'vertical')
    await expect(separator).toHaveAttribute('tabindex', '0')
    const originalWidth = await sidebar.evaluate(element => element.getBoundingClientRect().width)
    const originalMainWidth = await main.evaluate(element => element.getBoundingClientRect().width)
    const handle = await separator.boundingBox()
    expect(handle).not.toBeNull()
    await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle!.x + handle!.width / 2 + 60, handle!.y + handle!.height / 2, { steps: 8 })
    await page.mouse.up()
    await expect.poll(() => sidebar.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(originalWidth + 40)
    const resizedWidth = await sidebar.evaluate(element => element.getBoundingClientRect().width)
    const resizedMainWidth = await main.evaluate(element => element.getBoundingClientRect().width)
    expect(resizedMainWidth).toBeLessThan(originalMainWidth - 40)
    await page.screenshot({ path: testInfo.outputPath('sidebar-resized.png') })

    await page.getByRole('button', { name: '隐藏侧栏', exact: true }).click()
    await expect(sidebar).toBeHidden()
    await expect(separator).toBeHidden()
    await expect(page.getByRole('button', { name: '显示侧栏', exact: true })).toBeVisible()
    await expect.poll(() => main.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(resizedMainWidth + resizedWidth - 10)
    await page.screenshot({ path: testInfo.outputPath('sidebar-hidden.png') })
    await page.getByRole('button', { name: '显示侧栏', exact: true }).click()
    await expect(sidebar).toBeVisible()
    await expect.poll(() => sidebar.evaluate(element => element.getBoundingClientRect().width)).toBeCloseTo(resizedWidth, 0)

    await separator.focus()
    await separator.press('ArrowLeft')
    await expect.poll(() => sidebar.evaluate(element => element.getBoundingClientRect().width)).toBeCloseTo(resizedWidth - 16, 0)
    await separator.press('ArrowRight')
    await expect.poll(() => sidebar.evaluate(element => element.getBoundingClientRect().width)).toBeCloseTo(resizedWidth, 0)
    await expect(separator).toBeFocused()
    await separator.press('Home')
    await expect.poll(() => sidebar.evaluate(element => element.getBoundingClientRect().width)).toBeCloseTo(200, 0)

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(850, 620))
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThan(900)
    const viewportWidth = await page.evaluate(() => window.innerWidth)
    await separator.press('End')
    await expect.poll(() => sidebar.evaluate(element => element.getBoundingClientRect().width)).toBeCloseTo(Math.min(360, viewportWidth - 520), 0)
    expect(await main.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(519)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    const composer = await page.getByRole('textbox', { name: '消息', exact: true }).boundingBox()
    expect(composer).not.toBeNull()
    expect(composer!.width).toBeGreaterThan(200)
    expect(composer!.x + composer!.width).toBeLessThanOrEqual(viewportWidth + 1)
    await expect(page.locator('.model-details summary').first()).toBeInViewport()
    await page.locator('.model-details summary').first().click()
    await expect(page.getByRole('combobox', { name: '当前模型', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '隐藏侧栏', exact: true })).toBeInViewport()
    await page.screenshot({ path: testInfo.outputPath('sidebar-narrow.png') })
  } finally {
    await app?.close()
    rmSync(dataDirectory, { recursive: true, force: true })
  }
})
