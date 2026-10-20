import { createHash, randomUUID } from 'node:crypto'
import { synchronousJsonSchemaValidator } from './schema'
import type { ActionAssessment, ToolResult } from '../../shared/types'
import type { ToolDefinition, ToolExecutor, ToolExecutionContext, ToolRegistrationOptions, ToolRegistry } from './types'
import { normalizeToolResult } from './results'
import { ApprovalError } from './approval'
import { abortable } from './abort'
import type { DispatchPhase } from './ledger'

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
    const dispatchArgs = structuredClone(args)
    const assessment: ActionAssessment = tool.options.assess
      ? await abortable(tool.options.assess(structuredClone(args), context), context.signal)
      : { effect: 'unknown', target: name, summary: `执行工具 ${name}，参数：${JSON.stringify(dispatchArgs)}` }
    const assessmentIdentity = canonical(assessment)
    const valid = () => this.tools.get(name) === tool && tool.options.isAvailable?.() !== false &&
      context.validateRuntime?.() !== false && canonical(args) === original && canonical(assessment) === assessmentIdentity &&
      (!assessment.observationId || tool.options.validateObservation?.(assessment, context) === true)
    if (!valid()) throw new ApprovalError('工具配置或动作参数已失效。')
    const trustedInteraction = assessment.effect === 'interact' && !!assessment.observationId && tool.options.validateObservation?.(assessment, context) === true
    const checked = { ...context, observationValidated: trustedInteraction, approvalBinding: {
      revision: createHash('sha256').update(canonical({ run: context.runId, call: context.callId, identity: tool.identity, revision: tool.options.revision, args: original, assessment })).digest('hex'),
      validate: valid,
      allowAllOperations: tool.options.allowAllOperations === true,
      ...(tool.options.conversationApprovalScope ? { conversationScope: { id: tool.options.conversationApprovalScope,
        validate: () => this.tools.get(name) === tool && tool.options.isAvailable?.() !== false } } : {})
    } }
    context.ledger?.assertTargetFree(assessment)
    // A fresh observation lets a simple interaction proceed unprompted, except on a target recovered from an unknown outcome.
    const trusted = trustedInteraction && !context.ledger?.recovered(assessment.target)
    if (context.authorize) { if (!trusted) await context.authorize(assessment, checked) }
    else if (assessment.effect !== 'read' && !trusted && !checked.approvalBinding.allowAllOperations) throw new ApprovalError('这个动作需要用户确认。')
    // An interact assessment without live observation must use the same explicit approval gate as unknown actions.
    if (!checked.approvalBinding.validate()) throw new ApprovalError('工具配置或动作参数已失效。')
    context.signal.throwIfAborted()
    // Approval is done; only now wait for conflicting resources, so a pending prompt never blocks other work.
    const keys = tool.options.resources?.(structuredClone(args), assessment) ?? []
    const release = keys.length && context.resources ? await context.resources.acquire(keys, context.signal) : undefined
    try {
      if (!checked.approvalBinding.validate()) throw new ApprovalError('工具配置或动作参数已失效。')
      // Reads change nothing outside, so only mutations are ledgered. begin() throws, and nothing runs, if the write fails.
      const ledger = assessment.effect === 'read' ? undefined : context.ledger
      ledger?.begin(context.runId, context.callId, name, dispatchArgs, assessment)
      let phase: DispatchPhase = 'none', noEffect = false, observedTarget: string | undefined
      const settle = (outcome: 'ok' | 'error' | 'thrown', message: string) => {
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
        if (!tool.options.deferDispatch) { ledger?.dispatched(context.runId, context.callId, 'action'); phase = 'action'; context.onDispatch?.(assessment) }
        const controller = new AbortController()
        const signal = AbortSignal.any([context.signal, controller.signal])
        const timer = setTimeout(() => controller.abort(new Error('工具执行超时，结果可能未知。')), tool.options.timeoutMs ?? 60_000)
        try {
          const execution = tool.executor(dispatchArgs, { ...context, signal,
            onObserved: target => { if (!signal.aborted && context.validateRuntime?.() !== false) observedTarget = target; context.onObserved?.(target) },
            onNoEffect: () => { noEffect = true; context.onNoEffect?.() },
            markDispatched: next => {
              signal.throwIfAborted()
              if (this.tools.get(name) !== tool || tool.options.isAvailable?.() === false || context.validateRuntime?.() === false) throw new ApprovalError('工具运行态已失效。')
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
    async (args) => {
      const now = new Date()
      const options: Intl.DateTimeFormatOptions = {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZone: args.timezone as string | undefined,
      }
      return { content: [{ type: 'text', text: now.toLocaleString('zh-CN', options) }] }
    },
    { assess: async () => ({ effect: 'read', target: 'system:clock', summary: '查看当前时间' }) }
  )

  return registry
}
