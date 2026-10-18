import { randomUUID } from 'node:crypto'
import type { ToolResult } from '../../shared/types'
import type { ToolExecutionContext } from '../tools/types'
import type { McpConnectionManager } from './manager'
import type { McpServicePolicy } from './registry-adapter'

const fields: Record<string, string[]> = {
  browser_snapshot: [], browser_navigate: ['url'], browser_navigate_back: [],
  browser_click: ['target', 'element', 'doubleClick', 'button', 'modifiers'],
  browser_hover: ['target', 'element'], browser_type: ['target', 'element', 'text', 'submit', 'slowly'],
  browser_fill_form: ['fields'], browser_select_option: ['target', 'element', 'values'],
  browser_tabs: ['action', 'index', 'url'], browser_take_screenshot: ['type', 'fullPage', 'scale'],
  browser_wait_for: ['time', 'text', 'textGone']
}
export const BROWSER_TOOLS = Object.keys(fields)
const stale = () => new Error('Chrome 观察已失效，请重新读取页面或标签列表；不要重复未知动作。')
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export function webUrl(value: unknown): string {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new Error('只支持明确的 HTTP(S) 网页地址。')
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('只支持不带凭据的 HTTP(S) 网页地址。')
  return value
}
interface Observation {
  id: string; kind: 'page' | 'tabs'; fingerprint: string; url: string; title: string; refs: Set<string>; indexes: number[]
  runId: string; conversationId: string; revision: number
}
function parse(result: ToolResult, kind: Observation['kind']) {
  if (result.isError || result.truncated) throw stale()
  const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  const section = (name: string) => text.split('### ' + name + '\n')[1]?.split('\n### ')[0] ?? ''
  const tabs = [...section(kind === 'tabs' ? 'Result' : 'Open tabs').matchAll(/^- (\d+): (.*)$/gm)].map(match => ({ index: Number(match[1]), line: match[0] }))
  if (kind === 'tabs') {
    if (!tabs.length || tabs.filter(tab => tab.line.includes('(current)')).length !== 1) throw stale()
    return { fingerprint: tabs.map(tab => tab.line).join('\n'), url: '', title: 'Chrome 获准标签列表（临时索引）', refs: new Set<string>(), indexes: tabs.map(tab => tab.index) }
  }
  const url = text.match(/^- Page URL: (.+)$/m)?.[1], title = text.match(/^- Page Title: (.*)$/m)?.[1] ?? ''
  const snapshot = text.match(/### Snapshot\r?\n```yaml\r?\n([\s\S]*?)\r?\n```/)
  if (!url || !snapshot || /\[crashed\]|^- Page status: crashed$/m.test(text)) throw stale()
  // Public Markdown exposes only current page evidence. It has no stable Chrome tab ID or snapshot version.
  return { fingerprint: JSON.stringify([url, title, tabs.map(tab => tab.line), snapshot[1]]), url, title,
    refs: new Set([...snapshot[1].matchAll(/\[ref=((?:f\d+)?e\d+)\]/g)].map(match => match[1])), indexes: tabs.map(tab => tab.index) }
}

// Constructed per verified runtime connection. Never trust editable preset labels or server annotations.
export function createBrowserAdapter(manager: McpConnectionManager, serviceId: string): McpServicePolicy {
  let observation: Observation | undefined
  const actionTarget = `browser:${serviceId}:action`
  const readTarget = `browser:${serviceId}:observation` // Reset-capable reads never clear prior unknown actions.
  const status = () => manager.getStatus(serviceId)
  const passive = (name: string, args: Record<string, unknown>) => name === 'browser_snapshot' || name === 'browser_tabs' && args.action === 'list'
  function validate(name: string, args: Record<string, unknown>): void {
    if (!BROWSER_TOOLS.includes(name) || Object.keys(args).some(key => !fields[name].includes(key) && !(key === 'observation_id' && !passive(name, args)))) throw new Error('浏览器工具或参数不在允许清单中。')
    if (args.url !== undefined) webUrl(args.url)
    if (name === 'browser_navigate' && args.url === undefined) throw new Error('请输入网页地址。')
    if (name === 'browser_tabs') {
      if (!['list', 'new', 'close', 'select'].includes(String(args.action)) || args.index !== undefined && (!Number.isSafeInteger(args.index) || Number(args.index) < 0) ||
          ['select', 'close'].includes(String(args.action)) && args.index === undefined || args.url !== undefined && args.action !== 'new' || args.index !== undefined && !['select', 'close'].includes(String(args.action))) throw new Error('标签操作需要最新列表中的明确索引。')
    }
    if (name === 'browser_fill_form') {
      if (!Array.isArray(args.fields) || !args.fields.length || args.fields.some(value => {
        const field = object(value)
        return Object.keys(field).some(key => !['name', 'type', 'target', 'element', 'value'].includes(key)) || typeof field.name !== 'string' || typeof field.value !== 'string' || !['textbox', 'checkbox', 'radio', 'combobox', 'slider'].includes(String(field.type))
      })) throw new Error('表单字段不正确。')
    }
    if (name === 'browser_type' && typeof args.text !== 'string') throw new Error('请输入文本。')
    if (name === 'browser_wait_for' && (args.time !== undefined && (typeof args.time !== 'number' || args.time < 0 || args.time > 30) || !Object.keys(args).some(key => ['time', 'text', 'textGone'].includes(key)))) throw new Error('等待最多 30 秒，或指定页面文本。')
  }
  function current(name: string, args: Record<string, unknown>, context: ToolExecutionContext): Observation {
    const value = observation
    if (!value || value.id !== args.observation_id || value.runId !== context.runId || value.conversationId !== context.conversationId || value.revision !== status().revision || status().state !== 'ready') throw stale()
    if ((name === 'browser_tabs' ? 'tabs' : 'page') !== value.kind) throw stale()
    const targets = name === 'browser_fill_form' ? (args.fields as Record<string, unknown>[]).map(field => field.target) : ['browser_click', 'browser_hover', 'browser_type', 'browser_select_option'].includes(name) ? [args.target] : []
    if (targets.some(target => typeof target !== 'string' || !/^(f\d+)?e\d+$/.test(target) || !value.refs.has(target))) throw stale()
    if (name === 'browser_tabs' && args.index !== undefined && !value.indexes.includes(Number(args.index))) throw stale()
    return value
  }
  const boundary = '观察与预检可能关闭崩溃标签并重建页面；限定扩展获准范围。确认仅依据当前可见内容；隐式重连后的相同页面无法区分，不能保证原子标签身份。'
  return {
    conversationApprovalScope: randomUUID(),
    deferDispatch: true,
    allowedTools: BROWSER_TOOLS,
    parameters(name, schema) {
      const source = object(schema.properties)
      const properties: Record<string, unknown> = Object.fromEntries(fields[name].filter(key => key in source).map(key => [key, source[key]]))
      const required = Array.isArray(schema.required) ? schema.required.filter(key => fields[name].includes(String(key))) : []
      if (name !== 'browser_snapshot') properties.observation_id = { type: 'string', description: 'Latest Host observation_id; page snapshot for page actions, tabs list for tab changes. This is not a stable Chrome tab ID.' }
      if (!['browser_snapshot', 'browser_tabs'].includes(name)) required.push('observation_id')
      if (properties.target) properties.target = { type: 'string', pattern: '^(f[0-9]+)?e[0-9]+$', description: 'Exact target ref from the latest snapshot; selectors are forbidden.' }
      if (name === 'browser_fill_form') properties.fields = { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['name', 'type', 'target', 'value'], properties: {
        name: { type: 'string' }, type: { type: 'string', enum: ['textbox', 'checkbox', 'radio', 'combobox', 'slider'] }, target: { type: 'string', pattern: '^(f[0-9]+)?e[0-9]+$' }, element: { type: 'string' }, value: { type: 'string' }
      } } }
      if (name === 'browser_wait_for') properties.time = { type: 'number', minimum: 0, maximum: 30 }
      return { type: 'object', additionalProperties: false, properties, required }
    },
    async assess(name, args, context) {
      context.signal.throwIfAborted(); validate(name, args)
      if (passive(name, args)) return { effect: 'unknown', target: readTarget, summary: `读取 Chrome 当前获准页面；首次调用可能打开扩展连接审批。${boundary}` }
      const value = current(name, args, context)
      const effect = name === 'browser_type' && args.submit === true ? 'send' : name === 'browser_type' && args.slowly !== true || name === 'browser_fill_form' ? 'overwrite' : name === 'browser_tabs' && args.action === 'close' ? 'delete' : 'unknown'
      return { effect, target: actionTarget, observationId: value.id, displayTarget: `${value.title} · ${value.url}`,
        summary: `${name} · ${value.title} · ${value.url} · ${JSON.stringify(args)}。${boundary}` }
    },
    validateObservation: (assessment, context) => !!observation && observation.id === assessment.observationId && observation.runId === context.runId && observation.conversationId === context.conversationId && observation.revision === status().revision && status().state === 'ready',
    async execute(name, args, context, dispatch) {
      context.signal.throwIfAborted(); validate(name, args)
      if (passive(name, args)) {
        observation = undefined
        const result = await dispatch(name, args)
        if (result.isError) {
          const connectionError = result.content.some(block => block.type === 'text' && /extension|connect|连接|扩展/i.test(block.text))
          return { ...result, content: [...result.content, { type: 'text', text: connectionError ? '请检查 Chrome 官方 Playwright 扩展及用户批准的连接和标签范围；Her 不会自动批准或切换浏览器配置。' : '页面观察失败，可能的标签重建结果未知；请检查 Chrome 当前状态，通过任务中的人工处理入口解除未知阻塞。' }] }
        }
        const kind = name === 'browser_tabs' ? 'tabs' : 'page'
        const evidence = parse(result, kind); context.signal.throwIfAborted()
        observation = { ...evidence, kind, id: randomUUID(), runId: context.runId, conversationId: context.conversationId, revision: status().revision }
        return { ...result, meta: { ...result.meta, observation_id: observation.id }, content: [...result.content, { type: 'text', text: `Host observation_id: ${observation.id}. Session observation only, not a stable tab ID or extension consent receipt. Re-observe after every action. Unknown actions require user handling when tab continuity cannot be proven.` }] }
      }
      const value = current(name, args, context)
      observation = undefined // Errors, cancellation, navigation and tab changes all consume old authority.
      const fresh = parse(await dispatch(value.kind === 'tabs' ? 'browser_tabs' : 'browser_snapshot', value.kind === 'tabs' ? { action: 'list' } : {}, 'preflight'), value.kind)
      if (fresh.fingerprint !== value.fingerprint) throw stale()
      context.signal.throwIfAborted()
      const wire = { ...args }; delete wire.observation_id
      const result = await dispatch(name, wire)
      if (name === 'browser_take_screenshot') {
        const images = result.content.filter(block => block.type === 'image')
        return result.isError || !images.length ? { isError: true, content: [{ type: 'text', text: 'Chrome 截图未返回内联图片，请重新观察。' }] } : { content: images }
      }
      return result
    }
  }
}
