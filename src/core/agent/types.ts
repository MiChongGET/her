// Task 2.1–2.3: Her agent types for Pi runtime integration.

import type { Model } from '@earendil-works/pi-ai'

/** Her's configuration snapshot for one agent session. */
export interface AgentConfig {
  serviceId: string
  modelId: string
  configRevision: number
  /** Her's custom tools (names only; executors live in Her's tool gate) */
  tools: string[]
}

/** Her's credential store interface, injected into Pi via adapter. */
export interface HerCredentialStore {
  /**
   * Get the API key for the given provider. Returns null for keyless services,
   * undefined when the service is not authorized. When keyless, the adapter returns
   * an internal marker that Her's request wrapper strips before sending.
   */
  getApiKey(providerId: string): Promise<string | null | undefined>
}

/** Her's agent session handle, wrapping Pi's AgentSession. */
export interface AgentSessionHandle {
  sessionId: string
  generation: number
  active: boolean
  config: AgentConfig
  agentDir: string

  prompt(content: string, attachments?: unknown[]): Promise<void>
  compact(): Promise<void>
  abort(): void
  switchModel(newConfig: AgentConfig): Promise<void>
  dispose(): void
}
