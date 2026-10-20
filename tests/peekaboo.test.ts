import { expect, it } from 'vitest'
import { createPeekabooAdapter, imagePointToLogical } from '../src/core/mcp/peekaboo'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import { McpRegistryAdapter, mcpToolName } from '../src/core/mcp/registry-adapter'
import type { McpConnectionManager } from '../src/core/mcp/manager'
import type { ToolExecutionContext } from '../src/core/tools/types'
import type { ToolResult } from '../src/shared/types'

function receipt(snapshot = 'native-opaque', x = 100): ToolResult {
  return { content: [{ type: 'text', text: 'scratch' }, { type: 'image', artifactId: 'image', mimeType: 'image/png' }], meta: {
    snapshot_id: snapshot, used_cache: false, focused_element: { identifier: 'document', role: 'AXTextArea', processIdentifier: 12, windowID: 45 },
    target_receipt: { pid: 12, window_id: 45, process_start_identity_decimal: '9007199254740993123' },
    coordinate_context: { version: 1, reference_id: 'reference-opaque', window: { window_id: 45, title: 'scratch' }, logical_bounds: { x, y: 50, width: 400, height: 300 }, delivered_image_size: { width: 800, height: 600 }, logical_space: 'global_display_points', origin: 'top_left', viewport: null },
    ui_elements: [{ id: 'native-element', role: 'text', ax_role: 'AXTextArea', is_actionable: true, is_value_settable: true, bounds: { x: 110, y: 60, width: 200, height: 100 }, value: 'fixture' }]
  } }
}
function setup(executable = '/System/Applications/TextEdit.app/Contents/MacOS/TextEdit') {
  let revision = 1
  const manager = { getStatus: () => ({ revision }) } as unknown as McpConnectionManager
  const policy = createPeekabooAdapter(manager, 'service', { processExecutable: async () => executable })
  const context: ToolExecutionContext = { runId: 'run', conversationId: 'conversation', callId: 'call', signal: new AbortController().signal }
  const calls: { name: string; args: Record<string, unknown> }[] = []
  let observed = receipt()
  let fail = false
  const wire = async (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); if (name === 'see') return structuredClone(observed); if (name === 'window') return { content: [{ type: 'text', text: 'scratch [ID: 45, ON-SCREEN]' }] } as ToolResult; if (fail) throw new Error('timeout after dispatch'); return { content: [{ type: 'text', text: 'typed' }] } as ToolResult }
  const execute = (name: string, args: Record<string, unknown>, ctx = context) => policy.execute!(name, args, ctx, wire)
  const observe = () => execute('see', { app_target: 'PID:12', window_id: 45 })
  return { policy, context, calls, execute, observe, setRevision: (next: number) => { revision = next }, setReceipt: (r: ToolResult) => { observed = r }, setFail: () => { fail = true } }
}
it('stores actual native receipt separately from opaque host observation and rejects fabricated/cross-run snapshots', async () => {
  const h = setup(); const result = await h.observe()
  expect(result.meta).toMatchObject({ snapshot: 'native-opaque', coordinate_context: { reference_id: 'reference-opaque' } })
  const args = { snapshot: 'native-opaque', on: 'native-element', text: '中文' }
  expect(await h.policy.assess!('type', args, h.context)).toMatchObject({ effect: 'interact', displayTarget: 'TextEdit · scratch' })
  await expect(h.policy.assess!('type', { ...args, snapshot: 'forged' }, h.context)).rejects.toThrow(/观察/)
  await expect(h.policy.assess!('type', args, { ...h.context, runId: 'another' })).rejects.toThrow(/观察/)
})
it('maps Retina pixels using actual image and logical sizes, rejects out-of-image points', () => {
  const coordinates = receipt().meta!.coordinate_context as Record<string, unknown>
  expect(imagePointToLogical('400,300', coordinates)).toBe('300,200')
  expect(() => imagePointToLogical('801,300', coordinates)).toThrow()
})
it('rejects changed geometry or process identity before dispatch, with no hidden argument rewrite', async () => {
  const h = setup(); await h.observe(); h.setReceipt(receipt('new', 200))
  await expect(h.execute('type', { snapshot: 'native-opaque', on: 'native-element', text: '中文' })).rejects.toThrow(/重新观察/)
  expect(h.calls.map(c => c.name)).toEqual(['see', 'see'])
})
it('keeps an unchanged exact AX target usable when unrelated sidebar geometry jitters', async () => {
  const h = setup(), initial = receipt()
  const decoration = { id: 'sidebar-label', ax_role: 'AXStaticText', is_actionable: false, bounds: { x: 20, y: 20, width: 30, height: 15 } }
  ;(initial.meta!.ui_elements as unknown[]).push(decoration)
  h.setReceipt(initial); await h.observe()
  const fresh = structuredClone(initial)
  ;(fresh.meta!.ui_elements as Record<string, unknown>[])[1].bounds = { ...decoration.bounds, width: 31 }
  h.setReceipt(fresh)
  await h.execute('click', { snapshot: 'native-opaque', on: 'native-element' })
  expect(h.calls.at(-1)).toEqual({ name: 'click', args: { snapshot: 'native-opaque', on: 'native-element', foreground: true } })
})

it('still rejects changed geometry of the selected AX target before dispatch', async () => {
  const h = setup(); await h.observe()
  const changed = receipt()
  ;(changed.meta!.ui_elements as Record<string, unknown>[])[0].bounds = { x: 120, y: 60, width: 200, height: 100 }
  h.setReceipt(changed)
  await expect(h.execute('click', { snapshot: 'native-opaque', on: 'native-element' })).rejects.toThrow(/失效/)
  expect(h.calls.some(call => call.name === 'click')).toBe(false)
})
it('consumes observation after dispatched timeout and never retries input', async () => {
  const h = setup(); await h.observe(); h.setFail()
  const args = { snapshot: 'native-opaque', on: 'native-element', text: '中文' }
  await expect(h.execute('type', args)).rejects.toThrow(/timeout/)
  await expect(h.execute('type', args)).rejects.toThrow(/观察/)
  expect(h.calls.filter(c => c.name === 'type')).toHaveLength(1)
})
it('stops between preflight and dispatch', async () => {
  const h = setup(); await h.observe(); const controller = new AbortController(); controller.abort()
  await expect(h.execute('type', { snapshot: 'native-opaque', text: '中文' }, { ...h.context, signal: controller.signal })).rejects.toThrow()
  expect(h.calls).toHaveLength(1)
})
it('hard-rejects hidden names, screenshot path, targetless see and shell/agent/browser surfaces', async () => {
  const h = setup()
  for (const name of ['agent', 'browser', 'analyze', 'code']) await expect(h.execute(name, {})).rejects.toThrow()
  await expect(h.execute('see', { app_target: 'PID:12', window_id: 45, path: '/tmp/user' })).rejects.toThrow()
  await expect(h.execute('see', {})).rejects.toThrow()
  await expect(h.execute('app', { action: 'launch', name: '/bin/sh' })).rejects.toThrow()
  await expect(h.execute('app', { action: 'launch', name: 'TextEdit', openTargets: ['/tmp/user'] })).rejects.toThrow()
  await expect(setup('/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal').observe()).rejects.toThrow()
  await expect(setup('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome').observe()).rejects.toThrow()
  expect(h.calls).toHaveLength(0)
})
it('keeps unknown app effects and risky menu/key operations behind confirmation', async () => {
  const h = setup('/Applications/Notes.app/Contents/MacOS/Notes'); await h.observe()
  expect((await h.policy.assess!('type', { snapshot: 'native-opaque', on: 'native-element', text: 'hi' }, h.context)).effect).toBe('unknown')
  const text = setup(); await text.observe()
  expect((await text.policy.assess!('type', { snapshot: 'native-opaque', on: 'native-element', text: 'hi', clear: true }, text.context)).effect).toBe('overwrite')
  expect((await text.policy.assess!('press', { snapshot: 'native-opaque', keys: 'cmd+c' }, text.context)).effect).toBe('unknown')
})
it('restricts discovery schemas and hidden dispatch using the real registry adapter', async () => {
  const h = setup(); const registry = new SimpleToolRegistry(); const adapter = new McpRegistryAdapter(registry, 'Peekaboo')
  adapter.register('service', 1, ['see', 'agent'].map(name => ({ name, inputSchema: { type: 'object', properties: { path: { type: 'string' }, window_id: { type: 'number' }, app_target: { type: 'string' } } } })), h.policy, () => true, name => (args, ctx) => h.execute(name, args, ctx))
  expect(adapter.definitions()).toHaveLength(1)
  expect(adapter.definitions()[0].parameters.properties).not.toHaveProperty('path')
  expect(await registry.execute(mcpToolName('service', 'agent'), {}, h.context)).toMatchObject({ isError: true })
  expect(await registry.execute(mcpToolName('service', 'see'), { path: '/tmp/user' }, h.context)).toMatchObject({ isError: true })
})
it('the saved all-operation permission covers native app actions in different conversations', async () => {
  const h = setup(), registry = new SimpleToolRegistry(), adapter = new McpRegistryAdapter(registry, 'Peekaboo')
  const sent: Record<string, unknown>[] = []
  adapter.register('service', 1, [{ name: 'app', inputSchema: { type: 'object', properties: { action: { type: 'string' }, name: { type: 'string' } } } }], h.policy, () => true,
    name => (args, context) => h.policy.execute!(name, args, context, async (_remote, wire) => {
      sent.push(wire); return { content: [], meta: { effect: 'confirmed' } }
    }), true)
  let prompts = 0
  const approvals = new ToolApprovalService(request => {
    prompts++; approvals.decide({ approvalId: request.id, revision: request.revision, decision: 'approve' })
  })
  for (const conversationId of ['conversation-1', 'conversation-2']) {
    await registry.execute(mcpToolName('service', 'app'), { action: 'launch', name: 'TextEdit' }, { ...h.context, conversationId,
      authorize: (assessment, checked) => approvals.authorize(checked.callId, assessment, checked) })
  }
  expect(prompts).toBe(0)
  expect(sent).toEqual([{ action: 'launch', name: 'TextEdit', foreground: true }, { action: 'launch', name: 'TextEdit', foreground: true }])
})

it('reports precise observed process generation only after a validated fresh capture', async () => {
  const h = setup(); const targets: string[] = []
  await h.execute('see', { app_target: 'PID:12', window_id: 45 }, { ...h.context, onObserved: target => targets.push(target) })
  expect(targets).toEqual(['peekaboo:service:12:45:9007199254740993123'])
  expect((await h.policy.assess!('type', { snapshot: 'native-opaque', on: 'native-element', text: 'x' }, h.context)).target).toBe(targets[0])
})

it('keeps a dispatched input without confirmed native effect unknown until a new observation', async () => {
  const h = setup(); await h.observe()
  const result = await h.execute('type', { snapshot: 'native-opaque', on: 'native-element', text: '中文' })
  expect(result.isError).toBe(true)
  expect(result.content).toContainEqual(expect.objectContaining({ type: 'text', text: expect.stringContaining('结果未知') }))
})

it('dispatches snapshot-bound append text without adding foreground or replacement intent', async () => {
  const h = setup(); await h.observe()
  const args = { snapshot: 'native-opaque', on: 'native-element', text: '中文\n literal \\n' }
  const original = structuredClone(args)
  await h.execute('type', args)
  expect(h.calls.at(-1)).toEqual({ name: 'type', args: original })
  expect(args).toEqual(original)
})

it('waits for overwrite approval then preserves the exact snapshot, element, clear and literal replacement', async () => {
  const h = setup(); await h.observe()
  const registry = new SimpleToolRegistry()
  registry.register({ name: 'type', description: 'type', parameters: { type: 'object' } }, (args, context) => h.execute('type', args, context), {
    assess: (args, context) => h.policy.assess!('type', args, context), validateObservation: h.policy.validateObservation
  })
  let requested!: (request: import('../src/shared/types').ApprovalRequest) => void
  const request = new Promise<import('../src/shared/types').ApprovalRequest>(resolve => { requested = resolve })
  const approvals = new ToolApprovalService(requested)
  const args = { snapshot: 'native-opaque', on: 'native-element', text: '完整原文\n中文替换。', clear: true }
  const original = structuredClone(args)
  const pending = registry.execute('type', args, { ...h.context, authorize: async (assessment, context) => {
    expect(assessment.effect).toBe('overwrite')
    await approvals.authorize('call', assessment, context)
  } })
  const approval = await request
  expect(approval.summary).toContain(JSON.stringify(original))
  expect(h.calls.map(call => call.name)).toEqual(['see'])
  approvals.decide({ approvalId: approval.id, revision: approval.revision, decision: 'approve' })
  expect((await pending).isError).toBe(true) // No confirmed native effect in this fixture: still unknown.
  expect(h.calls.at(-1)).toEqual({ name: 'type', args: original })
  expect(args).toEqual(original)
})

import { HerStore } from '../src/core/storage/store'
import { ToolApprovalService } from '../src/core/tools/approval'
import type { TaskRun } from '../src/shared/types'
it('does not auto-trust a lookalike TextEdit path outside the actual system application', async () => {
  const h = setup('/tmp/System/Applications/TextEdit.app/Contents/MacOS/TextEdit'); await h.observe()
  expect((await h.policy.assess!('type', { snapshot: 'native-opaque', on: 'native-element', text: 'hi' }, h.context)).effect).toBe('unknown')
})
it('rejects key delivery when the focused native element changed since approval', async () => {
  const h = setup(); const initial = receipt(); initial.meta!.focused_element = { identifier: 'document', role: 'AXTextArea', processIdentifier: 12, windowID: 45 }
  h.setReceipt(initial); await h.observe()
  const changed = structuredClone(initial); (changed.meta!.focused_element as Record<string, unknown>).identifier = 'another-field'; h.setReceipt(changed)
  await expect(h.execute('press', { snapshot: 'native-opaque', keys: 'cmd+c' })).rejects.toThrow(/观察/)
  expect(h.calls.filter(c => c.name === 'press')).toHaveLength(0)
})

it('preserves receipt-pinned native key chords without incompatible foreground delivery', async () => {
  const h = setup(); await h.observe()
  const args = { snapshot: 'native-opaque', keys: ['cmd+c'] }
  await h.execute('press', args)
  expect(h.calls.at(-1)).toEqual({ name: 'press', args })
})

it('requires confirmation for bootstrap focus of an exact discovered PID and window', async () => {
  const h = setup()
  await h.execute('window', { action: 'list', app: 'PID:12' })
  expect(await h.policy.assess!('window', { action: 'focus', app: 'PID:12', window_id: 45 }, h.context)).toMatchObject({ effect: 'unknown', target: 'peekaboo:service:12:45:focus' })
  await expect(h.policy.assess!('window', { action: 'focus', app: 'PID:12' }, h.context)).rejects.toThrow()
  await expect(h.policy.assess!('window', { action: 'focus', app: 'PID:12', window_id: 99 }, h.context)).rejects.toThrow()
  await h.execute('window', { action: 'focus', app: 'PID:12', window_id: 45 })
  expect(h.calls.at(-1)).toEqual({ name: 'window', args: { action: 'focus', app: 'PID:12', window_id: 45 } })
})

it('invalidates observation after service revision or conversation changes', async () => {
  const h = setup(); await h.observe()
  const args = { snapshot: 'native-opaque', on: 'native-element', text: '中文' }
  await expect(h.policy.assess!('type', args, { ...h.context, conversationId: 'other' })).rejects.toThrow(/观察/)
  h.setRevision(2)
  await expect(h.policy.assess!('type', args, h.context)).rejects.toThrow(/观察/)
})

it('cannot authorize a document menu click on window B using a background observation of window A in the same PID', async () => {
  const h = setup(); const result = await h.observe()
  const observationId = result.meta!.observation_id
  // A (45) is observed; the app-global menu can instead affect frontmost B (46).
  const menu = { action: 'click', observation_id: observationId, path: 'File > Close' }
  await expect(h.policy.assess!('menu', menu, h.context)).rejects.toThrow(/菜单/)
  let affectedWindow: number | undefined
  const frontmostWindow = { pid: 12, window_id: 46 }
  await expect(h.policy.execute!('menu', menu, h.context, async () => { affectedWindow = frontmostWindow.window_id; return { content: [] } })).rejects.toThrow(/菜单/)
  expect(affectedWindow).toBeUndefined()
  expect(h.calls.filter(call => call.name === 'menu')).toHaveLength(0)
  const schema = h.policy.parameters!('menu', { properties: { action: { type: 'string', enum: ['list', 'click'] }, path: { type: 'string' }, item: { type: 'string' } } })
  expect(schema.properties).toMatchObject({ action: { enum: ['list'] } })
  expect(schema.properties).not.toHaveProperty('path')
  expect(schema.properties).not.toHaveProperty('item')
})

function verifiedDocument(value: string, windowId = 45): ToolResult {
  const after = receipt('after')
  Object.assign(after.meta!.target_receipt as object, { window_id: windowId })
  Object.assign((after.meta!.coordinate_context as Record<string, unknown>).window as object, { window_id: windowId })
  Object.assign((after.meta!.ui_elements as Record<string, unknown>[])[0], { identifier: 'First Text View', value })
  return after
}

it('a desktop action that waited for the queue cannot reuse the observation the earlier action consumed', async () => {
  const { ResourceQueue } = await import('../src/core/tools/resources')
  const h = setup(), registry = new SimpleToolRegistry(), adapter = new McpRegistryAdapter(registry, 'Peekaboo'), queue = new ResourceQueue()
  const clicks: Record<string, unknown>[] = []
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const props = { snapshot: { type: 'string' }, on: { type: 'string' }, app_target: { type: 'string' }, window_id: { type: 'number' } }
  adapter.register('service', 1, ['see', 'click'].map(name => ({ name, inputSchema: { type: 'object', properties: props } })), h.policy, () => true,
    name => (args, ctx) => h.policy.execute!(name, args, ctx, async (remote, wire) => {
      if (remote === 'see') return structuredClone(receipt())
      clicks.push(wire); await held; return { content: [{ type: 'text', text: 'clicked' }] }
    }), true)
  const context = { ...h.context, resources: queue }
  await registry.execute(mcpToolName('service', 'see'), { app_target: 'PID:12', window_id: 45 }, context)
  const args = { snapshot: 'native-opaque', on: 'native-element' }
  const first = registry.execute(mcpToolName('service', 'click'), args, { ...context, callId: 'first' })
  const second = registry.execute(mcpToolName('service', 'click'), args, { ...context, callId: 'second' })
  await new Promise(resolve => setImmediate(resolve))
  expect(clicks).toHaveLength(1)
  const rejected = expect(second).rejects.toThrow(/失效|观察/)
  release()
  // The first click was dispatched but its effect is unconfirmed, so it is reported unknown and consumes the observation.
  expect(await first).toMatchObject({ isError: true, content: [{ text: 'clicked' }, { text: expect.stringContaining('结果未知') }] })
  await rejected
  expect(clicks).toHaveLength(1)
})
