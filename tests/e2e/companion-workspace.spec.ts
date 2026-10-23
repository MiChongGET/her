import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron, expect, test, type Page } from '@playwright/test'
import { HerStore } from '../../src/core/storage/store'
import { dataPaths } from '../../src/core/storage/paths'
import { openConversationHistory } from '../../src/core/agent/factory'
import { startFixtureServer } from '../pi-sdk/wire'
import { startMockProvider } from '../helpers/mock-provider'
import { startMockHttp } from '../helpers/mock-mcp'

const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
async function launch(directory: string) {
  const executablePath = process.env.HER_TEST_APP_EXECUTABLE
  const app = await _electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [resolve('.')] }), env: { ...env, HER_DATA_DIR: directory } })
  const page = await app.firstWindow()
  await expect(page.getByRole('button', { name: '日常', exact: true })).toHaveAttribute('aria-current', 'page')
  return { app, page }
}
async function profile(page: Page, baseUrl: string) {
  await page.evaluate(async baseUrl => {
    const saved = await window.her.saveProfile({ name: '隔离本地验收', protocol: 'openai', baseUrl, model: 'test-model', contextWindow: 128000, authMethod: 'none' })
    await window.her.selectProfile(saved.id)
  }, baseUrl)
  await page.reload()
  await expect(page.getByRole('button', { name: '日常', exact: true })).toHaveAttribute('aria-current', 'page')
}
async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: '消息', exact: true }).fill(text)
  await page.getByRole('button', { name: '发送', exact: true }).click()
}
async function screenshot(page: Page, name: string) {
  const directory = resolve('experiments/companion-workspace/screenshots')
  mkdirSync(directory, { recursive: true })
  await page.screenshot({ path: join(directory, `${process.env.HER_TEST_APP_EXECUTABLE ? 'package' : 'source'}-${name}.png`) })
}
async function createWork(page: Page, title: string) {
  await page.getByRole('button', { name: '一起在做的事', exact: true }).click()
  await page.getByRole('button', { name: '另开一个话题' }).first().click()
  await page.getByRole('button', { name: '重命名对话', exact: true }).click()
  await page.getByLabel('对话标题', { exact: true }).fill(title)
  await page.getByLabel('对话标题', { exact: true }).press('Enter')
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
  return page.evaluate(async title => (await window.her.listWorkItems()).find(item => item.conversation.title === title)!.conversation.id, title)
}

test('daily_work_private_approval_round_trip', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'her-workspace-approval-'))
  const mcp = await startMockHttp({ callDelay: 500 })
  let step = 0
  const provider = await startMockProvider({ reply: body => ++step === 1
    ? { toolCall: { name: (body.tools as { function: { name: string } }[]).find(tool => tool.function.name.startsWith('mcp_'))!.function.name, arguments: { value: 0 } } }
    : { text: '后台工作已完成', delayMs: 500 } })
  let running = await launch(directory)
  try {
    let { page, app } = running
    await profile(page, provider.baseUrl)
    const daily = (await page.evaluate(() => window.her.getBootstrap())).dailyConversationId
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(850, 620))
    await page.evaluate(async url => {
      const service = await window.her.saveMcpService({ name: '审批对象秘密哨兵', enabled: true, transport: 'streamable-http', url })
      await window.her.testMcpService(service.id)
    }, mcp.url)
    const work = await createWork(page, '工作标题秘密哨兵')
    await send(page, '工作正文秘密哨兵')
    await expect(page.getByRole('button', { name: '执行一次', exact: true })).toBeVisible()
    const approval = (await page.evaluate(id => window.her.getConversationTask(id), work))!.approval!
    const notice = (await page.evaluate(() => window.her.getPendingActions()))[0]
    expect(Object.keys(notice).sort()).toEqual(['id', 'status', 'version'])
    expect(mcp.requests.filter(request => request.method === 'tools/call')).toHaveLength(0)
    await page.getByRole('button', { name: '日常', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeFocused()
    await expect(page.locator('.pending-notice')).toContainText('有一件事需要你确认')
    for (const secret of ['工作标题秘密哨兵', '工作正文秘密哨兵', '审批对象秘密哨兵', approval.target, approval.summary]) {
      if (secret) await expect(page.locator('body')).not.toContainText(secret)
    }
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeInViewport()
    await screenshot(page, 'daily-private-notice-850x620')
    expect(await page.evaluate(id => window.her.getMessages(id).then(() => false, () => true), work)).toBe(true)
    await page.getByRole('button', { name: '查看', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('heading', { name: '工作标题秘密哨兵', exact: true })).toBeVisible()
    expect((await page.evaluate(id => window.her.getConversationTask(id), work))!.approval!.id).toBe(approval.id)
    const allow = page.getByRole('button', { name: '执行一次', exact: true })
    await allow.scrollIntoViewIfNeeded()
    await expect(allow).toBeInViewport()
    await screenshot(page, 'work-approval-850x620')
    await allow.focus(); await page.keyboard.press('Enter')
    await page.getByRole('button', { name: '日常', exact: true }).click()
    await expect.poll(() => mcp.requests.filter(request => request.method === 'tools/call').length).toBe(1)
    await expect.poll(() => provider.requests.length).toBe(2)
    await expect.poll(() => page.evaluate(() => window.her.getPendingActions())).toEqual([])
    await page.getByRole('button', { name: '一起在做的事', exact: true }).click()
    await page.getByRole('button', { name: '工作标题秘密哨兵', exact: true }).click()
    await expect(page.locator('.message-assistant[data-status="complete"]')).toContainText('后台工作已完成')
    await page.getByRole('button', { name: '日常', exact: true }).click()
    await expect(page.locator('.message')).toHaveCount(0)
    expect(await page.evaluate(input => window.her.resolvePendingAction(input), { id: notice.id, version: notice.version })).toBeNull()
    await app.close()
    running = await launch(directory); ({ page, app } = running)
    expect((await page.evaluate(() => window.her.getBootstrap())).dailyConversationId).toBe(daily)
    await expect(page.locator('.message')).toHaveCount(0)
    expect(mcp.requests.filter(request => request.method === 'tools/call')).toHaveLength(1)
  } finally { await running.app.close(); await provider.close(); await mcp.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('legacy_and_work_secrets_never_enter_daily_requests', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'her-workspace-boundary-'))
  const paths = dataPaths(directory), legacy = randomUUID(), work = randomUUID()
  const store = new HerStore(paths.database)
  store.createConversation(legacy, randomUUID(), '旧历史秘密哨兵')
  store.createWorkConversation(work, randomUUID(), '工作秘密哨兵')
  for (const [id, text] of [[legacy, '旧历史秘密哨兵'], [work, '工作秘密哨兵']]) {
    const { manager } = await openConversationHistory(paths.root, store.getConversation(id)!)
    manager.appendMessage({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() })
  }
  store.close()
  const server = await startFixtureServer('openai', 'text', { byteChunks: true })
  let running = await launch(directory)
  try {
    await profile(running.page, server.baseUrl + '/v1')
    const daily = (await running.page.evaluate(() => window.her.getBootstrap())).dailyConversationId
    expect([legacy, work]).not.toContain(daily)
    for (let round = 0; round < 3; round++) {
      const { page } = running
      await send(page, `日常独立请求 ${round}`)
      await expect(page.locator('.message-assistant[data-status="complete"]')).toHaveCount(round + 1)
      const body = JSON.stringify(server.requests.at(-1)!.body)
      for (const secret of ['工作秘密哨兵', '旧历史秘密哨兵']) expect(body).not.toContain(secret)
      expect(body).toContain(`日常独立请求 ${round}`)
      await page.getByRole('button', { name: '一起在做的事', exact: true }).click()
      expect(await page.evaluate(() => window.her.listWorkItems())).toEqual([
        expect.objectContaining({ conversation: expect.objectContaining({ id: work }), topic: expect.objectContaining({ kind: 'work', shareProgress: true }) })
      ])
      await expect(page.getByRole('button', { name: '旧历史秘密哨兵', exact: true })).toHaveCount(0)
      await page.getByRole('button', { name: '工作秘密哨兵', exact: true }).click()
      expect((await page.evaluate(id => window.her.getMessages(id), work)).map(message => message.content)).toContain('工作秘密哨兵')
      await page.getByRole('button', { name: '日常', exact: true }).click()
      if (round < 2) {
        await running.app.close()
        if (round === 1) {
          const db = new DatabaseSync(paths.database)
          expect((db.prepare('SELECT COUNT(*) AS count FROM projection_entries').get() as { count: number }).count).toBeGreaterThan(0)
          db.exec('DELETE FROM projection_entries'); db.close()
        }
        running = await launch(directory)
        expect((await running.page.evaluate(() => window.her.getBootstrap())).dailyConversationId).toBe(daily)
      }
    }
    writeFileSync(resolve(`experiments/companion-workspace/${process.env.HER_TEST_APP_EXECUTABLE ? 'package' : 'source'}-daily-requests.json`), JSON.stringify(server.requests.map(request => request.body), null, 2))
    expect(server.requests).toHaveLength(3)
  } finally { await running.app.close(); await server.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('restoring_old_daily_keeps_current_daily', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'her-workspace-restore-')), paths = dataPaths(directory)
  const store = new HerStore(paths.database), old = store.ensureDailyConversation()
  store.renameConversation(old.id, '旧日常保留记录')
  const { manager } = await openConversationHistory(paths.root, old)
  manager.appendMessage({ role: 'user', content: '旧日常内容哨兵', timestamp: Date.now() })
  store.trashConversation(old.id)
  const current = store.ensureDailyConversation()
  store.close()
  const running = await launch(directory)
  try {
    const { page } = running
    expect((await page.evaluate(() => window.her.getBootstrap())).dailyConversationId).toBe(current.id)
    await page.getByText('更多', { exact: true }).click()
    await page.getByRole('button', { name: '回收站', exact: true }).click()
    await page.getByRole('button', { name: '恢复 旧日常保留记录', exact: true }).click()
    await expect(page.getByText('回收站是空的', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '关闭回收站', exact: true }).click()
    await expect(page.getByRole('button', { name: '日常', exact: true })).toHaveAttribute('aria-current', 'page')
    expect((await page.evaluate(() => window.her.getBootstrap())).dailyConversationId).toBe(current.id)
    await expect(page.locator('body')).not.toContainText('旧日常内容哨兵')
    await page.getByRole('button', { name: '一起在做的事', exact: true }).click()
    expect((await page.evaluate(() => window.her.listWorkItems())).find(item => item.conversation.id === old.id)).toBeUndefined()
    await expect(page.getByRole('button', { name: '旧日常保留记录', exact: true })).toHaveCount(0)
    await page.reload()
    expect((await page.evaluate(() => window.her.getBootstrap())).dailyConversationId).toBe(current.id)
    await expect(page.getByRole('button', { name: '日常', exact: true })).toHaveAttribute('aria-current', 'page')
  } finally { await running.app.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('hidden_pending_open_resolves_owner', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'her-workspace-hidden-'))
  const mcp = await startMockHttp()
  let releaseReply!: () => void
  const replyReady = new Promise<void>(resolve => { releaseReply = resolve })
  const provider = await startMockProvider({ beforeReply: () => replyReady, reply: body => ({ toolCall: { name: (body.tools as { function: { name: string } }[]).find(tool => tool.function.name.startsWith('mcp_'))!.function.name, arguments: { value: 0 } } }) })
  const { app, page } = await launch(directory)
  try {
    await profile(page, provider.baseUrl)
    await page.evaluate(async url => { const service = await window.her.saveMcpService({ name: '隐藏对象秘密哨兵', enabled: true, transport: 'streamable-http', url }); await window.her.testMcpService(service.id) }, mcp.url)
    const work = await createWork(page, '隐藏话题秘密哨兵')
    await send(page, '隐藏任务正文秘密哨兵')
    await page.getByRole('button', { name: '日常', exact: true }).click()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false)
    await expect.poll(() => provider.requests.length).toBe(1)
    expect(await page.evaluate(() => window.her.getPendingActions())).toEqual([])
    releaseReply()
    await expect.poll(async () => (await page.evaluate(() => window.her.getPendingActions()))[0]?.status).toBe('waiting_approval')
    const notice = (await page.evaluate(() => window.her.getPendingActions()))[0]
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false)
    expect(mcp.requests.filter(request => request.method === 'tools/call')).toHaveLength(0)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show())
    await expect(page.locator('body')).not.toContainText('隐藏任务正文秘密哨兵')
    const owner = await page.evaluate(input => window.her.resolvePendingAction(input), { id: notice.id, version: notice.version })
    expect(owner).toEqual({ conversationId: work })
    // Resolve is read-only; the actual generic UI control performs the select bridge.
    await expect(page.getByRole('button', { name: '日常', exact: true })).toHaveAttribute('aria-current', 'page')
    await page.getByRole('button', { name: '查看', exact: true }).click()
    await expect(page.getByRole('button', { name: '拒绝这次操作', exact: true })).toBeVisible()
    expect((await page.evaluate(id => window.her.getConversationTask(id), work))!.run.conversationId).toBe(work)
    await page.getByRole('button', { name: '返回话题' }).click()
    await page.getByLabel('隐藏话题秘密哨兵的更多操作').click()
    await page.getByRole('button', { name: '移到回收站' }).click()
    await page.getByRole('button', { name: '日常', exact: true }).click()
    expect(await page.evaluate(input => window.her.resolvePendingAction(input), { id: notice.id, version: notice.version })).toBeNull()
    await expect(page.locator('.pending-notice')).toHaveCount(0)
    await expect(page.locator('.message')).toHaveCount(0)
    expect(mcp.requests.filter(request => request.method === 'tools/call')).toHaveLength(0)
    expect(await page.evaluate(id => window.her.selectWorkspace({ section: 'work', conversationId: id }).then(() => false, () => true), work)).toBe(true)
    await page.getByText('更多', { exact: true }).click()
    await page.getByRole('button', { name: '回收站', exact: true }).click()
    await page.getByRole('button', { name: '恢复 隐藏话题秘密哨兵', exact: true }).click()
    await page.getByRole('button', { name: '关闭回收站', exact: true }).click()
    await expect(page.locator('.pending-notice')).toContainText('有一件事需要你处理')
    expect((await page.evaluate(() => window.her.getPendingActions()))[0].status).toBe('paused')
    expect(await page.evaluate(input => window.her.resolvePendingAction(input), { id: notice.id, version: notice.version })).toBeNull()
    expect(mcp.requests.filter(request => request.method === 'tools/call')).toHaveLength(0)
  } finally { releaseReply(); await app.close(); await provider.close(); await mcp.close(); rmSync(directory, { recursive: true, force: true }) }
})
