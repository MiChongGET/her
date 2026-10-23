import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, expect, test } from '@playwright/test'
import { startMockProvider } from '../helpers/mock-provider'
import { startMockHttp } from '../helpers/mock-mcp'

test('hidden window keeps parallel work, queued messages and pending approval; reopening restores them', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'her-pi-window-'))
  const mcp = await startMockHttp()
  const provider = await startMockProvider({ reply: body => {
    const messages = body.messages as { role: string; content: unknown }[]
    const last = messages.at(-1)!
    if (last.role === 'user' && JSON.stringify(last.content).includes('approve this')) {
      const tools = body.tools as { function: { name: string } }[]
      return { toolCall: { name: tools.find(tool => tool.function.name.startsWith('mcp_'))!.function.name, arguments: { value: 1 } } }
    }
    return { text: 'background finished', ...(JSON.stringify(last.content).includes('background request') ? { delayMs: 1500 } : {}) }
  } })
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
  const executablePath = process.env.HER_TEST_APP_EXECUTABLE
  const app = await _electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [resolve('.')] }), env: { ...env, HER_DATA_DIR: directory } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '日常', exact: true })).toBeVisible()
    const state = await page.evaluate(async ({ url, mcpUrl }) => {
      const profile = await window.her.saveProfile({ name: 'fixture', protocol: 'openai', baseUrl: url, model: 'fixture-model', contextWindow: 128000, authMethod: 'none' })
      await window.her.selectProfile(profile.id)
      const a = (await window.her.getBootstrap()).dailyConversationId
      await window.her.renameConversation(a, '等待确认的会话')
      const service = await window.her.saveMcpService({ name: 'test MCP', enabled: true, transport: 'streamable-http', url: mcpUrl })
      await window.her.testMcpService(service.id)
      return { profileId: profile.id, a }
    }, { url: provider.baseUrl, mcpUrl: mcp.url })
    await page.reload()
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('approve this')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect(page.getByRole('button', { name: '执行一次', exact: true })).toBeVisible()
    await page.evaluate(async ({ profileId, a, requestId }) => {
      await window.her.sendMessage({ requestId, conversationId: a, profileId, content: 'queued after approval' })
    }, { ...state, requestId: randomUUID() })
    await page.getByRole('button', { name: '一起在做的事', exact: true }).click()
    await page.getByRole('button', { name: '另开一个话题' }).first().click()
    const b = (await page.evaluate(() => window.her.listWorkItems()))[0].conversation.id
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('background request')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    expect(await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.close(); return !window.isVisible() && !window.isDestroyed() })).toBe(true)
    await expect.poll(async () => (await page.evaluate(id => window.her.getMessages(id), b)).at(-1)?.status).toBe('complete')
    expect(await page.evaluate(id => window.her.getQueue(id).then(queue => queue.items.length), state.a)).toBe(1)
    expect(mcp.requests.filter(request => request.method === 'tools/call')).toHaveLength(0)
    await app.evaluate(({ app }) => app.emit('activate'))
    await page.reload()
    await expect(page.getByRole('button', { name: '日常', exact: true })).toHaveAttribute('aria-current', 'page')
    expect((await page.evaluate(() => window.her.getBootstrap())).dailyConversationId).toBe(state.a)
    await expect(page.getByRole('heading', { name: '日常', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '执行一次', exact: true })).toBeVisible()
    await expect(page.getByText('queued after approval', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '执行一次', exact: true }).click()
    await expect.poll(async () => (await page.evaluate(id => window.her.getQueue(id), state.a)).items.length).toBe(0)
    await expect.poll(async () => (await page.evaluate(id => window.her.getMessages(id), state.a)).at(-1)?.status).toBe('complete')
    expect(mcp.requests.filter(request => request.method === 'tools/call')).toHaveLength(1)
  } finally {
    await app.close(); await provider.close(); await mcp.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
