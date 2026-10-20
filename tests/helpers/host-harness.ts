import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HerStore } from '../../src/core/storage/store'
import { ProfileService } from '../../src/core/storage/profiles'
import { AgentHost } from '../../src/core/agent/host'
import { retryPolicy } from '../../src/core/agent/factory'
import { FileAccessService } from '../../src/core/files/access'
import { ChatService } from '../../src/core/conversation/chat'
import type { ChatEvent, RequestEvent } from '../../src/shared/types'

/** Cleanups registered by harnesses; each test file runs them in afterEach. */
export const harnessCleanup: (() => void | Promise<void>)[] = []
const codec = { encrypt: async (text: string) => Buffer.from(text), decrypt: async (bytes: Buffer) => bytes.toString() }

/** Real backoff is seconds long; tests that are not about timing use a few milliseconds. */
retryPolicy.baseDelayMs = 10

export function harness(directory = mkdtempSync(join(tmpdir(), 'her-host-queue-')), toolsFor?: ConstructorParameters<typeof AgentHost>[3], withFiles = false) {
  const store = new HerStore(join(directory, 'her.sqlite'))
  const profiles = new ProfileService(store, codec)
  const files = withFiles ? new FileAccessService(store) : undefined
  const host = new AgentHost(store, profiles, directory, toolsFor, undefined, files)
  const events: ChatEvent[] = [], requests: RequestEvent[] = []
  const chat = new ChatService(store, host, event => events.push(structuredClone(event)), event => requests.push(structuredClone(event)))
  const id = randomUUID(); store.createConversation(id, randomUUID(), 'x')
  const other = randomUUID(); store.createConversation(other, randomUUID(), 'y')
  const state = (requestId: string) => requests.filter(event => event.requestId === requestId).map(event => event.state)
  const finished = (requestId: string) => requests.find(event => event.requestId === requestId && ['completed', 'failed', 'cancelled'].includes(event.state))
  const send = (conversationId: string, profileId: string, content: string, requestId = randomUUID(), fileIds?: string[]) =>
    chat.send({ requestId, conversationId, profileId, content, ...(fileIds ? { fileIds } : {}) }).then(result => ({ requestId, result }))
  harnessCleanup.push(async () => { await chat.shutdown(); try { store.close() } catch { /* closed */ } rmSync(directory, { recursive: true, force: true }) })
  return { directory, store, profiles, host, chat, files, events, requests, id, other, state, finished, send }
}

