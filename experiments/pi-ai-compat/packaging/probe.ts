import { app } from 'electron'
import { writeFileSync } from 'node:fs'
import type { ProviderEvent } from '../../../src/shared/types'

export async function runPackagingProbe(renderer: { url: string; title: string }): Promise<void> {
  const result: Record<string, unknown> = {
    mode: process.env.HER_PI_PROBE_MODE,
    observedAt: new Date().toISOString(),
    versions: process.versions,
    processType: process.type,
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userData: app.getPath('userData'),
    renderer,
    protocols: [],
  }
  let exitCode = 0
  try {
    if (process.env.HER_PI_PROBE_MODE !== 'baseline') {
      const importStarted = performance.now()
      const { streamChatWithPi } = await import('../adapter.ts')
      result.adapterImportMs = performance.now() - importStarted
      const { startFixtureServer, makeInput } = await import('../fixtures.ts')
      result.resolvedPiModule = import.meta.resolve('@earendil-works/pi-ai')
      result.resolvedOpenAiModule = import.meta.resolve('openai')
      result.resolvedAnthropicModule = import.meta.resolve('@anthropic-ai/sdk')
      const observations: unknown[] = []
      result.protocols = observations
      for (const protocol of ['openai', 'anthropic', 'openai-responses'] as const) {
        const server = await startFixtureServer(protocol, 'text')
        try {
          const started = performance.now()
          const events: ProviderEvent[] = []
          for await (const event of streamChatWithPi(makeInput(protocol, server.baseUrl))) events.push(event)
          observations.push({ protocol, scenario: 'text', events, requestCount: server.requests.length, elapsedMs: performance.now() - started })
          if (events.filter(event => event.type === 'text').map(event => event.text).join('') !== '你好🌙' || !events.some(event => event.type === 'done')) {
            throw new Error(`Missing successful text completion for ${protocol}`)
          }
        } finally {
          await server.close()
        }
        const toolServer = await startFixtureServer(protocol, ['tool', 'text'])
        try {
          const input = makeInput(protocol, toolServer.baseUrl)
          const first: ProviderEvent[] = []
          for await (const event of streamChatWithPi(input)) first.push(event)
          const calls = first.filter(event => event.type === 'tool')
          if (calls.length !== 1 || calls[0].name !== 'report_connection' || calls[0].arguments.ok !== true) throw new Error(`Missing tool request for ${protocol}`)
          input.messages.push({ role: 'assistant', content: null, tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) })
          for (const call of calls) input.messages.push({ role: 'tool', tool_call_id: call.id, content: '{"result":"ok"}' })
          const second: ProviderEvent[] = []
          for await (const event of streamChatWithPi(input)) second.push(event)
          if (!second.some(event => event.type === 'text' && event.text === '你好🌙') || !second.some(event => event.type === 'done') || toolServer.requests.length !== 2) throw new Error(`Tool continuation failed for ${protocol}`)
          observations.push({ protocol, scenario: 'tool-roundtrip', first, second, requestCount: toolServer.requests.length })
        } finally {
          await toolServer.close()
        }
        const cancelServer = await startFixtureServer(protocol, 'hang')
        try {
          const input = makeInput(protocol, cancelServer.baseUrl)
          const controller = new AbortController()
          input.signal = controller.signal
          const events: ProviderEvent[] = []
          let failure: { code?: string; message?: string } | undefined
          try {
            for await (const event of streamChatWithPi(input)) {
              events.push(event)
              if (event.type === 'text') controller.abort()
            }
          } catch (error) {
            failure = { code: (error as { code?: string }).code, message: error instanceof Error ? error.message : String(error) }
          }
          if (failure?.code !== 'cancelled' || events.some(event => event.type === 'done')) throw new Error(`Cancellation failed for ${protocol}`)
          observations.push({ protocol, scenario: 'cancel-after-text', events, failure, requestCount: cancelServer.requests.length })
        } finally {
          await cancelServer.close()
        }
      }
      if (app.isPackaged && !String(result.resolvedPiModule).includes('/app.asar/')) {
        throw new Error('Packaged Pi resolved outside app.asar')
      }
    }
    result.success = true
  } catch (error) {
    exitCode = 1
    result.success = false
    result.error = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error)
  } finally {
    writeFileSync(process.env.HER_PI_PROBE_RESULT!, JSON.stringify(result, null, 2) + '\n')
    app.exit(exitCode)
  }
}
