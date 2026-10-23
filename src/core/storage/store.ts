// Task 2.2: Her-Pi v1 storage layer.
// This is a clean-slate rewrite for the new Pi runtime. All old tables are dropped.
// Old ChatService will break until stage 4 replaces it (user confirmed approach 2).

import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  ProviderProtocol, ServiceModel, TestKind, ConnectionTestResult, ConversationSummary, TrashedConversation,
  McpServiceConfig, FileGrant, FileReference, ChatMessage, DesktopSettings, ArtifactReference, DocumentReference, UnknownToolCall, TopicInfo, MemoryRecord, MemoryScope, MemorySourceRef, MemorySourceDependencies, MemoryEntryBaseline
} from '../../shared/types'
import type { CompletionProof, Delegation, DelegationControl, DelegationDenial, DenialRevisionProof, PriorityControl, ActionDescriptor, UserIntent } from '../delegations/types'
import { DocumentCache, DOCUMENT_CLEANUP_ERROR } from '../documents/cache'

// ──────────────────────────────────────────────────────────────────────────────
// Error messages
// ──────────────────────────────────────────────────────────────────────────────

export const ARTIFACT_CLEANUP_ERROR = '图片资料清理未完成，已保留清理记录。请检查应用数据目录权限后重试删除或重启 Her。'

// ──────────────────────────────────────────────────────────────────────────────
// Service and credential types (replaces old profiles)
// ──────────────────────────────────────────────────────────────────────────────

export interface StoredService {
  id: string
  name: string
  protocol: ProviderProtocol
  baseUrl: string
  defaultModel: string
  authMethod: 'api-key' | 'headers' | 'none'
  sealedSecrets: string | null
  hasApiKey: boolean
  hasCustomHeaders: boolean
  maxOutputTokens: number | null
  contextWindow: number | null
  models: ServiceModel[]
  revision: number
  tests: Record<TestKind, ConnectionTestResult>
}

// Alias for backwards compatibility with ProfileService
export type StoredProfile = StoredService

// ──────────────────────────────────────────────────────────────────────────────
// Conversation and session authority types
// ──────────────────────────────────────────────────────────────────────────────

export interface StoredConversation {
  id: string
  title: string
  titleCustom: boolean
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
  /** Pi session ID (the session file basename without .jsonl) */
  piSessionId: string
  /** Last known entry ID from Pi, used for projection version tracking */
  lastEntryId: string | null
}

export interface StoredTopicHandoff {
  operationId: string
  previewId: string
  digest: string
  sourceConversationId: string
  sourceSessionId: string
  conversationId: string
  piSessionId: string
  receiverKey: string
  excerpts: { messageId: string; role?: 'user' | 'assistant'; entryId: string; text: string; createdAt: string; contentDigest: string; sourceReceiverKey?: string }[]
  status: 'preparing' | 'created' | 'failed'
  errorCode: 'source-changed' | 'receiver-changed' | 'storage-failed' | null
  piEntryId: string | null
}

// ──────────────────────────────────────────────────────────────────────────────
// Input queue and task types
// ──────────────────────────────────────────────────────────────────────────────

export type InputQueueStatus = 'pending' | 'running' | 'cancelled' | 'completed'

export interface StoredInputRequest {
  id: string
  conversationId: string
  content: string
  /** JSON array of attachment references */
  attachments: string | null
  status: InputQueueStatus
  profileId: string | null
  model: string | null
  /** Message id shown for this input, fixed when it is queued. */
  userMessageId: string | null
  createdAt: Date
  startedAt: Date | null
  completedAt: Date | null
}

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'waiting_resource'
  | 'compacting'
  | 'retrying'
  | 'stopping'
  | 'completed'
  | 'stopped'
  | 'failed'
  | 'interrupted'

export interface StoredTask {
  id: string
  conversationId: string
  requestId: string
  generation: number
  status: TaskStatus
  serviceId: string
  modelId: string
  configRevision: number
  createdAt: Date
  startedAt: Date | null
  endedAt: Date | null
  error: string | null
  /** The earlier attempt this one continues. */
  continuationOf: string | null
  /** The reply this task was producing, so a stopped task can be shown against its message. */
  assistantMessageId: string | null
}

// ──────────────────────────────────────────────────────────────────────────────
// Tool execution and action ledger types
// ──────────────────────────────────────────────────────────────────────────────

export type ToolCallStatus =
  | 'pending'
  | 'awaiting_approval'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unknown'

export type DispatchPhase =
  | 'validation'
  | 'authorization'
  | 'resource_wait'
  | 'dispatched'
  | 'completed'

export interface StoredToolCall {
  id: string
  taskId: string
  callId: string
  toolName: string
  /** JSON serialized arguments */
  arguments: string
  status: ToolCallStatus
  dispatchPhase: DispatchPhase
  result: string | null
  error: string | null
  createdAt: Date
  dispatchedAt: Date | null
  completedAt: Date | null
}

// ──────────────────────────────────────────────────────────────────────────────
// Projection and display types
// ──────────────────────────────────────────────────────────────────────────────

export interface StoredProjectionEntry {
  conversationId: string
  entryId: string
  /** JSON serialized ProjectedSessionEntry */
  content: string
  sequenceNumber: number
}

export interface StoredDraftFragment {
  taskId: string
  fragmentType: 'text' | 'tool_call'
  content: string
  createdAt: Date
}

// ──────────────────────────────────────────────────────────────────────────────
// MCP, file grants, and settings types
// ──────────────────────────────────────────────────────────────────────────────

interface McpServiceRow {
  id: string
  revision: number
  config: string
  sealed_secrets: string | null
}

export interface StoredMcpService {
  id: string
  revision: number
  config: McpServiceConfig
  sealedSecrets: string | null
}

export interface StoredDocument {
  reference: DocumentReference
  conversationId: string
  cacheKey: string
}

export interface StoredFileGrant {
  grant: FileGrant
  path: string
  identity: string
  revoked: boolean
}

export interface StoredFileReference {
  reference: FileReference
  conversationId: string
  path: string
  grantRevision: number
}

// ──────────────────────────────────────────────────────────────────────────────
// Database class
// ──────────────────────────────────────────────────────────────────────────────

export function untestedConnections(): Record<TestKind, ConnectionTestResult> {
  return {
    chat: { status: 'untested', message: '尚未测试' },
    tools: { status: 'untested', message: '尚未测试' },
    vision: { status: 'untested', message: '尚未测试' }
  }
}

export interface StoredMemorySource {
  ref: MemorySourceRef
  dependencies: MemorySourceDependencies
  shareRevision: number
}

/** Internal derived summary storage; creation/publication is wired by the memory producer later. */
export interface StoredProgressSummary {
  id: string
  revision: number
  conversationId: string
  summary: string
  feelingQuote?: string
  sources: MemorySourceRef[]
  expectedShareRevision: number
}

export const memorySourceKey = (ref: MemorySourceRef): string => JSON.stringify([ref.kind, ref.id, ref.revision, ref.conversationId, ref.sessionId ?? null, ref.entryId ?? null])
const memorySourceIdentity = (ref: MemorySourceRef): string => JSON.stringify([ref.kind, ref.id, ref.conversationId, ref.sessionId ?? null, ref.entryId ?? null])
const memoryConflict = () => new Error('记忆来源或版本已变化，请重新读取。')

export class HerStore {
  private readonly db: DatabaseSync
  readonly artifactDirectory: string
  readonly documentDirectory: string

  constructor(path: string) {
    this.documentDirectory = path === ':memory:' ? '' : join(dirname(path), 'documents')
    this.artifactDirectory = path === ':memory:' ? '' : join(dirname(path), 'artifacts')
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;')

    const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    if (version.user_version === 0) {
      this.createSchema()
    } else if (version.user_version !== 1) {
      throw new Error(`不支持的数据库版本 ${version.user_version}。请使用 Her-Pi v1 或更高版本。`)
    }
    // Keep the v1 grant authority (identity/kind/revision) used by FileAccessService.
    const grantColumns = this.db.prepare('PRAGMA table_info(file_grants)').all() as { name: string }[]
    if (!grantColumns.some(column => column.name === 'data')) this.db.exec('ALTER TABLE file_grants ADD COLUMN data TEXT')
    const conversationColumns = this.db.prepare('PRAGMA table_info(conversations)').all() as { name: string }[]
    if (!conversationColumns.some(column => column.name === 'initial_title_request_id')) this.db.exec('ALTER TABLE conversations ADD COLUMN initial_title_request_id TEXT')
    // Additive v1 cleanup tracking, explicitly approved for Her-Pi-v1 on 2026-10-20.
    this.db.exec(`CREATE TABLE IF NOT EXISTS purge_jobs (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      error TEXT
    )`)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_topics (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('daily', 'work')),
        share_progress INTEGER NOT NULL CHECK(share_progress IN (0, 1)),
        share_revision INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS companion_workspace (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        daily_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL
      );
    `)
    this.db.exec(`CREATE TABLE IF NOT EXISTS topic_handoffs (
      operation_id TEXT PRIMARY KEY,
      preview_id TEXT NOT NULL,
      digest TEXT NOT NULL,
      source_conversation_id TEXT NOT NULL,
      source_session_id TEXT NOT NULL,
      target_conversation_id TEXT NOT NULL UNIQUE,
      pi_session_id TEXT NOT NULL,
      receiver_key TEXT NOT NULL,
      excerpts TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('preparing', 'created', 'failed')),
      error_code TEXT,
      pi_entry_id TEXT
    )`)
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS topic_handoffs_preview_id ON topic_handoffs(preview_id)')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_intents (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS exact_message_consumptions (
        intent_id TEXT PRIMARY KEY REFERENCES user_intents(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL, call_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS delegations (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, data TEXT NOT NULL, proof TEXT
      );
      CREATE TABLE IF NOT EXISTS delegation_controls (
        id TEXT PRIMARY KEY, intent_id TEXT NOT NULL UNIQUE REFERENCES user_intents(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS delegation_runs (
        run_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        delegation_id TEXT NOT NULL REFERENCES delegations(id) ON DELETE CASCADE, scope_revision INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS delegation_inputs (
        request_id TEXT PRIMARY KEY, intent_id TEXT NOT NULL REFERENCES user_intents(id) ON DELETE CASCADE,
        delegation_id TEXT REFERENCES delegations(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS delegation_denials (
        id TEXT PRIMARY KEY, delegation_id TEXT NOT NULL REFERENCES delegations(id) ON DELETE CASCADE,
        scope_revision INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS priority_controls (
        id TEXT PRIMARY KEY, intent_id TEXT NOT NULL UNIQUE REFERENCES user_intents(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS delegation_action_facts (
        delegation_id TEXT NOT NULL REFERENCES delegations(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(delegation_id, target_id)
      );
      CREATE TABLE IF NOT EXISTS delegation_http_evidence (
        id TEXT PRIMARY KEY, delegation_id TEXT NOT NULL REFERENCES delegations(id) ON DELETE CASCADE,
        scope_revision INTEGER NOT NULL, data TEXT NOT NULL
      );
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(id, revision)
      );
      CREATE TABLE IF NOT EXISTS memory_sources (
        owner_key TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(owner_key, position)
      );
      CREATE TABLE IF NOT EXISTS memory_dependencies (
        source_key TEXT PRIMARY KEY, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_exclusions (
        source_identity TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS memory_baselines (
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(conversation_id, session_id)
      );
      CREATE TABLE IF NOT EXISTS progress_summaries (
        id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(id, revision)
      );
    `)
    this.markDelegationsResumeRequired()
    this.recoverArtifactFiles()
    this.recoverDocumentFiles()
    this.db.exec(`CREATE TABLE IF NOT EXISTS file_references (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      grant_id TEXT NOT NULL REFERENCES file_grants(id) ON DELETE CASCADE, data TEXT NOT NULL
    )`)
  }

  private createSchema() {
    this.db.exec(`
      -- Services (replaces old profiles table)
      CREATE TABLE services (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        protocol TEXT NOT NULL,
        base_url TEXT NOT NULL,
        default_model TEXT NOT NULL,
        auth_method TEXT NOT NULL,
        sealed_secrets TEXT,
        has_api_key INTEGER NOT NULL,
        has_custom_headers INTEGER NOT NULL,
        max_output_tokens INTEGER,
        context_window INTEGER,
        models TEXT NOT NULL,
        tests TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1
      );

      -- Conversations: product metadata and trash state
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        title_custom INTEGER NOT NULL DEFAULT 0,
        initial_title_request_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        pi_session_id TEXT NOT NULL UNIQUE,
        last_entry_id TEXT
      );

      CREATE INDEX idx_conversations_deleted ON conversations(deleted_at);
      CREATE INDEX idx_conversations_updated ON conversations(updated_at DESC);

      -- Input queue: persistent message queue per conversation
      CREATE TABLE input_requests (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        attachments TEXT,
        status TEXT NOT NULL,
        profile_id TEXT,
        model TEXT,
        user_message_id TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE INDEX idx_input_queue ON input_requests(conversation_id, status, created_at);

      -- Tasks: execution runs with config snapshots
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL REFERENCES input_requests(id),
        generation INTEGER NOT NULL,
        status TEXT NOT NULL,
        service_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        config_revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        error TEXT,
        continuation_of TEXT,
        assistant_message_id TEXT
      );

      CREATE INDEX idx_tasks_conversation ON tasks(conversation_id, created_at DESC);
      CREATE INDEX idx_tasks_status ON tasks(status);

      -- Task usage: token consumption per task (Task 3.6)
      CREATE TABLE task_usage (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        input_tokens INTEGER,
        output_tokens INTEGER,
        estimated INTEGER NOT NULL DEFAULT 0
      );

      -- Tool calls: action ledger with dispatch phases
      CREATE TABLE tool_calls (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        arguments TEXT NOT NULL,
        effect TEXT NOT NULL,
        target TEXT NOT NULL,
        status TEXT NOT NULL,
        dispatch_phase TEXT NOT NULL,
        result TEXT,
        error TEXT,
        -- A person's decision about an unknown outcome. The call itself stays 'unknown': this is a separate record.
        resolution TEXT,
        resolved_at TEXT,
        created_at TEXT NOT NULL,
        dispatched_at TEXT,
        completed_at TEXT,
        UNIQUE(task_id, call_id)
      );

      CREATE INDEX idx_tool_calls_task ON tool_calls(task_id, created_at);
      CREATE INDEX idx_tool_calls_status ON tool_calls(status);

      -- Targets whose last mutation has an unknown outcome. Global on purpose: no foreign keys,
      -- so isolation spans conversations and restarts until observed or resolved by the user.
      CREATE TABLE target_quarantine (
        target TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        call_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        resolution TEXT
      );

      -- Projection entries: rebuilable display state from Pi entries
      CREATE TABLE projection_entries (
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        entry_id TEXT NOT NULL,
        content TEXT NOT NULL,
        sequence_number INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, entry_id)
      );

      CREATE INDEX idx_projection_sequence ON projection_entries(conversation_id, sequence_number);

      -- Draft fragments: interrupted streaming state
      CREATE TABLE draft_fragments (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        fragment_type TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX idx_drafts_task ON draft_fragments(task_id, created_at);

      -- Tool images. artifact_owners is written before the file so a crash leaves an owner to clean up.
      CREATE TABLE tool_artifacts (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        mime_type TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        source_file_id TEXT
      );

      CREATE TABLE artifact_owners (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        published INTEGER NOT NULL DEFAULT 0
      );

      -- Document extraction cache (Task 7/8: documents and their cleanup ownership)
      CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        file_id TEXT NOT NULL REFERENCES file_references(id) ON DELETE CASCADE,
        cache_key TEXT NOT NULL,
        data TEXT NOT NULL
      );

      CREATE TABLE document_owners (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        published INTEGER NOT NULL DEFAULT 0
      );

      -- MCP services
      -- A removed service keeps its row with config NULL so its revision keeps increasing.
      CREATE TABLE mcp_services (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL DEFAULT 1,
        config TEXT,
        sealed_secrets TEXT,
        test_result TEXT
      );

      -- File grants: per-conversation and persistent
      CREATE TABLE file_grants (
        id TEXT PRIMARY KEY,
        conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        scope TEXT NOT NULL,
        granted_at TEXT NOT NULL,
        revoked_at TEXT,
        revision INTEGER NOT NULL DEFAULT 1
      );

      CREATE INDEX idx_file_grants_conversation ON file_grants(conversation_id, revoked_at);
      CREATE INDEX idx_file_grants_path ON file_grants(path, scope, revoked_at);

      -- Settings (single row)
      CREATE TABLE settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value TEXT NOT NULL
      );

      PRAGMA user_version = 1;
    `)
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Service operations
  // ──────────────────────────────────────────────────────────────────────────────

  saveService(service: StoredService): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO services (id, name, protocol, base_url, default_model, auth_method, sealed_secrets, has_api_key, has_custom_headers, max_output_tokens, context_window, models, tests, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      service.id,
      service.name,
      service.protocol,
      service.baseUrl,
      service.defaultModel,
      service.authMethod,
      service.sealedSecrets,
      service.hasApiKey ? 1 : 0,
      service.hasCustomHeaders ? 1 : 0,
      service.maxOutputTokens,
      service.contextWindow,
      JSON.stringify(service.models),
      JSON.stringify(service.tests),
      service.revision
    )
  }

  getService(id: string): StoredService | null {
    const row = this.db.prepare('SELECT * FROM services WHERE id = ?').get(id) as any
    return row ? this.serviceFromRow(row) : null
  }

  /** Rows written before a test kind existed lack it; fill it in on read so callers never see undefined. */
  private serviceFromRow(row: any): StoredService {
    const fill = (tests: Partial<Record<TestKind, ConnectionTestResult>> | undefined) => ({ ...untestedConnections(), ...tests })
    const models = (JSON.parse(row.models) as ServiceModel[]).map(model => ({ ...model, tests: fill(model.tests) }))
    return {
      id: row.id, name: row.name, protocol: row.protocol, baseUrl: row.base_url, defaultModel: row.default_model,
      authMethod: row.auth_method, sealedSecrets: row.sealed_secrets, hasApiKey: row.has_api_key === 1,
      hasCustomHeaders: row.has_custom_headers === 1, maxOutputTokens: row.max_output_tokens, contextWindow: row.context_window,
      models, tests: fill(JSON.parse(row.tests)), revision: row.revision
    }
  }

  listServices(): StoredService[] {
    return (this.db.prepare('SELECT * FROM services ORDER BY name').all() as any[]).map(row => this.serviceFromRow(row))
  }

  deleteService(id: string): void {
    this.db.prepare('DELETE FROM services WHERE id = ?').run(id)
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Conversation operations
  // ──────────────────────────────────────────────────────────────────────────────

  createConversation(id: string, piSessionId: string, title: string): void {
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO conversations (id, title, title_custom, created_at, updated_at, pi_session_id)
      VALUES (?, ?, 0, ?, ?, ?)
    `).run(id, title, now, now, piSessionId)
  }

  ensureDailyConversation(): StoredConversation {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const pointer = this.db.prepare('SELECT daily_conversation_id FROM companion_workspace WHERE id = 1').get() as { daily_conversation_id: string | null } | undefined
      const current = pointer?.daily_conversation_id ? this.getConversation(pointer.daily_conversation_id) : null
      if (current && !current.deletedAt) {
        this.db.exec('COMMIT')
        return current
      }
      if (pointer?.daily_conversation_id) this.db.prepare("DELETE FROM conversation_topics WHERE conversation_id = ? AND kind = 'daily'").run(pointer.daily_conversation_id)
      const id = randomUUID()
      this.createConversation(id, randomUUID(), '日常')
      this.db.prepare("INSERT INTO conversation_topics(conversation_id, kind, share_progress, share_revision) VALUES (?, 'daily', 0, 1)").run(id)
      this.db.prepare('INSERT INTO companion_workspace(id, daily_conversation_id) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET daily_conversation_id = excluded.daily_conversation_id').run(id)
      const daily = this.getConversation(id)!
      this.db.exec('COMMIT')
      return daily
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  createWorkConversation(id: string, piSessionId: string, title: string): TopicInfo {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.createConversation(id, piSessionId, title)
      this.db.prepare("INSERT INTO conversation_topics(conversation_id, kind, share_progress, share_revision) VALUES (?, 'work', 1, 1)").run(id)
      const topic = this.getTopicInfo(id)!
      this.db.exec('COMMIT')
      return topic
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  insertTopicHandoff(value: StoredTopicHandoff): void {
    this.db.prepare(`INSERT INTO topic_handoffs
      (operation_id, preview_id, digest, source_conversation_id, source_session_id, target_conversation_id, pi_session_id, receiver_key, excerpts, status, error_code, pi_entry_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(value.operationId, value.previewId, value.digest, value.sourceConversationId, value.sourceSessionId, value.conversationId,
        value.piSessionId, value.receiverKey, JSON.stringify(value.excerpts), value.status, value.errorCode, value.piEntryId)
  }

  getTopicHandoff(operationId: string): StoredTopicHandoff | null {
    const row = this.db.prepare('SELECT * FROM topic_handoffs WHERE operation_id = ?').get(operationId) as any
    return row ? { operationId: row.operation_id, previewId: row.preview_id, digest: row.digest,
      sourceConversationId: row.source_conversation_id, sourceSessionId: row.source_session_id, conversationId: row.target_conversation_id,
      piSessionId: row.pi_session_id, receiverKey: row.receiver_key, excerpts: JSON.parse(row.excerpts),
      status: row.status, errorCode: row.error_code, piEntryId: row.pi_entry_id } : null
  }

  getTopicHandoffForConversation(conversationId: string): StoredTopicHandoff | null {
    const row = this.db.prepare('SELECT operation_id FROM topic_handoffs WHERE target_conversation_id = ?').get(conversationId) as { operation_id: string } | undefined
    return row ? this.getTopicHandoff(row.operation_id) : null
  }

  listPreparingTopicHandoffs(): StoredTopicHandoff[] {
    return (this.db.prepare("SELECT operation_id FROM topic_handoffs WHERE status = 'preparing'").all() as { operation_id: string }[])
      .map(row => this.getTopicHandoff(row.operation_id)!)
  }

  finishTopicHandoff(operationId: string, status: 'created' | 'failed', errorCode: StoredTopicHandoff['errorCode'], piEntryId: string | null): void {
    this.db.prepare("UPDATE topic_handoffs SET status = ?, error_code = ?, pi_entry_id = ? WHERE operation_id = ? AND status = 'preparing'")
      .run(status, errorCode, piEntryId, operationId)
  }

  retryTopicHandoff(operationId: string): void {
    this.db.prepare("UPDATE topic_handoffs SET status = 'preparing', error_code = NULL WHERE operation_id = ? AND status = 'failed' AND error_code = 'storage-failed'")
      .run(operationId)
  }

  getTopicInfo(id: string): TopicInfo | null {
    const row = this.db.prepare('SELECT conversation_id, kind, share_progress, share_revision FROM conversation_topics WHERE conversation_id = ?').get(id) as
      { conversation_id: string; kind: TopicInfo['kind']; share_progress: number; share_revision: number } | undefined
    return row ? { conversationId: row.conversation_id, kind: row.kind, shareProgress: row.share_progress === 1, shareRevision: row.share_revision } : null
  }

  listTopicInfo(): TopicInfo[] {
    return (this.db.prepare('SELECT conversation_id FROM conversation_topics ORDER BY rowid').all() as { conversation_id: string }[])
      .map(row => this.getTopicInfo(row.conversation_id)!)
  }

  getMemory(id: string): MemoryRecord | null {
    const row = this.db.prepare('SELECT data FROM memories WHERE id = ? ORDER BY revision DESC LIMIT 1').get(id) as { data: string } | undefined
    return row ? JSON.parse(row.data) : null
  }

  getMemoryVersion(id: string, revision: number): MemoryRecord | null {
    const row = this.db.prepare('SELECT data FROM memories WHERE id = ? AND revision = ?').get(id, revision) as { data: string } | undefined
    return row ? JSON.parse(row.data) : null
  }

  listMemories(scope: MemoryScope): MemoryRecord[] {
    return (this.db.prepare('SELECT data FROM memories m WHERE revision = (SELECT MAX(revision) FROM memories WHERE id = m.id) ORDER BY rowid').all() as { data: string }[])
      .map(row => JSON.parse(row.data) as MemoryRecord).filter(value => value.scope.kind === scope.kind &&
        (scope.kind === 'personal' || (value.scope.kind === 'work' && value.scope.conversationId === scope.conversationId)))
  }

  /** Current version, source edges and exclusion tombstone commit together. Old content remains addressable. */
  saveMemory(input: MemoryRecord, expectedRevision: number | null): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const previous = this.getMemory(input.id)
      if ((previous?.revision ?? null) !== expectedRevision || input.revision !== (expectedRevision ?? 0) + 1 || !input.sources.length ||
          !input.id || !input.content.trim() || !Number.isFinite(Date.parse(input.validFrom)) ||
          (input.validUntil !== undefined && !Number.isFinite(Date.parse(input.validUntil))) ||
          !['active', 'superseded', 'excluded'].includes(input.status) || !['personal', 'work'].includes(input.scope.kind) ||
          (previous && JSON.stringify(previous.scope) !== JSON.stringify(input.scope))) throw memoryConflict()
      const conversationId = input.scope.kind === 'work' ? input.scope.conversationId : this.listTopicInfo().find(topic => topic.kind === 'daily')?.conversationId
      const topic = conversationId && this.getTopicInfo(conversationId)
      if (!topic || topic.kind !== (input.scope.kind === 'work' ? 'work' : 'daily')) throw memoryConflict()
      const ref: MemorySourceRef = { kind: 'memory', id: input.id, revision: input.revision, conversationId: topic.conversationId }
      this.saveMemorySource(ref, { memorySources: input.sources, fileSources: {} }, topic.shareRevision)
      if (previous) this.db.prepare('UPDATE memories SET data = ? WHERE id = ? AND revision = ?')
        .run(JSON.stringify({ ...previous, status: previous.status === 'excluded' ? 'excluded' : 'superseded', validUntil: input.validFrom }), previous.id, previous.revision)
      this.db.prepare('INSERT INTO memories(id, revision, data) VALUES (?, ?, ?)').run(input.id, input.revision, JSON.stringify(input))
      this.saveMemoryEdges(ref, input.sources)
      if (input.status === 'excluded') this.excludeMemorySource(ref)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  getMemorySource(ref: MemorySourceRef): StoredMemorySource | null {
    const row = this.db.prepare('SELECT data FROM memory_dependencies WHERE source_key = ?').get(memorySourceKey(ref)) as { data: string } | undefined
    return row ? JSON.parse(row.data) : null
  }

  /** Host-only provenance registration. An existing identity/version can never acquire different dependencies. */
  saveMemorySource(ref: MemorySourceRef, dependencies: MemorySourceDependencies, shareRevision: number): void {
    const conversation = this.getConversation(ref.conversationId), topic = this.getTopicInfo(ref.conversationId)
    if (!conversation || conversation.deletedAt || !topic || topic.shareRevision !== shareRevision || !ref.id ||
        !Number.isSafeInteger(ref.revision) || ref.revision < 1 || !['pi-entry', 'memory', 'progress'].includes(ref.kind) ||
        (ref.kind === 'pi-entry' ? !ref.entryId || ref.id !== ref.entryId || ref.sessionId !== conversation.piSessionId : ref.sessionId !== undefined || ref.entryId !== undefined)) throw memoryConflict()
    const value: StoredMemorySource = { ref, dependencies, shareRevision }
    const previous = this.getMemorySource(ref)
    if (previous) { if (JSON.stringify(previous) !== JSON.stringify(value)) throw memoryConflict(); return }
    this.db.prepare('INSERT INTO memory_dependencies(source_key, data) VALUES (?, ?)').run(memorySourceKey(ref), JSON.stringify(value))
  }

  private saveMemoryEdges(owner: MemorySourceRef, sources: MemorySourceRef[]): void {
    sources.forEach((source, position) => this.db.prepare('INSERT INTO memory_sources(owner_key, position, data) VALUES (?, ?, ?)')
      .run(memorySourceKey(owner), position, JSON.stringify(source)))
  }

  getMemorySources(owner: MemorySourceRef): MemorySourceRef[] {
    return (this.db.prepare('SELECT data FROM memory_sources WHERE owner_key = ? ORDER BY position').all(memorySourceKey(owner)) as { data: string }[]).map(row => JSON.parse(row.data))
  }

  excludeMemorySource(ref: MemorySourceRef): void {
    this.db.prepare('INSERT OR IGNORE INTO memory_exclusions(source_identity) VALUES (?)').run(memorySourceIdentity(ref))
  }

  isMemorySourceExcluded(ref: MemorySourceRef): boolean {
    return !!this.db.prepare('SELECT 1 FROM memory_exclusions WHERE source_identity = ?').get(memorySourceIdentity(ref))
  }

  saveMemoryBaseline(value: MemoryEntryBaseline): void {
    const conversation = this.getConversation(value.conversationId)
    if (!conversation || conversation.deletedAt || !this.getTopicInfo(value.conversationId) || conversation.piSessionId !== value.sessionId) throw memoryConflict()
    this.db.prepare('INSERT INTO memory_baselines(conversation_id, session_id, data) VALUES (?, ?, ?)')
      .run(value.conversationId, value.sessionId, JSON.stringify(value))
  }

  getMemoryBaseline(conversationId: string, sessionId: string): MemoryEntryBaseline | null {
    const row = this.db.prepare('SELECT data FROM memory_baselines WHERE conversation_id = ? AND session_id = ?').get(conversationId, sessionId) as { data: string } | undefined
    return row ? JSON.parse(row.data) : null
  }

  getProgressSummary(id: string): StoredProgressSummary | null {
    const row = this.db.prepare('SELECT data FROM progress_summaries WHERE id = ? ORDER BY revision DESC LIMIT 1').get(id) as { data: string } | undefined
    return row ? JSON.parse(row.data) : null
  }

  saveProgressSummary(input: StoredProgressSummary, expectedRevision: number | null): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const previous = this.getProgressSummary(input.id), topic = this.getTopicInfo(input.conversationId)
      if (!topic || topic.kind !== 'work' || !topic.shareProgress || topic.shareRevision !== input.expectedShareRevision ||
          (previous?.revision ?? null) !== expectedRevision || input.revision !== (expectedRevision ?? 0) + 1 ||
          !input.id || !input.summary.trim() || !input.sources.length || (previous && previous.conversationId !== input.conversationId)) throw memoryConflict()
      const ref: MemorySourceRef = { kind: 'progress', id: input.id, revision: input.revision, conversationId: input.conversationId }
      this.saveMemorySource(ref, { memorySources: input.sources, fileSources: {} }, input.expectedShareRevision)
      this.db.prepare('INSERT INTO progress_summaries(id, revision, data) VALUES (?, ?, ?)').run(input.id, input.revision, JSON.stringify(input))
      this.saveMemoryEdges(ref, input.sources)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  getConversation(id: string): StoredConversation | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as any
    if (!row) return null
    return {
      id: row.id,
      title: row.title,
      titleCustom: row.title_custom === 1,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      deletedAt: row.deleted_at ? new Date(row.deleted_at) : null,
      piSessionId: row.pi_session_id,
      lastEntryId: row.last_entry_id
    }
  }

  hasConversation(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM conversations WHERE id = ? AND deleted_at IS NULL').get(id)
  }

  getMessages(conversationId: string): ChatMessage[] {
    return (this.db.prepare('SELECT content FROM projection_entries WHERE conversation_id = ? ORDER BY sequence_number')
      .all(conversationId) as { content: string }[]).map(row => JSON.parse(row.content))
  }

  replaceMessageProjection(conversationId: string, entries: { entryId: string; message: ChatMessage }[], lastEntryId: string | null): void {
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM projection_entries WHERE conversation_id = ?').run(conversationId)
      const insert = this.db.prepare('INSERT INTO projection_entries(conversation_id, entry_id, content, sequence_number) VALUES (?, ?, ?, ?)')
      entries.forEach((entry, index) => insert.run(conversationId, entry.entryId, JSON.stringify(entry.message), index))
      this.db.prepare('UPDATE conversations SET last_entry_id = ? WHERE id = ?').run(lastEntryId, conversationId)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  saveFileGrant(value: StoredFileGrant): void {
    this.db.prepare(`INSERT INTO file_grants(id, conversation_id, path, scope, granted_at, revoked_at, revision, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      revoked_at = excluded.revoked_at, revision = excluded.revision, data = excluded.data`)
      .run(value.grant.id, value.grant.conversationId ?? null, value.path, value.grant.scope,
        new Date().toISOString(), value.revoked ? new Date().toISOString() : null, value.grant.revision, JSON.stringify(value))
  }

  getFileGrant(id: string): StoredFileGrant | null {
    const row = this.db.prepare('SELECT data FROM file_grants WHERE id = ?').get(id) as { data: string | null } | undefined
    return row?.data ? JSON.parse(row.data) : null
  }

  listFileGrants(): StoredFileGrant[] {
    // Rows without an identity snapshot cannot authorize access; they must be selected again.
    return (this.db.prepare('SELECT data FROM file_grants WHERE data IS NOT NULL ORDER BY rowid').all() as { data: string }[])
      .map(row => JSON.parse(row.data))
  }

  saveFileReference(value: StoredFileReference): void {
    this.db.prepare('INSERT INTO file_references(id, conversation_id, grant_id, data) VALUES (?, ?, ?, ?)')
      .run(value.reference.id, value.conversationId, value.reference.grantId, JSON.stringify(value))
  }

  getFileReference(id: string): StoredFileReference | null {
    const row = this.db.prepare('SELECT data FROM file_references WHERE id = ?').get(id) as { data: string } | undefined
    return row ? JSON.parse(row.data) : null
  }

  listConversations(includeDeleted: boolean = false): StoredConversation[] {
    const sql = includeDeleted
      ? 'SELECT * FROM conversations ORDER BY updated_at DESC, rowid DESC'
      : 'SELECT * FROM conversations WHERE deleted_at IS NULL ORDER BY updated_at DESC, rowid DESC'
    const rows = this.db.prepare(sql).all() as any[]
    return rows.map(row => ({
      id: row.id,
      title: row.title,
      titleCustom: row.title_custom === 1,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      deletedAt: row.deleted_at ? new Date(row.deleted_at) : null,
      piSessionId: row.pi_session_id,
      lastEntryId: row.last_entry_id
    }))
  }

  /** A user rename: trimmed, 1–80 characters, becomes a custom title, leaves the sort order alone, never touches a trashed conversation. */
  renameConversation(id: string, title: string): ConversationSummary {
    const clean = title.trim()
    if (!clean) throw new Error('请输入对话标题。')
    if (Array.from(clean).length > 80) throw new Error('对话标题最多 80 个字符。')
    const result = this.db.prepare('UPDATE conversations SET title = ?, title_custom = 1 WHERE id = ? AND deleted_at IS NULL').run(clean, id)
    if (!result.changes) throw new Error('该对话已经不存在。')
    return this.conversationSummary(this.getConversation(id)!)
  }

  updateConversationTitle(id: string, title: string, custom: boolean): void {
    const now = new Date().toISOString()
    this.db.prepare('UPDATE conversations SET title = ?, title_custom = ?, updated_at = ? WHERE id = ?')
      .run(title, custom ? 1 : 0, now, id)
  }

  setInitialTopicTitle(conversationId: string, requestId: string, text: string): void {
    const title = Array.from(text.replace(/\s+/gu, ' ').trim()).slice(0, 24).join('')
    if (!title) return
    this.db.prepare(`UPDATE conversations SET title = ?, initial_title_request_id = ?
      WHERE id = ? AND deleted_at IS NULL AND title_custom = 0 AND initial_title_request_id IS NULL
        AND EXISTS (SELECT 1 FROM conversation_topics WHERE conversation_id = ? AND kind = 'work')`)
      .run(title, requestId, conversationId, conversationId)
  }

  trashConversation(id: string): void {
    const now = new Date().toISOString()
    this.db.prepare('UPDATE conversations SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, id)
  }

  /** Viewing only: a restored conversation never resumes its queue or old approvals by itself. */
  restoreConversation(id: string): ConversationSummary {
    if (this.db.prepare('SELECT 1 FROM purge_jobs WHERE conversation_id = ?').get(id)) throw new Error('此对话正在永久清理，不能恢复，请重试清理。')
    const now = new Date().toISOString()
    const result = this.db.prepare('UPDATE conversations SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL').run(now, id)
    if (!result.changes) throw new Error('该对话不在回收站中。')
    return this.conversationSummary(this.getConversation(id)!)
  }

  listTrashedConversations(): TrashedConversation[] {
    const rows = this.db.prepare('SELECT * FROM conversations WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, rowid DESC').all() as any[]
    return rows.map(row => {
      const job = this.db.prepare('SELECT error FROM purge_jobs WHERE conversation_id = ?').get(row.id) as { error: string | null } | undefined
      return { ...this.conversationSummary(this.conversationFromRow(row)), deletedAt: row.deleted_at, ...(job ? { cleanupPending: true, cleanupError: job.error ?? undefined } : {}) }
    })
  }

  private conversationSummary(conversation: StoredConversation): ConversationSummary {
    return { id: conversation.id, title: conversation.title, titleCustom: conversation.titleCustom,
      createdAt: conversation.createdAt.toISOString(), updatedAt: conversation.updatedAt.toISOString(), lastMessage: '' }
  }

  beginPurge(ids: string[]): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const id of ids) {
        if (!this.db.prepare('SELECT 1 FROM conversations WHERE id = ? AND deleted_at IS NOT NULL').get(id)) throw new Error('只能永久删除回收站中的对话。')
      }
      for (const id of ids) this.db.prepare('INSERT INTO purge_jobs(conversation_id) VALUES (?) ON CONFLICT DO NOTHING').run(id)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  listPurgeJobs(): { conversationId: string; error: string | null }[] {
    return (this.db.prepare('SELECT conversation_id, error FROM purge_jobs').all() as { conversation_id: string; error: string | null }[])
      .map(row => ({ conversationId: row.conversation_id, error: row.error }))
  }

  failPurge(id: string): void {
    this.db.prepare('UPDATE purge_jobs SET error = ? WHERE conversation_id = ?').run('清理未完成，请重试。', id)
  }

  purgeConversation(id: string): void {
    this.purgeConversations([id])
  }

  permanentlyDeleteConversation(id: string): void {
    this.purgeConversations([id])
  }

  /**
   * Only a trashed conversation can be purged. Cascading foreign keys remove its input_requests, tasks,
   * tool_calls, projection_entries, draft_fragments and file_grants; tables with no foreign key (tool image
   * and document cache ownership, target quarantine) are cleared explicitly. File bytes are removed outside
   * the transaction, so a later rollback never leaves an owning row for bytes that are already gone.
   */
  purgeConversations(ids: string[]): void {
    if (!ids.length) return
    const artifacts = ids.flatMap(id => this.listArtifactOwners(id).map(owner => owner.id))
    const documents = ids.flatMap(id => this.documentIds(id))
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const id of ids) {
        if (!this.db.prepare('SELECT id FROM conversations WHERE id = ? AND deleted_at IS NOT NULL').get(id)) throw new Error('只能永久删除回收站中的对话。')
      }
      this.removeDocumentFiles(documents, true)
      this.removeArtifactFiles(artifacts, true)
      for (const id of ids) {
        // Keep a content-free intent tombstone so replay cannot recreate a permanently deleted work topic.
        for (const control of this.listDelegationControls().filter(value => value.conversationId === id)) {
          this.updateDelegationControl({ ...control, status: 'rejected', revision: control.revision + 1,
            proposal: { id: control.id, revision: control.revision + 1, evidenceSpans: [],
              scope: { purpose: '', objects: [], completion: '', allowedCapabilities: [], origins: [], constraints: {} } } }, control.revision)
        }
        this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  private conversationFromRow(row: any): StoredConversation {
    return { id: row.id, title: row.title, titleCustom: row.title_custom === 1, createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at), deletedAt: row.deleted_at ? new Date(row.deleted_at) : null,
      piSessionId: row.pi_session_id, lastEntryId: row.last_entry_id }
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Input queue operations
  // ──────────────────────────────────────────────────────────────────────────────

  enqueueInput(conversationId: string, content: string, attachments: any[] | null, id: string = randomUUID(),
    target: { profileId?: string; model?: string; userMessageId?: string; initialTitleText?: string } = {}): string {
    const now = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`
        INSERT INTO input_requests (id, conversation_id, content, attachments, status, profile_id, model, user_message_id, created_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
      `).run(id, conversationId, content, attachments ? JSON.stringify(attachments) : null, target.profileId ?? null, target.model ?? null, target.userMessageId ?? null, now)
      if (target.initialTitleText) this.setInitialTopicTitle(conversationId, id, target.initialTitleText)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return id
  }

  /** Oldest first, so a queue is always consumed in arrival order. */
  listPendingInputs(conversationId: string): StoredInputRequest[] {
    return (this.db.prepare(`SELECT * FROM input_requests WHERE conversation_id = ? AND status = 'pending' ORDER BY created_at ASC, rowid ASC`)
      .all(conversationId) as any[]).map(row => this.inputFromRow(row))
  }

  getInput(id: string): StoredInputRequest | null {
    const row = this.db.prepare('SELECT * FROM input_requests WHERE id = ?').get(id) as any
    return row ? this.inputFromRow(row) : null
  }

  /** Conditional update: true for exactly one caller, so a request can never start two tasks. */
  claimInput(id: string): boolean {
    return Number(this.db.prepare(`UPDATE input_requests SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'`)
      .run(new Date().toISOString(), id).changes) === 1
  }

  /** Only a still-pending request can be withdrawn; once claimed it is too late. */
  cancelPendingInput(id: string): boolean {
    return Number(this.db.prepare(`UPDATE input_requests SET status = 'cancelled', completed_at = ? WHERE id = ? AND status = 'pending'`)
      .run(new Date().toISOString(), id).changes) === 1
  }

  listConversationsWithPendingInput(): string[] {
    return (this.db.prepare(`SELECT DISTINCT conversation_id FROM input_requests WHERE status = 'pending'`).all() as { conversation_id: string }[]).map(row => row.conversation_id)
  }

  /**
   * Start-up: tasks a crash left in a non-final state are interrupted and never resumed automatically.
   * Inputs are deliberately not touched here: whether a claimed input reached Pi decides its fate (see recover.ts).
   */
  markInterruptedTasks(): number {
    const tasks = this.db.prepare(`UPDATE tasks SET status = 'interrupted', ended_at = ?, error = ? WHERE status IN ('queued', 'running', 'waiting_approval', 'waiting_resource', 'compacting', 'retrying', 'stopping')`)
      .run(new Date().toISOString(), '应用中断，任务未完成。')
    return Number(tasks.changes)
  }

  getTaskByRequest(requestId: string): StoredTask | null {
    const row = this.db.prepare('SELECT id FROM tasks WHERE request_id = ? ORDER BY rowid DESC LIMIT 1').get(requestId) as { id: string } | undefined
    return row ? this.getTask(row.id) : null
  }

  /** Requests a crash left claimed. Whether each reached Pi decides what happens to it. */
  listRunningInputs(): StoredInputRequest[] {
    return (this.db.prepare(`SELECT * FROM input_requests WHERE status = 'running' ORDER BY created_at ASC, rowid ASC`).all() as any[]).map(row => this.inputFromRow(row))
  }

  /** Puts a claimed request that never reached Pi back in the queue; false if it was no longer running. */
  requeueInput(id: string): boolean {
    return Number(this.db.prepare(`UPDATE input_requests SET status = 'pending', started_at = NULL WHERE id = ? AND status = 'running'`).run(id).changes) === 1
  }

  /** Tasks a crash left in a non-final state. */
  listNonTerminalTasks(): StoredTask[] {
    return (this.db.prepare(`SELECT id FROM tasks WHERE status IN ('queued', 'running', 'waiting_approval', 'waiting_resource', 'compacting', 'retrying', 'stopping')`).all() as { id: string }[])
      .map(row => this.getTask(row.id)!)
  }

  private inputFromRow(row: any): StoredInputRequest {
    return {
      id: row.id, conversationId: row.conversation_id, content: row.content, attachments: row.attachments, status: row.status,
      profileId: row.profile_id ?? null, model: row.model ?? null, userMessageId: row.user_message_id ?? null,
      createdAt: new Date(row.created_at), startedAt: row.started_at ? new Date(row.started_at) : null, completedAt: row.completed_at ? new Date(row.completed_at) : null
    }
  }

  getPendingInput(conversationId: string): StoredInputRequest | null {
    return this.listPendingInputs(conversationId)[0] ?? null
  }

  updateInputStatus(id: string, status: InputQueueStatus): void {
    const now = new Date().toISOString()
    const field = status === 'running' ? 'started_at' : status === 'completed' || status === 'cancelled' ? 'completed_at' : null
    if (field) {
      this.db.prepare(`UPDATE input_requests SET status = ?, ${field} = ? WHERE id = ?`).run(status, now, id)
    } else {
      this.db.prepare('UPDATE input_requests SET status = ? WHERE id = ?').run(status, id)
    }
  }

  /** Trusted ingress only. Classification must be a later host decision. */
  saveUserIntent(intent: UserIntent): void {
    if (intent.source !== 'user' || intent.kind !== 'unclassified') throw new Error('用户依据不正确。')
    this.db.prepare('INSERT INTO user_intents(id, conversation_id, data) VALUES (?, ?, ?)')
      .run(intent.id, intent.conversationId, JSON.stringify(intent))
  }

  getUserIntent(id: string): UserIntent | null {
    const row = this.db.prepare('SELECT data FROM user_intents WHERE id = ?').get(id) as { data: string } | undefined
    return row ? JSON.parse(row.data) : null
  }

  classifyUserIntent(id: string, kind: UserIntent['kind']): void {
    this.db.prepare("UPDATE user_intents SET data = json_set(data, '$.kind', ?) WHERE id = ?").run(kind, id)
  }

  bindDelegationInput(requestId: string, intentId: string, delegationId: string | null = null): void {
    this.db.prepare('INSERT INTO delegation_inputs(request_id, intent_id, delegation_id) VALUES (?, ?, ?)').run(requestId, intentId, delegationId)
  }

  getDelegationInput(requestId: string): { intentId: string; delegationId: string | null } | null {
    return this.db.prepare('SELECT intent_id AS intentId, delegation_id AS delegationId FROM delegation_inputs WHERE request_id = ?').get(requestId) as { intentId: string; delegationId: string | null } | undefined ?? null
  }

  /** Only already-admitted unfinished inputs or a waiting scope; completed history is excluded. */
  listPriorityCandidateIntentIds(): string[] {
    return (this.db.prepare(`SELECT DISTINCT u.id FROM user_intents u
      LEFT JOIN delegation_inputs b ON b.intent_id = u.id
      LEFT JOIN input_requests i ON i.id = COALESCE(b.request_id, u.id)
      LEFT JOIN delegation_controls c ON c.intent_id = u.id
      WHERE json_extract(u.data, '$.kind') != 'control' AND
        (i.status IN ('pending', 'running') OR json_extract(c.data, '$.status') = 'waiting')`).all() as { id: string }[]).map(row => row.id)
  }

  savePriorityControl(value: PriorityControl, expectedRevision?: number): void {
    if (expectedRevision === undefined) this.db.prepare('INSERT INTO priority_controls(id, intent_id, revision, data) VALUES (?, ?, ?, ?)')
      .run(value.id, value.intentId, value.revision, JSON.stringify(value))
    else if (!this.db.prepare('UPDATE priority_controls SET revision = ?, data = ? WHERE id = ? AND revision = ?')
      .run(value.revision, JSON.stringify(value), value.id, expectedRevision).changes) throw new Error('控制指令已变化。')
  }

  listPriorityControls(): PriorityControl[] {
    return (this.db.prepare('SELECT data FROM priority_controls ORDER BY rowid').all() as { data: string }[]).map(row => JSON.parse(row.data))
  }

  /** Only compiled registry descriptions feed these private identity facts; no payload/body copies. */
  saveDelegationActionFact(action: ActionDescriptor): void {
    if (!action.delegationId || action.opaque || !action.targetId) return
    this.db.prepare('INSERT OR REPLACE INTO delegation_action_facts(delegation_id, target_id, data) VALUES (?, ?, ?)')
      .run(action.delegationId, action.targetId, JSON.stringify({ delegationId: action.delegationId, scopeRevision: action.scopeRevision,
        targetId: action.targetId, target: action.target, effect: action.effect, businessEffect: action.businessEffect }))
  }

  listDelegationActionFacts(): Pick<ActionDescriptor, 'delegationId' | 'scopeRevision' | 'targetId' | 'target' | 'effect' | 'businessEffect'>[] {
    return (this.db.prepare('SELECT data FROM delegation_action_facts').all() as { data: string }[]).map(row => JSON.parse(row.data))
  }

  /** All selected lifecycle changes and candidate releases are one conditional write. */
  resolvePriorityControl(control: PriorityControl, expectedRevision: number, changes: Delegation[]): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const value of changes) this.updateDelegation(value, value.revision - 1)
      this.savePriorityControl(control, expectedRevision)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  getDelegationResumeControls(id: string): { id: string; revision: number }[] {
    const owner = this.getDelegation(id)?.conversationId
    return this.listPriorityControls().filter(control => control.kind === 'pause' && control.effect === 'all' &&
      (control.status === 'resolved' || (control.status === 'waiting' && owner && control.ownerResolutions?.[owner] === 'pause')) &&
      control.heldIntentIds.some(intentId => this.getIntentControl(intentId)?.delegationId === id))
      .map(control => ({ id: control.id, revision: control.revision })).sort((a, b) => a.id.localeCompare(b.id))
  }

  assertDelegationResumeControls(id: string, expected: { id: string; revision: number }[]): void {
    if (JSON.stringify(this.getDelegationResumeControls(id)) !== JSON.stringify([...expected].sort((a, b) => a.id.localeCompare(b.id)))) throw new Error('暂停控制已变化，请重新核对原话题卡片。')
  }

  /** Resume and release only the selected delegation's already-resolved lifecycle holds, together. */
  resumeDelegation(value: Delegation, expectedRevision: number, expectedControls: { id: string; revision: number }[]): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.getDelegation(value.id)
      if (!current || current.revision !== expectedRevision || !['active', 'paused'].includes(current.status)) throw new Error('委托版本已变化。')
      this.assertDelegationResumeControls(value.id, expectedControls)
      this.updateDelegation(value, expectedRevision)
      for (const expected of expectedControls) {
        const control = this.listPriorityControls().find(control => control.id === expected.id)!
        this.savePriorityControl({ ...control, revision: control.revision + 1,
          heldIntentIds: control.heldIntentIds.filter(intentId => this.getIntentControl(intentId)?.delegationId !== value.id) }, expected.revision)
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  insertDelegation(value: Delegation): void {
    this.db.prepare('INSERT INTO delegations(id, conversation_id, revision, data) VALUES (?, ?, ?, ?)')
      .run(value.id, value.conversationId, value.revision, JSON.stringify(value))
  }

  saveDelegationDenial(value: DelegationDenial): void {
    this.db.prepare('INSERT INTO delegation_denials (id, delegation_id, scope_revision, data) VALUES (?, ?, ?, ?)')
      .run(value.id, value.delegationId, value.scopeRevision, JSON.stringify(value))
  }

  listDelegationDenials(delegationId: string): DelegationDenial[] {
    return (this.db.prepare('SELECT id, scope_revision, data FROM delegation_denials WHERE delegation_id = ? ORDER BY rowid').all(delegationId) as { id: string; scope_revision: number; data: string }[])
      .map(row => ({ ...JSON.parse(row.data), id: row.id, delegationId, scopeRevision: row.scope_revision }))
  }

  /** Evidence consumption, refusal withdrawal and runtime invalidation commit together. */
  reviseDelegationDenial(value: Delegation, expectedRevision: number, denial: DelegationDenial, proof: DenialRevisionProof): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (this.db.prepare("SELECT 1 FROM delegation_denials WHERE json_extract(data, '$.withdrawal.intentId') = ?").get(proof.intentId)) throw new Error('这条用户依据已使用。')
      const row = this.db.prepare('SELECT data FROM delegation_denials WHERE id = ? AND delegation_id = ?').get(denial.id, value.id) as { data: string } | undefined
      if (!row || JSON.parse(row.data).withdrawal) throw new Error('拒绝记录已变化。')
      this.db.prepare('UPDATE delegation_denials SET data = ? WHERE id = ?').run(JSON.stringify({ ...denial, withdrawal: proof }), denial.id)
      this.updateDelegation(value, expectedRevision)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  saveHttpEvidence(value: import('../delegations/http-comparison').HttpEvidence): void {
    this.db.prepare('INSERT INTO delegation_http_evidence (id, delegation_id, scope_revision, data) VALUES (?, ?, ?, ?)')
      .run(value.id, value.delegationId, value.scopeRevision, JSON.stringify(value))
  }

  listHttpEvidence(delegationId: string, revision: number): import('../delegations/http-comparison').HttpEvidence[] {
    return (this.db.prepare('SELECT data FROM delegation_http_evidence WHERE delegation_id = ? AND scope_revision = ? ORDER BY rowid').all(delegationId, revision) as { data: string }[])
      .map(row => JSON.parse(row.data))
  }

  deleteHttpEvidence(id: string): void {
    this.db.prepare('DELETE FROM delegation_http_evidence WHERE id = ?').run(id)
  }

  getDelegation(id: string): Delegation | null {
    const row = this.db.prepare('SELECT data FROM delegations WHERE id = ?').get(id) as { data: string } | undefined
    return row ? JSON.parse(row.data) : null
  }

  markDelegationsResumeRequired(): void {
    this.db.exec("UPDATE delegations SET data = json_set(data, '$.resumeRequired', json('true')) WHERE json_extract(data, '$.status') IN ('active', 'paused')")
  }

  listDelegations(): Delegation[] {
    return (this.db.prepare('SELECT data FROM delegations').all() as { data: string }[]).map(row => JSON.parse(row.data))
  }

  updateDelegation(value: Delegation, expectedRevision: number, proof?: CompletionProof): void {
    const result = this.db.prepare('UPDATE delegations SET revision = ?, data = ?, proof = ? WHERE id = ? AND revision = ?')
      .run(value.revision, JSON.stringify(value), proof ? JSON.stringify(proof) : null, value.id, expectedRevision)
    if (!result.changes) throw new Error('委托版本已变化。')
  }

  /** Actual unresolved ledger identities for this delegation, including older bound runs. */
  listDelegationUnknownEvidence(id: string): string[] {
    return (this.db.prepare(`SELECT c.id FROM tool_calls c JOIN delegation_runs r ON r.run_id = c.task_id
      WHERE r.delegation_id = ? AND c.status = 'unknown' AND c.resolution IS NULL ORDER BY c.created_at, c.rowid`).all(id) as { id: string }[]).map(row => row.id)
  }

  getDelegationProof(id: string): CompletionProof | null {
    const row = this.db.prepare('SELECT proof FROM delegations WHERE id = ?').get(id) as { proof: string | null } | undefined
    return row?.proof ? JSON.parse(row.proof) : null
  }

  insertDelegationControl(value: DelegationControl): void {
    this.db.prepare('INSERT INTO delegation_controls(id, intent_id, revision, data) VALUES (?, ?, ?, ?)')
      .run(value.id, value.intentId, value.revision, JSON.stringify(value))
  }

  getDelegationControl(id: string): DelegationControl | null {
    const row = this.db.prepare('SELECT data FROM delegation_controls WHERE id = ?').get(id) as { data: string } | undefined
    return row ? JSON.parse(row.data) : null
  }

  getIntentControl(intentId: string): DelegationControl | null {
    const row = this.db.prepare('SELECT data FROM delegation_controls WHERE intent_id = ?').get(intentId) as { data: string } | undefined
    return row ? JSON.parse(row.data) : null
  }

  /** Known ordinary work input only; a future scope candidate is not an owned delegation yet. */
  getOrdinaryWorkInputOwner(intentId: string): string | undefined {
    if (this.getIntentControl(intentId)) return undefined
    const intent = this.getUserIntent(intentId), input = this.getInput(intentId)
    return intent && input?.conversationId === intent.conversationId && this.getTopicInfo(intent.conversationId)?.kind === 'work' ? intent.conversationId : undefined
  }

  listDelegationControls(): DelegationControl[] {
    return (this.db.prepare('SELECT data FROM delegation_controls').all() as { data: string }[]).map(row => JSON.parse(row.data))
  }

  updateDelegationControl(value: DelegationControl, expectedRevision: number): void {
    const result = this.db.prepare('UPDATE delegation_controls SET revision = ?, data = ? WHERE id = ? AND revision = ?')
      .run(value.revision, JSON.stringify(value), value.id, expectedRevision)
    if (!result.changes) throw new Error('范围候选已变化。')
  }

  /** Scope grant and its idempotency record commit together. */
  approveDelegationControl(control: DelegationControl, delegation: Delegation): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.insertDelegation(delegation)
      this.updateDelegationControl({ ...control, status: 'approved', delegationId: delegation.id }, control.revision)
      this.classifyUserIntent(control.intentId, 'delegate')
      // Materialize only a descendant of an input frozen before the priority control arrived.
      for (const priority of this.listPriorityControls().filter(value => value.candidateIntentIds?.includes(control.intentId))) {
        const held = priority.heldIntentIds?.includes(control.intentId)
        const ownerResolutions = { ...priority.ownerResolutions }
        if (held) delete ownerResolutions[delegation.conversationId]
        this.savePriorityControl({ ...priority, revision: priority.revision + 1,
          ...(held ? { status: 'waiting' as const, ownerResolutions, selection: undefined } : {}),
          candidates: [...priority.candidates, { delegationId: delegation.id, revision: delegation.revision }],
          heldDelegationIds: held ? [...priority.heldDelegationIds, delegation.id] : priority.heldDelegationIds }, priority.revision)
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  claimDelegationDispatch(id: string): boolean {
    return !!this.db.prepare("UPDATE delegation_controls SET data = json_set(data, '$.dispatch', 'claimed') WHERE id = ? AND json_extract(data, '$.dispatch') = 'pending' AND json_extract(data, '$.status') = 'approved'").run(id).changes
  }

  setDelegationDispatch(id: string, state: DelegationControl['dispatch']): void {
    this.db.prepare("UPDATE delegation_controls SET data = json_set(data, '$.dispatch', ?) WHERE id = ?").run(state, id)
  }

  /** A pre-run failure must be durable before publishing the failure/pending notification. */
  failDelegationAdmission(requestId: string): boolean {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare("SELECT data FROM delegation_controls WHERE json_extract(data, '$.requestId') = ?").get(requestId) as { data: string } | undefined
      const control: DelegationControl | undefined = row && JSON.parse(row.data)
      if (!control || control.status !== 'approved' || control.dispatch !== 'claimed' || !control.delegationId || this.getTaskByRequest(requestId)) {
        this.db.exec('COMMIT')
        return false
      }
      this.updateDelegationControl({ ...control, dispatch: 'failed' }, control.revision)
      const delegation = this.getDelegation(control.delegationId)
      if (delegation?.status === 'active') this.updateDelegation({ ...delegation, status: 'paused', revision: delegation.revision + 1 }, delegation.revision)
      this.db.exec('COMMIT')
      return true
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  attachDelegationRun(id: string, runId: string, revision: number): void {
    this.db.prepare('INSERT INTO delegation_runs(run_id, delegation_id, scope_revision) VALUES (?, ?, ?)').run(runId, id, revision)
  }

  getDelegationForRun(runId: string): Delegation | null {
    const row = this.getDelegationRun(runId)
    return row ? this.getDelegation(row.delegationId) : null
  }

  getLatestDelegationTask(id: string): StoredTask | null {
    const row = this.db.prepare('SELECT t.id FROM tasks t JOIN delegation_runs d ON d.run_id = t.id WHERE d.delegation_id = ? ORDER BY t.created_at DESC, t.rowid DESC LIMIT 1').get(id) as { id: string } | undefined
    return row ? this.getTask(row.id) : null
  }

  getDelegationRun(runId: string): { delegationId: string; scopeRevision: number } | null {
    return this.db.prepare('SELECT delegation_id AS delegationId, scope_revision AS scopeRevision FROM delegation_runs WHERE run_id = ?').get(runId) as { delegationId: string; scopeRevision: number } | undefined ?? null
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Task operations
  // ──────────────────────────────────────────────────────────────────────────────

  createTask(task: Omit<StoredTask, 'createdAt' | 'startedAt' | 'endedAt' | 'continuationOf' | 'assistantMessageId'> & { continuationOf?: string | null; assistantMessageId?: string | null }, association?: { delegationId: string; scopeRevision: number }): void {
    if (association) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const delegation = this.getDelegation(association.delegationId)
        if (!delegation || delegation.conversationId !== task.conversationId || delegation.status !== 'active' || delegation.resumeRequired || delegation.revision !== association.scopeRevision) throw new Error('委托范围已失效。')
        this.createTask(task)
        this.attachDelegationRun(delegation.id, task.id, association.scopeRevision)
        this.db.exec('COMMIT')
        return
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
    }
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO tasks (id, conversation_id, request_id, generation, status, service_id, model_id, config_revision, created_at, continuation_of, assistant_message_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id,
      task.conversationId,
      task.requestId,
      task.generation,
      task.status,
      task.serviceId,
      task.modelId,
      task.configRevision,
      now,
      task.continuationOf ?? null,
      task.assistantMessageId ?? null
    )
  }

  updateTaskStatus(id: string, status: TaskStatus, error: string | null = null): void {
    const now = new Date().toISOString()
    if (status === 'running') {
      this.db.prepare('UPDATE tasks SET status = ?, started_at = ? WHERE id = ?').run(status, now, id)
    } else if (['completed', 'stopped', 'failed', 'interrupted'].includes(status)) {
      this.db.prepare('UPDATE tasks SET status = ?, ended_at = ?, error = ? WHERE id = ?')
        .run(status, now, error, id)
    } else {
      this.db.prepare('UPDATE tasks SET status = ?, error = ? WHERE id = ?').run(status, error, id)
    }
  }

  getTask(id: string): StoredTask | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any
    if (!row) return null
    return {
      id: row.id,
      conversationId: row.conversation_id,
      requestId: row.request_id,
      generation: row.generation,
      status: row.status,
      serviceId: row.service_id,
      modelId: row.model_id,
      configRevision: row.config_revision,
      createdAt: new Date(row.created_at),
      startedAt: row.started_at ? new Date(row.started_at) : null,
      endedAt: row.ended_at ? new Date(row.ended_at) : null,
      error: row.error,
      continuationOf: row.continuation_of ?? null,
      assistantMessageId: row.assistant_message_id ?? null
    }
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Action ledger
  // ──────────────────────────────────────────────────────────────────────────────

  /** Throws on a repeated (task, call), so one known call can never be dispatched twice. */
  insertToolCall(row: { taskId: string; callId: string; toolName: string; args: string; effect: string; target: string }): void {
    this.db.prepare(`INSERT INTO tool_calls (id, task_id, call_id, tool_name, arguments, effect, target, status, dispatch_phase, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'none', ?)`)
      .run(randomUUID(), row.taskId, row.callId, row.toolName, row.args, row.effect, row.target, new Date().toISOString())
  }

  hasConsumedExactMessage(intentId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM exact_message_consumptions WHERE intent_id = ?').get(intentId)
  }

  /** The one-shot authority and the existing action ledger row commit together, or neither exists. */
  consumeExactMessage(intentId: string, action: ActionDescriptor, call: { runId: string; callId: string; toolName: string; args: Record<string, unknown> }): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const task = this.getTask(call.runId), binding = task && this.getDelegationInput(task.requestId)
      const run = this.getDelegationRun(call.runId), delegation = this.getDelegation(action.delegationId)
      if (!task || task.status !== 'running' || task.conversationId !== action.conversationId || binding?.intentId !== intentId ||
        binding.delegationId !== action.delegationId || run?.delegationId !== action.delegationId || run.scopeRevision !== action.scopeRevision ||
        !delegation || delegation.status !== 'active' || delegation.resumeRequired || delegation.revision !== action.scopeRevision ||
        action.intentId !== intentId || action.id !== call.callId || this.isTargetQuarantined(action.targetId)) throw new Error('消息运行或目标已失效。')
      this.db.prepare('INSERT INTO exact_message_consumptions(intent_id, task_id, call_id) VALUES (?, ?, ?)').run(intentId, call.runId, call.callId)
      this.insertToolCall({ taskId: call.runId, callId: call.callId, toolName: call.toolName, args: JSON.stringify(call.args), effect: action.effect, target: action.targetId })
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  updateToolCall(taskId: string, callId: string, patch: { status?: string; phase?: string; dispatched?: boolean; result?: string; error?: string }): void {
    const now = new Date().toISOString(), done = patch.status !== undefined && !['pending', 'running'].includes(patch.status)
    this.db.prepare(`UPDATE tool_calls SET status = COALESCE(?, status), dispatch_phase = COALESCE(?, dispatch_phase),
      dispatched_at = CASE WHEN ? THEN COALESCE(dispatched_at, ?) ELSE dispatched_at END,
      result = COALESCE(?, result), error = COALESCE(?, error), completed_at = CASE WHEN ? THEN ? ELSE completed_at END
      WHERE task_id = ? AND call_id = ?`)
      .run(patch.status ?? null, patch.phase ?? null, patch.dispatched ? 1 : 0, now, patch.result ?? null, patch.error ?? null, done ? 1 : 0, now, taskId, callId)
  }

  getToolCall(taskId: string, callId: string): { status: string; dispatchPhase: string; target: string; effect: string } | null {
    const row = this.db.prepare('SELECT status, dispatch_phase, target, effect FROM tool_calls WHERE task_id = ? AND call_id = ?').get(taskId, callId) as any
    return row ? { status: row.status, dispatchPhase: row.dispatch_phase, target: row.target, effect: row.effect } : null
  }

  /** Calls that never reached a final status, e.g. after a crash. */
  listUnsettledToolCalls(): { taskId: string; callId: string; target: string; effect: string; dispatchPhase: string; dispatchedAt: string | null; conversationId: string }[] {
    return (this.db.prepare(`SELECT c.task_id, c.call_id, c.target, c.effect, c.dispatch_phase, c.dispatched_at, t.conversation_id
      FROM tool_calls c JOIN tasks t ON t.id = c.task_id WHERE c.status IN ('pending', 'running')`).all() as any[])
      .map(row => ({ taskId: row.task_id, callId: row.call_id, target: row.target, effect: row.effect, dispatchPhase: row.dispatch_phase, dispatchedAt: row.dispatched_at, conversationId: row.conversation_id }))
  }

  /** Called after the call was already settled abnormally: keeps the status, records what eventually came back. */
  auditLateResult(taskId: string, callId: string, result: string): void {
    this.db.prepare(`UPDATE tool_calls SET result = COALESCE(result, ?) WHERE task_id = ? AND call_id = ?`).run(result, taskId, callId)
  }

  /** Calls whose outcome is unknown or still in flight; they stop a queue from running on. */
  listOpenToolCalls(taskId: string): { callId: string; toolName: string; target: string; status: string; resolution: 'handled' | 'abandoned' | null }[] {
    return (this.db.prepare(`SELECT call_id, tool_name, target, status, resolution FROM tool_calls WHERE task_id = ? AND status IN ('unknown', 'running') ORDER BY created_at, rowid`).all(taskId) as any[])
      .map(row => ({ callId: row.call_id, toolName: row.tool_name, target: row.target, status: row.status, resolution: row.resolution ?? null }))
  }

  /** Identifies one exact state of one unknown call, so a decision made on a stale screen cannot apply to a different state. */
  private unknownRevision(row: { task_id: string; call_id: string; created_at: string; dispatched_at: string | null }): string {
    return createHash('sha256').update(JSON.stringify([row.task_id, row.call_id, row.created_at, row.dispatched_at])).digest('hex').slice(0, 32)
  }

  /** Unknown outcomes in this conversation that nobody has decided about yet, oldest first. */
  listUnresolvedToolCalls(conversationId: string): UnknownToolCall[] {
    return (this.db.prepare(`SELECT c.* FROM tool_calls c JOIN tasks t ON t.id = c.task_id
      WHERE t.conversation_id = ? AND c.status = 'unknown' AND c.resolution IS NULL ORDER BY c.created_at, c.rowid`).all(conversationId) as any[])
      .map(row => ({ runId: row.task_id, callId: row.call_id, revision: this.unknownRevision(row),
        summary: `结果未知：${row.tool_name}（目标 ${row.target}）`,
        ...(row.dispatch_phase === 'none' ? {} : { dispatchPhase: row.dispatch_phase as UnknownToolCall['dispatchPhase'] }) }))
  }

  /**
   * Records a person's decision about one unknown call and returns its target. Fails, changing nothing, if the call is not
   * this conversation's, is not unknown, was already decided, or the revision no longer matches. The call stays 'unknown'.
   */
  resolveToolCall(input: { conversationId: string; runId: string; callId: string; revision: string; decision: 'handled' | 'abandoned' }): string {
    const row = this.db.prepare(`SELECT c.* FROM tool_calls c JOIN tasks t ON t.id = c.task_id
      WHERE c.task_id = ? AND c.call_id = ? AND t.conversation_id = ?`).get(input.runId, input.callId, input.conversationId) as any
    if (!row || row.status !== 'unknown' || row.resolution !== null || this.unknownRevision(row) !== input.revision) {
      throw new Error('这个未知动作已经变化或已处理，请刷新任务后再试。')
    }
    const changed = this.db.prepare(`UPDATE tool_calls SET resolution = ?, resolved_at = ? WHERE task_id = ? AND call_id = ? AND status = 'unknown' AND resolution IS NULL`)
      .run(input.decision, new Date().toISOString(), input.runId, input.callId).changes
    if (Number(changed) !== 1) throw new Error('这个未知动作已经变化或已处理，请刷新任务后再试。')
    return row.target as string
  }

  countToolCalls(taskId: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM tool_calls WHERE task_id = ?').get(taskId) as { n: number }).n)
  }

  /** Unknown outcomes on this target that no one has decided about, in any conversation. */
  countUnresolvedUnknownOnTarget(target: string): number {
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM tool_calls WHERE target = ? AND status = 'unknown' AND resolution IS NULL`).get(target) as { n: number }).n)
  }

  getToolCallRecord(taskId: string, callId: string): { status: string; result: string | null; resolution: string | null } | null {
    const row = this.db.prepare('SELECT status, result, resolution FROM tool_calls WHERE task_id = ? AND call_id = ?').get(taskId, callId) as any
    return row ? { status: row.status, result: row.result ?? null, resolution: row.resolution ?? null } : null
  }

  /** The conversation's newest task, whatever state it ended in. */
  getLatestTask(conversationId: string): StoredTask | null {
    const row = this.db.prepare('SELECT id FROM tasks WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(conversationId) as { id: string } | undefined
    return row ? this.getTask(row.id) : null
  }

  /** The attempt that continued this task, if any; a task is continued at most once. */
  getContinuation(taskId: string): string | null {
    const row = this.db.prepare('SELECT id FROM tasks WHERE continuation_of = ?').get(taskId) as { id: string } | undefined
    return row?.id ?? null
  }

  saveDraftFragment(taskId: string, type: string, content: string): void {
    this.db.prepare('INSERT INTO draft_fragments (task_id, fragment_type, content, created_at) VALUES (?, ?, ?, ?)').run(taskId, type, content, new Date().toISOString())
  }

  listDraftFragments(taskId: string): { type: string; content: string }[] {
    return (this.db.prepare('SELECT fragment_type, content FROM draft_fragments WHERE task_id = ? ORDER BY created_at, rowid').all(taskId) as any[])
      .map(row => ({ type: row.fragment_type, content: row.content }))
  }

  quarantineTarget(target: string, conversationId: string, taskId: string, callId: string): void {
    this.db.prepare(`INSERT INTO target_quarantine (target, conversation_id, task_id, call_id, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(target) DO UPDATE SET conversation_id = excluded.conversation_id, task_id = excluded.task_id, call_id = excluded.call_id,
        created_at = excluded.created_at, resolved_at = NULL, resolution = NULL`)
      .run(target, conversationId, taskId, callId, new Date().toISOString())
  }

  isTargetQuarantined(target: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM target_quarantine WHERE target = ? AND resolved_at IS NULL').get(target)
  }

  isTargetRecovered(target: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM target_quarantine WHERE target = ? AND resolved_at IS NOT NULL').get(target)
  }

  listQuarantinedTargets(): string[] {
    return (this.db.prepare('SELECT target FROM target_quarantine WHERE resolved_at IS NULL ORDER BY target').all() as { target: string }[]).map(row => row.target)
  }

  releaseTarget(target: string, resolution: string): boolean {
    return Number(this.db.prepare('UPDATE target_quarantine SET resolved_at = ?, resolution = ? WHERE target = ? AND resolved_at IS NULL')
      .run(new Date().toISOString(), resolution, target).changes) > 0
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Tool image artifacts
  // ──────────────────────────────────────────────────────────────────────────────

  beginArtifactFiles(id: string, conversationId: string): void {
    if (!/^[a-f0-9-]{36}$/.test(id) || !this.hasConversation(conversationId)) throw new Error('图片所属对话已失效。')
    this.db.prepare('INSERT INTO artifact_owners(id, conversation_id) VALUES (?, ?)').run(id, conversationId)
  }

  listArtifactOwners(conversationId: string): { id: string; published: number }[] {
    return this.db.prepare('SELECT id, published FROM artifact_owners WHERE conversation_id = ?').all(conversationId) as { id: string; published: number }[]
  }

  forgetArtifactFiles(id: string): void { this.db.prepare('DELETE FROM artifact_owners WHERE id = ?').run(id) }

  saveArtifact(reference: ArtifactReference): void {
    if (!this.hasConversation(reference.conversationId) ||
        !this.db.prepare('SELECT id FROM artifact_owners WHERE id = ? AND conversation_id = ? AND published = 0').get(reference.id, reference.conversationId)) {
      throw new Error('图片清理记录已失效。')
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('INSERT INTO tool_artifacts (id, conversation_id, mime_type, byte_length, source_file_id) VALUES (?, ?, ?, ?, ?)')
        .run(reference.id, reference.conversationId, reference.mimeType, reference.byteLength, reference.sourceFileId ?? null)
      this.db.prepare('UPDATE artifact_owners SET published = 1 WHERE id = ?').run(reference.id)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  getArtifact(id: string): ArtifactReference | null {
    const row = this.db.prepare(`SELECT id, conversation_id AS conversationId, mime_type AS mimeType,
      byte_length AS byteLength, source_file_id AS sourceFileId FROM tool_artifacts WHERE id = ?`).get(id) as any
    if (!row) return null
    const { sourceFileId, ...reference } = row
    return { ...reference, ...(sourceFileId !== null ? { sourceFileId } : {}) } as ArtifactReference
  }

  /** Removes an image's bytes; preserveUnpublished keeps an owner whose write may still be in flight. */
  private removeArtifactFiles(ids: string[], preserveUnpublished = false): void {
    for (const id of ids) {
      if (!this.artifactDirectory || !/^[a-f0-9-]{36}$/.test(id)) throw new Error(ARTIFACT_CLEANUP_ERROR)
      try { unlinkSync(join(this.artifactDirectory, id)) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(ARTIFACT_CLEANUP_ERROR) }
      if (!preserveUnpublished || this.db.prepare('SELECT published FROM artifact_owners WHERE id = ?').get(id)?.published === 1) this.forgetArtifactFiles(id)
    }
  }

  /** Removes the image file of an unpublished or orphaned owner; a failure keeps the owner so it is retried. */
  private recoverArtifactFiles(): void {
    const owners = this.db.prepare('SELECT id FROM artifact_owners WHERE published = 0 OR conversation_id NOT IN (SELECT id FROM conversations)').all() as { id: string }[]
    for (const owner of owners) {
      try { this.removeArtifactFiles([owner.id]) }
      catch { this.artifactCleanupWarning = ARTIFACT_CLEANUP_ERROR }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Document extraction cache
  // ──────────────────────────────────────────────────────────────────────────────

  beginDocumentFiles(id: string, conversationId: string): void {
    if (!/^[a-f0-9-]{36}$/.test(id) || !this.hasConversation(conversationId)) throw new Error('文档所属对话已失效。')
    this.db.prepare('INSERT INTO document_owners(id, conversation_id) VALUES (?, ?)').run(id, conversationId)
  }

  listDocumentOwners(conversationId: string): { id: string; published: number }[] {
    return this.db.prepare('SELECT id, published FROM document_owners WHERE conversation_id = ?').all(conversationId) as { id: string; published: number }[]
  }

  forgetDocumentFiles(id: string): void { this.db.prepare('DELETE FROM document_owners WHERE id = ?').run(id) }

  saveDocument(value: StoredDocument): void {
    if (!this.db.prepare('SELECT id FROM document_owners WHERE id = ? AND conversation_id = ?').get(value.reference.id, value.conversationId)) throw new Error('文档清理记录已失效。')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('INSERT INTO documents(id, conversation_id, file_id, cache_key, data) VALUES (?, ?, ?, ?, ?)')
        .run(value.reference.id, value.conversationId, value.reference.fileId, value.cacheKey, JSON.stringify(value))
      this.db.prepare('UPDATE document_owners SET published = 1 WHERE id = ?').run(value.reference.id)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  getDocument(id: string): StoredDocument | null {
    const row = this.db.prepare('SELECT data FROM documents WHERE id = ?').get(id) as { data: string } | undefined
    return row ? JSON.parse(row.data) as StoredDocument : null
  }

  findDocument(conversationId: string, cacheKey: string): StoredDocument | null {
    const row = this.db.prepare('SELECT data FROM documents WHERE conversation_id = ? AND cache_key = ? ORDER BY rowid DESC LIMIT 1').get(conversationId, cacheKey) as { data: string } | undefined
    return row ? JSON.parse(row.data) as StoredDocument : null
  }

  private documentIds(conversationId: string): string[] {
    return this.listDocumentOwners(conversationId).map(row => row.id)
  }

  /** Removes a document's cache files; a failure keeps the owner so recovery or purge can retry. */
  private removeDocumentFiles(ids: string[], preserveUnpublished = false): void {
    const cache = new DocumentCache(this.documentDirectory)
    for (const id of ids) {
      cache.removeSync(id)
      if (!preserveUnpublished || this.db.prepare('SELECT published FROM document_owners WHERE id = ?').get(id)?.published === 1) this.forgetDocumentFiles(id)
    }
  }

  private recoverDocumentFiles(): void {
    const owners = this.db.prepare('SELECT id FROM document_owners WHERE published = 0 OR conversation_id NOT IN (SELECT id FROM conversations)').all() as { id: string }[]
    for (const owner of owners) {
      try { this.removeDocumentFiles([owner.id]) }
      catch { this.documentCleanupWarning = DOCUMENT_CLEANUP_ERROR }
    }
  }

  /**
   * Task 3.6: Record token usage for a task. Usage comes from Pi's assistant message
   * or is marked as estimated when unavailable.
   */
  recordUsage(taskId: string, input: number | null, output: number | null, estimated: boolean): void {
    this.db.prepare(`
      INSERT INTO task_usage (task_id, input_tokens, output_tokens, estimated)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        estimated = excluded.estimated
    `).run(taskId, input, output, estimated ? 1 : 0)
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Settings operations
  // ──────────────────────────────────────────────────────────────────────────────

  getSettings(): DesktopSettings {
    const row = this.db.prepare('SELECT value FROM settings WHERE id = 1').get() as { value: string } | undefined
    return {
      activeProfileId: null, shortcut: 'CommandOrControl+Shift+H',
      stopShortcut: 'CommandOrControl+Shift+Escape', launchAtLogin: false, appearance: 'light',
      ...(row ? JSON.parse(row.value) : {})
    }
  }

  saveSettings(settings: DesktopSettings): void {
    this.db.prepare('INSERT OR REPLACE INTO settings (id, value) VALUES (1, ?)').run(JSON.stringify(settings))
  }

  // Alias for backwards compatibility
  setSettings(settings: DesktopSettings): void {
    this.saveSettings(settings)
  }

  /** Set when start-up could not remove an unpublished or orphaned tool image. */
  artifactCleanupWarning?: string

  /** Set when start-up could not remove an unpublished or orphaned document cache entry. */
  documentCleanupWarning?: string

  // ──────────────────────────────────────────────────────────────────────────────
  // Profile/Service operations (for backwards compatibility with ProfileService)
  // ──────────────────────────────────────────────────────────────────────────────

  listProfiles(): StoredProfile[] {
    return this.listServices()
  }

  getProfile(id: string): StoredProfile | null {
    return this.getService(id)
  }

  saveProfile(profile: StoredProfile): void {
    this.saveService(profile)
  }

  /** Deleting the selected service leaves nothing selected; it never picks another one on the user's behalf. */
  deleteProfile(id: string): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.deleteService(id)
      const settings = this.getSettings()
      if (settings.activeProfileId === id) this.saveSettings({ ...settings, activeProfileId: null })
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // MCP service operations (aliases for backwards compatibility)
  // ──────────────────────────────────────────────────────────────────────────────

  listMcpServices(): StoredMcpService[] {
    return (this.db.prepare('SELECT * FROM mcp_services WHERE config IS NOT NULL ORDER BY rowid').all() as unknown as McpServiceRow[])
      .map(row => this.mcpService(row))
  }

  getMcpService(id: string): StoredMcpService | undefined {
    const row = this.db.prepare('SELECT * FROM mcp_services WHERE id = ? AND config IS NOT NULL').get(id) as unknown as McpServiceRow | undefined
    return row && this.mcpService(row)
  }

  private mcpService(row: McpServiceRow): StoredMcpService {
    return { id: row.id, revision: row.revision, config: JSON.parse(row.config) as McpServiceConfig, sealedSecrets: row.sealed_secrets }
  }

  saveMcpService(service: StoredMcpService, expectedRevision?: number): boolean {
    const { config, sealedSecrets } = service
    if (expectedRevision === undefined) {
      return this.db.prepare('INSERT INTO mcp_services (id, revision, config, sealed_secrets) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING')
        .run(config.id, config.revision, JSON.stringify(config), sealedSecrets).changes === 1
    }
    return this.db.prepare(`UPDATE mcp_services SET revision = ?, config = ?, sealed_secrets = ?, test_result = NULL
      WHERE id = ? AND revision = ? AND config IS NOT NULL`)
      .run(config.revision, JSON.stringify(config), sealedSecrets, config.id, expectedRevision).changes === 1
  }

  removeMcpService(id: string): number | undefined {
    const row = this.db.prepare(`UPDATE mcp_services SET revision = revision + 1, config = NULL,
      sealed_secrets = NULL, test_result = NULL WHERE id = ? AND config IS NOT NULL RETURNING revision`)
      .get(id) as { revision: number } | undefined
    return row?.revision
  }

  recordMcpTest(id: string, expectedRevision: number, result: ConnectionTestResult): boolean {
    return this.db.prepare(`UPDATE mcp_services SET test_result = ? WHERE id = ? AND revision = ?
      AND config IS NOT NULL AND json_extract(config, '$.enabled') = 1`)
      .run(JSON.stringify(result), id, expectedRevision).changes === 1
  }

  getMcpTest(id: string, expectedRevision: number): ConnectionTestResult | undefined {
    const row = this.db.prepare(`SELECT test_result FROM mcp_services WHERE id = ? AND revision = ?
      AND config IS NOT NULL AND json_extract(config, '$.enabled') = 1`).get(id, expectedRevision) as { test_result: string | null } | undefined
    return row?.test_result ? JSON.parse(row.test_result) as ConnectionTestResult : undefined
  }

  close(): void {
    this.db.close()
  }
}
