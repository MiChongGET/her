import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { startMockProvider } from '../helpers/mock-provider'
import { startMockHttp } from '../helpers/mock-mcp'

const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
async function launch(directory: string) {
  const executablePath = process.env.HER_TEST_APP_EXECUTABLE
  const app = await _electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [resolve('.')] }), env: { ...env, HER_DATA_DIR: directory } })
  const page = await app.firstWindow()
  await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible()
  return { app, page }
}
async function profile(page: Page, url: string, protocol: 'openai' | 'anthropic' | 'openai-responses') {
  await page.evaluate(async ({ url, protocol }) => {
    const saved = await window.her.saveProfile({ name: '合成验收', protocol, baseUrl: url, model: 'fixture-vision', models: [{ id: 'fixture-vision', multimodal: true }] })
    await window.her.selectProfile(saved.id)
  }, { url, protocol })
  await page.reload()
}
async function send(page: Page, text: string) {
  await page.getByLabel('消息', { exact: true }).fill(text)
  await page.getByRole('button', { name: '发送', exact: true }).click()
}

for (const protocol of ['openai', 'anthropic', 'openai-responses'] as const) {
  test(`integrated ${protocol}: MCP confirmation, tool image, stop and restart preserve the audit without replay`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'her-tools-'))
    const mcp = await startMockHttp({ validImage: true })
    let step = 0
    const provider = await startMockProvider({ reply: body => {
      const tools = body.tools as any[]
      const name = tools?.map(tool => tool.function?.name ?? tool.name).find(name => name?.startsWith('mcp_'))
      return ++step <= 2 || step === 4 ? { toolCall: { name, arguments: { value: 1 } } } : { text: '合成图片已收到。' }
    } })
    let app: ElectronApplication | undefined
    try {
      let running = await launch(directory); app = running.app; let page = running.page
      await profile(page, provider.baseUrl, protocol)
      await page.evaluate(async url => {
        const service = await window.her.saveMcpService({ name: '合成 HTTP MCP', enabled: true, transport: 'streamable-http', url })
        await window.her.testMcpService(service.id)
      }, mcp.url)
      await send(page, '读取合成工具图像')
      await expect(page.getByRole('button', { name: '允许这次操作', exact: true })).toBeVisible()
      expect(mcp.requests.filter(r => r.method === 'tools/call')).toHaveLength(0)
      await page.getByRole('button', { name: '允许这次操作', exact: true }).click()
      await expect.poll(() => mcp.requests.filter(r => r.method === 'tools/call').length).toBe(1)
      await expect(page.getByRole('button', { name: '允许这次操作', exact: true })).toBeVisible()
      await page.getByRole('button', { name: '允许这次操作', exact: true }).click()
      await expect(page.locator('article.message-assistant[data-status="complete"]')).toContainText('合成图片已收到。')
      const preview = await page.evaluate(async () => {
        const id = (await window.her.getBootstrap()).conversations[0].id
        const result = (await window.her.getMessages(id)).at(-1)!.toolCalls![0].result
        if (!result || typeof result === 'string') throw new Error('Missing structured result')
        const image = result.content.find(block => block.type === 'image')!
        if (image.type !== 'image') throw new Error('Missing image')
        return window.her.getArtifactPreview(image.artifactId, id)
      })
      expect(await app.evaluate(({ nativeImage }, url) => nativeImage.createFromDataURL(url).isEmpty(), preview.dataUrl)).toBe(false)
      const imageRequest = provider.requests.at(-1)!.body
      if (protocol === 'openai') expect(JSON.stringify(imageRequest.messages)).toContain('data:image/png;base64,')
      if (protocol === 'anthropic') expect(JSON.stringify(imageRequest.messages)).toContain('"media_type":"image/png"')
      if (protocol === 'openai-responses') expect(JSON.stringify(imageRequest.input)).toContain('"type":"input_image"')
      expect(mcp.requests.filter(r => r.method === 'tools/call')).toHaveLength(2)
      await send(page, '第二步等待确认时停止')
      await expect(page.getByRole('button', { name: '允许这次操作', exact: true })).toBeVisible()
      await page.getByRole('button', { name: '停止生成', exact: true }).click()
      await expect(page.getByRole('button', { name: '继续任务', exact: true })).toBeVisible()
      const id = (await page.evaluate(() => window.her.getBootstrap())).conversations[0].id
      const messages = await page.evaluate(id => window.her.getMessages(id), id)
      const requests = provider.requests.length
      await app.close(); app = undefined
      running = await launch(directory); app = running.app; page = running.page
      expect(await page.evaluate(id => window.her.getMessages(id), id)).toEqual(messages)
      await expect(page.getByRole('button', { name: '继续任务', exact: true })).toBeVisible()
      expect(provider.requests).toHaveLength(requests)
      expect(mcp.requests.filter(r => r.method === 'tools/call')).toHaveLength(2)
      if (protocol === 'openai') {
        // The failure injection lives only in this isolated test application's main process.
        const imageIds = messages.flatMap(message => message.toolCalls ?? []).flatMap(call =>
          typeof call.result === 'object' ? call.result.content.filter(block => block.type === 'image').map(block => block.artifactId) : [])
        expect(imageIds.length).toBeGreaterThan(0)
        await app.evaluate(async (_electron, imageId) => {
          const fs = process.getBuiltinModule('node:fs'), modules = process.getBuiltinModule('node:module')
          const original = fs.unlinkSync
          fs.unlinkSync = path => {
            if (String(path).endsWith(imageId)) throw Object.assign(new Error('synthetic artifact unlink denied'), { code: 'EACCES' })
            original(path)
          }
          modules.syncBuiltinESMExports()
        }, imageIds[0])
        await page.evaluate(id => window.her.trashConversation(id), id)
        const failure = await page.evaluate(async id => { try { await window.her.purgeConversation(id); return '' } catch (error) { return String(error) } }, id)
        expect((await page.evaluate(() => window.her.listTrashedConversations())).map(c => c.id)).toContain(id)
        expect(failure).toMatch(/图片.*清理.*重试/); expect(failure).not.toContain(directory)
        await app.close(); app = undefined
        running = await launch(directory); app = running.app; page = running.page
        expect((await page.evaluate(() => window.her.listTrashedConversations())).map(c => c.id)).toContain(id)
        await page.evaluate(id => window.her.purgeConversation(id), id)
        expect(await page.evaluate(() => window.her.listTrashedConversations())).toEqual([])
        const remaining = await app.evaluate(async (_electron, { directory, imageIds }) => {
          const fs = process.getBuiltinModule('node:fs'), path = process.getBuiltinModule('node:path')
          return imageIds.filter(id => fs.existsSync(path.join(directory, 'tool-artifacts', id)))
        }, { directory, imageIds })
        expect(remaining).toEqual([])
      }
    } finally { await app?.close(); await provider.close(); await mcp.close(); rmSync(directory, { recursive: true, force: true }) }
  })
}

for (const fixture of [{ name: 'mixed.pdf', pages: [2, 3, 1] }, { name: 'scanned.pdf', pages: [1] }]) test(`integrated PDF ${fixture.name}: disk selection, physical scan pages, source and revocation use the real worker`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'her-tools-pdf-'))
  let fileId = '', step = 0
  const provider = await startMockProvider({ reply: () => ++step === 1
    ? { toolCall: { name: 'read_pdf_pages', arguments: { fileId, pageNumbers: fixture.pages } } }
    : { text: `合成扫描页已收到，来源为 ${fixture.name} 物理页 ${fixture.pages[0]}。` } })
  let app: ElectronApplication | undefined
  try {
    const running = await launch(directory); app = running.app; const page = running.page
    await profile(page, provider.baseUrl, 'openai')
    await app.evaluate(({ app }) => {
      const evidence = { workers: [] as string[], assets: [] as string[] }
      ;(globalThis as any).__t13Pdf = evidence
      app.on('browser-window-created', (_event, window) => {
        window.webContents.debugger.attach('1.3')
        window.webContents.debugger.on('message', (_event, method, params) => {
          if (method === 'Target.attachedToTarget' && params.targetInfo.type === 'worker') evidence.workers.push(params.targetInfo.url)
          if (method === 'Network.requestWillBeSent') evidence.assets.push(params.request.url)
        })
        void window.webContents.debugger.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
        void window.webContents.debugger.sendCommand('Network.enable')
      })
    })
    // Native-dialog return is replaced only in this test process; production IPC/preload/file authority are real.
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, resolve('tests/fixtures/documents', fixture.name))
    await page.getByRole('button', { name: '添加资料', exact: true }).click()
    await expect(page.getByText(fixture.name, { exact: true }).first()).toBeVisible()
    const id = (await page.evaluate(() => window.her.getBootstrap())).conversations[0].id
    const grants = await page.evaluate(id => window.her.listFileGrants(id), id)
    // Metadata-only references are visible in the composer; retrieve their opaque IDs from the real file API.
    const { files } = await page.evaluate(async id => window.her.selectFiles({ conversationId: id, kind: 'file', scope: 'conversation' }), id)
    fileId = files[0].id
    await send(page, '读取第 2 个物理页')
    await expect(page.locator('article.message-assistant[data-status="complete"]')).toContainText(`物理页 ${fixture.pages[0]}`)
    expect(JSON.stringify(provider.requests.at(-1)!.body.messages)).toContain('data:image/png;base64,')
    const messages = await page.evaluate(id => window.her.getMessages(id), id)
    const tool = messages.at(-1)!.toolCalls![0]
    const pdfEvidence = await app.evaluate(() => (globalThis as any).__t13Pdf)
    expect(pdfEvidence.workers.some((url: string) => url.endsWith('/pdf.worker.mjs'))).toBe(true)
    if (fixture.name === 'mixed.pdf') expect(pdfEvidence.assets.some((url: string) => url.includes('/standard_fonts/'))).toBe(true)
    await test.info().attach('pdf-worker-assets.json', { body: JSON.stringify(pdfEvidence, null, 2), contentType: 'application/json' })
    expect(tool.status).toBe('succeeded')
    expect(tool.result).toMatchObject({ structuredContent: { renderedPages: fixture.pages } })
    expect(JSON.stringify(messages)).not.toContain('data:image/png;base64,')
    await page.evaluate(async ids => { for (const id of ids) await window.her.revokeFileGrant(id) }, [...grants.map(g => g.id), files[0].grantId])
    const denied = await page.evaluate(async ({ conversationId, fileId }) => { try { await window.her.openFileSource({ conversationId, fileId }); return false } catch { return true } }, { conversationId: id, fileId })
    expect(denied).toBe(true)
  } finally { await app?.close(); await provider.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('integrated HTTP: static authorization rejects 401, persists protected headers and records dispatched disconnect as unknown', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'her-tools-auth-'))
  const mcp = await startMockHttp({ token: 'Bearer synthetic-t13-only' })
  const provider = await startMockProvider({ reply: body => ({ toolCall: { name: (body.tools as any[]).find(t => t.function?.name.startsWith('mcp_')).function.name, arguments: { value: 6 } } }) })
  let app: ElectronApplication | undefined
  try {
    const running = await launch(directory); app = running.app; const page = running.page
    await profile(page, provider.baseUrl, 'openai')
    const denied = await page.evaluate(async url => {
      const saved = await window.her.saveMcpService({ name: '鉴权合成验收', enabled: true, transport: 'streamable-http', url })
      return { saved, result: await window.her.testMcpService(saved.id) }
    }, mcp.url)
    expect(denied.result.status).toBe('failed')
    expect(JSON.stringify(denied.result)).not.toContain('synthetic-t13-only')
    const accepted = await page.evaluate(async saved => {
      const changed = await window.her.saveMcpService({ ...saved, expectedRevision: saved.revision, secretValues: { Authorization: 'Bearer synthetic-t13-only' } })
      return window.her.testMcpService(changed.id)
    }, denied.saved)
    expect(accepted.status).toBe('passed')
    await send(page, '仅在合成服务上执行一次后断线')
    await page.getByRole('button', { name: '允许这次操作', exact: true }).click()
    const id = (await page.evaluate(() => window.her.getBootstrap())).conversations[0].id
    await expect.poll(async () => (await page.evaluate(id => window.her.getConversationTask(id), id))?.unknownCalls?.length).toBe(1)
    expect(mcp.requests.filter(r => r.method === 'tools/call')).toHaveLength(1)
    const requests = provider.requests.length
    await app.close(); app = undefined
    const restarted = await launch(directory); app = restarted.app
    expect((await restarted.page.evaluate(id => window.her.getConversationTask(id), id))?.unknownCalls).toHaveLength(1)
    expect(provider.requests).toHaveLength(requests)
    expect(mcp.requests.filter(r => r.method === 'tools/call')).toHaveLength(1)
  } finally { await app?.close(); await provider.close(); await mcp.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('integrated installed MarkItDown: four real formats reach the configured fixture model with checked sources', async () => {
  test.skip(process.env.HER_TEST_MARKITDOWN !== '1', 'Requires separately installed pinned MarkItDown runtime; run HER_TEST_MARKITDOWN=1 for actual acceptance.')
  test.setTimeout(120_000)
  const directory = mkdtempSync(join(tmpdir(), 'her-tools-documents-'))
  let fileId = '', step = 0
  const provider = await startMockProvider({ reply: () => ++step % 2 === 1 ? { toolCall: { name: 'read_document', arguments: { fileId } } } : { text: '合成文档已读取。' } })
  let app: ElectronApplication | undefined
  try {
    const running = await launch(directory); app = running.app; const page = running.page
    await profile(page, provider.baseUrl, 'openai')
    await page.evaluate(async () => { const saved = await window.her.createMcpPreset('markitdown'); const status = await window.her.testMcpService(saved.id); if (status.status !== 'passed') throw new Error('Pinned parser is not ready') })
    for (const [name, marker] of [['tiny.docx', 'DOCX_MARKER_731'], ['tiny.pptx', 'PPTX_MARKER_732'], ['tiny.xlsx', 'Revenue'], ['text.pdf', 'PDF_TEXT_MARKER_738']]) {
      const id = await page.evaluate(async () => (await window.her.createConversation()).id)
      await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, resolve('tests/fixtures/documents', name))
      const selected = await page.evaluate(id => window.her.selectFiles({ conversationId: id, kind: 'file', scope: 'conversation' }), id)
      fileId = selected.files[0].id
      const settings = await page.evaluate(() => window.her.getBootstrap())
      await page.evaluate(input => window.her.sendMessage(input), { requestId: 'format-' + name, conversationId: id, profileId: settings.settings.activeProfileId!, content: '读取合成文档', fileIds: [fileId] })
      await expect.poll(async () => (await page.evaluate(id => window.her.getConversationTask(id), id))?.run.status, { timeout: 30_000 }).toBe('completed')
      const messages = await page.evaluate(id => window.her.getMessages(id), id)
      const result = messages.at(-1)!.toolCalls![0].result
      expect(result).toMatchObject({ structuredContent: { source: { fileId, name } } })
      expect(JSON.stringify(result).replace(/\\+_/g, '_')).toContain(marker)
      expect(JSON.stringify(provider.requests.at(-1)!.body).replace(/\\+_/g, '_')).toContain(marker)
      await page.reload()
      await expect(page.getByRole('button', { name: '打开来源 ' + name, exact: true }).first()).toBeVisible()
    }
  } finally { await app?.close(); await provider.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('integrated quit reaps only its owned stdio process even when that process ignores SIGTERM', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'her-tools-quit-'))
  let app: ElectronApplication | undefined
  let childPid = 0
  try {
    const running = await launch(directory); app = running.app
    const helper = resolve('tests/helpers/mock-mcp.ts')
    const ready = await running.page.evaluate(async ({ command, helper }) => {
      const service = await window.her.saveMcpService({ name: '自管退出合成验收', enabled: true, transport: 'stdio', command, args: [helper, '--stdio', '{"holdOpen":true}'] })
      return window.her.testMcpService(service.id)
    }, { command: process.execPath, helper })
    expect(ready.status).toBe('passed')
    const mainPid = await app.evaluate(() => process.pid)
    const { execFileSync } = await import('node:child_process')
    const children = execFileSync('/bin/ps', ['-axo', 'pid,ppid,args'], { encoding: 'utf8' }).split('\n').filter(line => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
      return match && Number(match[2]) === mainPid && match[3].includes(helper)
    })
    expect(children).toHaveLength(1)
    childPid = Number(children[0].trim().split(/\s+/)[0])
    const started = Date.now()
    await app.close(); app = undefined
    await expect.poll(() => { try { process.kill(childPid, 0); return false } catch { return true } }).toBe(true)
    expect(Date.now() - started).toBeLessThan(8000)
    await test.info().attach('owned-process-cleanup.json', { body: JSON.stringify({ mainPid, childPid, gone: true }), contentType: 'application/json' })
  } finally { await app?.close(); rmSync(directory, { recursive: true, force: true }) }
})
