import { mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import type { CredentialStore, Model, ProviderStreams } from '@earendil-works/pi-ai'
import type { ResourceLoader, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { StoredConversation } from '../storage/store'
import type { RuntimeProvider } from '../../shared/types'
import { compactionBudget } from './budget'
import { createSourceGuard, type SourceGuardOptions } from './source-guard'

/** SessionManager is the only reader/writer of authoritative conversation history. */
export async function openConversationHistory(dataDirectory: string, conversation: StoredConversation) {
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const agentDir = join(dataDirectory, 'Her-Pi-v1', 'pi')
  const cwd = join(agentDir, 'workspaces', conversation.id)
  const sessionDir = join(agentDir, 'sessions', conversation.id)
  mkdirSync(cwd, { recursive: true, mode: 0o700 })
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
  const file = readdirSync(sessionDir).find(name => name.endsWith(`_${conversation.piSessionId}.jsonl`))
  return { agentDir, cwd, manager: file ? SessionManager.open(join(sessionDir, file), sessionDir, cwd)
    : SessionManager.create(cwd, sessionDir, { id: conversation.piSessionId }) }
}

export async function createHerAgentSession(
  provider: RuntimeProvider, conversation: StoredConversation, dataDirectory: string, systemPrompt: string, signal: AbortSignal,
  previousHistory?: Awaited<ReturnType<typeof openConversationHistory>>, tools: ToolDefinition[] = [],
  /** Size reserve/keepRecent for this window instead of the model's own, e.g. when compacting to fit a smaller model. */
  compactForWindow?: number,
  /** Keeps revoked or replaced material out of every request, summary and continuation. */
  guard?: Omit<SourceGuardOptions, 'branch'>
) {
  const { createAgentSession, createExtensionRuntime, ModelRuntime, SettingsManager } = await import('@earendil-works/pi-coding-agent')
  const adapter: ProviderStreams = provider.protocol === 'openai' ? await import('@earendil-works/pi-ai/api/openai-completions')
    : provider.protocol === 'anthropic' ? await import('@earendil-works/pi-ai/api/anthropic-messages')
      : await import('@earendil-works/pi-ai/api/openai-responses')
  const history = previousHistory ?? await openConversationHistory(dataDirectory, conversation)
  const marker = randomUUID()
  const credentials: CredentialStore = {
    read: async id => id === provider.id ? { type: 'api_key', key: provider.apiKey || marker } : undefined,
    list: async () => [{ providerId: provider.id, type: 'api_key' }],
    modify: async () => { throw new Error('凭据由 Her 管理。') }, delete: async () => { throw new Error('凭据由 Her 管理。') }
  }
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false })
  const budget = compactionBudget(provider.contextWindow, provider.maxOutputTokens)
  const compactBudget = compactForWindow === undefined ? budget : compactionBudget(compactForWindow, provider.maxOutputTokens)
  const model: Model<'openai-completions' | 'anthropic-messages' | 'openai-responses'> = {
    id: provider.model, name: provider.model, provider: provider.id,
    api: provider.protocol === 'openai' ? 'openai-completions' : provider.protocol === 'anthropic' ? 'anthropic-messages' : 'openai-responses',
    baseUrl: provider.protocol === 'anthropic' ? provider.baseUrl.replace(/\/v1\/?$/, '') : provider.baseUrl,
    reasoning: false, input: provider.multimodal ? ['text', 'image'] : ['text'], contextWindow: budget.contextWindow, maxTokens: budget.maxOutputTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  }
  let finished = false, terminated = false
  const transport = { get normalEnd() { return finished && terminated }, failure: '模型请求失败，请检查模型设置后重试。' }
  runtime.registerProvider(provider.id, {
    baseUrl: model.baseUrl, api: model.api, models: [model],
    streamSimple: (selected, context, options) => {
      finished = false; terminated = false
      return adapter.streamSimple(selected, normalizeContext(context), {
      ...options, apiKey: provider.apiKey || marker, headers: provider.customHeaders,
      signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
      timeoutMs: 60_000, maxRetries: 0, cacheRetention: 'none',
      fetch: async (input, init) => {
        signal.throwIfAborted()
        const headers = new Headers(init?.headers)
        if (!provider.apiKey) {
          if (headers.get('authorization') === `Bearer ${marker}`) headers.delete('authorization')
          if (headers.get('x-api-key') === marker) headers.delete('x-api-key')
        }
        const response = await fetch(input, { ...init, headers, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal, redirect: 'error' })
        if (!response.ok || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
          transport.failure = !response.ok ? `模型服务请求失败（HTTP ${response.status}），请检查模型设置。` : '模型服务未返回 SSE 流，请检查协议。'
          await response.body?.cancel()
          throw new Error(transport.failure)
        }
        if (provider.protocol !== 'openai' || !response.body) return response
        // Observe only the completion sentinel; Pi remains responsible for SSE decoding.
        const decoder = new TextDecoder()
        let line = ''
        const observe = (text: string) => {
          const lines = (line + text).split('\n')
          line = lines.pop()!
          for (const value of lines) if (/^data:\s*\[DONE\]\s*$/.test(value)) terminated = true
        }
        const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) { observe(decoder.decode(chunk, { stream: true })); controller.enqueue(chunk) },
          flush() { observe(decoder.decode() + '\n') }
        }))
        return new Response(body, { status: response.status, headers: response.headers })
      },
      onProviderStreamEvent(data) {
        if (!data || typeof data !== 'object') return
        const event = data as { type?: string; choices?: { finish_reason?: string }[]; delta?: { stop_reason?: string }; response?: { status?: string } }
        if (provider.protocol === 'openai' && event.choices?.some(choice => choice.finish_reason === 'stop')) finished = true
        if (provider.protocol === 'anthropic') {
          if (event.type === 'message_delta') finished = ['end_turn', 'stop_sequence'].includes(event.delta?.stop_reason ?? '')
          if (event.type === 'message_stop') terminated = true
        }
        if (provider.protocol === 'openai-responses' && event.type === 'response.completed') finished = terminated = event.response?.status === 'completed'
      }
      })
    }
  })
  const extensionRuntime = createExtensionRuntime()
  const resources: ResourceLoader = {
    getExtensions: () => ({ extensions: guard ? [createSourceGuard({ ...guard, branch: () => history.manager.getBranch() })] : [], errors: [], runtime: extensionRuntime }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt, getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {}
  }
  signal.throwIfAborted()
  const { session } = await createAgentSession({
    cwd: history.cwd, agentDir: history.agentDir, modelRuntime: runtime, model: runtime.getModel(provider.id, provider.model)!,
    thinkingLevel: 'off', noTools: 'builtin', tools: tools.map(tool => tool.name), customTools: tools, resourceLoader: resources,
    sessionManager: history.manager, settingsManager: SettingsManager.inMemory({ retry: { enabled: false },
      compaction: { enabled: true, reserveTokens: compactBudget.reserveTokens, keepRecentTokens: compactBudget.keepRecentTokens } })
  })
  const exposed = session.getActiveToolNames()
  if (exposed.length !== tools.length || exposed.some(name => !tools.some(tool => tool.name === name))) {
    session.dispose(); throw new Error('会话包含未授权的工具。')
  }
  return { ...history, session, transport, budget }
}
