import type { MemoryRecord, MemoryScope, MemorySourceDependencies, MemorySourceRef } from '../../shared/types'
import { HerStore, memorySourceKey } from '../storage/store'
import { FileAccessService } from '../files/access'

/** Main-only hook: the host resolves an entry from its current authoritative Pi session, never from a projection. */
export interface ResolvedMemoryEntry {
  ref: MemorySourceRef
  dependencies: MemorySourceDependencies
}
export type MemoryEntryResolver = (ref: MemorySourceRef) => ResolvedMemoryEntry | null

export class MemoryService {
  constructor(private readonly store: HerStore, private readonly files: FileAccessService, private readonly resolvePiEntry?: MemoryEntryResolver) {}

  listMemories(scope: MemoryScope): MemoryRecord[] {
    const conversationId = scope.kind === 'work' ? scope.conversationId : this.store.listTopicInfo().find(topic => topic.kind === 'daily')?.conversationId
    if (!conversationId) return []
    return this.store.listMemories(scope).filter(memory => this.isUsable([
      { kind: 'memory', id: memory.id, revision: memory.revision, conversationId }
    ], conversationId))
  }

  getSources(memoryId: string): MemorySourceRef[] {
    const memory = this.store.getMemory(memoryId)
    if (!memory) return []
    const conversationId = memory.scope.kind === 'work' ? memory.scope.conversationId : this.store.listTopicInfo().find(topic => topic.kind === 'daily')?.conversationId
    return conversationId ? this.store.getMemorySources({ kind: 'memory', id: memory.id, revision: memory.revision, conversationId }) : []
  }

  /** All checks are synchronous, including actual file version/grant checks under the original source topic. */
  isUsable(refs: MemorySourceRef[], targetConversationId: string): boolean {
    try {
      const target = this.store.getConversation(targetConversationId), targetTopic = this.store.getTopicInfo(targetConversationId)
      if (!target || target.deletedAt || !targetTopic || !refs.length) return false
      const visit = (ref: MemorySourceRef, path: Set<string>, sharedProgress: boolean, personalOnly: boolean): boolean => {
        const key = memorySourceKey(ref)
        if (path.has(key) || this.store.isMemorySourceExcluded(ref)) return false
        const conversation = this.store.getConversation(ref.conversationId), topic = this.store.getTopicInfo(ref.conversationId)
        const source = this.store.getMemorySource(ref)
        if (!conversation || conversation.deletedAt || !topic || !source || memorySourceKey(source.ref) !== key || (personalOnly && topic.kind !== 'daily')) return false
        const crossing = ref.conversationId !== targetConversationId
        if (crossing) {
          if (topic.kind !== 'work' || targetTopic.kind !== 'daily' || !topic.shareProgress || source.shareRevision !== topic.shareRevision ||
              (!sharedProgress && ref.kind !== 'progress')) return false
          sharedProgress = true
        }
        const nextPath = new Set(path).add(key)
        const validate = (deps: MemorySourceDependencies): boolean => {
          this.files.validateSources(deps.fileSources, { conversationId: ref.conversationId, runId: 'memory-read', callId: 'memory-read', signal: new AbortController().signal })
          return deps.memorySources.every(dependency => visit(dependency, nextPath, sharedProgress, personalOnly))
        }
        if (ref.kind === 'pi-entry') {
          if (!ref.entryId || ref.id !== ref.entryId || ref.sessionId !== conversation.piSessionId) return false
          const baseline = this.store.getMemoryBaseline(ref.conversationId, ref.sessionId)
          if (!baseline || baseline.entryIds.includes(ref.entryId)) return false
          const resolved = this.resolvePiEntry?.(ref)
          if (!resolved || memorySourceKey(resolved.ref) !== key) return false
          return validate(source.dependencies) && validate(resolved.dependencies)
        }
        if (ref.sessionId !== undefined || ref.entryId !== undefined) return false
        let sources: MemorySourceRef[]
        if (ref.kind === 'memory') {
          const memory = this.store.getMemory(ref.id)
          if (!memory || memory.revision !== ref.revision || memory.status !== 'active' ||
              !Number.isFinite(Date.parse(memory.validFrom)) || Date.parse(memory.validFrom) > Date.now() ||
              (memory.validUntil !== undefined && (!Number.isFinite(Date.parse(memory.validUntil)) || Date.parse(memory.validUntil) <= Date.now()))) return false
          if (memory.scope.kind === 'work' ? memory.scope.conversationId !== ref.conversationId || topic.kind !== 'work' : topic.kind !== 'daily') return false
          personalOnly ||= memory.scope.kind === 'personal'
          sources = memory.sources
        } else if (ref.kind === 'progress') {
          const progress = this.store.getProgressSummary(ref.id)
          if (!progress || progress.revision !== ref.revision || progress.conversationId !== ref.conversationId || topic.kind !== 'work' ||
              (crossing && progress.expectedShareRevision !== topic.shareRevision)) return false
          sources = progress.sources
        } else return false
        const edges = this.store.getMemorySources(ref)
        if (!sources.length || JSON.stringify(edges) !== JSON.stringify(sources) || JSON.stringify(source.dependencies.memorySources) !== JSON.stringify(sources)) return false
        return validate(source.dependencies)
      }
      return refs.every(ref => visit(ref, new Set(), false, false))
    } catch { return false }
  }
}
