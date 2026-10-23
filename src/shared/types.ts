export type ProviderProtocol = 'openai' | 'anthropic' | 'openai-responses'
export type TestKind = 'chat' | 'tools' | 'vision'

// Task 3.1: Authentication methods for services
export type AuthMethod = 'api-key' | 'headers' | 'none'

export interface ConnectionTestResult {
  status: 'untested' | 'passed' | 'failed'
  message: string
  checkedAt?: string
}

export interface CatalogModel {
  provider: string
  id: string
  name: string
  protocol: ProviderProtocol
  baseUrl: string
  contextWindow: number
  maxOutputTokens: number
  multimodal: boolean
}

export interface ServiceModel {
  catalogProvider?: string
  id: string
  longOutput: boolean
  multimodal: boolean
  tests: Record<TestKind, ConnectionTestResult>
}

// Task 3.1: Service profile supporting Pi directory models and custom compatible services
export interface ProviderProfile {
  catalogProvider?: string
  id: string
  name: string
  protocol: ProviderProtocol
  baseUrl: string
  model: string
  models: ServiceModel[]
  authMethod: AuthMethod
  hasApiKey: boolean
  hasCustomHeaders: boolean
  maxOutputTokens?: number
  /** For custom services, context window capacity is required */
  contextWindow?: number
}

export interface SaveProfileInput {
  catalogProvider?: string
  id?: string
  name: string
  protocol: ProviderProtocol
  baseUrl: string
  model: string
  models?: { id: string; longOutput?: boolean; multimodal?: boolean }[]
  authMethod: AuthMethod
  apiKey?: string
  customHeaders?: Record<string, string>
  maxOutputTokens?: number | null
  /** Required for custom services when not using Pi directory models */
  contextWindow?: number
}

export interface McpTransportConfig {
  transport: 'stdio' | 'streamable-http'
  command?: string
  args?: string[]
  cwd?: string
  url?: string
}

export interface McpServiceConfig extends McpTransportConfig {
  allowAllOperations?: boolean
  id: string
  name: string
  presetId?: string
  enabled: boolean
  revision: number
  secretKeys: string[]
  hasSecrets: boolean
}

export interface SaveMcpServiceInput extends McpTransportConfig {
  id?: string
  name: string
  presetId?: string
  enabled: boolean
  expectedRevision?: number
  secretValues?: Record<string, string>
  clearSecretKeys?: string[]
}

export interface PdfInspection {
  pageCount: number
  pages: { pageNumber: number; textStatus: 'present' | 'empty' | 'unknown' }[]
}
export type PdfRequest = { kind: 'inspect' } | { kind: 'render'; pageNumbers: number[] }
export interface PdfRenderReply {
  pages: { pageNumber: number; bytes: Uint8Array; width: number; height: number }[]
  failures: { pageNumber: number; error: string }[]
}

export interface RuntimeProvider {
  multimodal?: boolean
  id: string
  name: string
  protocol: ProviderProtocol
  baseUrl: string
  model: string
  apiKey: string
  customHeaders: Record<string, string>
  maxOutputTokens?: number
  /** Tokens the model accepts; drives compaction reserve/keepRecent. */
  contextWindow?: number
}

export interface FileGrant {
  id: string
  scope: 'conversation' | 'persistent'
  conversationId?: string
  kind: 'file' | 'directory'
  displayName: string
  revision: number
}

export interface FileReference {
  id: string
  grantId: string
  name: string
  mimeType: string
  size: number
  version: string
}

// Host-produced provenance, carried privately alongside model messages.
export interface FileSources {
  fileIds?: string[]
  grants?: { id: string; revision: number }[]
}

export interface ModelMessage {
  role: 'user' | 'assistant'
  fileSources?: FileSources
  content: string | Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }>
}

export interface ToolMessage {
  role: 'tool'
  tool_call_id: string
  content: string | ToolResult
}

export interface AssistantToolCall {
  fileSources?: FileSources
  role: 'assistant'
  content: string | null
  tool_calls: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
}

export type AnyModelMessage = ModelMessage | ToolMessage | AssistantToolCall

export interface ModelTool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface StreamChatInput {
  provider: RuntimeProvider
  system: string
  messages: AnyModelMessage[]
  signal: AbortSignal
  tools?: ModelTool[]
  forceTool?: string
  loadImage?: (id: string) => Promise<Uint8Array>
  beforeDispatch?: () => void
}

export type ProviderEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string; name: string; arguments: Record<string, unknown> }
  | { type: 'done' }

export interface TopicInfo {
  conversationId: string
  kind: 'daily' | 'work'
  shareProgress: boolean
  shareRevision: number
}

export interface TopicHandoffPreview {
  id: string
  digest: string
  sourceConversationId: string
  excerpts: { messageId: string; role: 'user' | 'assistant'; text: string; createdAt: string }[]
  receiverLabel: string
  omittedCount: number
  crossServiceReplyCount?: number
}

export interface TopicHandoffOperation {
  operationId: string
  status: 'preparing' | 'created' | 'failed'
  conversationId?: string
  errorCode?: 'source-changed' | 'receiver-changed' | 'storage-failed'
}

export interface MemorySourceRef {
  kind: 'pi-entry' | 'memory' | 'progress'
  id: string
  revision: number
  conversationId: string
  sessionId?: string
  entryId?: string
}

export interface MemorySourceDependencies {
  memorySources: MemorySourceRef[]
  fileSources: FileSources
}

export type MemoryScope = { kind: 'personal' } | { kind: 'work'; conversationId: string }

export interface MemoryRecord {
  id: string
  content: string
  revision: number
  scope: MemoryScope
  status: 'active' | 'superseded' | 'excluded'
  sources: MemorySourceRef[]
  validFrom: string
  validUntil?: string
}

export interface MemoryEntryBaseline {
  conversationId: string
  sessionId: string
  entryIds: string[]
}

export interface WorkspaceSelection {
  section: 'daily' | 'work' | 'memory'
  conversationId?: string
}

export interface PendingActionNotice {
  id: string
  status: 'waiting_approval' | 'paused' | 'unknown'
  version: number
}

export interface WorkspaceListItem {
  conversation: ConversationSummary
  topic: TopicInfo | null
}

export interface WorkspaceSnapshot {
  activeRequest?: { requestId: string; conversationId: string } | null
  selection: WorkspaceSelection
  version: number
  conversation: ConversationSummary | null
  topic: TopicInfo | null
  messages: ChatMessage[]
  task: TaskEvent | null
  workItems: WorkspaceListItem[]
}

export interface WorkspaceChatEvent {
  selectionVersion: number
  event: ChatEvent
}

export interface WorkspaceRequestEvent {
  selectionVersion: number
  event: RequestEvent
}

export interface WorkspaceTaskEvent {
  selectionVersion: number
  event: TaskEvent
}

export interface ConversationSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  lastMessage: string
  titleCustom?: boolean
}

export interface TrashedConversation extends ConversationSummary {
  cleanupPending?: boolean
  cleanupError?: string
  deletedAt: string
}

export type MessageStatus = 'complete' | 'streaming' | 'failed' | 'cancelled'

export interface MessageAttachment {
  type: 'image' | 'audio' | 'video' | 'file'
  name: string
  mimeType: string
  data: string // base64
  size: number
}

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; artifactId: string; mimeType: string }
  | { type: 'resource_link'; uri: string; name: string }

export interface ToolResult {
  fileSources?: FileSources
  content: ToolContent[]
  isError?: boolean
  structuredContent?: Record<string, unknown>
  meta?: Record<string, unknown>
  truncated?: boolean
}

export interface ArtifactReference {
  id: string
  conversationId: string
  mimeType: string
  byteLength: number
  sourceFileId?: string
}

export type DelegationStatus = 'active' | 'paused' | 'completed' | 'cancelled'

export interface TaskRun {
  delegationId?: string
  scopeRevision?: number
  id: string
  requestId: string
  conversationId: string
  assistantMessageId: string
  status: 'queued' | 'running' | 'awaiting_confirmation' | 'waiting_approval' | 'waiting_resource' | 'compacting' | 'retrying' | 'stopping' | 'paused' | 'stopped' | 'completed' | 'failed' | 'interrupted'
  providerId: string
  model: string
  toolCallsCount: number
  activeMs: number
  continuationOf?: string
  toolRevisions?: Record<string, string>
}

export interface ToolCallRecord {
  id: string
  name: string
  arguments: Record<string, unknown>
  result?: string | ToolResult
  // Optional only for records written before execution tracking was introduced.
  runId?: string
  status?: 'pending' | 'awaiting_confirmation' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'
  startedAt?: string
  finishedAt?: string
  assessment?: ActionAssessment
  dispatchPhase?: 'preflight' | 'preflight-completed' | 'action'
  resolution?: { decision: 'handled' | 'abandoned'; resolvedAt: string }
}

export interface TokenUsage {
  input: number | null
  output: number | null
}

export interface ChatMessage {
  /** Local persisted control status, not a model-authored answer. */
  hostStatus?: boolean
  interrupted?: boolean
  usage?: TokenUsage
  id: string
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  status: MessageStatus
  createdAt: string
  profileId?: string
  model?: string
  error?: string
  attachments?: MessageAttachment[]
  files?: FileReference[]
  fileSources?: FileSources
  toolCalls?: ToolCallRecord[]
}

export type Appearance = 'light' | 'dark' | 'system'

export interface DesktopSettings {
  activeProfileId: string | null
  shortcut: string
  stopShortcut: string
  launchAtLogin: boolean
  appearance: Appearance
  systemPrompt?: string
  disabledSkillIds?: string[]
}

export interface BuiltinSkill {
  id: string
  name: string
  description: string
  version: string
  sourceUrl: string
  content: string
  enabled: boolean
}

export interface BootstrapState {
  profiles: ProviderProfile[]
  dailyConversationId: string
  settings: DesktopSettings
  appVersion: string
  dataDirectory: string
}

export interface SendMessageInput {
  requestId: string
  conversationId: string
  profileId: string
  model?: string
  content: string
  retryMessageId?: string
  fileIds?: string[]
  attachmentOnly?: boolean
  attachments?: MessageAttachment[]
}

export interface SendMessageResult {
  /** Opaque priority-control identity; details remain in the original topic. */
  controlId?: string
  userMessage: ChatMessage
  assistantMessage: ChatMessage
  /** True when the conversation was busy and the message waits in the queue. */
  queued?: boolean
}

/** Why a conversation's queue is not running on by itself. */
export type QueuePauseReason = 'stopped' | 'failed' | 'limit' | 'source-revoked' | 'service-changed' | 'unknown-action' | 'compaction-stopped' | 'compaction-failed' | 'restart'

export interface QueuedInput {
  requestId: string
  userMessageId: string
  /** Start of the message, enough to recognise it in the queue. */
  preview: string
  profileId: string | null
  model: string | null
  createdAt: string
}

/** Pi's estimate of the last observed context, not cumulative billed usage. */
export interface ConversationContextUsage {
  tokens: number | null
  contextWindow: number
}

export interface CompactConversationInput {
  conversationId: string
  profileId: string
  model?: string
}

export interface ConversationQueueState {
  conversationId: string
  items: QueuedInput[]
  /** Set when the queue waits for the user instead of running on. */
  paused: QueuePauseReason | null
  running: boolean
  compacting: boolean
}

export interface ActionAssessment {
  effect: 'read' | 'interact' | 'send' | 'delete' | 'overwrite' | 'unknown'
  target: string
  displayTarget?: string
  summary: string
  observationId?: string
}

export interface ActionPreview {
  fields: { label: string; value: string }[]
  finalText?: string
  recipient?: string
  transferDestination?: string
}

export interface ApprovalRequest {
  purpose: string
  preview: ActionPreview
  dataClasses: string[]
  providerName?: string
  scopeSummary: string
  actionLabel: string
  id: string
  runId: string
  callId: string
  revision: string
  target: string
  summary: string
  allowConversation?: boolean
}

export interface ApprovalDecisionInput {
  approvalId: string
  revision: string
  decision: 'approve' | 'reject'
}

export interface UnknownToolCall {
  runId: string
  callId: string
  revision: string
  summary: string
  dispatchPhase?: ToolCallRecord['dispatchPhase']
}

export interface ResolveUnknownToolCallInput {
  conversationId: string
  runId: string
  callId: string
  revision: string
  decision: 'handled' | 'abandoned'
}

export interface TaskEvent {
  runId?: string
  seq?: number
  generation?: number
  browserAutoApproved?: boolean
  unknownCalls?: UnknownToolCall[]
  requestId: string
  conversationId: string
  run: TaskRun
  approval?: ApprovalRequest
}

export interface ContinueTaskInput {
  runId: string
  requestId: string
  profileId: string
  model?: string
}

export interface RequestEvent {
  runId?: string
  seq?: number
  generation?: number
  requestId: string
  conversationId: string
  state: 'started' | 'completed' | 'cancelled' | 'failed'
  error?: string
}

export interface ChatEvent {
  runId?: string
  seq?: number
  generation?: number
  requestId: string
  conversationId: string
  message: ChatMessage
  done: boolean
  task?: TaskEvent
}

export interface SelectFilesInput {
  conversationId: string
  kind: 'file' | 'directory'
  scope: 'conversation' | 'persistent'
}

/** Selected original work-topic cards only; never included in bootstrap or notices. */
export interface DelegationScopeView {
  purpose: string
  objects: string[]
  completion: string
  allowedCapabilities: string[]
  origins: string[]
  constraints: Record<string, string | number>
}
export interface DelegationControlRevision { id: string; revision: number }
export interface DelegationControlInput {
  conversationId: string
  controlId: string
  revision: number
}
export interface DelegationControlChoiceInput extends DelegationControlInput {
  releaseOwnedInputs?: boolean
  kind: 'pause' | 'cancel' | 'revise' | 'ordinary'
  delegationIds: string[]
  candidateRevisions?: { delegationId: string; currentRevision: number }[]
}
export interface DelegationDenialInput extends DelegationControlInput {
  delegationId: string
  scopeRevision: number
  denialId: string
}
export interface DelegationDetails {
  conversationId: string
  delegations: { id: string; revision: number; status: DelegationStatus; resumeRequired: boolean; scope: DelegationScopeView; canResume: boolean; resumeControls: DelegationControlRevision[] }[]
  scopes: { id: string; revision: number; scope: DelegationScopeView }[]
  controls: {
    id: string; revision: number; kind: 'pause' | 'cancel' | 'revise' | 'uncertain' | 'withdraw'; effect: 'mutation' | 'all' | 'budget'; budget?: number
    resolution?: 'pause' | 'cancel' | 'revise' | 'ordinary' | 'withdraw'
    hasOwnedInputs?: boolean
    candidates: { delegationId: string; scopeRevision: number; currentRevision: number; purpose: string; denials: { id: string; target: string; capability: string; businessEffect?: string; dataClasses: string[] }[] }[]
    selection?: { delegationId: string; scopeRevision: number; denialId: string }
  }[]
}

export interface HerApi {
  previewTopicHandoff(input: { conversationId: string; messageIds: string[] }): Promise<TopicHandoffPreview>
  commitTopicHandoff(input: { operationId: string; previewId: string; digest: string }): Promise<TopicHandoffOperation>
  getTopicHandoffOperation(operationId: string): Promise<TopicHandoffOperation | null>
  getDelegationDetails(conversationId: string): Promise<DelegationDetails>
  pauseDelegation(id: string, revision: number): Promise<void>
  cancelDelegation(id: string, revision: number): Promise<void>
  resumeDelegation(id: string, revision: number, controls?: DelegationControlRevision[]): Promise<void>
  approveDelegationScope(proposalId: string, revision: number): Promise<void>
  rejectDelegationScope(proposalId: string, revision: number): Promise<void>
  resolveDelegationControl(input: DelegationControlChoiceInput): Promise<void>
  prepareDelegationDenial(input: DelegationDenialInput): Promise<void>
  confirmDelegationDenial(input: DelegationControlInput): Promise<void>
  addDroppedFiles(conversationId: string, files: File[]): Promise<FileReference[]>
  listPersistentFileGrants(): Promise<FileGrant[]>
  openFileSource(input: { conversationId: string; fileId: string }): Promise<void>
  getFilePreview(input: { conversationId: string; fileId: string }): Promise<{ mimeType: string; dataUrl: string }>

  selectFiles(input: SelectFilesInput): Promise<{ grants: FileGrant[]; files: FileReference[] }>
  validateDraftFiles(input: { conversationId: string; fileIds: string[] }): Promise<{ valid: FileReference[]; invalidIds: string[] }>
  listFileGrants(conversationId: string): Promise<FileGrant[]>
  revokeFileGrant(id: string): Promise<void>
  listMcpPresets(): Promise<McpPreset[]>
  checkPresetDependencies(presetId: string, serviceId: string): Promise<DependencyCheck[]>
  createMcpPreset(presetId: string): Promise<McpServiceConfig>
  listMcpServices(): Promise<McpServiceConfig[]>
  getMcpEnvironment(id: string, expectedRevision: number): Promise<Record<string, string>>
  saveMcpService(input: SaveMcpServiceInput): Promise<McpServiceConfig>
  deleteMcpService(id: string): Promise<void>
  testMcpService(id: string): Promise<ConnectionTestResult>
  setMcpServiceEnabled(id: string, enabled: boolean, expectedRevision: number): Promise<McpServiceConfig>
  listMcpTools(id: string): Promise<ModelTool[]>
  getMcpStatus(id: string): Promise<McpConnectionStatus>
  getConversationTask(conversationId: string): Promise<TaskEvent | null>
  decideToolApproval(input: ApprovalDecisionInput): Promise<void>
  revokeConversationApprovals(conversationId: string): Promise<void>
  resolveUnknownToolCall(input: ResolveUnknownToolCallInput): Promise<TaskEvent | null>
  continueTask(input: ContinueTaskInput): Promise<SendMessageResult>
  getConversationContext(input: CompactConversationInput): Promise<ConversationContextUsage>
  getQueue(conversationId: string): Promise<ConversationQueueState>
  cancelQueuedMessage(conversationId: string, requestId: string): Promise<void>
  resumeQueue(conversationId: string): Promise<void>
  compactConversation(input: CompactConversationInput): Promise<void>
  stopCompaction(conversationId: string): Promise<void>
  switchModel(input: CompactConversationInput): Promise<void>
  onWorkspaceRequestEvent(callback: (event: WorkspaceRequestEvent) => void): () => void
  onWorkspaceTaskEvent(callback: (event: WorkspaceTaskEvent) => void): () => void
  getArtifactPreview(id: string, conversationId: string): Promise<{ mimeType: string; dataUrl: string }>
  getBootstrap(): Promise<BootstrapState>
  listModelCatalog(): Promise<CatalogModel[]>
  saveProfile(input: SaveProfileInput): Promise<ProviderProfile>
  deleteProfile(id: string): Promise<void>
  selectProfile(id: string): Promise<void>
  testProfile(id: string, kind: TestKind, model?: string): Promise<ConnectionTestResult>
  selectWorkspace(selection: WorkspaceSelection): Promise<WorkspaceSnapshot>
  listWorkItems(): Promise<WorkspaceListItem[]>
  getPendingActions(): Promise<PendingActionNotice[]>
  resolvePendingAction(input: { id: string; version: number }): Promise<{ conversationId: string } | null>
  getPendingActionOpen(): Promise<PendingActionNotice | null>
  ackPendingActionOpen(input: { id: string; version: number }): Promise<void>
  onPendingActionOpen(callback: () => void): () => void
  onPendingActions(callback: (notices: PendingActionNotice[]) => void): () => void
  createConversation(): Promise<WorkspaceSnapshot>
  renameConversation(id: string, title: string): Promise<ConversationSummary>
  trashConversation(id: string): Promise<void>
  restoreConversation(id: string): Promise<ConversationSummary>
  purgeConversation(id: string): Promise<void>
  purgeConversations(ids: string[]): Promise<void>
  listTrashedConversations(): Promise<TrashedConversation[]>
  getMessages(conversationId: string): Promise<ChatMessage[]>
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>
  cancelMessage(requestId: string): Promise<void>
  setDesktopPreferences(input: { shortcut: string; stopShortcut: string; launchAtLogin: boolean }): Promise<DesktopSettings>
  setAppearance(appearance: Appearance): Promise<DesktopSettings>
  getSystemPrompt(): Promise<string>
  listSkills(): Promise<BuiltinSkill[]>
  setSkillEnabled(id: string, enabled: boolean): Promise<BuiltinSkill[]>
  setSystemPrompt(prompt: string): Promise<void>
  getDefaultSystemPrompt(): Promise<string>
  onWorkspaceChatEvent(callback: (event: WorkspaceChatEvent) => void): () => void
  openExternal(url: string): Promise<void>
}

declare global {
  interface Window {
    her: HerApi
  }
}

export interface McpConnectionStatus {
  serviceId: string
  revision: number
  state: 'disconnected' | 'connecting' | 'ready' | 'error'
  message?: string
  toolCount: number
}

export interface DependencySetup {
  steps: string[]
  links: { label: string; url: string }[]
  command?: string
}

export interface DependencyCheck {
  component: string
  status: 'ready' | 'missing' | 'incompatible' | 'permission_required'
  message: string
  resolvedPath?: string
  version?: string
  setup?: DependencySetup
}
export interface McpPreset {
  id: string
  name: string
  version?: string
  defaultEnabled: boolean
  executable: boolean
  guidance: string
  /** Public, fixed defaults only; never include saved user credentials. */
  environmentDefaults?: Record<string, string>
}

export interface DocumentReference {
  id: string
  fileId: string
  version: string
  status: 'ready' | 'partial' | 'empty'
  parserVersion: string
}

export interface DocumentChunk {
  documentId: string
  text: string
  status: DocumentReference['status']
  notice?: string
  source: { fileId: string; name: string; section?: string; sheet?: string; pageNumber?: number }
  range: { offset: number; length: number }
  truncated: boolean
  nextCursor?: string
}
