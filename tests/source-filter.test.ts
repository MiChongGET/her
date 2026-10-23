import { describe, expect, it } from 'vitest'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { filterMessages, indexBranch, fileKey, grantKey, handoffKey, sourceKeys, toFileSources, sourcesOf, SOURCE_PLACEHOLDER, RUN_SOURCES, TOOL_SOURCES } from '../src/core/agent/sources'
import { createSourceGuard } from '../src/core/agent/source-guard'

let clock = 1000
const next = () => ++clock
const custom = (customType: string, data: unknown) => ({ type: 'custom', customType, data, id: String(next()), timestamp: new Date(clock).toISOString() }) as unknown as SessionEntry
const message = (m: Record<string, unknown>) => ({ type: 'message', id: String(next()), timestamp: new Date(clock).toISOString(), message: { timestamp: clock, ...m } }) as unknown as SessionEntry
const user = (text: string) => message({ role: 'user', content: [{ type: 'text', text }] })
const assistant = (text: string, calls: { id: string }[] = []) => message({ role: 'assistant', content: [{ type: 'text', text }, ...calls.map(call => ({ type: 'toolCall', id: call.id, name: 't', arguments: { secret: 'x' } }))] })
const toolResult = (toolCallId: string, text: string) => message({ role: 'toolResult', toolCallId, toolName: 't', content: [{ type: 'text', text }], isError: false })
const compaction = (summary: string) => ({ type: 'compaction', summary, firstKeptEntryId: 'x', tokensBefore: 1, id: String(next()), timestamp: new Date(next()).toISOString() }) as unknown as SessionEntry
const messagesOf = (branch: SessionEntry[]): unknown[] => branch.flatMap((entry): unknown[] => {
  if (entry.type === 'message') return [entry.message]
  if (entry.type === 'compaction') return [{ role: 'compactionSummary', summary: entry.summary, tokensBefore: 1, timestamp: new Date(entry.timestamp).getTime() }]
  return []
})
const text = (m: unknown) => JSON.stringify(m)

describe('source keys', () => {
  it('round-trips files and grants', () => {
    const keys = [fileKey('f1'), grantKey('g1', 3)]
    expect(sourceKeys({ fileIds: ['f1'], grants: [{ id: 'g1', revision: 3 }] })).toEqual(keys)
    expect(toFileSources(keys)).toEqual({ fileIds: ['f1'], grants: [{ id: 'g1', revision: 3 }] })
    expect(toFileSources([])).toEqual({})
  })
})

describe('source filtering', () => {
  it('failed_context_index_never_sends_user_background_or_summary', async () => {
    const guard = createSourceGuard({ branch: () => { throw new Error('index unavailable') }, valid: () => true })
    const handler = guard.handlers.get('context')![0]
    const result = await handler({ messages: [
      { role: 'user', content: [{ type: 'text', text: 'HANDOFF_SECRET' }] },
      { role: 'compactionSummary', summary: 'SUMMARY_SECRET', tokensBefore: 1, timestamp: 1 }
    ] })
    expect(JSON.stringify(result)).not.toContain('HANDOFF_SECRET')
    expect(JSON.stringify(result)).not.toContain('SUMMARY_SECRET')
    expect(JSON.stringify(result)).toContain(SOURCE_PLACEHOLDER)
  })
  it('restricted_handoff_background_and_derivatives_are_filtered', () => {
    const timestamp = new Date(next()).toISOString()
    const background = { type: 'custom_message', customType: 'her.topic-handoff', details: { operationId: 'handoff-1' }, content: 'private seed',
      id: String(next()), timestamp } as unknown as SessionEntry
    const later = assistant('private derivative')
    const summary = compaction('summary derived from private seed')
    const messages = [{ role: 'custom', content: 'private seed', timestamp: new Date(timestamp).getTime() }, (later as Extract<SessionEntry, { type: 'message' }>).message,
      { role: 'compactionSummary', summary: 'summary derived from private seed', tokensBefore: 1, timestamp: new Date(summary.timestamp).getTime() }]
    const result = filterMessages(messages, indexBranch([background, later, summary]), keys => !keys.includes(handoffKey('handoff-1')))
    expect(JSON.stringify(result.messages)).not.toContain('private seed')
    expect(JSON.stringify(result.messages)).not.toContain('private derivative')
    expect(JSON.stringify(result.messages)).not.toContain('summary derived')
    expect(result.dropped).toBe(3)
  })
  const build = () => {
    const branch = [
      custom(RUN_SOURCES, { fileSources: { fileIds: ['f1'] } }), user('see attached'), assistant('I looked', [{ id: 'c1' }]),
      custom(TOOL_SOURCES, { toolCallId: 'c1', fileSources: { fileIds: ['f2'] } }), toolResult('c1', 'file two body'), assistant('summary of both'),
      custom(RUN_SOURCES, {}), user('a plain follow up'), assistant('plain answer')
    ]
    return { branch, messages: messagesOf(branch) }
  }
  const only = (...bad: string[]) => (keys: string[]) => !keys.some(key => bad.includes(key))

  it('passes everything through while every source is valid', () => {
    const { branch, messages } = build()
    const result = filterMessages(messages, indexBranch(branch), () => true)
    expect(result.dropped).toBe(0)
    expect(result.messages).toEqual(messages)
  })

  it('replaces the attachment message and everything derived from it, but not a later message the user typed', () => {
    const { branch, messages } = build()
    const result = filterMessages(messages, indexBranch(branch), only(fileKey('f1')))
    const out = result.messages.map(text)
    expect(out[0]).toContain(SOURCE_PLACEHOLDER)          // user message with the attachment
    expect(out[1]).toContain(SOURCE_PLACEHOLDER)          // assistant that saw it
    expect(out[2]).toContain(SOURCE_PLACEHOLDER)          // tool result
    expect(out[3]).toContain(SOURCE_PLACEHOLDER)          // later assistant, derived
    expect(out[4]).not.toContain(SOURCE_PLACEHOLDER)      // the user's own plain follow-up survives
    expect(out[4]).toContain('a plain follow up')
    expect(out[5]).toContain(SOURCE_PLACEHOLDER)          // answer that was produced with the tainted context
    expect(JSON.stringify(out)).not.toContain('file two body')
    expect(JSON.stringify(out)).not.toContain('I looked')
  })

  it('a tool-read source taints what followed it but not what came before', () => {
    const { branch, messages } = build()
    const out = filterMessages(messages, indexBranch(branch), only(fileKey('f2'))).messages.map(text)
    expect(out[0]).toContain('see attached')
    expect(out[1]).toContain('I looked')
    expect(out[2]).toContain(SOURCE_PLACEHOLDER)
    expect(out[3]).toContain(SOURCE_PLACEHOLDER)
    expect(out[4]).toContain('a plain follow up')
  })

  it('keeps tool-call ids but empties their arguments so the pairing survives', () => {
    const { branch, messages } = build()
    const out = filterMessages(messages, indexBranch(branch), only(fileKey('f1'))).messages[1] as { content: { type: string; id?: string; arguments?: unknown }[] }
    const call = out.content.find(part => part.type === 'toolCall')!
    expect(call.id).toBe('c1')
    expect(call.arguments).toEqual({})
  })

  it('a summary inherits the dependencies of what it summarised, and a later summary those of the earlier one', () => {
    const branch = [custom(RUN_SOURCES, { fileSources: { fileIds: ['f1'] } }), user('attached'), assistant('reply'), compaction('SUMMARY ONE'),
      custom(RUN_SOURCES, {}), user('next'), assistant('more'), compaction('SUMMARY TWO')]
    const messages = messagesOf(branch)
    const out = filterMessages(messages, indexBranch(branch), only(fileKey('f1'))).messages.map(text)
    expect(out[2]).toContain(SOURCE_PLACEHOLDER)
    expect(out[2]).not.toContain('SUMMARY ONE')
    expect(out[5]).toContain(SOURCE_PLACEHOLDER)
    expect(out[5]).not.toContain('SUMMARY TWO')
    expect(out[3]).toContain('next')
  })

  it('treats a revoked grant revision like a revoked file', () => {
    const branch = [custom(RUN_SOURCES, { fileSources: { grants: [{ id: 'g', revision: 2 }] } }), user('dir'), assistant('listed it')]
    const messages = messagesOf(branch)
    expect(filterMessages(messages, indexBranch(branch), only(grantKey('g', 2))).dropped).toBe(2)
    expect(filterMessages(messages, indexBranch(branch), only(grantKey('g', 1))).dropped).toBe(0)
  })

  it('judges a message it cannot match by everything the branch has seen', () => {
    const { branch } = build()
    const stranger = { role: 'assistant', timestamp: 999_999, content: [{ type: 'text', text: 'unaccounted' }] }
    expect(text(filterMessages([stranger], indexBranch(branch), only(fileKey('f2'))).messages[0])).toContain(SOURCE_PLACEHOLDER)
    expect(text(filterMessages([stranger], indexBranch(branch), () => true).messages[0])).toContain('unaccounted')
  })

  it('reports which sources the surviving messages still rely on', () => {
    const { branch, messages } = build()
    const index = indexBranch(branch)
    expect([...filterMessages(messages, index, () => true).used].sort()).toEqual([fileKey('f1'), fileKey('f2')])
    expect([...filterMessages(messages, index, only(fileKey('f2'))).used]).toEqual([fileKey('f1')])
    expect([...sourcesOf(messages.slice(0, 1), index)]).toEqual([fileKey('f1')])
  })

  it('does not rewrite messages that never touched a source', () => {
    const branch = [custom(RUN_SOURCES, {}), user('hello'), assistant('hi')]
    const messages = messagesOf(branch)
    const out = filterMessages(messages, indexBranch(branch), () => false)
    expect(out.dropped).toBe(0)
    expect(out.messages).toEqual(messages)
  })
})
