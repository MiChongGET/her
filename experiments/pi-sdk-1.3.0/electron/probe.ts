// Electron main-process probe for Pi 1.3.0. Bundled as the app entry by run.mjs; never imported by Her.
import { app, nativeImage } from 'electron'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { Type } from 'typebox'
import {
  createAgentSession, createExtensionRuntime, defineTool, ModelRuntime, resizeImage, SessionManager, SettingsManager,
  type ResourceLoader
} from '@earendil-works/pi-coding-agent'
import type { Credential, CredentialStore } from '@earendil-works/pi-ai'

const resultPath = process.env.HER_PI_PROBE_RESULT!
const result: Record<string, unknown> = {
  observedAt: new Date().toISOString(), versions: process.versions, processType: process.type,
  isPackaged: app.isPackaged, appPath: app.getAppPath()
}

function sse(value: unknown): string { return 'data: ' + JSON.stringify(value) + '\n\n' }
function chunk(delta: unknown, finish: string | null = null) { return sse({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] }) }

async function fixture() {
  let calls = 0
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* drain */ }
    calls++
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(calls === 1
      ? chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'her_echo', arguments: '{"text":"茶"}' } }] }) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n'
      : chunk({ content: '你好🌙' }) + chunk({}, 'stop') + 'data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { baseUrl: 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/v1', calls: () => calls, close: () => server.close() }
}

const resources: ResourceLoader = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => 'probe', getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {}
}

async function probe(): Promise<void> {
  const root = join(app.getPath('userData'), 'Her-Pi-v1')
  const cwd = join(root, 'pi', 'workspaces', 'probe')
  mkdirSync(cwd, { recursive: true })
  const server = await fixture()
  try {
    const stored = new Map<string, Credential>([['her-probe', { type: 'api_key', key: 'k' }]])
    const credentials: CredentialStore = {
      read: async id => stored.get(id), list: async () => [...stored].map(([providerId, value]) => ({ providerId, type: value.type })),
      modify: async (id, fn) => { const next = await fn(stored.get(id)); if (next) stored.set(id, next); return stored.get(id) },
      delete: async id => { stored.delete(id) }
    }
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false })
    runtime.registerProvider('her-probe', {
      baseUrl: server.baseUrl, api: 'openai-completions',
      models: [{ id: 'm', name: 'm', reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }]
    })
    const echoed: unknown[] = []
    const echo = defineTool({
      name: 'her_echo', label: 'echo', description: 'echo', parameters: Type.Object({ text: Type.String() }),
      execute: async (_id, params) => { echoed.push(params); return { content: [{ type: 'text', text: params.text }], details: undefined } }
    })
    const { session } = await createAgentSession({
      cwd, agentDir: join(root, 'pi'), model: runtime.getModel('her-probe', 'm')!, thinkingLevel: 'off', modelRuntime: runtime,
      resourceLoader: resources, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
      sessionManager: SessionManager.create(cwd, join(root, 'pi', 'sessions')), noTools: 'builtin', customTools: [echo]
    })
    let text = ''
    session.subscribe(event => { if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') text += event.assistantMessageEvent.delta })
    await session.prompt('hi')
    result.activeTools = session.getActiveToolNames()
    result.toolCalls = echoed
    result.text = text
    result.requests = server.calls()
    result.sessionFile = session.sessionManager.getSessionFile()
    session.dispose()
    // resizeImage runs Photon (WASM) in a worker thread, falling back in-process.
    const png = nativeImage.createFromBitmap(Buffer.alloc(64 * 64 * 4, 200), { width: 64, height: 64 }).toPNG()
    const resized = await resizeImage(new Uint8Array(png), 'image/png', { maxWidth: 16, maxHeight: 16 })
    result.resized = resized && { width: resized.width, height: resized.height, wasResized: resized.wasResized, mimeType: resized.mimeType }
    result.photonLoaded = resized?.wasResized === true && resized.width === 16
    result.resolvedPi = import.meta.resolve('@earendil-works/pi-coding-agent')
    result.success = text === '你好🌙' && echoed.length === 1 && result.photonLoaded === true &&
      JSON.stringify(result.activeTools) === '["her_echo"]'
  } finally { server.close() }
}

app.whenReady().then(probe).catch(error => {
  result.success = false
  result.error = error instanceof Error ? error.stack : String(error)
}).finally(() => {
  writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n')
  app.exit(result.success ? 0 : 1)
})
