import type { ToolResult } from '../../shared/types'
import type { ActionDescriptor } from '../delegations/types'
import type { SimpleToolRegistry } from './registry'
import type { ToolExecutionContext, ToolExecutor } from './types'

export interface MessageTarget {
  accountId: string
  recipientId: string
  displayName: string
  observationId: string
  adapterRevision: string
}

/** Compiled channel implementation only. No production channel currently implements this contract. */
export interface MessageAdapter {
  readonly channelId: string
  readonly channelName: string
  readonly revision: string
  resolveRecipient(name: string): Promise<MessageTarget[]>
  describeSend(target: MessageTarget, text: string): Promise<ActionDescriptor>
  /** Synchronous current-account, stable-recipient, observation and adapter-version check. */
  validateTarget(target: MessageTarget): boolean
  /** Must dispatch synchronously before its first await; asynchronous preflight belongs in resolution. */
  send(target: MessageTarget, text: string, context: ToolExecutionContext): Promise<ToolResult>
  readback(target: MessageTarget, text: string, result: ToolResult, context: ToolExecutionContext): Promise<boolean>
}
interface MessageProof {
  adapter: MessageAdapter
  channelId: string
  channelName: string
  revision: string
  target: MessageTarget
  text: string
}
const registrations = new WeakMap<ToolExecutor, MessageAdapter>()
const descriptions = new WeakMap<ActionDescriptor, MessageProof>()
const actions = new WeakMap<ActionDescriptor, MessageProof>()

/** Dedicated compiled registration, never installed from an MCP annotation, config or tool argument. */
export function registerMessageAdapter(registry: SimpleToolRegistry, name: string, adapter: MessageAdapter): void {
  const executor: ToolExecutor = async (_args, context) => {
    const proof = context.action && actions.get(context.action)
    if (!proof || !context.markDispatched) throw new Error('消息渠道事实不可用。')
    context.markDispatched('action')
    const result = await adapter.send(proof.target, proof.text, context)
    context.signal.throwIfAborted()
    if (result.isError) return result
    if (!await adapter.readback(proof.target, proof.text, result, context)) return { isError: true, content: [{ type: 'text', text: '消息发送结果未核实，请先观察，不能自动重发。' }] }
    return result
  }
  registrations.set(executor, adapter)
  registry.register({ name, description: '向已核验的唯一联系人发送消息并读回结果。', parameters: {
    type: 'object', additionalProperties: false, required: ['recipientName', 'text'],
    properties: { recipientName: { type: 'string', minLength: 1 }, text: { type: 'string', minLength: 1 } }
  } }, executor, { revision: adapter.revision, deferDispatch: true,
    resources: () => [`message:${adapter.channelId}`] })
}

/** Registry-only bridge: ordinary ActionDescription objects have no entry in these private maps. */
export async function describeMessageAction(executor: ToolExecutor, args: Record<string, unknown>): Promise<ActionDescriptor | undefined> {
  const adapter = registrations.get(executor)
  if (!adapter) return undefined
  const targets = await adapter.resolveRecipient(String(args.recipientName))
  if (targets.length !== 1) throw new Error('联系人不唯一，请先确认具体对象。')
  const target = Object.freeze(structuredClone(targets[0])), text = String(args.text)
  if (![target.accountId, target.recipientId, target.displayName, target.observationId, target.adapterRevision].every(value => typeof value === 'string' && value.trim()) || target.displayName !== args.recipientName ||
    !adapter.channelId || !adapter.channelName || !adapter.revision || target.adapterRevision !== adapter.revision || !adapter.validateTarget(target)) throw new Error('消息对象或账号观察已失效。')
  const description = await adapter.describeSend(target, text)
  const facts: ActionDescriptor = { ...description, confirmation: 'always',
    ...(description.effect !== 'send' ? { effect: 'unknown', opaque: true } : {}), targetId: JSON.stringify([adapter.channelId, target.accountId, target.recipientId]), target: target.displayName,
    observationId: target.observationId, preview: { ...description.preview, fields: description.preview?.fields ?? [], finalText: text, recipient: target.displayName } }
  descriptions.set(facts, { adapter, channelId: adapter.channelId, channelName: adapter.channelName, revision: adapter.revision, target, text })
  return facts
}
export function bindMessageAction(description: ActionDescriptor | undefined, action: ActionDescriptor): void {
  const proof = description && descriptions.get(description)
  if (proof) actions.set(action, proof)
}
export function messageActionFacts(action: ActionDescriptor): { target: MessageTarget; text: string; channelName: string } | undefined {
  const proof = actions.get(action)
  if (!proof) return undefined
  return { target: { ...proof.target }, text: proof.text, channelName: proof.channelName }
}
export function messageActionCurrent(action: ActionDescriptor): boolean {
  const proof = actions.get(action)
  return !proof || (proof.adapter.channelId === proof.channelId && proof.adapter.channelName === proof.channelName && proof.adapter.revision === proof.revision &&
    action.adapterRevision === proof.revision && action.observationId === proof.target.observationId && proof.adapter.validateTarget(proof.target))
}
