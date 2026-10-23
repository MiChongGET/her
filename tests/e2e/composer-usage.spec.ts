import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, expect, test } from '@playwright/test'
import { fixtureWire } from '../pi-sdk/wire'

test('composer keeps only a ring visible and opens real Pi usage and compaction at desktop widths', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'her-composer-usage-'))
  const evidence = resolve('.taste-skill/composer-usage')
  mkdirSync(evidence, { recursive: true })
  let requests = 0
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* drain the request */ }
    requests++
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const input = requests === 1 ? 3406 : 7165, output = requests === 1 ? 137 : 101
    response.end(fixtureWire('openai', 'text', input).replaceAll('你好🌙', requests === 1 ? '我可以陪你整理思路、处理资料，也可以调用已授权的工具。' : '这是一条用于验证 token 用量与输入区排版的模拟回复。')
      .replaceAll('"completion_tokens":5', `"completion_tokens":${output}`).replaceAll(`"total_tokens":${input + 5}`, `"total_tokens":${input + output}`))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
  const executablePath = process.env.HER_TEST_APP_EXECUTABLE
  const app = await _electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [resolve('.')] }), env: { ...env, HER_DATA_DIR: directory } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '日常', exact: true })).toBeVisible()
    await page.evaluate(async baseUrl => {
      const saved = await window.her.saveProfile({ name: '界面验收 · 模拟服务', protocol: 'openai', baseUrl, model: 'test-model', contextWindow: 16000, authMethod: 'none' })
      await window.her.selectProfile(saved.id)
    }, baseUrl)
    await page.reload()
    for (const prompt of ['你可以帮我做些什么？', '说明一下这次回复的 token 用量。']) {
      await page.getByRole('textbox', { name: '消息', exact: true }).fill(prompt)
      await page.getByRole('button', { name: '发送', exact: true }).click()
      await expect(page.locator('.message-assistant[data-status="complete"]')).toHaveCount(prompt.startsWith('你') ? 1 : 2)
    }
    const controls = page.getByRole('group', { name: 'Token 用量与上下文' })
    const summary = controls.getByLabel('查看 token 用量与上下文')
    await expect(summary).toHaveText('45%')
    await expect(controls.getByRole('button', { name: '压缩上下文' })).not.toBeVisible()
    await expect(controls.locator('.usage-popover')).not.toBeVisible()
    await page.reload()
    await expect(summary).toHaveText('45%')
    expect(requests).toBe(2)
    await expect(page.locator('.message-assistant[data-status="complete"]')).toHaveCount(2)
    await expect(page.locator('.message-usage')).toHaveCount(0)
    for (const [width, height] of [[1440, 900], [1024, 768], [850, 640]]) {
      await app.evaluate(({ BrowserWindow }, { width, height }) => BrowserWindow.getAllWindows()[0].setSize(width, height), { width, height })
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds().width)).toBe(width)
      await expect(summary).toBeInViewport()
      const ring = await summary.boundingBox(), composer = await page.locator('.composer').boundingBox()
      expect(ring!.x + ring!.width).toBeGreaterThan(composer!.x + composer!.width - 75)
      expect(ring!.y + ring!.height).toBeGreaterThan(composer!.y + composer!.height - 25)
      expect(await controls.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      await page.screenshot({ path: join(evidence, `desktop-${width}.png`) })
      if (width === 1440) await page.locator('.composer').screenshot({ path: join(evidence, 'composer-preview.png') })
    }
    await summary.focus(); await page.keyboard.press('Enter')
    await expect(controls.locator('.usage-popover')).toBeVisible()
    await expect(controls.locator('.usage-popover')).toContainText('7,165')
    await expect(controls.locator('.usage-popover')).toContainText('10,809')
    await expect(controls.getByRole('button', { name: '压缩上下文' })).toBeVisible()
    await expect(controls.locator('.usage-popover')).toContainText('7,266 / 16,000')
    await expect(controls.locator('.usage-popover')).toBeInViewport()
    await page.screenshot({ path: join(evidence, 'details-850.png') })
    await page.keyboard.press('Escape')
    await expect(summary).toBeFocused()
    await expect(controls.locator('details')).not.toHaveAttribute('open', '')
    await summary.click()
    await page.getByRole('textbox', { name: '消息', exact: true }).click({ position: { x: 8, y: 8 } })
    await expect(controls.locator('.usage-popover')).not.toBeVisible()
    await summary.click()
    await page.getByRole('button', { name: '压缩上下文' }).click()
    await expect(page.getByRole('alert')).toContainText('没有足够的内容可以压缩')
    await expect(controls).not.toContainText('已压缩')
    const markup = await controls.evaluate(node => node.outerHTML)
    const css = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    writeFileSync(join(evidence, 'component.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Her 输入区用量控件</title><style>${css}\nbody { min-width: 0; height: auto; padding: 32px 16px; background: var(--paper); } .component-preview { display: flex; align-items: flex-start; justify-content: flex-end; max-width: 800px; margin: 0 auto; min-height: 600px; } .usage-popover { bottom: auto; top: calc(100% + 10px); }</style><main class="component-preview">${markup}</main></html>`)
  } finally { await app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }) }
})
