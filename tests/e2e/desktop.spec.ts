import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { startMockProvider } from '../helpers/mock-provider'

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

async function saveProfile(page: Page, input: { name: string; protocol: 'openai' | 'anthropic' | 'openai-responses'; baseUrl: string; model: string }) {
  await page.locator('.sidebar-more summary').click(); await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '添加服务', exact: true }).click()
  await page.getByLabel('服务名称', { exact: true }).fill(input.name)
  await page.getByLabel('协议', { exact: true }).selectOption(input.protocol)
  await page.getByLabel('Base URL', { exact: true }).fill(input.baseUrl)
  await page.getByLabel('Model ID', { exact: true }).fill(input.model)
  await page.getByLabel('认证方式', { exact: true }).selectOption('none')
  await page.getByText('高级选项', { exact: true }).click()
  await page.getByLabel('上下文容量', { exact: true }).fill('128000')
  await page.getByText('高级选项', { exact: true }).click()
  await page.getByRole('button', { name: '保存服务', exact: true }).click()
  await expect(page.getByText('服务已保存', { exact: true })).toBeVisible()
}

async function send(page: Page, content: string) {
  await page.getByRole('textbox', { name: '消息', exact: true }).fill(content)
  await page.getByRole('button', { name: '发送', exact: true }).click()
}

test('desktop: service actions remain reachable when a small window scrolls a multi-model configuration', async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'her-settings-layout-'))
  const provider = await startMockProvider()
  let app: ElectronApplication | undefined
  try {
    const running = await launch(dataDirectory)
    app = running.app
    const page = running.page
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(850, 620))
    await saveProfile(page, { name: '设置布局验收', protocol: 'openai', baseUrl: provider.baseUrl, model: 'fixture-openai' })
    for (const index of [2, 3]) {
      await page.getByRole('button', { name: '添加模型', exact: true }).click()
      await page.getByLabel(`Model ID ${index}`, { exact: true }).fill(`fixture-model-${index}`)
    }
    await page.getByRole('button', { name: '保存服务', exact: true }).click()
    await expect(page.getByText('服务已保存', { exact: true })).toBeVisible()

    await page.getByRole('heading', { name: '服务配置', exact: true }).scrollIntoViewIfNeeded()
    await expect(page.getByRole('button', { name: '保存服务', exact: true })).toBeInViewport()
    await page.getByRole('button', { name: '测试视觉', exact: true }).scrollIntoViewIfNeeded()
    await expect(page.getByRole('button', { name: '保存服务', exact: true })).toBeInViewport()

    await page.getByRole('heading', { name: '服务配置', exact: true }).scrollIntoViewIfNeeded()
    await page.getByRole('button', { name: '删除服务', exact: true }).click()
    await expect(page.getByRole('button', { name: '确认删除服务', exact: true })).toBeInViewport()
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await expect(page.getByRole('button', { name: '保存服务', exact: true })).toBeInViewport()
  } finally {
    await app?.close()
    await provider.close()
    rmSync(dataDirectory, { recursive: true, force: true })
  }
})

test('desktop: both HTTP protocols, capability probes, stream, cancel, restart and isolated preload', async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'her-desktop-'))
  const provider = await startMockProvider()
  let app: ElectronApplication | undefined
  try {
    let running = await launch(dataDirectory)
    app = running.app
    let page = running.page
    expect(await page.evaluate(() => ({
      require: typeof (window as unknown as { require?: unknown }).require,
      process: typeof (window as unknown as { process?: unknown }).process,
      arbitraryIpc: typeof (window.her as unknown as { send?: unknown }).send
    }))).toEqual({ require: 'undefined', process: 'undefined', arbitraryIpc: 'undefined' })

    await saveProfile(page, {
      name: '本地 OpenAI 验收', protocol: 'openai', baseUrl: provider.baseUrl, model: 'fixture-openai'
    })
    await page.getByRole('button', { name: '测试文字', exact: true }).click()
    await expect(page.getByText(/文字测试：已收到文字增量/)).toBeVisible()
    await page.getByRole('button', { name: '测试工具', exact: true }).click()
    await expect(page.getByText(/工具测试：已验证指定工具调用及参数/)).toBeVisible()
    const firstBootstrap = await page.evaluate(() => window.her.getBootstrap())
    expect(firstBootstrap.profiles[0]).not.toHaveProperty('apiKey')
    expect(firstBootstrap.profiles[0]).not.toHaveProperty('customHeaders')
    expect(firstBootstrap.profiles[0].models[0].tests.chat.status).toBe('passed')
    expect(firstBootstrap.profiles[0].models[0].tests.tools.status).toBe('passed')
    await page.getByRole('button', { name: '关闭设置', exact: true }).click()
    await send(page, '今天开始开发 Her 了。')
    await expect(page.locator('article.message-assistant[data-status="complete"]')).toContainText('我在，慢慢说。')
    const conversationId = (await page.evaluate(() => window.her.getBootstrap())).dailyConversationId
    expect(provider.requests[0].path).toBe('/proxy/v1/chat/completions')

    await saveProfile(page, {
      name: '本地 Claude 验收', protocol: 'anthropic', baseUrl: provider.baseUrl, model: 'fixture-claude'
    })
    await page.getByRole('button', { name: '设为当前', exact: true }).click()
    await page.getByRole('button', { name: '测试文字', exact: true }).click()
    await expect(page.getByText(/文字测试：已收到文字增量/)).toBeVisible()
    await page.getByRole('button', { name: '测试工具', exact: true }).click()
    await expect(page.getByText(/工具测试：已验证指定工具调用及参数/)).toBeVisible()
    await page.getByRole('button', { name: '关闭设置', exact: true }).click()
    await send(page, '换个模型继续刚才的话题。')
    await expect(page.locator('article.message-assistant[data-status="complete"]')).toHaveCount(2)
    const claudeRequest = provider.requests.findLast(request => request.path.endsWith('/messages') && request.body.tools && !request.body.tool_choice)
    expect(claudeRequest?.body.system).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.any(String) })]))
    expect(JSON.stringify(claudeRequest?.body.messages)).toContain('今天开始开发 Her 了。')

    await send(page, '这次请慢一点说。')
    await expect(page.locator('article.message-assistant[data-status="streaming"]')).toContainText('我在，')
    await page.getByRole('button', { name: '停止生成', exact: true }).click()
    await expect(page.locator('article.message-assistant[data-status="cancelled"]')).toContainText('我在，')
    const beforeRestart = await page.evaluate(id => window.her.getMessages(id), conversationId)
    expect(beforeRestart).toHaveLength(6)
    await page.screenshot({ path: 'test-results/her-stage-a-desktop.png', fullPage: true })
    await app.close()
    app = undefined

    running = await launch(dataDirectory)
    app = running.app
    page = running.page
    await expect(page.getByRole('button', { name: '日常', exact: true })).toHaveAttribute('aria-current', 'page')
    const afterRestart = await page.evaluate(id => window.her.getMessages(id), conversationId)
    expect(afterRestart.map(message => ({ id: message.id, content: message.content, status: message.status })))
      .toEqual(beforeRestart.map(message => ({ id: message.id, content: message.content, status: message.status })))
    const restored = await page.evaluate(() => window.her.getBootstrap())
    expect(restored.profiles).toHaveLength(2)
    expect(restored.settings.activeProfileId).toBe(restored.profiles.find(profile => profile.name === '本地 Claude 验收')!.id)
    await page.locator('.sidebar-more summary').click(); await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('tab', { name: '桌面偏好', exact: true }).click()
    if (process.env.HER_TEST_APP_EXECUTABLE) {
      // Package preference persistence is real; the OS login-item boundary is test-local.
      await app.evaluate(({ app }) => {
        let openAtLogin = false
        const baseline = app.getLoginItemSettings()
        app.setLoginItemSettings = settings => { openAtLogin = !!settings.openAtLogin }
        app.getLoginItemSettings = () => ({ ...baseline, openAtLogin })
      })
    }
    await page.getByRole('checkbox', { name: '登录时启动 Her', exact: true }).check()
    await page.getByRole('button', { name: '保存偏好', exact: true }).click()
    if (process.env.HER_TEST_APP_EXECUTABLE) {
      expect((await page.evaluate(() => window.her.getBootstrap())).settings.launchAtLogin).toBe(true)
      expect(await app.evaluate(({ app }) => app.getLoginItemSettings().openAtLogin)).toBe(true)
      await page.getByRole('checkbox', { name: '登录时启动 Her', exact: true }).uncheck()
      await page.getByRole('button', { name: '保存偏好', exact: true }).click()
      expect((await page.evaluate(() => window.her.getBootstrap())).settings.launchAtLogin).toBe(false)
      expect(await app.evaluate(({ app }) => app.getLoginItemSettings().openAtLogin)).toBe(false)
    } else {
      await expect(page.getByRole('alert')).toContainText('当前源码运行暂不支持')
      expect((await page.evaluate(() => window.her.getBootstrap())).settings.launchAtLogin).toBe(false)
    }
    await page.getByRole('button', { name: '关闭设置', exact: true }).click()
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close() })
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false)
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].show() })
    await expect(page.getByRole('button', { name: '日常', exact: true })).toBeVisible()
  } finally {
    await app?.close()
    await provider.close()
    rmSync(dataDirectory, { recursive: true, force: true })
  }
})

test('desktop: retry creates a new attempt and preserves the original failure', async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'her-retry-'))
  const provider = await startMockProvider()
  let app: ElectronApplication | undefined
  try {
    const running = await launch(dataDirectory)
    app = running.app
    const page = running.page
    await saveProfile(page, {
      name: '错误与恢复验收', protocol: 'openai', baseUrl: provider.baseUrl, model: 'error-model'
    })
    await page.getByRole('button', { name: '关闭设置', exact: true }).click()
    await send(page, '这条消息只应该保存一次。')
    await expect(page.locator('article.message-assistant[data-status="failed"]')).toContainText('HTTP 401')
    await page.locator('.sidebar-more summary').click(); await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByLabel('Model ID', { exact: true }).fill('fixture-openai')
    await page.getByRole('button', { name: '保存服务', exact: true }).click()
    await expect(page.getByText('服务已保存', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '关闭设置', exact: true }).click()
    await page.getByRole('button', { name: '重试', exact: true }).click()
    await expect(page.locator('article.message-assistant[data-status="complete"]')).toContainText('我在，慢慢说。')
    const state = await page.evaluate(() => window.her.getBootstrap())
    const messages = await page.evaluate(id => window.her.getMessages(id), state.dailyConversationId)
    expect(messages).toHaveLength(4)
    expect(messages[0].content).toBe('这条消息只应该保存一次。')
    expect(messages[1].status).toBe('failed')
    expect(messages[2].content).toBe(messages[0].content)
    expect(messages[3].model).toBe('fixture-openai')
    expect(messages[3].status).toBe('complete')
  } finally {
    await app?.close()
    await provider.close()
    rmSync(dataDirectory, { recursive: true, force: true })
  }
})

test('desktop: conversations can be renamed, trashed, restored and permanently deleted across restarts', async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'her-trash-'))
  const provider = await startMockProvider()
  let app: ElectronApplication | undefined
  try {
    let running = await launch(dataDirectory)
    app = running.app
    let page = running.page
    await saveProfile(page, {
      name: '回收站验收', protocol: 'openai', baseUrl: provider.baseUrl, model: 'fixture-openai'
    })
    await page.getByRole('button', { name: '关闭设置', exact: true }).click()
    await page.getByRole('button', { name: '一起在做的事', exact: true }).click()
    await page.getByRole('button', { name: '另开一个话题' }).first().click()
    const conversationId = (await page.evaluate(() => window.her.listWorkItems()))[0].conversation.id
    await send(page, '这段对话要经历回收站。')
    await expect(page.locator('article.message-assistant[data-status="complete"]')).toContainText('我在，慢慢说。')

    await page.getByRole('button', { name: '重命名对话', exact: true }).click()
    await page.getByLabel('对话标题', { exact: true }).fill('周报草稿')
    await page.getByLabel('对话标题', { exact: true }).press('Enter')
    await expect(page.getByRole('heading', { name: '周报草稿', exact: true })).toBeVisible()

    await page.getByRole('button', { name: '返回话题' }).click()
    await page.getByLabel('周报草稿的更多操作').click()
    await page.getByRole('button', { name: '移到回收站' }).click()
    await expect(page.getByRole('button', { name: '周报草稿', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '一起在做的事', exact: true }).click()
    const afterTrash = await page.evaluate(() => window.her.listWorkItems())
    expect(afterTrash.map(item => item.conversation.id)).not.toContain(conversationId)
    await app.close()
    app = undefined

    running = await launch(dataDirectory)
    app = running.app
    page = running.page
    await page.locator('.sidebar-more summary').click(); await page.getByRole('button', { name: '回收站', exact: true }).click()
    const trash = page.getByRole('dialog', { name: '回收站', exact: true })
    await expect(trash.getByText('周报草稿', { exact: true })).toBeVisible()
    await trash.getByRole('button', { name: '恢复 周报草稿', exact: true }).click()
    await expect(trash.getByText('回收站是空的', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '关闭回收站', exact: true }).click()
    await page.getByRole('button', { name: '一起在做的事', exact: true }).click()
    await page.getByRole('button', { name: '周报草稿', exact: true }).click()
    await expect(page.getByRole('heading', { name: '周报草稿', exact: true })).toBeVisible()
    const restored = await page.evaluate(id => window.her.getMessages(id), conversationId)
    expect(restored.map(message => message.content)).toEqual(['这段对话要经历回收站。', '我在，慢慢说。'])

    await page.getByRole('button', { name: '返回话题' }).click()
    await page.getByLabel('周报草稿的更多操作').click()
    await page.getByRole('button', { name: '移到回收站' }).click()
    await page.locator('.sidebar-more summary').click(); await page.getByRole('button', { name: '回收站', exact: true }).click()
    await trash.getByRole('button', { name: '永久删除 周报草稿', exact: true }).click()
    await trash.getByRole('button', { name: '确认永久删除', exact: true }).click()
    await expect(trash.getByText('回收站是空的', { exact: true })).toBeVisible()
    await app.close()
    app = undefined

    running = await launch(dataDirectory)
    app = running.app
    page = running.page
    await page.getByRole('button', { name: '一起在做的事', exact: true }).click()
    const final = await page.evaluate(() => window.her.listWorkItems())
    expect(final.map(item => item.conversation.id)).not.toContain(conversationId)
    expect(await page.evaluate(() => window.her.listTrashedConversations())).toEqual([])
    await expect(page.evaluate(id => window.her.getMessages(id), conversationId)).rejects.toThrow()
  } finally {
    await app?.close()
    await provider.close()
    rmSync(dataDirectory, { recursive: true, force: true })
  }
})

test('desktop: OpenAI Responses protocol with connection tests and message exchange', async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'her-responses-'))
  const provider = await startMockProvider()
  let app: ElectronApplication | undefined
  try {
    const running = await launch(dataDirectory)
    app = running.app
    const page = running.page

    await saveProfile(page, {
      name: '星火 Responses 验收', protocol: 'openai-responses', baseUrl: provider.baseUrl, model: 'fixture-responses'
    })

    await page.getByRole('button', { name: '测试文字', exact: true }).click()
    await expect(page.getByText(/文字测试：已收到文字增量/)).toBeVisible()

    await page.getByRole('button', { name: '测试工具', exact: true }).click()
    await expect(page.getByText(/工具测试：已验证指定工具调用及参数/)).toBeVisible()

    const bootstrap = await page.evaluate(() => window.her.getBootstrap())
    expect(bootstrap.profiles[0].models[0].tests.chat.status).toBe('passed')
    expect(bootstrap.profiles[0].models[0].tests.tools.status).toBe('passed')

    await page.getByRole('button', { name: '关闭设置', exact: true }).click()
    await send(page, '测试 Responses 协议。')
    await expect(page.locator('article.message-assistant[data-status="complete"]')).toContainText('我在，慢慢说。')

    const responsesRequest = provider.requests.find(request => request.path.endsWith('/responses') && request.body.tools && !request.body.tool_choice)
    expect(responsesRequest).toBeDefined()
    expect(responsesRequest?.path).toBe('/proxy/v1/responses')
    expect(responsesRequest?.body.input).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'system', content: expect.any(String) })]))
    expect(responsesRequest?.body.input).toEqual(expect.any(Array))
    expect(responsesRequest?.body.max_output_tokens).toBeGreaterThan(0)
    expect(responsesRequest?.body).not.toHaveProperty('temperature')
    expect(responsesRequest?.body).not.toHaveProperty('top_p')
  } finally {
    await app?.close()
    await provider.close()
    rmSync(dataDirectory, { recursive: true, force: true })
  }
})

test('desktop: chat bubbles are right/left aligned, flat, distinctly coloured and readable', async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'her-bubbles-'))
  const provider = await startMockProvider()
  let app: ElectronApplication | undefined
  try {
    const running = await launch(dataDirectory)
    app = running.app
    const page = running.page
    await saveProfile(page, { name: '气泡验收', protocol: 'openai', baseUrl: provider.baseUrl, model: 'fixture-openai' })
    await page.getByRole('button', { name: '关闭设置', exact: true }).click()
    await send(page, '你好')
    await expect(page.locator('article.message-assistant[data-status="complete"]')).toContainText('我在，慢慢说。')

    const measured = await page.evaluate(() => {
      const parse = (value: string) => {
        const m = /rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/.exec(value)
        return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null
      }
      const luminance = (c: { r: number; g: number; b: number }) => {
        const [r, g, b] = [c.r, c.g, c.b].map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) })
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
      }
      const contrast = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) => {
        const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
        return (hi + 0.05) / (lo + 0.05)
      }
      const read = (role: 'user' | 'assistant', textSelector: string) => {
        const article = document.querySelector(`article.message-${role}`) as HTMLElement
        const body = article.querySelector('.message-body') as HTMLElement
        const avatar = article.querySelector('.message-avatar') as HTMLElement
        const text = article.querySelector(textSelector) as HTMLElement
        const style = getComputedStyle(body)
        const bg = parse(style.backgroundColor)!
        const fg = parse(getComputedStyle(text).color)!
        const rect = body.getBoundingClientRect()
        const articleRect = article.getBoundingClientRect()
        return {
          left: rect.left, right: rect.right, width: rect.width, articleWidth: articleRect.width,
          avatarLeft: avatar.getBoundingClientRect().left, avatarRight: avatar.getBoundingClientRect().right,
          bg: style.backgroundColor, alpha: bg.a, shadow: style.boxShadow, image: style.backgroundImage,
          borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
          radii: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius],
          contrast: contrast(fg, bg)
        }
      }
      return { user: read('user', '.user-text'), assistant: read('assistant', '.markdown') }
    })
    const { user, assistant } = measured

    expect(user.right).toBeGreaterThan(assistant.right)
    expect(user.left).toBeGreaterThan(assistant.left)
    expect(user.avatarLeft).toBeGreaterThanOrEqual(user.right)
    expect(assistant.avatarRight).toBeLessThanOrEqual(assistant.left)

    expect(user.bg).not.toBe(assistant.bg)
    for (const bubble of [user, assistant]) {
      expect(bubble.alpha).toBe(1)
      expect(bubble.bg).not.toBe('rgb(248, 247, 243)')
      // 气泡有细微阴影是允许的（扁平设计可以有轻微阴影）
      expect(bubble.image).toBe('none')
      // 1px 边框是允许的
      for (const border of bubble.borders) expect(parseFloat(border)).toBeLessThanOrEqual(1)
      for (const radius of bubble.radii) expect(parseFloat(radius)).toBeGreaterThan(0)
      expect(bubble.contrast).toBeGreaterThanOrEqual(4.5)
    }

    expect(user.width).toBeLessThanOrEqual(Math.min(user.articleWidth * 0.75, 560) + 1)
    expect(assistant.width).toBeLessThanOrEqual(Math.min(assistant.articleWidth * 0.88, 680) + 1)
    expect(user.width).toBeLessThan(user.articleWidth * 0.5)
  } finally {
    await app?.close()
    await provider.close()
    rmSync(dataDirectory, { recursive: true, force: true })
  }
})

test('desktop: streaming, error and retry controls stay inside the assistant bubble', async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'her-bubble-states-'))
  const provider = await startMockProvider()
  let app: ElectronApplication | undefined
  try {
    const running = await launch(dataDirectory)
    app = running.app
    const page = running.page
    await saveProfile(page, { name: '状态验收', protocol: 'openai', baseUrl: provider.baseUrl, model: 'error-model' })
    await page.getByRole('button', { name: '关闭设置', exact: true }).click()
    await send(page, '会失败的消息')
    const failed = page.locator('article.message-assistant[data-status="failed"] .message-body')
    await expect(failed).toContainText('HTTP 401')
    const bubble = await failed.boundingBox()
    const retry = await page.getByRole('button', { name: '重试', exact: true }).boundingBox()
    const settings = await failed.getByRole('button', { name: '检查模型设置', exact: true }).boundingBox()
    const error = await page.locator('article.message-assistant[data-status="failed"] .message-error').boundingBox()
    for (const inner of [retry, settings, error]) {
      expect(inner).not.toBeNull()
      expect(inner!.x).toBeGreaterThanOrEqual(bubble!.x)
      expect(inner!.y).toBeGreaterThanOrEqual(bubble!.y)
      expect(inner!.x + inner!.width).toBeLessThanOrEqual(bubble!.x + bubble!.width + 0.5)
      expect(inner!.y + inner!.height).toBeLessThanOrEqual(bubble!.y + bubble!.height + 0.5)
    }

    await failed.getByRole('button', { name: '检查模型设置', exact: true }).click()
    await expect(page.getByLabel('服务名称', { exact: true })).toHaveValue('状态验收')
    await page.getByLabel('Model ID', { exact: true }).fill('fixture-openai')
    await page.getByRole('button', { name: '保存服务', exact: true }).click()
    await expect(page.getByText('服务已保存', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '关闭设置', exact: true }).click()
    await send(page, '这次请慢一点说。')
    const streaming = page.locator('article.message-assistant[data-status="streaming"] .message-body')
    await expect(streaming).toContainText('正在写…')
    const streamBubble = await streaming.boundingBox()
    const status = await page.locator('article.message-assistant[data-status="streaming"] .stream-status').boundingBox()
    expect(status!.x).toBeGreaterThanOrEqual(streamBubble!.x)
    expect(status!.y + status!.height).toBeLessThanOrEqual(streamBubble!.y + streamBubble!.height + 0.5)
    await page.getByRole('button', { name: '停止生成', exact: true }).click()
    await expect(page.locator('article.message-assistant[data-status="cancelled"] .message-body')).toContainText('已停止')
  } finally {
    await app?.close()
    await provider.close()
    rmSync(dataDirectory, { recursive: true, force: true })
  }
})

test('desktop: custom system prompt configuration', async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'her-desktop-'))
  const provider = await startMockProvider()
  let app: ElectronApplication | undefined
  try {
    const { app: launchedApp, page } = await launch(dataDirectory)
    app = launchedApp

    await saveProfile(page, {
      name: '本地测试', protocol: 'openai', baseUrl: provider.baseUrl, model: 'fixture-openai'
    })
    await page.getByRole('button', { name: '关闭设置', exact: true }).click()

    // 打开设置 → 系统提示词 tab
    await page.locator('.sidebar-more summary').click(); await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('tab', { name: '系统提示词', exact: true }).click()

    // 验证提示词输入框已显示
    const promptTextarea = page.getByLabel('系统提示词', { exact: true })
    await expect(promptTextarea).toBeVisible()

    // 默认原文直接载入，允许在原文上修改。
    const defaultPrompt = await page.evaluate(() => window.her.getDefaultSystemPrompt())
    await expect(promptTextarea).toHaveValue(defaultPrompt)
    expect(defaultPrompt).toContain('# 任务执行')
    expect(defaultPrompt).toContain('# 失败与完成')
    const requestsBeforePreview = provider.requests.length
    await page.getByRole('button', { name: '刷新预览', exact: true }).click()
    await expect(page.getByRole('tabpanel', { name: '草稿预览', exact: true })).toContainText('条件性加入')
    expect(provider.requests).toHaveLength(requestsBeforePreview)

    // 编辑提示词
    const customInstruction = '请在回答前加上 SYSTEM_PROMPT_EDIT_MARKER 前缀。'
    const customPrompt = `${defaultPrompt}\n${customInstruction}`
    await promptTextarea.fill(customPrompt)

    // 保存
    await page.getByRole('button', { name: '保存提示词', exact: true }).click()
    await expect(page.getByText('系统提示词已保存', { exact: true })).toBeVisible()

    // 关闭设置
    await page.getByRole('button', { name: '关闭设置', exact: true }).click()

    // 发起对话，验证消息能正常完成（系统提示词功能不影响对话）
    await send(page, '你好')
    const firstReply = page.locator('article.message-assistant').first()
    await expect(firstReply).toHaveAttribute('data-status', 'complete', { timeout: 10000 })
    // 验证有回复内容（具体内容由 mock provider 决定）
    await expect(firstReply.locator('.message-body')).not.toBeEmpty()
    expect(JSON.stringify(provider.requests.at(-1)?.body)).toContain(customInstruction)

    // 恢复默认提示词
    await page.locator('.sidebar-more summary').click(); await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('tab', { name: '系统提示词', exact: true }).click()
    await expect(promptTextarea).toHaveValue(customPrompt)
    await page.getByRole('tab', { name: '最近实际使用', exact: true }).click()
    const actualPrompt = page.getByLabel('实际系统提示词', { exact: true })
    await expect(actualPrompt).toHaveValue(new RegExp('SYSTEM_PROMPT_EDIT_MARKER'))
    await expect(page.getByRole('tabpanel', { name: '最近实际使用', exact: true })).toContainText('fixture-openai')
    await page.getByRole('button', { name: '恢复默认', exact: true }).click()

    // 恢复后仍显示可编辑的默认原文。
    await expect(promptTextarea).toHaveValue(defaultPrompt)
    await expect(actualPrompt).toHaveValue(new RegExp('SYSTEM_PROMPT_EDIT_MARKER'))

    // 保存后在已有对话中发送，验证下一次请求使用默认提示词。
    await page.getByRole('button', { name: '保存提示词', exact: true }).click()
    await expect(page.getByText('系统提示词已保存', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => window.her.getSystemPrompt())).toBe('')
    await page.getByRole('button', { name: '关闭设置', exact: true }).click()

    await send(page, '再次你好')
    const secondReply = page.locator('article.message-assistant').last()
    await expect(secondReply).toHaveAttribute('data-status', 'complete', { timeout: 10000 })
    await expect(secondReply.locator('.message-body')).not.toBeEmpty()
    expect(JSON.stringify(provider.requests.at(-1)?.body)).not.toContain(customInstruction)
    expect(JSON.stringify(provider.requests.at(-1)?.body)).toContain('你是 Samantha')
    await page.locator('.sidebar-more summary').click(); await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('tab', { name: '系统提示词', exact: true }).click()
    await page.getByRole('tab', { name: '最近实际使用', exact: true }).click()
    await expect(page.getByLabel('实际系统提示词', { exact: true })).not.toHaveValue(new RegExp('SYSTEM_PROMPT_EDIT_MARKER'))

  } finally {
    await app?.close()
    await provider.close()
    rmSync(dataDirectory, { recursive: true, force: true })
  }
})

