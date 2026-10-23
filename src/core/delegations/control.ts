import { randomUUID } from 'node:crypto'
import type { TopicInfo } from '../../shared/types'
import type { HerStore } from '../storage/store'
import type { ControlChoice, Delegation, DelegationDenial, DenialRevisionProof, PriorityControl, UserIntent } from './types'

function amount(text: string): number | undefined {
  if (/^\d+(?:\.\d{1,2})?$/.test(text)) return Number(text)
  if (!/^[零一二两三四五六七八九十百千万]+$/.test(text) || /[一二两三四五六七八九]{2}|[百千万][一二两三四五六七八九]$/.test(text) ||
    /^(?:百|千|万)|万.*万|零零/.test(text) || (text.length > 1 && (/^零|零$/.test(text)))) return undefined
  const digits = '零一二三四五六七八九', units: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 }
  let total = 0, section = 0, current = 0, previousUnit = Infinity
  for (const char of text) {
    if (char === '万') { total += (section + current) * 10000; section = current = 0; previousUnit = Infinity }
    else if (char in units) {
      if (units[char] >= previousUnit) return undefined
      section += (current || 1) * units[char]; current = 0; previousUnit = units[char]
    } else current = char === '两' ? 2 : digits.indexOf(char)
  }
  return total + section + current
}

/** A bounded clause grammar, not a grant source or general natural-language classifier. */
function interpret(text: string): Pick<PriorityControl, 'kind' | 'effect' | 'budget'> & { ordinary?: boolean; recipient?: string } {
  const clause = text.trim().replace(/[。！!]+$/, '')
  if (/^(?:这句|把这句|请把这句)[“"‘'][\s\S]+[”"’'](?:怎么改写|改写一下|是什么意思)[？?]?$/.test(clause) ||
    /^(?:不用停|不要停|无需暂停|不用暂停)[，,、\s]*(?:继续|继续吧|继续做)?$/.test(clause)) return { kind: 'uncertain', effect: 'mutation', ordinary: true }
  const stop = /^(?:请|麻烦)?(?:先别|暂时别|不要|先不要|暂时不要)(?:发|发送)(?:了|出去)?(?:给(.+?))?$/.exec(clause)
  if (stop || /^(?:暂停|暂缓)(?:发送|发消息)$/.test(clause)) return { kind: 'pause', effect: 'mutation', ...(stop?.[1] ? { recipient: stop[1] } : {}) }
  if (/^(?:请)?(?:暂停|暂缓|先停下)(?:这件事|这个委托|这项工作)$/.test(clause)) return { kind: 'pause', effect: 'all' }
  if (/^(?:请)?取消(?:这件事|这个委托|这项工作)$/.test(clause)) return { kind: 'cancel', effect: 'all' }
  const budget = /^(?:请)?(?:把)?预算(?:改成|改为|调整为)([\d.零一二两三四五六七八九十百千万]+)(?:元)?$/.exec(clause)
  if (budget) return { kind: 'revise', effect: 'budget', budget: amount(budget[1]) }
  if (/^(?:明确)?(?:改为允许|重新允许|撤回拒绝)(?:这一步|刚才那一步|这一步提交资料)$/.test(clause)) return { kind: 'withdraw', effect: 'all' }
  // Uncertain control-like clauses can only hold; no keyword authorizes cancellation or revision.
  return { kind: 'uncertain', effect: 'mutation', ordinary: !/(别|暂停|暂缓|停|取消|预算|等等|等一下|再想想|撤回|重新允许)/.test(clause) }
}

export class ControlService {
  constructor(private readonly store: HerStore, private readonly preparingIntents: () => string[] = () => []) {}

  intercept(intent: UserIntent, topic: TopicInfo): { controlId?: string; heldDelegationIds: string[]; ordinary: boolean } {
    const stored = this.store.getUserIntent(intent.id), actual = this.store.getTopicInfo(topic.conversationId)
    if (!stored || stored.source !== 'user' || stored.text !== intent.text || stored.messageId !== intent.messageId ||
      stored.conversationId !== topic.conversationId || actual?.kind !== topic.kind || !this.store.hasConversation(topic.conversationId)) throw new Error('用户依据无效。')
    const candidates = this.store.listDelegations().filter(value => ['active', 'paused'].includes(value.status) && this.store.hasConversation(value.conversationId) &&
      (topic.kind === 'daily' || value.conversationId === topic.conversationId)).map(value => ({ delegationId: value.id, revision: value.revision }))
    const candidateIntentIds = [...new Set([...this.preparingIntents(), ...this.store.listPriorityCandidateIntentIds()])].filter(id => {
      const old = this.store.getUserIntent(id)
      return id !== intent.id && !!old && old.kind !== 'control' && this.store.hasConversation(old.conversationId) &&
        (topic.kind === 'daily' || old.conversationId === topic.conversationId)
    })
    if (!candidates.length && !candidateIntentIds.length) return { ordinary: true, heldDelegationIds: [] }
    let record: PriorityControl = { id: randomUUID(), intentId: intent.id, conversationId: topic.conversationId, candidates, candidateIntentIds, heldIntentIds: candidateIntentIds,
      heldDelegationIds: candidates.map(value => value.delegationId), revision: 1, status: 'classifying', kind: 'uncertain', effect: 'mutation',
      history: 'pending', createdAt: new Date().toISOString() }
    // Persist before interpreting even the first clause. Gate checks read this same durable barrier.
    this.store.savePriorityControl(record)
    const parsed = interpret(stored.text)
    if (parsed.ordinary) {
      this.store.classifyUserIntent(intent.id, 'ordinary')
      this.store.savePriorityControl({ ...record, status: 'ordinary', heldDelegationIds: [], heldIntentIds: [], history: 'ordinary', revision: 2 }, 1)
      return { ordinary: true, heldDelegationIds: [] }
    }
    record = { ...record, kind: parsed.kind, effect: parsed.effect, budget: parsed.budget, status: 'waiting', revision: 2 }
    if (parsed.recipient) {
      const targets = new Set(this.store.listDelegationActionFacts().filter(fact => fact.target === parsed.recipient && fact.effect !== 'read' &&
        candidates.some(value => value.delegationId === fact.delegationId && value.revision === fact.scopeRevision)).map(fact => fact.targetId))
      if (targets.size === 1) record.targetIds = [...targets]
    }
    this.store.classifyUserIntent(intent.id, 'control')
    this.store.savePriorityControl(record, 1)
    if (parsed.recipient && record.targetIds && parsed.kind === 'pause') {
      this.apply(record, { delegationIds: record.heldDelegationIds, kind: 'pause' })
      return { controlId: record.id, ordinary: false, heldDelegationIds: this.get(record.id).heldDelegationIds }
    }
    // Unique work-topic selection is sufficient for restriction, never for a new permission.
    if (candidates.length === 1 && candidateIntentIds.every(id => this.store.getIntentControl(id)?.delegationId === candidates[0].delegationId) && parsed.kind !== 'uncertain' && parsed.kind !== 'withdraw' && (!parsed.recipient || record.targetIds)) {
      const selected = this.store.getDelegation(candidates[0].delegationId)!
      if (parsed.kind !== 'revise') this.apply(record, { delegationIds: [selected.id], kind: parsed.kind })
      else if (parsed.budget !== undefined && typeof selected.scope.constraints.budget === 'number') {
        this.apply(record, { delegationIds: [selected.id], kind: 'revise', scope: { ...selected.scope, constraints: { ...selected.scope.constraints, budget: parsed.budget } } })
      }
    }
    return { controlId: record.id, ordinary: false, heldDelegationIds: this.get(record.id).heldDelegationIds }
  }

  get(id: string): PriorityControl {
    const value = this.store.listPriorityControls().find(value => value.id === id)
    if (!value) throw new Error('找不到控制指令。')
    return value
  }

  async resolve(controlId: string, choice: ControlChoice): Promise<void> { this.apply(this.get(controlId), choice) }

  resolveForOwner(controlId: string, owner: string, choice: ControlChoice): void {
    const control = this.get(controlId)
    const owned = control.candidates.filter(candidate => (control.heldDelegationIds.includes(candidate.delegationId) || control.heldIntentIds.some(id => this.store.getIntentControl(id)?.delegationId === candidate.delegationId)) && this.store.getDelegation(candidate.delegationId)?.conversationId === owner)
    const previous = control.ownerResolutions?.[owner]
    const ownedInputs = control.heldIntentIds.some(id => this.store.getOrdinaryWorkInputOwner(id) === owner)
    if ((!owned.length && !ownedInputs) || (previous && !(choice.kind === 'ordinary' && (previous === 'pause' || ownedInputs))) ||
      choice.delegationIds.some(id => !owned.some(candidate => candidate.delegationId === id))) throw new Error('此话题的控制选择已变化。')
    if (choice.kind === 'ordinary' && ownedInputs && choice.releaseOwnedInputs !== true) throw new Error('请明确核对此话题尚受控制的普通输入。')
    this.apply(control, choice, owner)
  }

  private intentOwner(id: string): string | undefined {
    const delegationId = this.store.getIntentControl(id)?.delegationId
    return delegationId ? this.store.getDelegation(delegationId)?.conversationId : undefined
  }

  private saveResolution(control: PriorityControl, next: PriorityControl, changes: Delegation[], owner?: string, kind?: ControlChoice['kind'] | 'withdraw', releaseOwnedInputs = false): void {
    if (owner) {
      const owns = (id: string) => this.store.getDelegation(id)?.conversationId === owner
      const ownerResolutions = { ...control.ownerResolutions, [owner]: kind! }
      const heldDelegationIds = [...control.heldDelegationIds.filter(id => !owns(id)), ...next.heldDelegationIds.filter(owns)]
      const affectsIntent = (id: string) => this.intentOwner(id) === owner || (releaseOwnedInputs && this.store.getOrdinaryWorkInputOwner(id) === owner)
      const heldIntentIds = [...control.heldIntentIds.filter(id => !affectsIntent(id)), ...next.heldIntentIds.filter(affectsIntent)]
      const remaining = control.candidates.some(candidate => {
        const candidateOwner = this.store.getDelegation(candidate.delegationId)?.conversationId
        return !candidateOwner || !ownerResolutions[candidateOwner]
      }) || heldIntentIds.some(id => { const intentOwner = this.intentOwner(id); return !intentOwner || !ownerResolutions[intentOwner] })
      const status = remaining ? 'waiting' : next.status === 'ordinary' && (heldDelegationIds.length || heldIntentIds.length) ? 'resolved' : next.status
      next = { ...next, ownerResolutions, heldDelegationIds, heldIntentIds, status,
        selectedDelegationIds: [...(control.selectedDelegationIds ?? []).filter(id => !owns(id)), ...(next.selectedDelegationIds ?? []).filter(owns)] }
    }
    this.store.resolvePriorityControl(next, control.revision, changes)
  }

  private apply(control: PriorityControl, choice: ControlChoice, owner?: string): void {
    if ((!['waiting', 'classifying'].includes(control.status) && !(control.status === 'resolved' && control.kind === 'pause' && choice.kind === 'ordinary')) || !this.store.hasConversation(control.conversationId) || !this.store.getUserIntent(control.intentId)) throw new Error('控制指令已变化。')
    if (!Array.isArray(choice.delegationIds) || new Set(choice.delegationIds).size !== choice.delegationIds.length ||
      choice.delegationIds.some(id => !control.candidates.some(candidate => candidate.delegationId === id))) throw new Error('只能缩小原有候选范围。')
    if (choice.kind === 'ordinary') {
      if (choice.delegationIds.length || choice.scope) throw new Error('普通消息不能授予范围。')
      this.saveResolution(control, { ...control, status: 'ordinary', heldDelegationIds: [], heldIntentIds: [], revision: control.revision + 1 }, [], owner, 'ordinary', choice.releaseOwnedInputs)
      if (!owner) this.store.classifyUserIntent(control.intentId, 'ordinary'); return
    }
    if (!choice.delegationIds.length || (choice.kind !== control.kind && !(control.kind === 'uncertain' && choice.kind === 'pause')) || (choice.scope && choice.kind !== 'revise')) throw new Error('选择不符合原始控制指令。')
    const selected = choice.delegationIds.map(id => {
      const value = this.store.getDelegation(id), original = control.candidates.find(candidate => candidate.delegationId === id)!
      if (!value || value.revision !== original.revision || !['active', 'paused'].includes(value.status) || !this.store.hasConversation(value.conversationId)) throw new Error('委托版本已变化。')
      return value
    })
    const changes: Delegation[] = []
    for (const value of selected) {
      if (choice.kind === 'revise') {
        const expected = { ...value.scope, constraints: { ...value.scope.constraints, budget: control.budget } }
        if (control.budget === undefined || !Number.isFinite(control.budget) || control.budget < 0 || typeof value.scope.constraints.budget !== 'number' ||
          !choice.scope || JSON.stringify(choice.scope) !== JSON.stringify(expected)) throw new Error('新范围尚未核实，不能增加授权。')
        changes.push({ ...value, scope: structuredClone(choice.scope), revision: value.revision + 1, resumeRequired: true })
      } else if (choice.kind === 'cancel' || control.effect === 'all') changes.push({ ...value, revision: value.revision + 1,
        status: choice.kind === 'cancel' ? 'cancelled' : 'paused', resumeRequired: choice.kind !== 'cancel' })
    }
    this.saveResolution(control, { ...control, status: 'resolved', selectedDelegationIds: choice.delegationIds, heldIntentIds: control.targetIds ? control.heldIntentIds : control.heldIntentIds.filter(id => choice.delegationIds.includes(this.store.getIntentControl(id)?.delegationId ?? '')), heldDelegationIds: choice.kind === 'pause' && control.effect === 'mutation' ? choice.delegationIds : [],
      revision: control.revision + 1 }, changes, owner, choice.kind)
  }

  /** Preparation is inert; B7 must bind the later click to the original owner and current card revision. */
  prepareDenialRevision(controlId: string, conversationId: string, delegationId: string, revision: number, denialId: string): PriorityControl {
    const control = this.get(controlId), delegation = this.store.getDelegation(delegationId)
    if (control.ownerResolutions?.[conversationId] || control.status !== 'waiting' || control.kind !== 'withdraw' || delegation?.conversationId !== conversationId || delegation.revision !== revision ||
      !control.candidates.some(value => value.delegationId === delegationId && value.revision === revision) ||
      !this.store.listDelegationDenials(delegationId).some(value => value.id === denialId && !value.withdrawal)) throw new Error('请选择原工作话题的当前拒绝步骤。')
    const next = { ...control, revision: control.revision + 1, selection: { delegationId, scopeRevision: revision, denialId, confirmed: false } }
    this.store.savePriorityControl(next, control.revision); return next
  }

  confirmDenialRevision(controlId: string, conversationId: string, revision: number, revise: (d: Delegation, denial: DelegationDenial, intent: UserIntent) => void): void {
    const control = this.get(controlId), selected = control.selection, d = selected && this.store.getDelegation(selected.delegationId)
    const denial = d && this.store.listDelegationDenials(d.id).find(value => value.id === selected!.denialId && !value.withdrawal)
    const intent = this.store.getUserIntent(control.intentId)
    if (control.ownerResolutions?.[conversationId] || control.status !== 'waiting' || control.revision !== revision || !selected || selected.confirmed || !d || d.conversationId !== conversationId ||
      d.revision !== selected.scopeRevision || !denial || !intent || !this.store.hasConversation(conversationId)) throw new Error('确认卡已失效。')
    const confirmed = { ...control, selection: { ...selected, confirmed: true }, revision: revision + 1 }
    this.store.savePriorityControl(confirmed, revision)
    try {
      revise(d, denial, intent)
      this.saveResolution(confirmed, { ...confirmed, status: 'resolved', heldDelegationIds: [], heldIntentIds: [], revision: revision + 2 }, [], conversationId, 'withdraw')
    } catch (error) {
      this.store.savePriorityControl({ ...confirmed, selection: { ...selected, confirmed: false }, revision: revision + 2 }, revision + 1)
      throw error
    }
  }

  validateDenialRevision = (d: Delegation, denial: DelegationDenial, intent: UserIntent, spans: [number, number][]): DenialRevisionProof | null => {
    const control = this.store.listPriorityControls().find(value => value.intentId === intent.id && value.status === 'waiting' && value.kind === 'withdraw' && value.selection?.confirmed &&
      value.selection.delegationId === d.id && value.selection.scopeRevision === d.revision && value.selection.denialId === denial.id)
    if (!control || JSON.stringify(spans) !== JSON.stringify([[0, intent.text.length]])) return null
    return { delegationId: d.id, scopeRevision: d.revision, denialId: denial.id, targetId: denial.targetId, businessEffect: denial.businessEffect,
      effect: denial.effect, dataClasses: denial.dataClasses ?? [], intentId: intent.id, messageId: intent.messageId, evidenceSpans: spans, decision: 'withdraw-denial' }
  }
}
