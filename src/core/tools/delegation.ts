import { randomUUID } from 'node:crypto'
import type { DelegationProposal, UserIntent } from '../delegations/types'
import type { DelegationService } from '../delegations/service'
import type { SimpleToolRegistry } from './registry'

/** The optional target is an opaque, run-local Host identity, never a model argument. */
export function registerDelegationTool(registry: SimpleToolRegistry, service: DelegationService, intent: UserIntent, target = randomUUID()): void {
  const boundIntent = structuredClone(intent)
  const strings = { type: 'array', items: { type: 'string' }, maxItems: 100 }
  registry.register({ name: 'delegate_work', description: '根据本次真实用户输入提出一件有明确目标和边界的工作。候选不构成授权；仅返回通用接纳状态。',
    parameters: { type: 'object', additionalProperties: false, required: ['id', 'scope', 'evidenceSpans', 'revision'], properties: {
      id: { type: 'string', minLength: 1, maxLength: 128 }, topicId: { type: 'string', minLength: 1, maxLength: 128 }, revision: { type: 'integer', const: 1 },
      evidenceSpans: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'integer', minimum: 0 } } },
      scope: { type: 'object', additionalProperties: false, required: ['purpose', 'objects', 'completion', 'allowedCapabilities', 'origins', 'constraints'], properties: {
        purpose: { type: 'string', maxLength: 10000 }, objects: strings, completion: { type: 'string', maxLength: 10000 }, allowedCapabilities: strings, origins: strings,
        constraints: { type: 'object', additionalProperties: { anyOf: [{ type: 'string' }, { type: 'number' }] } }
      } }
    } }
  }, async (args, context) => {
    context.signal.throwIfAborted()
    const result = service.admitIntent(boundIntent, args as unknown as DelegationProposal)
    return { content: [{ type: 'text', text: JSON.stringify({ status: result.status }) }] }
  }, { assess: async () => ({ effect: 'unknown', target, summary: '接纳本次输入的工作候选。' }) })
}
