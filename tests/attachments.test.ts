import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import { SOURCE_PLACEHOLDER } from '../src/core/agent/sources'
import { startFixtureServer, TOOL_NAME, type Scenario } from './pi-sdk/wire'
import { approveNextTool, harness, harnessCleanup } from './helpers/host-harness'
import type { FileReference } from '../src/shared/types'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of [...cleanup.splice(0), ...harnessCleanup.splice(0)].reverse()) await close() })
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
/** A valid solid-colour PNG, built here so the test needs no image file. */
function solidPng(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (buffer: Buffer) => { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), body.length + 4); return out
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x7f)])
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', require('node:zlib').deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk('IEND', Buffer.alloc(0))])
}
const long = (n: number) => 'lorem ipsum '.repeat(Math.ceil(n / 12)).slice(0, n)

async function server(scenario: Scenario | Scenario[], options: Parameters<typeof startFixtureServer>[2] = {}) {
  const s = await startFixtureServer('openai', scenario, { measuredUsage: true, ...options }); cleanup.push(s.close); return s
}
async function profile(f: ReturnType<typeof harness>, baseUrl: string, extra: object = {}) {
  return f.profiles.save({ name: 'p', protocol: 'openai', baseUrl: baseUrl + '/v1', model: 'test-model', contextWindow: 128000, authMethod: 'none', ...extra })
}
function gated() {
  let release!: () => void
  const open = new Promise<void>(resolve => { release = resolve })
  return { release, beforeReply: () => open }
}
/** Grants one file to a conversation and returns the reference the picker would hand to the renderer. */
async function attach(f: ReturnType<typeof harness>, name: string, content: string | Buffer, conversationId = f.id) {
  const directory = join(f.directory, 'files'); mkdirSync(directory, { recursive: true })
  const path = join(directory, name); writeFileSync(path, content)
  const [grant] = await f.files!.grant([path], { scope: 'conversation', conversationId, kind: 'file' })
  const context = { conversationId, runId: 'setup', callId: 'setup', signal: new AbortController().signal }
  const reference: FileReference = await f.files!.reference(grant.id, '', context)
  return { path, grant, reference }
}
/** A stand-in for read_text: it reads through the real FileAccessService and reports where its data came from. */
function readerTool(f: ReturnType<typeof harness>, fileId: string, hold?: Promise<void>) {
  const registry = new SimpleToolRegistry()
  registry.register({ name: TOOL_NAME, description: 'read', parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } },
    async (_args, context) => {
      const data = await f.files!.readText(fileId, context)
      if (hold) await hold
      return { content: [{ type: 'text', text: data.text }], fileSources: { fileIds: [fileId] } }
    }, { assess: async () => ({ effect: 'read', target: `file:${fileId}`, summary: 'read' }) })
  return registry
}
const bodies = (s: { requests: { body: unknown }[] }) => s.requests.map(request => JSON.stringify(request.body))
const entriesOf = async (f: ReturnType<typeof harness>) => {
  const { openConversationHistory } = await import('../src/core/agent/factory')
  return (await openConversationHistory(f.directory, f.store.getConversation(f.id)!)).manager.getEntries()
}
async function say(f: ReturnType<typeof harness>, profileId: string, content: string, fileIds?: string[], approveTool = false) {
  const sent = await f.send(f.id, profileId, content, randomUUID(), fileIds)
  if (approveTool) await approveNextTool(f.chat, f.id)
  await expect.poll(() => f.finished(sent.requestId)?.state, { timeout: 15_000 }).toBe('completed')
  return sent
}

describe('sending files (7.1)', () => {
  it.each([
    { name: 'picture.png', content: solidPng(64, 64) },
    { name: 'notes.txt', content: 'plain notes' }
  ])('keeps $name in the immediate send result so the sent message displays its attachment', async ({ name, content }) => {
    const s = await server('text')
    const f = harness(undefined, undefined, true), p = await profile(f, s.baseUrl, { models: [{ id: 'test-model', multimodal: true }] })
    const file = await attach(f, name, content)
    const sent = await f.send(f.id, p.id, 'look at this', randomUUID(), [file.reference.id])
    expect(sent.result.userMessage.files).toEqual([file.reference])
    expect(JSON.stringify(sent.result.userMessage)).not.toContain(file.path)
    await expect.poll(() => f.finished(sent.requestId)?.state).toBe('completed')
  })

  it('sends an authorised file as a reference block for the model while the chat shows what was typed, with the file attached', async () => {
    const s = await server('text')
    const f = harness(undefined, undefined, true), p = await profile(f, s.baseUrl)
    const file = await attach(f, 'notes.txt', 'plain notes')
    await say(f, p.id, 'please read this', [file.reference.id])
    const body = bodies(s)[0]
    expect(body).toContain('已授权资料引用')
    expect(body).toContain(file.reference.id)
    expect(body).not.toContain(file.path)
    expect(body).not.toContain('plain notes')
    const messages = await f.chat.getMessages(f.id)
    expect(messages[0]).toMatchObject({ role: 'user', content: 'please read this' })
    expect(messages[0].files).toEqual([file.reference])
  }, 30_000)

  it('refuses to send when the file was deleted, naming the problem and sending nothing', async () => {
    const s = await server('text')
    const f = harness(undefined, undefined, true), p = await profile(f, s.baseUrl)
    const file = await attach(f, 'gone.txt', 'soon deleted')
    rmSync(file.path)
    await expect(f.send(f.id, p.id, 'read it', randomUUID(), [file.reference.id])).rejects.toThrow('已不存在')
    expect(s.requests).toHaveLength(0)
    expect(f.chat.getQueue(f.id).items).toEqual([])
  }, 20_000)

  it('refuses to send when the file was replaced after it was chosen', async () => {
    const s = await server('text')
    const f = harness(undefined, undefined, true), p = await profile(f, s.baseUrl)
    const file = await attach(f, 'swapped.txt', 'original')
    writeFileSync(file.path, 'someone else wrote something quite different here')
    await expect(f.send(f.id, p.id, 'read it', randomUUID(), [file.reference.id])).rejects.toThrow('已失效')
    expect(s.requests).toHaveLength(0)
  }, 20_000)

  it('refuses a file whose grant was revoked, and a file belonging to another conversation', async () => {
    const s = await server('text')
    const f = harness(undefined, undefined, true), p = await profile(f, s.baseUrl)
    const mine = await attach(f, 'mine.txt', 'mine'), theirs = await attach(f, 'theirs.txt', 'theirs', f.other)
    await f.files!.revoke(mine.grant.id)
    await expect(f.send(f.id, p.id, 'x', randomUUID(), [mine.reference.id])).rejects.toThrow('已失效')
    await expect(f.send(f.id, p.id, 'x', randomUUID(), [theirs.reference.id])).rejects.toThrow('已失效')
    expect(s.requests).toHaveLength(0)
  }, 20_000)

  it('a queued message is checked again when it starts: a file removed while it waited stops it and pauses the queue', async () => {
    const gate = gated(), s = await server('text', { beforeReply: gate.beforeReply })
    const f = harness(undefined, undefined, true), p = await profile(f, s.baseUrl)
    const file = await attach(f, 'later.txt', 'will vanish')
    const first = await f.send(f.id, p.id, 'first')
    const queued = await f.send(f.id, p.id, 'with a file', randomUUID(), [file.reference.id])
    expect(queued.result.queued).toBe(true)
    rmSync(file.path)
    gate.release()
    await expect.poll(() => f.finished(first.requestId)?.state, { timeout: 15_000 }).toBe('completed')
    await expect.poll(() => f.state(queued.requestId)).toContain('failed')
    expect(f.requests.find(event => event.requestId === queued.requestId && event.state === 'failed')?.error).toContain('已不存在')
    expect(f.store.getInput(queued.requestId)).toMatchObject({ status: 'cancelled' })
    expect(f.chat.getQueue(f.id).paused).toBe('failed')
    expect(s.requests).toHaveLength(1)
  }, 40_000)

  it('a tool read is checked too: deleting or replacing the file makes the read fail rather than return stale content', async () => {
    for (const change of ['delete', 'replace'] as const) {
      const s = await server(['tool', 'text'])
      const f = harness(undefined, undefined, true)
      const p = await profile(f, s.baseUrl)
      const file = await attach(f, `read-${change}.txt`, 'READ-ME-BODY')
      const host = harness(f.directory, undefined, true)
      void host
      const registry = readerTool(f, file.reference.id)
      ;(f.host as unknown as { toolsFor: unknown }).toolsFor = async () => registry.snapshot()
      if (change === 'delete') rmSync(file.path); else writeFileSync(file.path, 'REPLACED BODY OF A DIFFERENT SIZE')
      await say(f, p.id, 'read it', undefined, true)
      const second = bodies(s)[1]
      expect(second).not.toContain('READ-ME-BODY')
      expect(second).not.toContain('REPLACED BODY')
    }
  }, 60_000)

  it('refuses an image for a model that cannot see, and sends it to one that can', async () => {
    const s = await server('text')
    const f = harness(undefined, undefined, true)
    const blind = await profile(f, s.baseUrl)
    const sighted = await f.profiles.save({ name: 'v', protocol: 'openai', baseUrl: s.baseUrl + '/v1', model: 'vision-model', contextWindow: 128000, authMethod: 'none', models: [{ id: 'vision-model', multimodal: true }] })
    const png = solidPng(64, 64)
    const picture = await attach(f, 'pic.png', png)
    await expect(f.send(f.id, blind.id, 'what is this', randomUUID(), [picture.reference.id])).rejects.toThrow('不支持视觉')
    expect(s.requests).toHaveLength(0)
    await say(f, sighted.id, 'what is this', [picture.reference.id])
    expect(bodies(s)[0]).toContain(`data:image/png;base64,${png.toString('base64')}`)
  }, 30_000)

  it('a granted file that has since vanished does not get in the way of an ordinary message', async () => {
    const s = await server('text')
    const f = harness(undefined, undefined, true), p = await profile(f, s.baseUrl)
    const file = await attach(f, 'vanishing.txt', 'old')
    rmSync(file.path)
    await say(f, p.id, 'hello, nothing attached')
    expect(bodies(s)[0]).not.toContain('vanishing.txt')
    expect((await f.chat.getMessages(f.id)).map(message => message.status)).toEqual(['complete', 'complete'])
  }, 20_000)

  it('still refuses pasted inline attachments, and says why', async () => {
    const s = await server('text')
    const f = harness(undefined, undefined, true), p = await profile(f, s.baseUrl)
    await expect(f.chat.send({ requestId: randomUUID(), conversationId: f.id, profileId: p.id, content: 'x',
      attachments: [{ type: 'image', name: 'a.png', mimeType: 'image/png', data: 'AAAA', size: 3 }] })).rejects.toThrow('尚未接入')
  }, 20_000)
})

describe('provenance records (7.2)', () => {
  it('records which files a run and a tool result depend on, as ids only: no file text, no path, no credential', async () => {
    const s = await server(['tool', 'text'])
    const f = harness(undefined, undefined, true), p = await profile(f, s.baseUrl, { authMethod: 'api-key', apiKey: 'sk-secret-credential' })
    const attached = await attach(f, 'attached.txt', 'ATTACHED-BODY'), read = await attach(f, 'read.txt', 'READ-BODY')
    ;(f.host as unknown as { toolsFor: unknown }).toolsFor = async () => readerTool(f, read.reference.id).snapshot()
    await say(f, p.id, 'go', [attached.reference.id], true)
    const records = (await entriesOf(f)).filter(entry => entry.type === 'custom' && ['her.run', 'her.sources'].includes(entry.customType))
    const text = JSON.stringify(records)
    expect(text).toContain(attached.reference.id)
    expect(text).toContain(read.reference.id)
    for (const forbidden of ['ATTACHED-BODY', 'READ-BODY', attached.path, read.path, 'sk-secret-credential']) expect(text).not.toContain(forbidden)
    expect(records.find(entry => entry.type === 'custom' && entry.customType === 'her.sources')).toMatchObject({ data: { fileSources: { fileIds: [read.reference.id] } } })
  }, 30_000)

  it('a summary depends on the files behind what it summarised', async () => {
    const s = await server('text')
    const f = harness(undefined, undefined, true), p = await profile(f, s.baseUrl, { contextWindow: 4096 })
    // Keep this provenance scenario below automatic compaction regardless of default prompt size.
    f.store.setSettings({ ...f.store.getSettings(), systemPrompt: 'Test assistant.' })
    const file = await attach(f, 'summarised.txt', 'x')
    await say(f, p.id, `FIRST-TURN ${long(2000)}`, [file.reference.id])
    // Stay under the point where Pi compacts by itself (a fifth turn crosses it in a 4096 window), so the manual compaction has something to do.
    for (let i = 0; i < 3; i++) await say(f, p.id, `${i}:${long(2000)}`)
    expect((await entriesOf(f)).some(entry => entry.type === 'compaction')).toBe(false)
    await f.chat.compact({ conversationId: f.id, profileId: p.id })
    expect((await entriesOf(f)).some(entry => entry.type === 'compaction')).toBe(true)
    await f.files!.revoke(file.grant.id)
    await say(f, p.id, 'after the revoke')
    const last = bodies(s).at(-1)!
    expect(last).toContain(SOURCE_PLACEHOLDER)
    expect(last).not.toContain('FIRST-TURN')
    expect(last).toContain('after the revoke')
  }, 90_000)
})

describe('revoked material stays out (7.3)', () => {
  async function conversationWithFile() {
    const s = await server('text')
    const f = harness(undefined, undefined, true), p = await profile(f, s.baseUrl, { contextWindow: 4096 })
    const file = await attach(f, 'secret-report.txt', 'confidential body')
    return { s, f, p, file }
  }

  it('ordinary requests: after a revoke the next request carries a placeholder, not the file turn or the reply to it', async () => {
    const { s, f, p, file } = await conversationWithFile()
    await say(f, p.id, 'FILE-TURN-MARKER please read', [file.reference.id])
    expect(bodies(s)[0]).toContain('FILE-TURN-MARKER')
    await f.files!.revoke(file.grant.id)
    await say(f, p.id, 'a fresh question')
    const second = bodies(s)[1]
    expect(second).not.toContain('FILE-TURN-MARKER')
    expect(second).not.toContain('secret-report')
    expect(second).toContain(SOURCE_PLACEHOLDER)
    expect(second).toContain('a fresh question')
    // The original is still there for the user to read.
    expect((await f.chat.getMessages(f.id))[0].content).toContain('FILE-TURN-MARKER')
  }, 40_000)

  it('compaction: a revoke before compacting keeps the file turn out of the summary request', async () => {
    const { s, f, p, file } = await conversationWithFile()
    await say(f, p.id, `FILE-TURN-MARKER ${long(2000)}`, [file.reference.id])
    for (let i = 0; i < 4; i++) await say(f, p.id, `${i}:${long(2000)}`)
    await f.files!.revoke(file.grant.id)
    const before = s.requests.length
    await f.chat.compact({ conversationId: f.id, profileId: p.id }).catch(() => {})
    const summaryRequests = bodies(s).slice(before)
    for (const body of summaryRequests) {
      expect(body).not.toContain('FILE-TURN-MARKER')
      expect(body).not.toContain('secret-report')
    }
  }, 90_000)

  it('recovery: after a restart the next request still leaves revoked material out', async () => {
    const { s, f, p, file } = await conversationWithFile()
    await say(f, p.id, 'FILE-TURN-MARKER please read', [file.reference.id])
    await f.files!.revoke(file.grant.id)
    const { AgentHost } = await import('../src/core/agent/host')
    const { ChatService } = await import('../src/core/conversation/chat')
    const restarted = new ChatService(f.store, new AgentHost(f.store, f.profiles, f.directory, undefined, undefined, f.files), () => {}, () => {})
    const requestId = randomUUID()
    await restarted.send({ requestId, conversationId: f.id, profileId: p.id, content: 'after restart' })
    await expect.poll(() => s.requests.length, { timeout: 15_000 }).toBe(2)
    await wait(200)
    const body = bodies(s)[1]
    expect(body).not.toContain('FILE-TURN-MARKER')
    expect(body).toContain(SOURCE_PLACEHOLDER)
    expect(body).toContain('after restart')
    await restarted.shutdown()
  }, 40_000)

  it('continuing a stopped task also leaves revoked material out', async () => {
    const gate = gated()
    const s = await server(['hang', 'text', 'text'], { beforeReply: gate.beforeReply })
    const f = harness(undefined, undefined, true), p = await profile(f, s.baseUrl)
    const file = await attach(f, 'secret-report.txt', 'confidential body')
    const first = await f.send(f.id, p.id, 'FILE-TURN-MARKER please read', randomUUID(), [file.reference.id])
    await expect.poll(() => s.requests.length).toBe(1)
    gate.release()
    f.chat.cancel(first.requestId)
    await expect.poll(() => f.finished(first.requestId)?.state, { timeout: 10_000 }).toBe('cancelled')
    await f.files!.revoke(file.grant.id)
    const taskId = (f.store as unknown as { db: { prepare(sql: string): { get(): { id: string } } } }).db.prepare('SELECT id FROM tasks').get().id
    const requestId = randomUUID()
    await f.chat.continueTask({ runId: taskId, requestId, profileId: p.id })
    await expect.poll(() => f.finished(requestId)?.state, { timeout: 15_000 }).toBe('completed')
    const body = bodies(s).at(-1)!
    expect(body).not.toContain('FILE-TURN-MARKER')
    expect(body).not.toContain('secret-report')
  }, 40_000)

  it('a revoke stops the request that was relying on the file, and pauses the queue', async () => {
    const gate = gated()
    const s = await server(['hang', 'text'], { beforeReply: gate.beforeReply })
    const f = harness(undefined, undefined, true), p = await profile(f, s.baseUrl)
    const file = await attach(f, 'secret-report.txt', 'confidential body')
    const running = await f.send(f.id, p.id, 'read it', randomUUID(), [file.reference.id])
    const waiting = await f.send(f.id, p.id, 'and then this')
    await expect.poll(() => s.requests.length).toBe(1)
    await f.files!.revoke(file.grant.id)
    gate.release()
    await expect.poll(() => f.finished(running.requestId)?.state, { timeout: 10_000 }).toBe('cancelled')
    expect(f.finished(running.requestId)?.error).toContain('撤销')
    await wait(300)
    expect(f.chat.getQueue(f.id).paused).toBe('source-revoked')
    expect(f.state(waiting.requestId)).toEqual([])
    expect(s.requests).toHaveLength(1)
  }, 40_000)

  it('a revoke does not stop a request that never used the file', async () => {
    const gate = gated()
    const s = await server('text', { beforeReply: gate.beforeReply })
    const f = harness(undefined, undefined, true), p = await profile(f, s.baseUrl)
    const file = await attach(f, 'unrelated.txt', 'x')
    const running = await f.send(f.id, p.id, 'no files here')
    await expect.poll(() => s.requests.length).toBe(1)
    await f.files!.revoke(file.grant.id)
    gate.release()
    await expect.poll(() => f.finished(running.requestId)?.state, { timeout: 10_000 }).toBe('completed')
  }, 30_000)

  it('a tool result that arrives after the revoke does not come back into later requests', async () => {
    const hold = gated()
    const s = await server(['tool', 'text', 'text'])
    const f = harness(undefined, undefined, true), p = await profile(f, s.baseUrl)
    const file = await attach(f, 'secret-report.txt', 'LATE-FILE-BODY')
    const open = new Promise<void>(resolve => { void hold.beforeReply().then(resolve) })
    ;(f.host as unknown as { toolsFor: unknown }).toolsFor = async () => readerTool(f, file.reference.id, open).snapshot()
    const running = await f.send(f.id, p.id, 'read it through the tool')
    await approveNextTool(f.chat, f.id)
    await expect.poll(() => s.requests.length).toBe(1)
    await wait(200)
    await f.files!.revoke(file.grant.id)
    hold.release()
    await expect.poll(() => f.finished(running.requestId)?.state, { timeout: 10_000 }).toMatch(/cancelled|failed|completed/)
    await wait(300)
    f.chat.resumeQueue(f.id)
    await say(f, p.id, 'a later question')
    for (const body of bodies(s).slice(1)) expect(body).not.toContain('LATE-FILE-BODY')
  }, 40_000)

  it('derived material is replaced too: a tool result read before the revoke is a placeholder afterwards', async () => {
    const s = await server(['tool', 'text', 'text'])
    const f = harness(undefined, undefined, true), p = await profile(f, s.baseUrl)
    const file = await attach(f, 'secret-report.txt', 'TOOL-READ-BODY')
    ;(f.host as unknown as { toolsFor: unknown }).toolsFor = async () => readerTool(f, file.reference.id).snapshot()
    await say(f, p.id, 'read it through the tool', undefined, true)
    expect(bodies(s)[1]).toContain('TOOL-READ-BODY')
    await f.files!.revoke(file.grant.id)
    await say(f, p.id, 'a later question')
    const last = bodies(s).at(-1)!
    expect(last).not.toContain('TOOL-READ-BODY')
    expect(last).toContain(SOURCE_PLACEHOLDER)
    expect(last).toContain('a later question')
  }, 40_000)
})
