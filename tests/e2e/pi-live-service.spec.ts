import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, expect, test } from '@playwright/test'

test('explicitly selected saved service: real authentication, chat, tool roundtrip, capacity, compaction and cancellation', async ({}, testInfo) => {
  test.skip(process.env.HER_TEST_LIVE !== '1', 'Opt in to the user-authorized saved service; credentials stay encrypted in an isolated store.')
  test.setTimeout(240_000)
  const directory = mkdtempSync(join(tmpdir(), 'her-pi-live-'))
  const file = join(directory, 'acceptance.txt')
  writeFileSync(file, 'HER_PI_LIVE_READ_731')
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
  const executablePath = process.env.HER_TEST_APP_EXECUTABLE
  const app = await _electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [resolve('.')] }), env: { ...env, HER_DATA_DIR: directory } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '日常', exact: true })).toBeVisible()
    const selected = await app.evaluate((_electron, { sourcePath, serviceName, directory }) => {
      const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
      const source = new DatabaseSync(sourcePath, { readOnly: true })
      const target = new DatabaseSync(process.getBuiltinModule('node:path').join(directory, 'Her-Pi-v1', 'her.sqlite'))
      try {
        const row = source.prepare('SELECT * FROM services WHERE name = ?').get(serviceName) as Record<string, any> | undefined
        if (!row) throw new Error('Requested saved service was not found')
        // Copy only this connection, encrypted credentials included; no old histories or store migrations.
        row.context_window = 128000; row.max_output_tokens = 1024
        // The old record labels itself 'none' despite a stored key; select that already-saved credential explicitly in the isolated copy.
        row.auth_method = row.has_api_key ? 'api-key' : row.has_custom_headers ? 'headers' : 'none'
        const columns = target.prepare('PRAGMA table_info(services)').all().map((column: any) => column.name).filter((name: string) => name in row)
        target.prepare(`INSERT INTO services (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map((name: string) => row[name]))
        return { id: row.id as string, name: row.name as string, protocol: row.protocol as string, model: row.default_model as string }
      } finally { source.close(); target.close() }
    }, { sourcePath: process.env.HER_TEST_LIVE_DB ?? join(homedir(), 'Library/Application Support/Her/her.sqlite'), serviceName: process.env.HER_TEST_LIVE_SERVICE ?? '公司', directory })
    await page.evaluate(id => window.her.selectProfile(id), selected.id)
    await page.reload()
    const auth = await page.evaluate(id => window.her.testProfile(id, 'chat'), selected.id)
    expect(auth.status, auth.message).toBe('passed')
    const toolsProbe = await page.evaluate(id => window.her.testProfile(id, 'tools'), selected.id)
    expect(toolsProbe.status, toolsProbe.message).toBe('passed')
    console.info('live: authentication and tool probe passed')
    const conversation = (await page.evaluate(() => window.her.createConversation())).conversation!
    const say = async (content: string, fileIds?: string[]) => {
      const requestId = 'live-' + crypto.randomUUID()
      await page.evaluate(input => window.her.sendMessage(input), { requestId, conversationId: conversation.id, profileId: selected.id, content, fileIds })
      await expect.poll(async () => (await page.evaluate(async id => { const daily = (await window.her.getBootstrap()).dailyConversationId; await window.her.selectWorkspace({ section: id === daily ? 'daily' : 'work', conversationId: id }); return window.her.getMessages(id) }, conversation.id)).at(-1)?.status, { timeout: 60_000 }).toMatch(/^(complete|failed|cancelled)$/)
      const last = (await page.evaluate(async id => { const daily = (await window.her.getBootstrap()).dailyConversationId; await window.her.selectWorkspace({ section: id === daily ? 'daily' : 'work', conversationId: id }); return window.her.getMessages(id) }, conversation.id)).at(-1)!
      expect(last.status, last.error).toBe('complete')
    }
    await say('请只回答：真实服务已连接。')
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, file)
    const grant = await page.evaluate(id => window.her.selectFiles({ conversationId: id, kind: 'file', scope: 'conversation' }), conversation.id)
    await say('必须调用 read_text 读取附带的资料，回复文件里的完整标记。', grant.files.map(file => file.id))
    const toolMessage = (await page.evaluate(async id => { const daily = (await window.her.getBootstrap()).dailyConversationId; await window.her.selectWorkspace({ section: id === daily ? 'daily' : 'work', conversationId: id }); return window.her.getMessages(id) }, conversation.id)).at(-1)!
    await testInfo.attach('live-tool-result.json', { body: JSON.stringify(toolMessage, null, 2), contentType: 'application/json' })
    expect(toolMessage.content).toContain('HER_PI_LIVE_READ_731')
    expect(toolMessage.toolCalls?.some(call => call.name === 'read_text' && call.status === 'succeeded')).toBe(true)
    console.info('live: chat and read_text roundtrip passed')
    // A deliberately smaller configured window exercises Her's budget against the real provider.
    await page.evaluate(async id => {
      const profile = (await window.her.getBootstrap()).profiles.find(profile => profile.id === id)!
      await window.her.saveProfile({ ...profile, contextWindow: 4096, maxOutputTokens: 1024 })
    }, selected.id)
    const tooLarge = await page.evaluate(async input => { try { await window.her.sendMessage(input); return '' } catch (error) { return String(error) } },
      { requestId: 'live-oversize', conversationId: conversation.id, profileId: selected.id, content: 'capacity '.repeat(4000) })
    expect(tooLarge).toMatch(/上下文|容量|过大|窗口/)
    for (let i = 0; i < 5; i++) await say(`保存编号 ${i}，只回复收到。资料：${'context budget sample '.repeat(100)}`)
    const countCompactions = () => app.evaluate((_electron, { directory, id }) => {
      const fs = process.getBuiltinModule('node:fs'), path = process.getBuiltinModule('node:path')
      const folder = path.join(directory, 'Her-Pi-v1', 'pi', 'sessions', id)
      return fs.readdirSync(folder).filter(name => name.endsWith('.jsonl')).flatMap(name => fs.readFileSync(path.join(folder, name), 'utf8').trim().split('\n').map(line => JSON.parse(line))).filter(entry => entry.type === 'compaction').length
    }, { directory, id: conversation.id })
    const checkpointsBefore = await countCompactions()
    const before = await page.evaluate(async id => { const daily = (await window.her.getBootstrap()).dailyConversationId; await window.her.selectWorkspace({ section: id === daily ? 'daily' : 'work', conversationId: id }); return window.her.getMessages(id) }, conversation.id)
    // Real reported usage may have already triggered Pi's automatic checkpoint during the fill.
    if (!checkpointsBefore) await page.evaluate(input => window.her.compactConversation(input), { conversationId: conversation.id, profileId: selected.id })
    expect((await page.evaluate(async id => { const daily = (await window.her.getBootstrap()).dailyConversationId; await window.her.selectWorkspace({ section: id === daily ? 'daily' : 'work', conversationId: id }); return window.her.getMessages(id) }, conversation.id)).map(message => message.content)).toEqual(before.map(message => message.content))
    const checkpoints = await countCompactions()
    expect(checkpoints).toBeGreaterThan(0)
    await say('压缩后请只回复：继续成功。')
    console.info('live: configured capacity and compaction passed')
    const requestId = 'live-cancel'
    await page.evaluate(input => window.her.sendMessage(input), { requestId, conversationId: conversation.id, profileId: selected.id, content: '请写一篇至少五千字的长文，解释计算机的发展，每个年代都详细描述。' })
    await expect.poll(async () => (await page.evaluate(async id => { const daily = (await window.her.getBootstrap()).dailyConversationId; await window.her.selectWorkspace({ section: id === daily ? 'daily' : 'work', conversationId: id }); return window.her.getMessages(id) }, conversation.id)).at(-1)?.content.length, { timeout: 60_000 }).toBeGreaterThan(10)
    await page.evaluate(id => window.her.cancelMessage(id), requestId)
    await expect.poll(async () => (await page.evaluate(async id => { const daily = (await window.her.getBootstrap()).dailyConversationId; await window.her.selectWorkspace({ section: id === daily ? 'daily' : 'work', conversationId: id }); return window.her.getMessages(id) }, conversation.id)).at(-1)?.status).toBe('cancelled')
    const invalid = await page.evaluate(async id => {
      const p = (await window.her.getBootstrap()).profiles.find(p => p.id === id)!
      const bad = await window.her.saveProfile({ name: 'invalid-auth', protocol: p.protocol, baseUrl: p.baseUrl, model: p.model, contextWindow: 4096, authMethod: 'api-key', apiKey: 'synthetic-invalid-her-pi-credential' })
      return window.her.testProfile(bad.id, 'chat')
    }, selected.id)
    expect(invalid.status).toBe('failed')
    expect(JSON.stringify(invalid)).not.toContain('synthetic-invalid-her-pi-credential')
    const evidence = { service: selected, authentication: auth.status, toolProbe: toolsProbe.status, toolCalls: toolMessage.toolCalls?.map(call => ({ name: call.name, status: call.status })), usage: toolMessage.usage, capacity: '4096 rejects oversized input', compaction: { checkpoints, mode: checkpointsBefore ? 'automatic' : 'manual', originalMessagesPreserved: true, followUpComplete: true }, cancellation: 'partial reply cancelled', invalidAuthentication: invalid.status }
    writeFileSync(testInfo.outputPath('live-service.json'), JSON.stringify(evidence, null, 2))
    await testInfo.attach('live-service.json', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' })
  } finally {
    const diagnostics = await app.evaluate((_electron, directory) => {
      const fs = process.getBuiltinModule('node:fs'), path = process.getBuiltinModule('node:path')
      const root = path.join(directory, 'Her-Pi-v1', 'pi', 'sessions')
      return fs.readdirSync(root).flatMap(id => fs.readdirSync(path.join(root, id)).filter(name => name.endsWith('.jsonl')).flatMap(name => fs.readFileSync(path.join(root, id, name), 'utf8').trim().split('\n').map(line => JSON.parse(line))))
        .map(entry => ({ type: entry.type, customType: entry.customType, role: entry.message?.role, stopReason: entry.message?.stopReason, usage: entry.message?.usage, contentKinds: Array.isArray(entry.message?.content) ? entry.message.content.map((part: any) => part.type) : undefined }))
    }, directory).catch(() => [])
    writeFileSync(testInfo.outputPath('pi-entry-diagnostics.json'), JSON.stringify(diagnostics, null, 2))
    await testInfo.attach('pi-entry-diagnostics.json', { body: JSON.stringify(diagnostics, null, 2), contentType: 'application/json' })
    await app.close(); rmSync(directory, { recursive: true, force: true })
  }
})
