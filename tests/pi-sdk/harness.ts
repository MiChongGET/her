import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager,
  type ResourceLoader, type ToolDefinition
} from '@earendil-works/pi-coding-agent'
import type { Credential, CredentialStore } from '@earendil-works/pi-ai'

/** Fake user home seeded with Pi config that a controlled session must never read. */
export function seedDecoyHome(): { home: string; markers: string } {
  const home = mkdtempSync(join(tmpdir(), 'her-pi-home-'))
  const agent = join(home, '.pi', 'agent')
  const markers = join(home, 'markers')
  mkdirSync(join(agent, 'extensions'), { recursive: true })
  mkdirSync(markers)
  writeFileSync(join(agent, 'auth.json'), JSON.stringify({ decoy: { type: 'api_key', key: 'DECOY-HOME-KEY' } }))
  writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultTools: ['read', 'bash', 'edit', 'write'] }))
  writeFileSync(join(agent, 'AGENTS.md'), 'DECOY-HOME-INSTRUCTIONS')
  writeFileSync(join(agent, 'extensions', 'decoy.ts'),
    `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(join(markers, 'extension-loaded'))}, '1')\nexport default function () {}\n`)
  return { home, markers }
}

/** In-memory CredentialStore keyed by provider id. */
export function memoryCredentials(initial: Record<string, Credential> = {}): CredentialStore & { reads: string[] } {
  const values = new Map(Object.entries(initial))
  const reads: string[] = []
  return {
    reads,
    async read(id) { reads.push(id); return values.get(id) },
    async list() { return [...values].map(([providerId, value]) => ({ providerId, type: value.type })) },
    async modify(id, fn) { const next = await fn(values.get(id)); if (next) values.set(id, next); return values.get(id) },
    async delete(id) { values.delete(id) }
  }
}

export function emptyResources(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {}
  }
}

export interface ProbeOptions {
  root: string
  baseUrl: string
  providerId?: string
  credentials?: CredentialStore
  tools?: ToolDefinition[]
  apiKey?: string
  headers?: Record<string, string>
  persist?: boolean
  contextWindow?: number
  api?: 'openai-completions' | 'anthropic-messages' | 'openai-responses'
  authHeader?: boolean
  modelId?: string
}

/** Mirrors the controlled injection planned for src/core/agent/factory.ts (design D1). */
export async function createProbeSession(options: ProbeOptions) {
  const providerId = options.providerId ?? 'her-probe'
  const agentDir = join(options.root, 'pi')
  const cwd = join(options.root, 'pi', 'workspaces', providerId)
  mkdirSync(cwd, { recursive: true })
  const runtime = await ModelRuntime.create({
    credentials: options.credentials ?? memoryCredentials(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false
  })
  runtime.registerProvider(providerId, {
    name: providerId,
    baseUrl: options.baseUrl,
    api: options.api ?? 'openai-completions',
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.authHeader !== undefined ? { authHeader: options.authHeader } : {}),
    models: [{
      id: options.modelId ?? 'probe-model', name: 'probe-model', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: options.contextWindow ?? 32_000, maxTokens: 1024
    }]
  })
  const model = runtime.getModel(providerId, options.modelId ?? 'probe-model')
  if (!model) throw new Error('probe model not registered')
  const { session } = await createAgentSession({
    cwd, agentDir, model, thinkingLevel: 'off', modelRuntime: runtime,
    resourceLoader: emptyResources('You are a probe.'),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    sessionManager: options.persist ? SessionManager.create(cwd, join(agentDir, 'sessions')) : SessionManager.inMemory(cwd),
    noTools: 'builtin',
    customTools: options.tools ?? []
  })
  return { session, runtime }
}
