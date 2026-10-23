import type { ActionAssessment, ActionPreview, DelegationStatus } from '../../shared/types'

export interface DelegationScope {
  purpose: string
  objects: string[]
  completion: string
  allowedCapabilities: string[]
  origins: string[]
  constraints: Record<string, string | number>
}
export interface Delegation {
  id: string
  conversationId: string
  scope: DelegationScope
  revision: number
  status: DelegationStatus
  resumeRequired: boolean
}
/** Minimal C-facing observation; private inputs, scope and tool bodies stay in their owner. */
export interface DelegationProgressEvidence {
  delegationId: string
  conversationId: string
  revision: number
  status: DelegationStatus
  pendingReason: 'approval' | 'capability' | 'unknown' | null
  /** Current validated grant only (terminal: completion proof revision), never a lifetime total; zero does not mean no prior effects. */
  completedActionCount: number
  observedAt: string
  evidenceRefs: { kind: 'user-request' | 'ledger'; id: string }[]
}
export interface UserIntent {
  id: string
  messageId: string
  conversationId: string
  text: string
  source: 'user'
  kind: 'unclassified' | 'ordinary' | 'delegate' | 'control' | 'send-exact'
  spans: [number, number][]
}
export interface DelegationProposal {
  id: string
  topicId?: string
  scope: DelegationScope
  evidenceSpans: [number, number][]
  revision: number
}
export interface CompletionProof {
  delegationId: string
  scopeRevision: number
  condition: string
  evidenceId: string
}
export interface DelegationControl {
  id: string
  intentId: string
  conversationId: string
  proposal: DelegationProposal
  revision: number
  status: 'waiting' | 'approved' | 'rejected'
  delegationId?: string
  requestId: string
  dispatch: 'pending' | 'claimed' | 'attached' | 'failed'
}
/** Only main-process assembly supplies these producers; no model/IPC fields map to them. */
export interface DelegationProducers {
  resolveScope?: (intent: UserIntent, proposal: DelegationProposal) => { scope: DelegationScope; topicId?: string } | null
  revalidate?: (delegation: Delegation) => boolean
  validateCompletion?: (delegation: Delegation) => CompletionProof | null
  /** Main-only verification of a user's explicit selection to revise one refused step. Defaults unavailable. */
  validateDenialRevision?: (delegation: Delegation, denial: DelegationDenial, intent: UserIntent, evidenceSpans: [number, number][]) => DenialRevisionProof | null
  recordDelivery?: (delegation: Delegation, runId: string, messageId: string, text: string) => void
}
/** Facts produced only by a compiled main-process adapter from the exact dispatched arguments. */
export interface ActionDescription {
  effect: ActionAssessment['effect']
  /** Stable business effect supplied by a compiled adapter, independent of transport/capability. */
  businessEffect?: string
  targetId: string
  target: string
  capability: string
  confirmation: 'scope' | 'always'
  opaque: boolean
  dataClasses: string[]
  preview: ActionPreview
  summary: string
  actionLabel: string
  origin?: string
  constraints?: Record<string, string | number>
  providerId?: string
  providerName?: string
}
export interface ActionDescriptor {
  /** Actual main-process owner, stamped by the registry even for ordinary unbound work. */
  conversationId?: string
  intentId?: string
  id: string
  delegationId: string
  scopeRevision: number
  adapterId: string
  adapterRevision: string
  effect: ActionAssessment['effect']
  /** Stable business effect supplied by a compiled adapter, independent of transport/capability. */
  businessEffect?: string
  targetId: string
  payloadHash: string
  observationId?: string
  dataClasses: string[]
  providerId?: string
  capability: string
  confirmation: 'scope' | 'always'
  opaque: boolean
  purpose?: string
  scopeSummary?: string
  target?: string
  summary?: string
  preview?: ActionPreview
  actionLabel?: string
  providerName?: string
  origin?: string
  constraints?: Record<string, string | number>
}
export type { ActionPreview } from '../../shared/types'

/** Durable refusal; optional semantic fields support already-stored exact-payload refusals fail closed. */
export interface DelegationDenial {
  id: string
  delegationId: string
  scopeRevision: number
  targetId: string
  businessEffect?: string
  effect?: ActionAssessment['effect']
  dataClasses?: string[]
  actionId?: string
  adapterId?: string
  adapterRevision?: string
  capability: string
  payloadHash: string
  withdrawal?: DenialRevisionProof
}
export interface DenialRevisionProof {
  delegationId: string
  scopeRevision: number
  denialId: string
  targetId: string
  businessEffect?: string
  effect?: ActionAssessment['effect']
  dataClasses: string[]
  intentId: string
  messageId: string
  evidenceSpans: [number, number][]
  decision: 'withdraw-denial'
}

/** Main-private priority input; candidates and selections never enter model context or notices. */
export interface PriorityControl {
  id: string
  intentId: string
  conversationId: string
  candidateIntentIds: string[]
  heldIntentIds: string[]
  candidates: { delegationId: string; revision: number }[]
  heldDelegationIds: string[]
  selectedDelegationIds?: string[]
  /** Explicit choices made in each original owner; never exposed across owners. */
  ownerResolutions?: Record<string, ControlChoice['kind'] | 'withdraw'>
  revision: number
  status: 'classifying' | 'waiting' | 'resolved' | 'ordinary'
  kind: 'pause' | 'cancel' | 'revise' | 'uncertain' | 'withdraw'
  effect: 'mutation' | 'all' | 'budget'
  targetIds?: string[]
  budget?: number
  history: 'pending' | 'written' | 'ordinary'
  profileId?: string
  model?: string
  createdAt: string
  selection?: { delegationId: string; scopeRevision: number; denialId: string; confirmed: boolean }
}
export interface ControlChoice {
  releaseOwnedInputs?: boolean
  delegationIds: string[]
  kind: 'pause' | 'cancel' | 'revise' | 'ordinary'
  scope?: DelegationScope
}
