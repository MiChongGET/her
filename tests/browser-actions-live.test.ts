import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { BrowserActions } from '../src/core/tools/browser-actions'
import { EgoBrowserTools } from '../src/core/tools/ego-browser'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import type { ToolExecutionContext } from '../src/core/tools/types'

it.skipIf(process.env.HER_TEST_COMPANION_BROWSER_LIVE !== '1')('probes the official browser and keeps unproven typed capabilities unavailable with local attack counters', async () => {
  const evidencePath = 'experiments/companion-browser/browser-live-result.json'
  if (existsSync(evidencePath)) {
    const previous = JSON.parse(readFileSync(evidencePath, 'utf8'))
    if (!previous.finished && previous.commands?.length) throw new Error('An earlier owned/unknown browser probe is retained; resume it explicitly, never create a replacement space.')
  }
  const seen: string[] = [], unapprovedRequests: string[] = []
  let counting = false
  const dispatchedTargets: { workspaceId: string; pageId: string }[] = []
  const server = createServer((request, response) => {
    const path = request.url ?? ''; seen.push(path)
    if (counting && path.startsWith('/unapproved')) unapprovedRequests.push(path)
    if (path === '/redirect') { response.writeHead(302, { location: '/unapproved-redirect' }); response.end(); return }
    if (path !== '/attack') { response.end('ok'); return }
    response.setHeader('content-type', 'text/html')
    response.end(`<!doctype html><title>Her controlled browser probe</title><a href="/safe" onclick="fetch('/unapproved-click')">Safe-looking link</a><input aria-label="Fictional field" onchange="fetch('/unapproved-save')"><p>Fixture only</p><script>addEventListener('pagehide',()=>navigator.sendBeacon('/unapproved-unload'));setTimeout(()=>fetch('/unapproved-background'),100)</script>`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const browser = new EgoBrowserTools(), registry = new SimpleToolRegistry(), actions = new BrowserActions(browser)
  browser.register(registry)
  const context: ToolExecutionContext = { runId: randomUUID(), conversationId: randomUUID(), callId: 'probe', delegationId: randomUUID(), signal: new AbortController().signal, authorize: async () => {} }
  const evidence: Record<string, unknown> = { time: new Date().toISOString(), officialCli: true, capabilities: actions.capabilities, commands: [], finished: false, userTabsTouched: 0 }
  const controlled = browser.runControlled.bind(browser)
  browser.runControlled = async (command, ctx) => {
    const result = await controlled(command, ctx)
    if (command.kind !== 'create') dispatchedTargets.push({ workspaceId: String(command.workspaceId), pageId: command.pageId })
    ;(evidence.commands as unknown[]).push({ command, result })
    writeFileSync('experiments/companion-browser/browser-live-result.json', JSON.stringify(evidence, null, 2) + '\n')
    return result
  }
  try {
    let offset = 0
    while (true) {
      const result = await registry.execute('ego_browser_guide', { offset }, context)
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      if (result.structuredContent?.complete) break
      offset = Number(result.structuredContent?.nextOffset)
    }
    const owned = await actions.createWorkspace(context)
    evidence.owned = owned
    const observation = await browser.runControlled({ kind: 'observe', workspaceId: Number(owned.workspaceId), pageId: owned.pageId }, context)
    expect(observation.isError, JSON.stringify(observation)).not.toBe(true)
    // This exact probe setup is explicitly approved and deliberately measures the page's autonomous background behavior.
    const setup = await registry.execute('ego_browser_run', { code: `const task=await taskSpace(${Number(owned.workspaceId)});const page=task.page("p1");console.log(JSON.stringify(await page.goto(${JSON.stringify(origin + '/attack')})));` }, { ...context, callId: 'fixture-setup' })
    evidence.fixtureSetup = setup
    dispatchedTargets.push({ workspaceId: owned.workspaceId, pageId: owned.pageId })
    expect(setup.isError, JSON.stringify(setup)).not.toBe(true)
    for (let i = 0; i < 100 && !seen.includes('/unapproved-background'); i++) await new Promise(resolve => setTimeout(resolve, 20))
    evidence.setupRequests = [...seen]
    expect(seen).toContain('/attack')
    expect(seen).toContain('/unapproved-background')
    counting = true
    const action = { kind: 'observe' as const, delegationId: context.delegationId!, ...owned }
    expect(await actions.execute(action, context)).toMatchObject({ isError: true })
    expect(await actions.execute({ ...action, kind: 'navigate', url: 'https://example.com/' }, context)).toMatchObject({ isError: true })
    for (const forged of [
      { ...action, kind: 'click', selector: 'a' }, { ...action, kind: 'fill', text: 'fictional' }, { ...action, kind: 'navigate', url: origin + '/redirect' },
      { ...action, workspaceId: 'user-space' }, { ...action, pageId: 'unmanaged' }, { ...action, code: "fetch('/unapproved-script')" }
    ]) await expect(actions.execute(forged as never, context)).rejects.toThrow()
    const stopped = new AbortController(); stopped.abort()
    await expect(actions.execute(action, { ...context, signal: stopped.signal })).rejects.toThrow()
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(unapprovedRequests).toHaveLength(0)
    const userTabsTouched = dispatchedTargets.filter(target => target.workspaceId !== owned.workspaceId || target.pageId !== owned.pageId).length
    expect(userTabsTouched).toBe(0)
    evidence.typedRequests = [...unapprovedRequests]
    evidence.status = 'guard-probe-complete; automatic observe/navigate unavailable'
    evidence.reason = 'Observed autonomous background request during exact approved fixture setup. No pre-effect unload/redirect/background/remote-cancel confinement established; no crash-observation guarantee. No automatic capability enabled.'
    counting = false // Finishing this owned fixture is a separately authorized cleanup action.
    // A successful diagnostic can conclude capabilities are unavailable; that is not a browser execution failure.
    const finished = await browser.runControlled({ kind: 'finish', workspaceId: Number(owned.workspaceId), pageId: owned.pageId }, context)
    expect(finished.isError, JSON.stringify(finished)).not.toBe(true)
    const receipt = JSON.parse(finished.content.filter(part => part.type === 'text').map(part => part.text).join('').trim()).herControlled
    expect(receipt).toMatchObject({ spaceId: Number(owned.workspaceId), closedSpace: true })
    evidence.finished = true
    evidence.finishReceipt = receipt
  } catch (error) {
    evidence.status = 'unavailable-or-unknown; no replay or cleanup'
    evidence.error = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    evidence.allRequests = seen
    const owned = evidence.owned as { workspaceId: string; pageId: string } | undefined
    evidence.userTabsTouched = owned ? dispatchedTargets.filter(target => target.workspaceId !== owned.workspaceId || target.pageId !== owned.pageId).length : null
    evidence.dispatchedTargets = dispatchedTargets
    writeFileSync('experiments/companion-browser/browser-live-result.json', JSON.stringify(evidence, null, 2) + '\n')
    await browser.shutdown()
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  }
}, 90_000)
