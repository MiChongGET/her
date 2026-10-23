import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import type { CredentialStore, Model, ProviderStreams } from '@earendil-works/pi-ai'
import type { ResourceLoader, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { StoredConversation } from '../storage/store'
import type { RuntimeProvider } from '../../shared/types'
import { compactionBudget } from './budget'
import { createSourceGuard, type SourceGuardOptions } from './source-guard'

/** The conversation's Pi session file is damaged or not a session at all. The file is left exactly as it was. */
/** A transient model failure (overload, rate limit, 5xx, dropped connection) is retried at most this many times; auth, validation and cancellation are not retried. */
export const MODEL_RETRIES = 2
/** Pi doubles this before each further attempt. Exposed so tests do not wait for real backoff. */
export const retryPolicy = { baseDelayMs: 2000 }
/** Statuses that mean "try again later". Anything else (auth, validation, not found, redirects) will fail the same way again. */
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529])

export class SessionDamagedError extends Error {
  constructor() { super('这个对话的记录文件已损坏或无法识别。原文件已原样保留，没有被修改；其他对话不受影响。') }
}

/** Never carries a path: SDK and file-system errors name the local file. */
export class SessionUnreadableError extends Error {
  constructor() { super('无法读取这个对话的记录文件，请检查资料目录是否存在以及读写权限。') }
}

/** Pi refuses, without touching the file, a non-empty file that does not start with a valid session header. */
export function classifySessionError(error: unknown): Error {
  if (error instanceof SessionDamagedError || error instanceof SessionUnreadableError) return error
  return error instanceof Error && /not a valid .*session/i.test(error.message) ? new SessionDamagedError() : new SessionUnreadableError()
}

/** SessionManager is the only reader/writer of authoritative conversation history. */
export async function openConversationHistory(dataDirectory: string, conversation: StoredConversation) {
  const { SessionManager, parseSessionEntries } = await import('@earendil-works/pi-coding-agent')
  const agentDir = join(dataDirectory, 'pi')
  const cwd = join(agentDir, 'workspaces', conversation.id)
  const sessionDir = join(agentDir, 'sessions', conversation.id)
  mkdirSync(cwd, { recursive: true, mode: 0o700 })
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
  try {
    const file = readdirSync(sessionDir).find(name => name.endsWith(`_${conversation.piSessionId}.jsonl`))
    const quarantine = join(agentDir, 'quarantine', conversation.id)
    if (!file && existsSync(quarantine)) throw new SessionDamagedError()
    if (file) {
      // Integrity only: Pi still owns history interpretation and all writes to the session file.
      const content = readFileSync(join(sessionDir, file), 'utf8')
      const lines = content.split('\n').filter(line => line.trim())
      const parsed = parseSessionEntries(content)
      if (!lines.length || parsed.length !== lines.length || parsed.some(entry => !entry || typeof entry !== 'object') || parsed[0]?.type !== 'session') {
        mkdirSync(join(agentDir, 'quarantine'), { recursive: true, mode: 0o700 })
        writeFileSync(quarantine, 'session-damaged', { mode: 0o600 })
        throw new SessionDamagedError()
      }
      rmSync(quarantine, { force: true })
    }
    return { agentDir, cwd, manager: file ? SessionManager.open(join(sessionDir, file), sessionDir, cwd)
      : SessionManager.create(cwd, sessionDir, { id: conversation.piSessionId }) }
  } catch (error) { throw classifySessionError(error) }
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
  let settings: ReturnType<typeof SettingsManager.inMemory> | undefined
  // The SDK reports every failed request as "Connection error.", which Pi would retry. Permanent failures must say so here.
  const giveUp = () => settings?.setRetryEnabled(false)
  const adapter: ProviderStreams = provider.protocol === 'openai' ? await import('@earendil-works/pi-ai/api/openai-completions')
    : provider.protocol === 'anthropic' ? await import('@earendil-works/pi-ai/api/anthropic-messages')
      : await import('@earendil-works/pi-ai/api/openai-responses')
  const history = previousHistory ?? await openConversationHistory(dataDirectory, conversation)
  const marker = randomUUID()
  const providerId = `her-${provider.id}`
  const credentials: CredentialStore = {
    read: async id => id === providerId ? { type: 'api_key', key: provider.apiKey || marker } : undefined,
    list: async () => [{ providerId, type: 'api_key' }],
    modify: async () => { throw new Error('凭据由 Her 管理。') }, delete: async () => { throw new Error('凭据由 Her 管理。') }
  }
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false })
  const budget = compactionBudget(provider.contextWindow, provider.maxOutputTokens)
  const compactBudget = compactForWindow === undefined ? budget : compactionBudget(compactForWindow, provider.maxOutputTokens)
  const model: Model<'openai-completions' | 'anthropic-messages' | 'openai-responses'> = {
    id: provider.model, name: provider.model, provider: providerId,
    api: provider.protocol === 'openai' ? 'openai-completions' : provider.protocol === 'anthropic' ? 'anthropic-messages' : 'openai-responses',
    baseUrl: provider.protocol === 'anthropic' ? provider.baseUrl.replace(/\/v1\/?$/, '') : provider.baseUrl,
    reasoning: false, input: provider.multimodal ? ['text', 'image'] : ['text'], contextWindow: budget.contextWindow, maxTokens: budget.maxOutputTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  }
  let finished = false, terminated = false, inputReported = false, outputReported = false
  const transport = { get usageKnown() { return inputReported && outputReported }, get normalEnd() { return finished && terminated }, failure: '模型请求失败，请检查模型设置后重试。' }
  runtime.registerProvider(providerId, {
    baseUrl: model.baseUrl, api: model.api, models: [model],
    streamSimple: (selected, context, options) => {
      finished = false; terminated = false; inputReported = false; outputReported = false
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
        let response: Response
        try { response = await fetch(input, { ...init, headers, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal, redirect: 'error' }) }
        catch (error) {
          // A refused redirect will be refused again; a dropped connection may not be.
          const detail = `${(error as Error)?.message ?? ''} ${((error as { cause?: Error })?.cause?.message) ?? ''}`
          if (/redirect/i.test(detail)) giveUp()
          throw error
        }
        if (!response.ok && !TRANSIENT_STATUS.has(response.status)) giveUp()
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
        const counts = data as { usage?: Record<string, unknown>; response?: { usage?: Record<string, unknown> }; choices?: { usage?: Record<string, unknown> }[] }
        if (provider.protocol === 'anthropic' && (data as { message?: { usage?: { input_tokens?: number } } }).message?.usage?.input_tokens !== undefined) inputReported = true
        const usage = counts.usage ?? counts.response?.usage ?? counts.choices?.[0]?.usage
        if (usage) {
          inputReported ||= typeof (usage.prompt_tokens ?? usage.input_tokens) === 'number'
          outputReported ||= typeof (usage.completion_tokens ?? usage.output_tokens) === 'number'
        }
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
    cwd: history.cwd, agentDir: history.agentDir, modelRuntime: runtime, model: runtime.getModel(providerId, provider.model)!,
    thinkingLevel: 'off', noTools: 'builtin', tools: tools.map(tool => tool.name), customTools: tools, resourceLoader: resources,
    sessionManager: history.manager, settingsManager: settings = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: MODEL_RETRIES, baseDelayMs: retryPolicy.baseDelayMs },
      compaction: { enabled: true, reserveTokens: compactBudget.reserveTokens, keepRecentTokens: compactBudget.keepRecentTokens } })
  })
  const exposed = session.getActiveToolNames()
  if (exposed.length !== tools.length || exposed.some(name => !tools.some(tool => tool.name === name))) {
    session.dispose(); throw new Error('会话包含未授权的工具。')
  }
  return { ...history, session, transport, budget }
}
