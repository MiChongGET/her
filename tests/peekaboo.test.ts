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
import { TaskExecution } from '../src/core/tools/execution'
import { ToolApprovalService } from '../src/core/tools/approval'
import type { TaskRun } from '../src/shared/types'
it('records native preflight drift as failed without ever dispatching the final action', async () => {
  const h = setup(), store = new HerStore(':memory:'), conversation = store.createConversation(), registry = new SimpleToolRegistry()
  const sent: string[] = []
  for (const name of ['see', 'click']) registry.register({ name, description: name, parameters: {} }, (args, context) => h.policy.execute!(name, args, context, async (remote, _wire, phase = 'action') => {
    if (h.policy.deferDispatch) context.markDispatched?.(phase)
    sent.push(remote)
    const result = receipt('snapshot', sent.length > 1 ? 200 : 100)
    if (h.policy.deferDispatch && phase === 'preflight') context.completePreflight?.()
    return result
  }), { allowAllOperations: true, deferDispatch: h.policy.deferDispatch, assess: (args, context) => h.policy.assess!(name, args, context), validateObservation: h.policy.validateObservation })
  const run: TaskRun = { id: 'preflight', requestId: 'preflight', conversationId: conversation.id, assistantMessageId: 'm', status: 'running', providerId: 'p', model: 'm', toolCallsCount: 0, activeMs: 0 }
  const task = new TaskExecution(run, store, registry, new ToolApprovalService(), new AbortController().signal, () => {})
  try {
    await task.execute(task.prepare({ id: 'observe', name: 'see', arguments: { app_target: 'PID:12', window_id: 45 } }))
    await task.execute(task.prepare({ id: 'click', name: 'click', arguments: { snapshot: 'snapshot', on: 'native-element' } }))
    expect(store.listToolCalls(run.id)[1]).toMatchObject({ status: 'failed', dispatchPhase: 'preflight-completed' })
    expect(task.hasUnknownResults()).toBe(false)
    expect(sent).toEqual(['see', 'see'])
  } finally { task.finish('completed'); store.close() }
})

it.each([
  { error: "Failed to launch application: Application 'Notepad' not found", expected: 'failed' },
  { error: 'Failed to launch application: timed out', expected: 'unknown' },
  { error: "Failed to launch application: Application 'AnotherApp' not found", expected: 'unknown' }
])('classifies a native launch error from its exact bound app evidence: $expected / $error', async ({ error, expected }) => {
  const h = setup(), store = new HerStore(':memory:'), conversation = store.createConversation(), registry = new SimpleToolRegistry()
  let sent = 0
  registry.register({ name: 'app', description: 'Native app', parameters: {} }, (args, context) => h.policy.execute!('app', args, context, async () => {
    sent++
    return sent === 1 ? { isError: true, content: [{ type: 'text', text: error }], meta: { effect: 'not_applied' } } : { content: [], meta: { effect: 'confirmed' } }
  }), { allowAllOperations: true, assess: (args, context) => h.policy.assess!('app', args, context) })
  const run: TaskRun = { id: 'launch', requestId: 'launch', conversationId: conversation.id, assistantMessageId: 'm', status: 'running', providerId: 'p', model: 'm', toolCallsCount: 0, activeMs: 0 }
  const task = new TaskExecution(run, store, registry, new ToolApprovalService(), new AbortController().signal, () => {})
  const launch = (id: string, name: string) => task.execute(task.prepare({ id, name: 'app', arguments: { action: 'launch', name } }))
  try {
    expect((await launch('missing', 'Notepad')).isError).toBe(true)
    expect(store.listToolCalls(run.id)[0].status).toBe(expected)
    expect(task.hasUnknownResults()).toBe(expected === 'unknown')
    if (expected === 'failed') {
      await launch('native-editor', 'TextEdit')
      expect(sent).toBe(2)
      expect(store.listToolCalls(run.id)[1].status).toBe('succeeded')
    } else {
      await expect(launch('must-not-retry', 'TextEdit')).rejects.toThrow(/未知/)
      expect(sent).toBe(1)
    }
  } finally { task.finish('completed'); store.close() }
})

it('reconciles a persisted unknown through a recreated adapter only for the same process generation', async () => {
  const store = new HerStore(':memory:')
  const conversation = store.createConversation()
  function runtime(id: string, unknown: string[] = []) {
    const h = setup(); const registry = new SimpleToolRegistry()
    for (const name of ['see', 'type']) registry.register({ name, description: name, parameters: { type: 'object' } }, (args, context) => h.execute(name, args, context), { assess: (args, context) => h.policy.assess!(name, args, context), validateObservation: h.policy.validateObservation })
    const run: TaskRun = { id, conversationId: conversation.id, requestId: id, assistantMessageId: id, providerId: 'p', model: 'm', status: 'running', toolCallsCount: 0, activeMs: 0 }
    const task = new TaskExecution(run, store, registry.snapshot(), new ToolApprovalService(() => {}), new AbortController().signal, () => {}, unknown)
    const execute = (callId: string, name: string, args: Record<string, unknown>) => task.execute(task.prepare({ id: callId, name, arguments: args }))
    return { h, task, execute }
  }
  const first = runtime('first')
  const observe = { app_target: 'PID:12', window_id: 45 }
  await first.execute('see', 'see', observe)
  await first.execute('type', 'type', { snapshot: 'native-opaque', on: 'native-element', text: '中文' })
  expect(store.listToolCalls('first').at(-1)?.status).toBe('unknown')
  first.task.finish('paused')
  const second = runtime('second', store.getUnknownToolTargets(conversation.id))
  try {
    const other = receipt(); (other.meta!.target_receipt as Record<string, unknown>).process_start_identity_decimal = '9007199254740993124'
    second.h.setReceipt(other); await second.execute('reused', 'see', observe)
    expect(second.task.hasUnknownResults()).toBe(true)
    second.h.setReceipt(receipt()); await second.execute('same', 'see', observe)
    expect(second.task.hasUnknownResults()).toBe(false)
  } finally { second.task.finish('completed'); store.close() }
})

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

function verificationRuntime(mode: 'type' | 'new-document' | 'new-document-key', after: ToolResult, windowsAfter: string | (() => string) = 'scratch [ID: 46, ON-SCREEN]',
  native: ToolResult = { isError: true, content: [{ type: 'text', text: 'Native effect unverified' }], meta: { effect: 'unverifiable', state: 'dispatched_unverified', dispatch_state: 'dispatched', mutation_dispatched: true } }) {
  const h = setup(), store = new HerStore(':memory:'), conversation = store.createConversation(), registry = new SimpleToolRegistry()
  const before = receipt('before')
  const element = (before.meta!.ui_elements as Record<string, unknown>[])[0]
  Object.assign(element, mode !== 'new-document'
    ? { identifier: 'First Text View', value: '', selected_text_range: { location: 0, length: 0 } }
    : { ax_role: 'AXButton', identifier: 'NewDocumentButton', is_enabled: true })
  let mutated = false, prompts = 0
  const sent: string[] = []
  for (const name of ['see', 'click', 'type', 'press']) registry.register({ name, description: name, parameters: {} }, (args, context) => h.policy.execute!(name, args, context, async (remote, wire, phase = 'action') => {
    context.markDispatched?.(phase)
    sent.push(remote)
    let result: ToolResult
    if (remote === 'see') result = structuredClone(mutated ? after : before)
    else if (remote === 'window') result = { content: [{ type: 'text', text: mutated ? typeof windowsAfter === 'function' ? windowsAfter() : windowsAfter : 'Open [ID: 45, ON-SCREEN]' }] }
    else { mutated = true; result = structuredClone(native) }
    if (phase === 'preflight' && !result.isError) context.completePreflight?.()
    return result
  }), { allowAllOperations: true, deferDispatch: true, assess: (args, context) => h.policy.assess!(name, args, context), validateObservation: h.policy.validateObservation })
  const run: TaskRun = { id: 'verify', requestId: 'verify', conversationId: conversation.id, assistantMessageId: 'm', status: 'running', providerId: 'p', model: 'm', toolCallsCount: 0, activeMs: 0 }
  const task = new TaskExecution(run, store, registry, new ToolApprovalService(() => { prompts++ }), new AbortController().signal, () => {})
  const execute = (id: string, name: string, args: Record<string, unknown>) => task.execute(task.prepare({ id, name, arguments: args }))
  return { store, task, sent, before, get prompts() { return prompts }, execute, close: () => { task.finish('completed'); store.close() } }
}

function verifiedDocument(value: string, windowId = 45): ToolResult {
  const after = receipt('after')
  Object.assign(after.meta!.target_receipt as object, { window_id: windowId })
  Object.assign((after.meta!.coordinate_context as Record<string, unknown>).window as object, { window_id: windowId })
  Object.assign((after.meta!.ui_elements as Record<string, unknown>[])[0], { identifier: 'First Text View', value })
  return after
}

it('automatically confirms Chinese input from an exact native readback without a manual resolution or replay', async () => {
  const h = verificationRuntime('type', verifiedDocument('你好世界'))
  try {
    await h.execute('see', 'see', { app_target: 'PID:12', window_id: 45 })
    const result = await h.execute('input', 'type', { snapshot: 'before', on: 'native-element', text: '你好世界' })
    expect(result.isError).not.toBe(true)
    expect(result.meta).toMatchObject({ effect: 'confirmed', host_verification: { kind: 'text_value', value: '你好世界', native_outcome: { isError: true, meta: { state: 'dispatched_unverified' } } } })
    expect(h.store.listToolCalls('verify').at(-1)?.status).toBe('succeeded')
    expect(h.store.listUnresolvedToolCalls(h.task.run.conversationId)).toEqual([])
    expect(h.task.hasUnknownResults()).toBe(false)
    expect(h.sent.filter(x => x === 'type')).toHaveLength(1)
    expect(h.prompts).toBe(0)
  } finally { h.close() }
})

it('does not ask for manual resolution when the verified native adapter explicitly refuses before dispatch', async () => {
  const refused: ToolResult = { isError: true, content: [{ type: 'text', text: 'snapshot is only supported for receipt-pinned background press' }], meta: { state: 'refused', effect: 'refused', dispatch_state: 'none', mutation_dispatched: false, evidence: 'request_refused' } }
  const h = verificationRuntime('type', verifiedDocument(''), undefined, refused)
  try {
    await h.execute('see', 'see', { app_target: 'PID:12', window_id: 45 })
    await h.execute('input', 'type', { snapshot: 'before', on: 'native-element', text: '你好世界' })
    expect(h.store.listToolCalls('verify').at(-1)?.status).toBe('failed')
    expect(h.store.listUnresolvedToolCalls(h.task.run.conversationId)).toEqual([])
    expect(h.task.hasUnknownResults()).toBe(false)
  } finally { h.close() }
})

it('automatically confirms a new TextEdit document from a unique new blank window after the picker closes', async () => {
  const h = verificationRuntime('new-document', verifiedDocument('', 46))
  try {
    await h.execute('see', 'see', { app_target: 'PID:12', window_id: 45 })
    const result = await h.execute('new', 'click', { snapshot: 'before', on: 'native-element' })
    expect(result.isError).not.toBe(true)
    expect(result.meta).toMatchObject({ effect: 'confirmed', host_verification: { kind: 'new_document', window_id: 46 } })
    expect(h.store.listUnresolvedToolCalls(h.task.run.conversationId)).toEqual([])
    expect(h.sent.filter(x => x === 'click')).toHaveLength(1)
    expect(h.prompts).toBe(0)
  } finally { h.close() }
})

it('automatically confirms TextEdit Cmd+N while retaining the original document window', async () => {
  const h = verificationRuntime('new-document-key', verifiedDocument('', 46), 'original [ID: 45, ON-SCREEN]\nscratch [ID: 46, ON-SCREEN]')
  try {
    await h.execute('see', 'see', { app_target: 'PID:12', window_id: 45 })
    const result = await h.execute('new', 'press', { snapshot: 'before', keys: ['cmd+n'] })
    expect(result.isError).not.toBe(true)
    expect(result.meta).toMatchObject({ effect: 'confirmed', host_verification: { kind: 'new_document', window_id: 46 } })
    expect(h.store.listUnresolvedToolCalls(h.task.run.conversationId)).toEqual([])
    expect(h.sent.filter(x => x === 'press')).toHaveLength(1)
    expect(h.prompts).toBe(0)
  } finally { h.close() }
})

it('waits for the new native window to appear using bounded reads without replaying Cmd+N', async () => {
  let reads = 0
  const h = verificationRuntime('new-document-key', verifiedDocument('', 46), () => ++reads === 1 ? 'original [ID: 45, ON-SCREEN]' : 'original [ID: 45, ON-SCREEN]\nscratch [ID: 46, ON-SCREEN]')
  try {
    await h.execute('see', 'see', { app_target: 'PID:12', window_id: 45 })
    const result = await h.execute('new', 'press', { snapshot: 'before', keys: ['cmd+n'] })
    expect(result.isError).not.toBe(true)
    expect(result.meta).toMatchObject({ effect: 'confirmed', host_verification: { kind: 'new_document', attempts: 2 } })
    expect(h.store.listUnresolvedToolCalls(h.task.run.conversationId)).toEqual([])
    expect(h.sent.filter(x => x === 'press')).toHaveLength(1)
  } finally { h.close() }
})

it.each(['wrong text', 'reused process', 'wrong field', 'failed observation'])('keeps unverifiable input blocked without replay: %s', async mode => {
  const after = verifiedDocument(mode === 'wrong text' ? '你好世界你好世界' : '你好世界')
  if (mode === 'reused process') (after.meta!.target_receipt as Record<string, unknown>).process_start_identity_decimal = '9007199254740993124'
  if (mode === 'wrong field') (after.meta!.ui_elements as Record<string, unknown>[])[0].identifier = 'another field'
  if (mode === 'failed observation') after.isError = true
  const h = verificationRuntime('type', after)
  try {
    await h.execute('see', 'see', { app_target: 'PID:12', window_id: 45 })
    const result = await h.execute('input', 'type', { snapshot: 'before', on: 'native-element', text: '你好世界' })
    expect(result.isError).toBe(true)
    expect(h.task.hasUnknownResults()).toBe(true)
    expect(h.store.listUnresolvedToolCalls(h.task.run.conversationId)).toHaveLength(1)
    expect(h.sent.filter(x => x === 'type')).toHaveLength(1)
    expect(h.prompts).toBe(0)
  } finally { h.close() }
})

it.each([
  { before: 'A😀B', range: { location: 1, length: 2 }, clear: false, expected: 'A你好世界B' },
  { before: 'old content', range: { location: 3, length: 0 }, clear: true, expected: '你好世界' }
])('verifies text using the actual selection and replacement mode: $expected', async ({ before, range, clear, expected }) => {
  const h = verificationRuntime('type', verifiedDocument(expected))
  Object.assign((h.before.meta!.ui_elements as Record<string, unknown>[])[0], { value: before, selected_text_range: range })
  try {
    await h.execute('see', 'see', { app_target: 'PID:12', window_id: 45 })
    const result = await h.execute('input', 'type', { snapshot: 'before', on: 'native-element', text: '你好世界', clear })
    expect(result.meta).toMatchObject({ effect: 'confirmed', host_verification: { value: expected } })
    expect(h.task.hasUnknownResults()).toBe(false)
  } finally { h.close() }
})

it.each([
  { windows: 'Open [ID: 45, ON-SCREEN]\nscratch [ID: 46, ON-SCREEN]', value: '' },
  { windows: 'scratch [ID: 46, ON-SCREEN]\nanother [ID: 47, ON-SCREEN]', value: '' },
  { windows: 'scratch [ID: 46, ON-SCREEN]', value: 'existing content' }
])('does not confirm creation from ambiguous windows or a nonblank document: $windows / $value', async ({ windows, value }) => {
  const h = verificationRuntime('new-document', verifiedDocument(value, 46), windows)
  try {
    await h.execute('see', 'see', { app_target: 'PID:12', window_id: 45 })
    const result = await h.execute('new', 'click', { snapshot: 'before', on: 'native-element' })
    expect(result.isError).toBe(true)
    expect(h.task.hasUnknownResults()).toBe(true)
    expect(h.sent.filter(x => x === 'click')).toHaveLength(1)
  } finally { h.close() }
})
