import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import type { ActionAssessment, ToolResult } from '../../shared/types'
import type { ToolExecutionContext } from '../tools/types'
import type { McpConnectionManager } from './manager'
import type { McpServicePolicy } from './registry-adapter'
import { PEEKABOO_TOOLS } from './presets'

const exec = promisify(execFile)
const fields: Record<string, string[]> = {
  app: ['action', 'name', 'bundleId'], window: ['action', 'app', 'window_id', 'include_window_details'],
  see: ['app_target', 'window_id', 'include_elements', 'fresh', 'ocr'],
  click: ['snapshot', 'on', 'coords', 'coordinate_reference', 'coordinate_space'],
  type: ['snapshot', 'on', 'text', 'clear'], press: ['snapshot', 'keys'],
  scroll: ['snapshot', 'direction', 'amount', 'on', 'coords', 'coordinate_reference', 'coordinate_space'],
  menu: ['observation_id', 'action']
}
function mutationResult(result: ToolResult): ToolResult {
  if (result.isError || result.meta?.effect === 'confirmed') return result
  return { ...result, isError: true, content: [...result.content, { type: 'text', text: '动作已派发但没有确认效果，结果未知；必须重新观察，不能自动重复输入或点击。' }] }
}
const stale = () => new Error('观察已失效或目标发生变化，请重新观察后再决定，不能重复未知动作。')
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown): string => typeof value === 'string' && value.length > 0 ? value : ''
const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : NaN
const positive = (value: unknown) => number(value) > 0
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const textEdit = '/System/Applications/TextEdit.app/Contents/MacOS/TextEdit'
function windowIds(result: ToolResult): number[] {
  return result.isError ? [] : [...new Set(result.content.flatMap(block => block.type === 'text' ? [...block.text.matchAll(/\[ID: (\d+),/g)].map(match => Number(match[1])) : []))]
}
function expectedText(element: Record<string, unknown>, args: Record<string, unknown>): string | undefined {
  if (element.ax_role !== 'AXTextArea' || !text(element.identifier) || typeof element.value !== 'string') return
  if (args.clear === true) return String(args.text)
  const range = object(element.selected_text_range)
  if (!Number.isSafeInteger(range.location) || !Number.isSafeInteger(range.length) || number(range.location) < 0 || number(range.length) < 0 ||
      number(range.location) + number(range.length) > element.value.length) return
  return element.value.slice(0, number(range.location)) + args.text + element.value.slice(number(range.location) + number(range.length))
}
// These known execution/delegation surfaces are refused. Other apps still require unknown-effect confirmation.
const excluded = /terminal|iterm|warp|ghostty|script editor|scripteditor|automator|shortcuts|osascript|visual studio code|vscode|cursor|xcode|codex|claude|chatgpt|chrome|chromium|safari|firefox|microsoft edge|arc\.app|brave/i
function appIdentity(value: unknown): string {
  const name = text(value)
  if (!name || name.length > 200 || /[/\\:\n\r]/.test(name) || !/^[\p{L}\p{N} ._()-]+$/u.test(name) || excluded.test(name)) throw new Error('不支持此应用目标；脚本、代理和浏览器操作不能绕过对应受控入口。')
  return name
}
interface Observation {
  id: string; snapshot: string; reference: string; runId: string; conversationId: string; revision: number
  pid: number; windowId: number; generation: string; coordinates: Record<string, unknown>; elements: Record<string, unknown>[]
  executable: string; display: string; focusedElement: Record<string, unknown>
}

export function imagePointToLogical(coords: string, coordinate: Record<string, unknown>): string {
  const values = coords.split(',').map(value => Number(value.trim()))
  const size = object(coordinate.delivered_image_size), bounds = object(coordinate.logical_bounds)
  if (values.length !== 2 || values.some(value => !Number.isFinite(value)) || !positive(size.width) || !positive(size.height) ||
      values[0] < 0 || values[1] < 0 || values[0] >= number(size.width) || values[1] >= number(size.height) ||
      !positive(bounds.width) || !positive(bounds.height) || !Number.isFinite(number(bounds.x)) || !Number.isFinite(number(bounds.y)) ||
      coordinate.origin !== 'top_left' || coordinate.logical_space !== 'global_display_points' || coordinate.viewport != null) throw stale()
  return `${number(bounds.x) + values[0] * number(bounds.width) / number(size.width)},${number(bounds.y) + values[1] * number(bounds.height) / number(size.height)}`
}

// Called only after Host dependency verification, once per runtime connection. No server annotations confer trust.
export function createPeekabooAdapter(manager: McpConnectionManager, serviceId: string,
  options: { processExecutable?: (pid: number) => Promise<string> } = {}): McpServicePolicy {
  const processExecutable = options.processExecutable ?? (async pid => (await exec('/bin/ps', ['-p', String(pid), '-o', 'comm='], { timeout: 5000, maxBuffer: 8192 })).stdout.trim())
  let observation: Observation | undefined
  let discoveredWindows: { runId: string; conversationId: string; revision: number; pid: string; ids: number[] } | undefined
  const targetOf = (current: Observation) => `peekaboo:${serviceId}:${current.pid}:${current.windowId}:${current.generation}`
  const revision = () => manager.getStatus(serviceId).revision
  const checkProcess = async (pid: number) => {
    const executable = await processExecutable(pid)
    if (!executable.includes('.app/Contents/MacOS/') || excluded.test(executable)) throw new Error('此进程不是受支持的原生应用；脚本、代理和浏览器目标已禁用。')
    return executable
  }
  function validate(name: string, args: Record<string, unknown>): void {
    if (name === 'menu' && args.action !== 'list') throw new Error('菜单仅支持只读列表；原生菜单点击无法保证文档窗口目标。')
    if (!PEEKABOO_TOOLS.includes(name as typeof PEEKABOO_TOOLS[number]) || Object.keys(args).some(key => !fields[name].includes(key))) throw new Error('Peekaboo 工具或参数不在允许清单中。')
    if (name === 'app') {
      if (!['list', 'launch', 'focus'].includes(String(args.action))) throw new Error('不支持此应用子操作。')
      if (args.action !== 'list') { if (!!args.name === !!args.bundleId) throw new Error('只可指定一个应用身份。'); appIdentity(args.name ?? args.bundleId) }
    }
    if (name === 'window' && (!['list', 'focus'].includes(String(args.action)) || !/^PID:[1-9]\d*$/.test(String(args.app)) || args.action === 'focus' && !Number.isSafeInteger(args.window_id))) throw new Error('窗口发现必须指定准确 PID。')
    if (name === 'see' && (!/^PID:[1-9]\d*$/.test(String(args.app_target)) || !Number.isSafeInteger(args.window_id) || number(args.window_id) < 1 || args.fresh === false || args.include_elements === false)) throw new Error('观察必须指定准确 PID 和窗口，并读取新观察。')
    if (name === 'type' && (typeof args.text !== 'string' || !text(args.on))) throw new Error('请输入明确的文本。')
    if (name === 'press' && (Array.isArray(args.keys) ? args.keys.length === 0 || args.keys.some(key => !text(key)) : !text(args.keys))) throw new Error('请输入明确的按键。')
    if (name === 'click' && (!!args.on === !!args.coords) || name === 'scroll' && args.on && args.coords) throw new Error('请指定唯一动作目标。')
    if (name === 'scroll' && !args.on && !args.coords) throw new Error('滚动必须指定观察中的元素或图片坐标。')
    if (name === 'scroll' && !['up', 'down', 'left', 'right'].includes(String(args.direction))) throw new Error('滚动方向不正确。')
  }
  function requireDiscovered(args: Record<string, unknown>, context: ToolExecutionContext): void {
    if (!discoveredWindows || discoveredWindows.runId !== context.runId || discoveredWindows.conversationId !== context.conversationId || discoveredWindows.revision !== revision() || discoveredWindows.pid !== args.app || !discoveredWindows.ids.includes(number(args.window_id))) throw new Error('请先发现此 PID 的准确窗口，再确认聚焦目标。')
  }
  function get(args: Record<string, unknown>, context: ToolExecutionContext): Observation {
    const current = observation
    if (!current || current.runId !== context.runId || current.conversationId !== context.conversationId || current.revision !== revision() ||
        (args.observation_id !== undefined ? args.observation_id !== current.id : args.snapshot !== current.snapshot)) throw stale()
    if (args.on && !current.elements.some(element => element.id === args.on && element.is_actionable === true)) throw stale()
    if (args.coordinate_reference !== undefined && args.coordinate_reference !== current.reference) throw stale()
    if (args.coords) {
      if (args.coordinate_space !== 'image_pixels' || args.coordinate_reference !== current.reference) throw new Error('坐标动作只接受此观察图片的 image_pixels 及原始 coordinate_reference。')
      imagePointToLogical(String(args.coords), current.coordinates)
    }
    return current
  }
  async function parse(result: ToolResult, args: Record<string, unknown>, context: ToolExecutionContext): Promise<Observation> {
    const meta = result.meta ?? {}, target = object(meta.target_receipt), coordinates = object(meta.coordinate_context)
    const window = object(coordinates.window), bounds = object(coordinates.logical_bounds), size = object(coordinates.delivered_image_size)
    if (result.isError || meta.used_cache !== false || !text(meta.snapshot_id) || !text(coordinates.reference_id) || coordinates.version !== 1 ||
        target.pid !== Number(String(args.app_target).slice(4)) || target.window_id !== args.window_id || window.window_id !== args.window_id ||
        !/^\d+$/.test(text(target.process_start_identity_decimal)) || !positive(bounds.width) || !positive(bounds.height) ||
        !Number.isFinite(number(bounds.x)) || !Number.isFinite(number(bounds.y)) || !positive(size.width) || !positive(size.height) ||
        coordinates.origin !== 'top_left' || coordinates.logical_space !== 'global_display_points' || coordinates.viewport != null || !Array.isArray(meta.ui_elements) ||
        !result.content.some(block => block.type === 'image')) throw stale()
    const executable = await checkProcess(number(target.pid))
    context.signal.throwIfAborted()
    return { id: randomUUID(), snapshot: text(meta.snapshot_id), reference: text(coordinates.reference_id), runId: context.runId, conversationId: context.conversationId,
      revision: revision(), pid: number(target.pid), windowId: number(target.window_id), generation: text(target.process_start_identity_decimal), coordinates,
      elements: meta.ui_elements.map(object), focusedElement: object(meta.focused_element), executable, display: `${executable.split('.app/')[0].split('/').at(-1)} · ${text(window.title) || `窗口 ${target.window_id}`}` }
  }
  const policy: McpServicePolicy = {
    deferDispatch: true,
    allowedTools: PEEKABOO_TOOLS,
    parameters(name, schema) {
      const source = object(schema.properties)
      const properties = Object.fromEntries(fields[name].filter(key => key in source).map(key => [key, source[key]]))
      if (name === 'menu') {
        properties.observation_id = { type: 'string', description: 'Host observation_id from the latest see result.' }
        properties.action = { type: 'string', enum: ['list'], description: 'Read application menus only; menu clicks cannot bind a document window.' }
      }
      const required = name === 'see' ? ['app_target', 'window_id'] : ['click', 'type', 'press', 'scroll'].includes(name) ? ['snapshot', ...(name === 'type' ? ['text'] : name === 'press' ? ['keys'] : name === 'scroll' ? ['direction'] : [])] : name === 'menu' ? ['observation_id', 'action'] : ['action']
      return { type: 'object', additionalProperties: false, properties, required }
    },
    async assess(name, args, context): Promise<ActionAssessment> {
      context.signal.throwIfAborted(); validate(name, args)
      if (name === 'see' || name === 'window') {
        const pid = Number(String(args.app_target ?? args.app).slice(4)); await checkProcess(pid)
        if (name === 'window' && args.action === 'focus') {
          requireDiscovered(args, context)
          return { effect: 'unknown', target: `peekaboo:${serviceId}:${pid}:${args.window_id}:focus`, summary: `前台聚焦 PID ${pid} / 窗口 ${args.window_id}` }
        }
        return { effect: 'read', target: `peekaboo:${serviceId}:${pid}${name === 'see' ? `:${args.window_id}` : ''}`, summary: `观察原生应用 PID ${pid}${name === 'see' ? ` / 窗口 ${args.window_id}` : '窗口列表'}` }
      }
      if (name === 'app') return { effect: args.action === 'list' ? 'read' : 'unknown', target: `peekaboo:${serviceId}:app:${args.name ?? args.bundleId ?? 'list'}`, summary: `${args.action} ${args.name ?? args.bundleId ?? '应用列表'}` }
      const current = get(args, context)
      const element = current.elements.find(item => item.id === args.on)
      const simpleText = current.executable === textEdit && element?.ax_role === 'AXTextArea' && element?.is_value_settable === true
      const effect = name === 'menu' && args.action === 'list' ? 'read' : name === 'type' && args.clear === true ? 'overwrite' : name === 'type' && simpleText ? 'interact' : 'unknown'
      return { effect, target: targetOf(current) + (name === 'menu' && args.action === 'list' ? ':menu' : ''), displayTarget: current.display, observationId: current.id,
        summary: `${current.display} · ${name} ${JSON.stringify(args)}` }
    },
    validateObservation: (assessment, context) => !!observation && observation.id === assessment.observationId && observation.runId === context.runId && observation.conversationId === context.conversationId && observation.revision === revision(),
    async execute(name, args, context, dispatch) {
      context.signal.throwIfAborted(); validate(name, args)
      if (name === 'see') {
        observation = undefined
        await checkProcess(Number(String(args.app_target).slice(4))); context.signal.throwIfAborted()
        const request = { ...args, include_elements: true, fresh: true, web_focus: false }
        const result = await dispatch('see', request)
        if (result.isError) return result
        observation = await parse(result, request, context)
        context.onObserved?.(targetOf(observation))
        return { ...result, meta: { ...result.meta, snapshot: observation.snapshot, observation_id: observation.id }, content: [...result.content, { type: 'text', text: `Host observation_id: ${observation.id}; target: ${observation.display}. Actions require this snapshot; re-observe after every action.` }] }
      }
      if (name === 'window') {
        await checkProcess(Number(String(args.app).slice(4))); context.signal.throwIfAborted()
        if (args.action === 'focus') {
          requireDiscovered(args, context); observation = undefined
          return mutationResult(await dispatch(name, args))
        }
        discoveredWindows = undefined
        const result = await dispatch(name, args)
        if (!result.isError) discoveredWindows = { runId: context.runId, conversationId: context.conversationId, revision: revision(), pid: String(args.app), ids: result.content.flatMap(block => block.type === 'text' ? [...block.text.matchAll(/\[ID: (\d+),/g)].map(match => Number(match[1])) : []) }
        return result
      }
      if (name === 'app') {
        if (args.action !== 'list') observation = undefined
        const result = await dispatch(name, { ...args, ...(args.action !== 'list' ? { foreground: true } : {}) })
        // The verified native adapter recognizes only this exact failure for the requested app.
        // Remote metadata cannot declare an arbitrary failed mutation safe to repeat.
        if (args.action === 'launch' && result.isError && result.content.length === 1 && result.content[0].type === 'text' &&
            result.content[0].text === `Failed to launch application: Application '${args.name ?? args.bundleId}' not found`) context.onNoEffect?.()
        return args.action === 'list' ? result : mutationResult(result)
      }
      const current = get(args, context)
      if (name === 'press' && (current.focusedElement.processIdentifier !== current.pid || current.focusedElement.windowID !== current.windowId)) throw stale()
      observation = undefined
      const request = { app_target: `PID:${current.pid}`, window_id: current.windowId, include_elements: true, fresh: true, web_focus: false }
      const fresh = await parse(await dispatch('see', request, 'preflight'), request, context)
      const targetUnchanged = args.on
        ? same(current.elements.find(element => element.id === args.on), fresh.elements.find(element => element.id === args.on))
        : same(current.elements, fresh.elements)
      // Do not replace the approved native snapshot/element or silently remap an action.
      if (current.generation !== fresh.generation || current.executable !== fresh.executable ||
          !same(current.coordinates.logical_bounds, fresh.coordinates.logical_bounds) || !same(current.coordinates.delivered_image_size, fresh.coordinates.delivered_image_size) ||
          !targetUnchanged || name === 'press' && !same(current.focusedElement, fresh.focusedElement)) { observation = undefined; throw stale() }
      context.signal.throwIfAborted()
      const wire = { ...args }
      if (name === 'menu') { delete wire.observation_id; wire.app = `PID:${current.pid}` }
      if (args.coords) { wire.coords = imagePointToLogical(String(args.coords), current.coordinates); wire.coordinate_space = 'global_display_points' }
      if (name !== 'type' && name !== 'scroll' && name !== 'press' && !(name === 'menu' && args.action === 'list')) wire.foreground = true
      const element = fresh.elements.find(item => item.id === args.on) ?? {}
      const expected = current.executable === textEdit && name === 'type' ? expectedText(element, args) : undefined
      const newDocumentButton = current.executable === textEdit && name === 'click' && element.ax_role === 'AXButton' &&
        element.identifier === 'NewDocumentButton' && element.is_enabled === true
      const newDocument = newDocumentButton || current.executable === textEdit && name === 'press' && (args.keys === 'cmd+n' || same(args.keys, ['cmd+n'])) &&
        fresh.elements.some(item => item.ax_role === 'AXTextArea' && item.identifier === 'First Text View')
      const listRequest = { action: 'list', app: `PID:${current.pid}`, include_window_details: ['ids', 'bounds', 'off_screen'] }
      const beforeWindows = newDocument ? windowIds(await dispatch('window', listRequest, 'preflight')) : []
      if (newDocument && !beforeWindows.includes(current.windowId)) throw stale()
      context.signal.throwIfAborted()
      observation = undefined // A dispatched error/timeout also consumes authority; no retry without a visible observation.
      const result = await dispatch(name, wire)
      if (result.isError && result.meta?.state === 'refused' && result.meta.effect === 'refused' && result.meta.dispatch_state === 'none' &&
          result.meta.mutation_dispatched === false && result.meta.evidence === 'request_refused') context.onNoEffect?.()
      // Verify only effects with an exact, Host-owned postcondition. Never replay the mutation.
      if (result.meta?.state === 'dispatched_unverified' && result.meta.mutation_dispatched === true && (expected !== undefined || newDocument)) {
        for (let attempt = 0; attempt < 4; attempt++) try {
          if (attempt > 0) await delay(250 * attempt, undefined, { signal: context.signal })
          let windowId = current.windowId
          if (newDocument) {
            const afterWindows = windowIds(await dispatch('window', listRequest))
            const added = afterWindows.filter(id => !beforeWindows.includes(id))
            if (newDocumentButton && afterWindows.includes(current.windowId) || added.length !== 1) continue
            windowId = added[0]
          }
          const readRequest = { ...request, window_id: windowId }
          const captured = await dispatch('see', readRequest)
          const after = await parse(captured, readRequest, context)
          if (after.generation !== current.generation || after.executable !== current.executable || after.revision !== current.revision || context.validateRuntime?.() === false) return mutationResult(result)
          const fields = after.elements.filter(item => item.ax_role === 'AXTextArea' && item.identifier === (newDocument ? 'First Text View' : element.identifier))
          if (fields.length !== 1 || fields[0].value !== (newDocument ? '' : expected)) continue
          observation = after
          return { ...captured, isError: false, meta: { ...captured.meta, snapshot: after.snapshot, observation_id: after.id, effect: 'confirmed',
            host_verification: { kind: newDocument ? 'new_document' : 'text_value', attempts: attempt + 1, window_id: windowId, value: fields[0].value, native_outcome: result } },
            content: [{ type: 'text', text: `Host 自动核验成功：${newDocument ? '已新建空白文档' : `文本读回与预期完全一致：${JSON.stringify(expected)}`}。原动作仅派发一次，无需人工解除阻塞。Host observation_id: ${after.id}` }, ...captured.content] }
        } catch {
          context.signal.throwIfAborted()
          // Failed readback is not evidence of failure or permission to repeat the action.
          break
        }
      }
      return name === 'menu' && args.action === 'list' ? result : mutationResult(result)
    }
  }
  return policy
}
