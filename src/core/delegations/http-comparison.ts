import { createHash, randomUUID } from 'node:crypto'
import type { HerStore } from '../storage/store'
import type { ToolExecutionContext } from '../tools/types'
import type { CompletionProof, Delegation, DelegationProposal, DelegationScope, UserIntent } from './types'

interface ComparisonPage { name: string; url: string }
interface ComparisonRequest { pages: ComparisonPage[]; queries: string[] }
interface HttpComparisonOptions {
  available: () => boolean
  serviceRevision: (id: string) => string | null
}
/** C provenance: each artifact/delivery references immutable receipt IDs; deleting a receipt invalidates its descendants. */
export interface HttpEvidence {
  id: string
  delegationId: string
  scopeRevision: number
  intentId: string
  kind: 'receipt' | 'table' | 'delivery'
  runId: string
  createdAt: string
  refs: string[]
  url?: string
  finalUrl?: string
  title?: string
  excerpt?: string
  contentHash: string
  retrievalMethod?: 'request'
  adapterId?: string
  adapterRevision?: string
  providerId?: string
  callId?: string
  payloadHash?: string
  markdown?: string
  messageId?: string
}
const completion = '交付三家酒店公开页面的来源对照表'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const cell = (value: string) => value.replace(/[\r\n\t]+/g, ' ').replaceAll('|', '\\|').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const whitespace = (value: string) => value.replace(/\r\n/g, '\n').split('\n').map(line => line.trim()).join('\n').trim()

/** Deliberately narrow literal request grammar. The model proposal never supplies authority. */
function parseRequest(text: string): ComparisonRequest | null {
  const lines = text.trim().split(/\r?\n/)
  if (!/^(?:请|帮我)比较下面三家酒店的公开页面[，,]整理来源对照表[：:]$/.test(lines[0]) || lines.length < 4 || lines.length > 5) return null
  const pages: ComparisonPage[] = []
  for (const line of lines.slice(1, 4)) {
    const match = /^([^\s<>|]{1,60})\s+(https:\/\/\S+)$/.exec(line)
    if (!match) return null
    try {
      const url = new URL(match[2])
      if (url.username || url.password || url.hash || url.search || url.hostname === 'localhost' || !url.hostname.includes('.') || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':')) return null
      pages.push({ name: match[1], url: url.href })
    } catch { return null }
  }
  if (new Set(pages.map(page => page.url)).size !== 3 || new Set(pages.map(page => page.name)).size !== 3) return null
  const queries: string[] = []
  if (lines[4]) {
    const query = /^搜索词[：:]“([^”\r\n]{1,200})”$/.exec(lines[4])
    if (!query) return null
    queries.push(query[1])
  }
  return { pages, queries }
}
function scopeFor(request: ComparisonRequest): DelegationScope {
  return { purpose: '比较三家酒店公开页面的来源', objects: [...request.pages.map(page => page.url), ...request.queries.map(query => `search:${query}`)],
    completion, allowedCapabilities: ['http.read', ...(request.queries.length ? ['web.search'] : [])],
    origins: [...new Set(request.pages.map(page => new URL(page.url).origin)), ...(request.queries.length ? ['https://cn.bing.com'] : [])],
    constraints: { renderMode: 'request', redirectPolicy: 'error' } }
}

export class HttpComparison {
  constructor(private readonly store: HerStore, private readonly options: HttpComparisonOptions) {}

  resolveScope = (intent: UserIntent, _proposal: DelegationProposal): { scope: DelegationScope } | null => {
    const stored = this.store.getUserIntent(intent.id)
    if (!this.options.available() || !stored || stored.text !== intent.text || stored.messageId !== intent.messageId || stored.conversationId !== intent.conversationId) return null
    const request = parseRequest(stored.text)
    return request ? { scope: scopeFor(request) } : null
  }

  revalidate = (delegation: Delegation): boolean => {
    if (!this.options.available()) return false
    const control = this.store.listDelegationControls().find(control => control.delegationId === delegation.id)
    const intent = control && this.store.getUserIntent(control.intentId)
    const request = intent && parseRequest(intent.text)
    return !!request && JSON.stringify(scopeFor(request)) === JSON.stringify(delegation.scope)
  }

  private request(delegation: Delegation): { request: ComparisonRequest; intentId: string } | null {
    if (!this.revalidate(delegation)) return null
    const control = this.store.listDelegationControls().find(control => control.delegationId === delegation.id)!
    return { request: parseRequest(this.store.getUserIntent(control.intentId)!.text)!, intentId: control.intentId }
  }

  private markdown(request: ComparisonRequest, receipts: HttpEvidence[]): string {
    return '| 酒店 | 页面标题 | 来源摘录 | 来源 URL |\n| --- | --- | --- | --- |\n' + receipts.map((receipt, index) =>
      `| ${cell(request.pages[index].name)} | ${cell(receipt.title || '未提供标题')} | ${cell(receipt.excerpt || '未提供摘录')} | ${receipt.url} |`).join('\n')
  }

  private validReceipt(value: HttpEvidence, delegation: Delegation, intentId: string): boolean {
    const run = this.store.getDelegationRun(value.runId)
    return value.kind === 'receipt' && value.intentId === intentId && value.retrievalMethod === 'request' && value.url === value.finalUrl &&
      !!value.providerId && this.options.serviceRevision(value.providerId) === value.adapterRevision && !!value.adapterId && !!value.contentHash &&
      run?.delegationId === delegation.id && run.scopeRevision === delegation.revision
  }

  private table(delegation: Delegation): HttpEvidence | undefined {
    const bound = this.request(delegation)
    if (!bound) return undefined
    const all = this.store.listHttpEvidence(delegation.id, delegation.revision)
    return all.findLast(value => {
      if (value.kind !== 'table' || value.intentId !== bound.intentId || !value.markdown || hash(value.markdown) !== value.contentHash || value.refs.length !== 3) return false
      const receipts = value.refs.map(id => all.find(receipt => receipt.id === id))
      if (!receipts.every((receipt, index) => receipt && receipt.url === bound.request.pages[index].url && this.validReceipt(receipt, delegation, bound.intentId))) return false
      return this.markdown(bound.request, receipts as HttpEvidence[]) === value.markdown
    })
  }

  /** Only the compiled HTTP adapter calls this after validating the actual request-mode result. */
  recordRead(context: ToolExecutionContext, result: Record<string, unknown>): string | undefined {
    const action = context.action, delegation = context.delegationId && this.store.getDelegation(context.delegationId)
    if (!delegation || !action || delegation.status !== 'active' || delegation.resumeRequired || delegation.revision !== action.scopeRevision) return undefined
    const bound = this.request(delegation), run = this.store.getDelegationRun(context.runId)
    if (!bound || run?.delegationId !== delegation.id || run.scopeRevision !== delegation.revision || action.capability !== 'http.read' || action.opaque ||
      !action.providerId || this.options.serviceRevision(action.providerId) !== action.adapterRevision || !bound.request.pages.some(page => page.url === result.url) ||
      result.url !== action.targetId || result.finalUrl !== result.url || result.retrievalMethod !== 'request' || typeof result.content !== 'string' || !result.content.trim()) return undefined
    context.signal.throwIfAborted()
    const common = { delegationId: delegation.id, scopeRevision: delegation.revision, intentId: bound.intentId, runId: context.runId, createdAt: new Date().toISOString() }
    this.store.saveHttpEvidence({ ...common, id: randomUUID(), kind: 'receipt', refs: [], url: String(result.url), finalUrl: String(result.finalUrl),
      title: typeof result.title === 'string' ? result.title.slice(0, 200) : '', excerpt: result.content.trim().slice(0, 400), contentHash: hash(result.content), retrievalMethod: 'request',
      adapterId: action.adapterId, adapterRevision: action.adapterRevision, providerId: action.providerId, callId: context.callId, payloadHash: action.payloadHash })
    const all = this.store.listHttpEvidence(delegation.id, delegation.revision)
    const receipts = bound.request.pages.map(page => all.findLast(value => value.url === page.url && this.validReceipt(value, delegation, bound.intentId)))
    if (receipts.some(value => !value)) return undefined
    const markdown = this.markdown(bound.request, receipts as HttpEvidence[])
    this.store.saveHttpEvidence({ ...common, id: randomUUID(), kind: 'table', refs: receipts.map(value => value!.id), markdown, contentHash: hash(markdown) })
    return markdown
  }

  /** Only Host supplies a persisted final Pi assistant entry; model success labels never call this. */
  recordDelivery = (delegation: Delegation, runId: string, messageId: string, text: string): void => {
    const table = this.table(delegation), run = this.store.getDelegationRun(runId)
    if (!table?.markdown || !messageId || run?.delegationId !== delegation.id || run.scopeRevision !== delegation.revision ||
      this.store.getTask(runId)?.status !== 'completed' || !whitespace(text).includes(whitespace(table.markdown))) return
    this.store.saveHttpEvidence({ id: randomUUID(), kind: 'delivery', delegationId: delegation.id, scopeRevision: delegation.revision, intentId: table.intentId,
      runId, messageId, createdAt: new Date().toISOString(), refs: [table.id], contentHash: hash(text) })
  }

  /** Reads intentionally have no mutation-ledger row. Count only this producer's immutable observed receipts. */
  getVerifiedReadCount(delegation: Delegation): number {
    const proof = this.store.getDelegationProof(delegation.id)
    const revision = delegation.status === 'completed' ? proof?.scopeRevision : delegation.revision
    if (!revision || (delegation.status === 'completed' && (proof?.delegationId !== delegation.id ||
      proof.condition !== delegation.scope.completion || revision !== delegation.revision - 1))) return 0
    const observed = { ...delegation, revision, status: 'active' as const, resumeRequired: false }
    const bound = this.request(observed)
    if (!bound) return 0
    if (delegation.status === 'completed' && this.validateCompletion(observed)?.evidenceId !== proof?.evidenceId) return 0
    const calls = new Set<string>()
    for (const receipt of this.store.listHttpEvidence(delegation.id, revision)) {
      if (receipt.delegationId !== delegation.id || receipt.scopeRevision !== revision || !receipt.callId || receipt.refs.length ||
        !/^[a-f0-9]{64}$/.test(receipt.payloadHash ?? '') || !/^[a-f0-9]{64}$/.test(receipt.contentHash) ||
        !bound.request.pages.some(page => page.url === receipt.url) || !this.validReceipt(receipt, observed, bound.intentId)) continue
      calls.add(JSON.stringify([receipt.runId, receipt.callId]))
    }
    return calls.size
  }

  validateCompletion = (delegation: Delegation): CompletionProof | null => {
    if (delegation.status !== 'active' || delegation.resumeRequired) return null
    const table = this.table(delegation)
    if (!table) return null
    const delivery = this.store.listHttpEvidence(delegation.id, delegation.revision).findLast(value => value.kind === 'delivery' && value.refs[0] === table.id && value.messageId &&
      this.store.getTask(value.runId)?.status === 'completed' && this.store.getDelegationRun(value.runId)?.scopeRevision === delegation.revision)
    return delivery ? { delegationId: delegation.id, scopeRevision: delegation.revision, condition: completion, evidenceId: delivery.id } : null
  }
}
