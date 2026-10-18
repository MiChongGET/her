import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { _electron, expect, test } from '@playwright/test'
import { startMockHttp } from '../helpers/mock-mcp'

// Exercise the application's registered callback without relying on CI macOS
// Accessibility access to synthesize an OS-wide chord. Native registration is also checked.
test('MCP settings, approval reload, hidden global stop, continuation and quit share the real runtime', async ({}, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), 'her-mcp-e2e-'))
  const mcp = await startMockHttp()
  const slowMcp = await startMockHttp({ initDelay: 1500 })
  const requests: any[] = []
  const provider = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk
    const input = JSON.parse(body); requests.push(input)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const push = (delta: unknown, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    const tool = input.tools?.find((item: any) => item.function?.name.startsWith('mcp_'))
    if (tool && input.messages.at(-1)?.role === 'user') {
      push({ tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name: tool.function.name, arguments: '{}' } }] })
      push({}, 'tool_calls')
    } else { push({ content: '任务已完成，保留之前的步骤。' }); push({}, 'stop') }
    response.end('data: [DONE]\n\n')
  })
  await new Promise<void>(done => provider.listen(0, '127.0.0.1', done))
  const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`
  const entry = join(directory, 'entry.cjs')
  writeFileSync(entry, `const { globalShortcut } = require('electron');\nconst callbacks = new Map(); global.__herShortcutCallbacks = callbacks; const original = globalShortcut.register.bind(globalShortcut); globalShortcut.register = (key, callback) => { callbacks.set(key, callback); return original(key, callback); }; import(${JSON.stringify(pathToFileURL(resolve('out/main/index.js')).toString())});`)
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
  const app = await _electron.launch({ args: [entry], env: { ...env, HER_DATA_DIR: directory } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible()
    await page.evaluate(async url => {
      const profile = await window.her.saveProfile({ name: '本地工具验收模型', protocol: 'openai', baseUrl: url, model: 'model-a', models: [{ id: 'model-a' }, { id: 'model-b' }] })
      await window.her.selectProfile(profile.id)
    }, providerUrl)
    await page.reload()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('tab', { name: 'MCP 工具' }).click()
    await page.getByLabel('MCP 名称').fill('本地 MCP 验收')
    await page.getByLabel('传输方式').selectOption('streamable-http')
    await page.getByLabel('MCP URL').fill(mcp.url)
    await page.getByLabel('启用 MCP 服务', { exact: true }).check()
    await page.getByRole('button', { name: '保存 MCP 服务', exact: true }).click()
    await page.getByRole('button', { name: '测试 MCP 连接', exact: true }).click()
    await expect(page.getByText('连接成功，发现 2 个工具。', { exact: true })).toBeVisible()
    await page.getByLabel('MCP 名称').scrollIntoViewIfNeeded()
    await page.screenshot({ path: resolve('.superpowers/sdd/2026-10-15-her-tools-v1/T06-mcp-settings.png') })
    await page.getByRole('button', { name: '测试 MCP 连接', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: resolve('.superpowers/sdd/2026-10-15-her-tools-v1/T06-mcp-status.png') })
    await page.getByRole('button', { name: '关闭设置', exact: true }).click()
    await page.getByLabel('消息', { exact: true }).fill('执行本地测试工具')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect(page.getByRole('button', { name: '允许这次操作', exact: true })).toBeVisible()
    await expect(page.locator('.task-records')).not.toHaveAttribute('open', '')
    expect(mcp.requests.filter(item => item.method === 'tools/call')).toHaveLength(0)
    await page.screenshot({ path: resolve('.superpowers/sdd/2026-10-15-her-tools-v1/T06-task-approval.png') })
    await page.reload()
    await expect(page.getByRole('button', { name: '允许这次操作', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '允许这次操作', exact: true }).click()
    await expect(page.getByText('任务已完成，保留之前的步骤。', { exact: true }).last()).toBeVisible()
    expect(mcp.requests.filter(item => item.method === 'tools/call')).toHaveLength(1)
    const records = page.locator('.task-records')
    const summary = records.locator('summary')
    await expect(records).not.toHaveAttribute('open', '')
    await expect(summary).toContainText('已完成')
    await expect(summary).toContainText('已调用 1 个工具 · model-a')
    await page.screenshot({ path: testInfo.outputPath('task-records-collapsed.png') })
    await summary.press('Enter')
    await expect(records).toHaveAttribute('open', '')
    await expect(records.locator('p').first()).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('task-records-expanded.png') })
    await summary.press('Space')
    await expect(records).not.toHaveAttribute('open', '')
    await page.getByLabel('消息', { exact: true }).fill('再执行一次测试工具')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect(page.getByRole('button', { name: '允许这次操作', exact: true })).toBeVisible()
    const approval = await page.evaluate(async () => {
      const state = await window.her.getBootstrap(); return (await window.her.getConversationTask(state.conversations[0].id))!.approval!
    })
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close() })
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false)
    expect(await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('CommandOrControl+Shift+Escape'))).toBe(true)
    await app.evaluate(() => { (globalThis as any).__herShortcutCallbacks.get('CommandOrControl+Shift+Escape')() })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show())
    await expect(page.getByRole('button', { name: '继续任务', exact: true })).toBeVisible()
    await page.evaluate(input => window.her.decideToolApproval({ approvalId: input.id, revision: input.revision, decision: 'approve' }), approval)
    expect(mcp.requests.filter(item => item.method === 'tools/call')).toHaveLength(1)
    await page.reload()
    await expect(page.getByRole('button', { name: '继续任务', exact: true })).toBeVisible()
    await page.getByLabel('当前模型', { exact: true }).selectOption('model-b')
    await page.getByRole('button', { name: '继续任务', exact: true }).click()
    await expect(page.locator('article.message-assistant[data-status="complete"]')).toHaveCount(2)
    expect(requests.at(-1).model).toBe('model-b')
    expect(requests.at(-1).messages.some((item: any) => item.role === 'tool')).toBe(true)
    expect(mcp.requests.filter(item => item.method === 'tools/call')).toHaveLength(1)
    await page.evaluate(async url => {
      await window.her.saveMcpService({ name: '延迟准备', transport: 'streamable-http', url, enabled: true })
    }, slowMcp.url)
    const beforePreparation = requests.length
    await page.getByLabel('消息', { exact: true }).fill('准备期间重载后停止')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(() => slowMcp.requests.some(item => item.method === 'initialize')).toBe(true)
    await page.reload()
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible()
    await app.evaluate(() => { (globalThis as any).__herShortcutCallbacks.get('CommandOrControl+Shift+Escape')() })
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible()
    await expect.poll(async () => page.evaluate(async () => {
      const config = (await window.her.listMcpServices()).find(item => item.name === '延迟准备')!
      return (await window.her.getMcpStatus(config.id)).state
    })).toBe('ready')
    expect(requests).toHaveLength(beforePreparation)
    expect(slowMcp.requests.filter(item => item.method === 'tools/call')).toHaveLength(0)
    await page.getByLabel('消息', { exact: true }).fill('退出时等待确认')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect(page.getByRole('button', { name: '允许这次操作', exact: true })).toBeVisible()
    const quitting = app.waitForEvent('close')
    await app.evaluate(({ app }) => app.quit())
    await quitting
    expect(mcp.requests.filter(item => item.method === 'tools/call')).toHaveLength(1)
  } finally {
    await app.close().catch(() => {})
    await mcp.close()
    await slowMcp.close()
    provider.closeAllConnections(); await new Promise<void>(done => provider.close(() => done()))
    rmSync(directory, { recursive: true, force: true })
  }
})
