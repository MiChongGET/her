import { randomUUID } from 'node:crypto'
import type { ToolResult } from '../../shared/types'
import type { ActionDescriptor } from '../delegations/types'
import type { EgoBrowserTools } from './ego-browser'
import type { SimpleToolRegistry } from './registry'
import type { ToolExecutionContext } from './types'

export interface BrowserAction {
  kind: 'observe' | 'navigate'
  delegationId: string
  workspaceId: string
  pageId: string
  url?: string
  observationId?: string
}
export type ControlledBrowserCommand = { kind: 'create'; name: string } | { kind: 'observe' | 'finish'; workspaceId: number; pageId: string }

/** Host templates only. Values are serialized data; no model code, evaluation or protocol forwarding. */
export function controlledBrowserScript(command: ControlledBrowserCommand): string {
  const input = `const input = ${JSON.stringify(command)};\n`
  if (command.kind === 'create') return input + 'const task = await taskSpace(input.name); console.log(JSON.stringify({herControlled:{spaceId:task.spaceId,ownership:task.ownership,pages:(await task.tabs()).map(tab=>({label:tab.label,openedBy:tab.openedBy}))}}));'
  const owned = 'const task = await taskSpace(input.workspaceId); if (task.ownership !== "agent") throw new Error("Workspace control unavailable"); const tabs = await task.tabs(); const tab = tabs.find(item=>item.label===input.pageId); if (!tab || tab.openedBy!=="agent") throw new Error("Owned page unavailable"); '
  if (command.kind === 'finish') return input + owned + 'console.log(JSON.stringify({herControlled:await task.finish({keep:[]})}));'
  return input + owned + 'const page=task.page(input.pageId); console.log(JSON.stringify({herControlled:{spaceId:task.spaceId,pageId:page.label,url:await page.url(),snapshot:await page.snapshot()}}));'
}

export class BrowserActions {
  readonly capabilities = Object.freeze({
    observe: Object.freeze({ available: false, reason: '尚未证实观察不会自动重建崩溃页或受到后台动作影响。' }),
    navigate: Object.freeze({ available: false, reason: '尚未证实可在发生前阻断 unload、后台请求、重定向与停止后的动作。' })
  })
  private readonly workspaces = new Map<string, { workspaceId: string; pageId: string }>()
  private readonly attempted = new Set<string>()
  constructor(private readonly runtime: EgoBrowserTools) {}

  /** Host-owned setup only; never exposed as a model registration or allowed to adopt existing tabs. */
  async createWorkspace(context: ToolExecutionContext): Promise<{ workspaceId: string; pageId: string }> {
    context.signal.throwIfAborted()
    if (!context.delegationId || this.attempted.has(context.delegationId)) throw new Error('工作空间创建结果需要先核实，不能重试或另建空间。')
    this.attempted.add(context.delegationId)
    const result = await this.runtime.runControlled({ kind: 'create', name: `Her bounded browser ${randomUUID()}` }, context)
    if (result.isError) throw new Error('受控浏览器不可用；保留已派发状态，等待处理。')
    const receipt = result.content.filter(part => part.type === 'text').flatMap(part => part.text.split('\n')).flatMap(line => {
      try { return [JSON.parse(line).herControlled] } catch { return [] }
    }).find(value => value && Number.isSafeInteger(value.spaceId) && value.spaceId > 0)
    if (receipt?.ownership !== 'agent' || !Array.isArray(receipt.pages) || !receipt.pages.some((page: { label?: string; openedBy?: string }) => page.label === 'p1' && page.openedBy === 'agent')) throw new Error('工作空间与页面归属未获证实。')
    const owned = { workspaceId: String(receipt.spaceId), pageId: 'p1' }
    this.workspaces.set(context.delegationId, owned)
    return { ...owned }
  }

  private validate(input: BrowserAction, context: ToolExecutionContext): void {
    context.signal.throwIfAborted()
    const allowed = ['kind', 'delegationId', 'workspaceId', 'pageId', 'url', 'observationId']
    const owned = this.workspaces.get(context.delegationId ?? '')
    if (!input || Object.keys(input).some(key => !allowed.includes(key)) || !['observe', 'navigate'].includes(input.kind) ||
      input.delegationId !== context.delegationId || !owned || owned.workspaceId !== input.workspaceId || owned.pageId !== input.pageId) throw new Error('浏览器动作或页面归属无效。')
    if (input.kind === 'observe' && input.url !== undefined) throw new Error('观察不能携带导航地址。')
    if (input.kind === 'navigate') {
      const url = new URL(input.url ?? '')
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('浏览器地址无效。')
    }
  }

  async describe(input: BrowserAction, context: ToolExecutionContext): Promise<ActionDescriptor> {
    this.validate(input, context)
    throw new Error(this.capabilities[input.kind].reason)
  }

  async execute(input: BrowserAction, context: ToolExecutionContext): Promise<ToolResult> {
    this.validate(input, context)
    return { isError: true, content: [{ type: 'text', text: this.capabilities[input.kind].reason + '如需继续，请单独确认具体浏览器操作。' }] }
  }

  register(registry: SimpleToolRegistry): void {
    registry.register({ name: 'browser_action', description: '受控浏览器动作（能力验证通过前不可用）。', parameters: {
      type: 'object', additionalProperties: false, required: ['kind', 'delegationId', 'workspaceId', 'pageId'], properties: {
        kind: { type: 'string', enum: ['observe', 'navigate'] }, delegationId: { type: 'string' }, workspaceId: { type: 'string' }, pageId: { type: 'string' },
        url: { type: 'string' }, observationId: { type: 'string' }
      }
    } }, (args, context) => this.execute(args as unknown as BrowserAction, context), { isAvailable: () => false })
  }
}
