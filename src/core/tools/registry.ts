import { createHash, randomUUID } from 'node:crypto'
import { synchronousJsonSchemaValidator } from './schema'
import type { ActionAssessment, ToolResult } from '../../shared/types'
import type { ToolDefinition, ToolExecutor, ToolExecutionContext, ToolRegistrationOptions, ToolRegistry } from './types'
import { normalizeToolResult } from './results'
import { ApprovalError } from './approval'
import { abortable } from './abort'
import type { DispatchPhase } from './ledger'
import type { ActionDescriptor } from '../delegations/types'
import { describeMessageAction, bindMessageAction, messageActionFacts, messageActionCurrent } from './message-actions'
import { bindWeatherAction } from '../weather/tools'

interface RegisteredTool {
  definition: ToolDefinition
  executor: ToolExecutor
  options: ToolRegistrationOptions
  identity: string
  validate: ReturnType<typeof synchronousJsonSchemaValidator.getValidator>
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}'
  return JSON.stringify(value)
}
const localClocks = new WeakSet<ToolExecutor>()
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value) }
  return value
}
const failure = (text: string): ToolResult => ({ isError: true, content: [{ type: 'text', text }] })

export class SimpleToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>()

  register(definition: ToolDefinition, executor: ToolExecutor, options: ToolRegistrationOptions = {}): void {
    const copy = structuredClone(definition)
    this.tools.set(definition.name, { definition: copy, executor, options: { ...options }, identity: randomUUID(), validate: synchronousJsonSchemaValidator.getValidator(copy.parameters) })
  }

  has(name: string): boolean { return this.tools.has(name) }
  unregister(name: string): void { this.tools.delete(name) }
  getDefinitions(): ToolDefinition[] { return this.snapshot().getDefinitions() }
  getRevisions(): Record<string, string> { return this.snapshot().getRevisions() }

  snapshot(): ToolRegistry {
    const entries = new Map([...this.tools].filter(([, tool]) => tool.options.isAvailable?.() !== false))
    const snapshot: ToolRegistry = {
      snapshot: () => snapshot,
      getDefinitions: () => [...entries.values()].map(tool => structuredClone(tool.definition)),
      getRevisions: () => Object.fromEntries([...entries].map(([name, tool]) => [name, `${tool.identity}:${tool.options.revision ?? ''}`])),
      execute: (name, args, context) => this.invoke(entries.get(name), name, args, context)
    }
    return snapshot
  }

  execute(name: string, args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    return this.snapshot().execute(name, args, context)
  }

  private async invoke(tool: RegisteredTool | undefined, name: string, args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    context.signal.throwIfAborted()
    if (!tool) return failure(`Unknown tool: ${name}`)
    const validation = tool.validate(args)
    if (!validation.valid) return failure(`Invalid tool arguments: ${validation.errorMessage}`)
    const original = canonical(args)
    // The executor receives a separate copy; asynchronous model/adapter mutation cannot alter approved arguments.
    const dispatchArgs = freeze(structuredClone(args))
    let assessment: ActionAssessment = tool.options.assess
      ? await abortable(tool.options.assess(structuredClone(args), context), context.signal)
      : { effect: 'unknown', target: name, summary: `执行工具 ${name}，参数：${JSON.stringify(dispatchArgs)}` }
    const base = context.describeAction ? await abortable(context.describeAction(assessment, dispatchArgs), context.signal) : undefined
    const message = await abortable(describeMessageAction(tool.executor, dispatchArgs), context.signal)
    const description = message ?? (tool.options.describeAction ? await abortable(tool.options.describeAction(dispatchArgs, context), context.signal) : undefined)
    const action: ActionDescriptor = freeze({
      providerName: base?.providerName,
      effect: 'unknown', targetId: assessment.target, capability: '', confirmation: 'always', opaque: true, dataClasses: [],
      target: assessment.displayTarget ?? assessment.target, summary: '需要确认工具的实际操作', actionLabel: '执行一次',
      preview: { fields: [{ label: '原始工具参数', value: JSON.stringify(dispatchArgs) }] },
      ...(description ? structuredClone(description) : {}),
      ...(localClocks.has(tool.executor) ? { effect: 'read' as const, targetId: 'system:clock', opaque: false, capability: 'local.clock' } : {}),
      purpose: base?.purpose ?? '执行本次请求', scopeSummary: base?.scopeSummary ?? '仅本次动作', observationId: message?.observationId ?? assessment.observationId,
      conversationId: context.conversationId, intentId: context.intent?.id, id: context.callId, delegationId: context.delegationId ?? '', scopeRevision: base?.scopeRevision ?? 0,
      adapterId: tool.identity, adapterRevision: tool.options.revision ?? '',
      payloadHash: createHash('sha256').update(original).digest('hex')
    })
    bindMessageAction(message, action)
    bindWeatherAction(tool.executor, action)
    if (description) context.actionPolicy?.observeAction?.(action)
    // Effect labels from ordinary assessments cannot exempt an opaque dispatch from the ledger.
    assessment = { ...assessment, effect: action.opaque ? 'unknown' : action.effect, target: action.targetId }
    // Reuse the Host's private random-target closure; no model or descriptor flag can create this exception.
    const localCandidate = () => context.admitLocalCandidate?.(assessment, { ...context, action }) === true
    const controlVersion = context.actionPolicy?.controlVersion?.(action)
    const assessmentIdentity = canonical(assessment), intentIdentity = canonical(context.intent)
    const valid = () => this.tools.get(name) === tool && tool.options.isAvailable?.() !== false &&
      context.validateRuntime?.() !== false && messageActionCurrent(action) && canonical(args) === original && canonical(dispatchArgs) === original &&
      canonical(context.intent) === intentIdentity && canonical(assessment) === assessmentIdentity &&
      (!assessment.observationId || tool.options.validateObservation?.(assessment, context) === true)
    const assertCurrent = () => {
      context.signal.throwIfAborted()
      if (!valid()) throw new ApprovalError('工具配置或动作参数已失效。')
      if (!localCandidate() && context.actionPolicy?.controlVersion?.(action) !== controlVersion) throw new ApprovalError('用户控制已变化，旧动作批准已失效。')
      context.actionPolicy?.assertCurrent(action, localCandidate)
    }
    assertCurrent()
    const checked: ToolExecutionContext = { ...context, action, observationValidated: !!assessment.observationId,
      approvalBinding: {
        revision: createHash('sha256').update(canonical({ run: context.runId, call: context.callId, action, args: original, intent: context.intent, assessment })).digest('hex'),
        validate: () => { try { assertCurrent(); return true } catch { return false } },
        // Only this module's actual built-in executor or the Host's exact daily-run closure can admit local work.
        localAdmission: () => localClocks.has(tool.executor) || context.admitLocalCandidate?.(assessment, checked) === true
      }
    }
    context.ledger?.assertTargetFree(assessment)
    const decision = context.actionPolicy?.decide(action, context.intent, localCandidate) ?? 'confirm'
    if (decision === 'deny') throw new ApprovalError('动作授权已失效或已被拒绝。')
    const exactMessage = decision === 'allow' && !!messageActionFacts(action) && action.effect === 'send'
    if (exactMessage && (!context.ledger || !context.actionPolicy?.consumeExactMessage || !context.intent)) throw new ApprovalError('消息派发账本不可用。')
    if (context.authorize) await context.authorize(assessment, checked)
    else if (decision !== 'allow' && !checked.approvalBinding!.localAdmission!()) throw new ApprovalError('这个动作需要用户确认。')
    assertCurrent()
    context.signal.throwIfAborted()
    // Approval is done; only now wait for conflicting resources, so a pending prompt never blocks other work.
    const keys = tool.options.resources?.(structuredClone(args), assessment) ?? []
    const release = keys.length && context.resources ? await context.resources.acquire(keys, context.signal, context.onWaitingResources) : undefined
    try {
      assertCurrent()
      // Reads change nothing outside, so only mutations are ledgered. begin() throws, and nothing runs, if the write fails.
      const ledger = assessment.effect === 'read' ? undefined : context.ledger
      if (!exactMessage) ledger?.begin(context.runId, context.callId, name, dispatchArgs, assessment)
      let ledgerPrepared = !exactMessage
      let phase: DispatchPhase = 'none', noEffect = false, observedTarget: string | undefined
      const settle = (outcome: 'ok' | 'error' | 'thrown', message: string) => {
        if (!ledgerPrepared) return
        try {
          if (outcome === 'ok') ledger?.succeeded(context.runId, context.callId)
          else if (phase !== 'none' && phase !== 'preflight-completed' && !noEffect) {
            ledger?.unknown(context.runId, context.callId, context.conversationId, assessment.target,
              phase === 'preflight' ? '观察预检可能已关闭或重建崩溃标签，结果未知；最终动作未派发。' : '动作已派发但结果未知；禁止自动重放。')
          } else if (outcome === 'thrown') ledger?.cancelled(context.runId, context.callId)
          else ledger?.failed(context.runId, context.callId, message)
        } catch { /* the row stays running and ActionLedger.recover() settles it as unknown on the next start */ }
      }
      let result: ToolResult
      try {
        context.onAttempt?.()
        if (!tool.options.deferDispatch) { assertCurrent(); ledger?.dispatched(context.runId, context.callId, 'action'); phase = 'action'; context.onDispatch?.(assessment) }
        const controller = new AbortController()
        const signal = AbortSignal.any([context.signal, controller.signal])
        const timer = setTimeout(() => controller.abort(new Error('工具执行超时，结果可能未知。')), tool.options.timeoutMs ?? 60_000)
        try {
          const execution = tool.executor(dispatchArgs, { ...checked, signal,
            onObserved: target => { if (!signal.aborted && context.validateRuntime?.() !== false) observedTarget = target; context.onObserved?.(target) },
            onNoEffect: () => { noEffect = true; context.onNoEffect?.() },
            markDispatched: next => {
              signal.throwIfAborted()
              assertCurrent()
              if (exactMessage) {
                if (next !== 'action' || phase !== 'none') throw new ApprovalError('原样消息不能重复派发。')
                context.actionPolicy!.consumeExactMessage!(context.intent!.id, action, { runId: context.runId, callId: context.callId, toolName: name, args: dispatchArgs })
                ledgerPrepared = true
              }
              ledger?.dispatched(context.runId, context.callId, next); phase = next
              context.onDispatch?.(assessment, next)
            },
            completePreflight: () => {
              signal.throwIfAborted()
              ledger?.preflightCompleted(context.runId, context.callId); phase = 'preflight-completed'
              context.onPreflightComplete?.()
            }
          })
          let abandoned = false
          // Whatever a stopped or timed-out call eventually returns is audit only: it never changes the call or the run.
          void execution.then(late => { if (abandoned) ledger?.audit(context.runId, context.callId, late) }, () => {})
          try { result = normalizeToolResult(await abortable(execution, signal)) }
          catch (error) { abandoned = true; throw error }
        } catch (error) {
          context.signal.throwIfAborted()
          result = failure(`Tool execution failed: ${error instanceof Error ? error.message : String(error)}`)
        } finally { clearTimeout(timer) }
      } catch (error) {
        settle('thrown', error instanceof Error ? error.message : String(error))
        throw error
      }
      settle(result.isError ? 'error' : 'ok', result.content.map(part => part.type === 'text' ? part.text : '').join('\n'))
      // Only a successful read of the very target that was observed can lift its quarantine.
      if (assessment.effect === 'read' && !result.isError && !context.signal.aborted && context.validateRuntime?.() !== false) {
        context.ledger?.observed(observedTarget ?? assessment.target)
      }
      return result
    } finally { release?.() }
  }
}

export function createDefaultRegistry(): SimpleToolRegistry {
  const registry = new SimpleToolRegistry()

  const clock: ToolExecutor = async (args) => {
      const now = new Date()
      const options: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: args.timezone as string | undefined }
      return { content: [{ type: 'text', text: now.toLocaleString('zh-CN', options) }] }
  }
  localClocks.add(clock)
  registry.register(
    {
      name: 'get_current_time',
      description: 'Get the current date and time',
      parameters: {
        type: 'object',
        properties: {
          timezone: {
            type: 'string',
            description: 'Optional IANA timezone (e.g. "Asia/Shanghai"). Defaults to system timezone.'
          }
        }
      },
    },
    clock,
    { assess: async () => ({ effect: 'read', target: 'system:clock', summary: '查看当前时间' }) }
  )

  return registry
}
