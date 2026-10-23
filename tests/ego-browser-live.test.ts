import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { EgoBrowserTools } from '../src/core/tools/ego-browser'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import { ToolArtifactStore } from '../src/core/tools/artifacts'
import { HerStore } from '../src/core/storage/store'
import type { ToolExecutionContext } from '../src/core/tools/types'

it.skipIf(process.env.HER_TEST_EGO_LIVE !== '1')('operates and screenshots a local form through the installed official ego CLI and closes its own TaskSpace', async () => {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end('<!doctype html><title>Her ego verification</title><label>消息<input aria-label="消息"></label><button onclick="document.querySelector(\'p\').textContent=\'已确认：\'+document.querySelector(\'input\').value">确认</button><p>等待输入</p>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const directory = mkdtempSync(join(tmpdir(), 'her-ego-live-'))
  const store = new HerStore(join(directory, 'her.sqlite')), artifacts = new ToolArtifactStore(store)
  const registry = new SimpleToolRegistry(), browser = new EgoBrowserTools({ artifacts })
  browser.register(registry)
  const context: ToolExecutionContext = { conversationId: randomUUID(), runId: randomUUID(), callId: '', signal: new AbortController().signal, authorize: async () => {} }
  store.createConversation(context.conversationId, randomUUID(), 'ego live verification')
  const call = (name: string, args: Record<string, unknown>) => registry.execute(name, args, { ...context, callId: randomUUID() })
  const name = `Her local verification ${randomUUID()}`
  try {
    let offset = 0
    while (true) {
      const result = await call('ego_browser_guide', { offset })
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      if (result.structuredContent?.complete) break
      offset = Number(result.structuredContent?.nextOffset)
      expect(Number.isSafeInteger(offset)).toBe(true)
    }
    const observed = await call('ego_browser_run', { code: `const task = await taskSpace(${JSON.stringify(name)}); const page = task.page("p1"); await page.goto("http://127.0.0.1:${address.port}"); console.log(await page.snapshot());` })
    expect(observed.isError, JSON.stringify(observed)).not.toBe(true)
    expect(JSON.stringify(observed.content)).toContain('消息')
    expect(JSON.stringify(observed.content)).toContain('确认')
    const acted = await call('ego_browser_run', { code: `const task = await taskSpace(${JSON.stringify(name)}); const page = task.page("p1"); await page.fill("loc=role:textbox[name='消息']", "中文测试"); await page.click("loc=role:button[name='确认']", {label: "verify local form result"}); const snapshot = await page.snapshot(); console.log(snapshot); if (!snapshot.includes("已确认：中文测试")) throw new Error("Local form verification failed"); console.log(JSON.stringify({screenshot: await page.screenshot()}));` })
    expect(acted.isError, JSON.stringify(acted)).not.toBe(true)
    expect(JSON.stringify(acted.content)).toContain('已确认：中文测试')
    const image = acted.content.find(part => part.type === 'image')
    expect(image).toMatchObject({ type: 'image', mimeType: 'image/png' })
    if (image?.type !== 'image') throw new Error('missing live screenshot')
    const bytes = await artifacts.read(image.artifactId, context)
    expect(Buffer.from(bytes.subarray(0, 8)).toString('hex')).toBe('89504e470d0a1a0a')
    expect(bytes.byteLength).toBeGreaterThan(100)
    const finished = await call('ego_browser_run', { code: `const task = await taskSpace(${JSON.stringify(name)}); console.log(JSON.stringify(await task.finish({keep: []})));` })
    expect(finished.isError, JSON.stringify(finished)).not.toBe(true)
    const receipt = JSON.parse(finished.content.filter(part => part.type === 'text').map(part => part.text).join('').trim())
    expect(receipt).toMatchObject({ closedSpace: true })
  } finally {
    await browser.shutdown()
    await artifacts.shutdown()
    store.close()
    rmSync(directory, { recursive: true, force: true })
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
  }
}, 90_000)
