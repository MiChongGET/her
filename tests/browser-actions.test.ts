import { expect, it } from 'vitest'
import { BrowserActions, controlledBrowserScript } from '../src/core/tools/browser-actions'
import type { EgoBrowserTools } from '../src/core/tools/ego-browser'
import type { ToolExecutionContext } from '../src/core/tools/types'

const context: ToolExecutionContext = { runId: 'run', conversationId: 'work', callId: 'call', signal: new AbortController().signal, delegationId: 'delegation' }
it('owned_workspace_and_exact_operation_only', async () => {
  const dispatched: unknown[] = []
  const runtime = { runControlled: async (command: unknown) => { dispatched.push(command); return { content: [{ type: 'text', text: JSON.stringify({ herControlled: { spaceId: 7, ownership: 'agent', pages: [{ label: 'p1', openedBy: 'agent' }] } }) }] } } } as unknown as EgoBrowserTools
  const actions = new BrowserActions(runtime)
  const owned = await actions.createWorkspace(context)
  expect(owned).toEqual({ workspaceId: '7', pageId: 'p1' })
  const valid = { kind: 'observe', delegationId: 'delegation', workspaceId: '7', pageId: 'p1' }
  for (const forged of [
    { ...valid, workspaceId: '8' }, { ...valid, pageId: 'user-tab' }, { ...valid, delegationId: 'other' }, { ...valid, kind: 'click' },
    { ...valid, code: 'process.exit()' }, { ...valid, evaluate: 'document.cookie' }, { ...valid, cdp: 'Page.navigate' },
    { ...valid, kind: 'navigate', url: 'javascript:alert(1)' }, { ...valid, origin: 'https://approved.test' }
  ]) await expect(actions.describe(forged as never, context)).rejects.toThrow()
  expect(dispatched).toHaveLength(1)
  expect(actions.capabilities.observe.available).toBe(false)
  expect(actions.capabilities.navigate.available).toBe(false)
  expect(await actions.execute(valid as never, context)).toMatchObject({ isError: true })
  expect(dispatched).toHaveLength(1)
})
it('fixed template treats injected strings as data and never executes another Node or page action', async () => {
  const names: string[] = [], unexpected: unknown[] = []
  const source = controlledBrowserScript({ kind: 'create', name: '\"); await process.exit(); await taskSpace("user"); //' })
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
  await new AsyncFunction('taskSpace', 'console', 'process', source)(async (name: string) => {
    names.push(name)
    return { spaceId: 7, ownership: 'agent', tabs: async () => [{ label: 'p1', openedBy: 'agent' }] }
  }, { log: () => {} }, { exit: () => unexpected.push('exit') })
  expect(names).toEqual(['\"); await process.exit(); await taskSpace("user"); //'])
  expect(unexpected).toEqual([])
})
it('does not adopt user pages or retry when workspace ownership is unproven', async () => {
  let attempts = 0
  const runtime = { runControlled: async () => { attempts++; return { content: [{ type: 'text', text: JSON.stringify({ herControlled: { spaceId: 7, ownership: 'user', pages: [{ label: 'p1', openedBy: 'unknown' }] } }) }] } } } as unknown as EgoBrowserTools
  const actions = new BrowserActions(runtime)
  await expect(actions.createWorkspace(context)).rejects.toThrow()
  await expect(actions.createWorkspace(context)).rejects.toThrow()
  expect(attempts).toBe(1)
})
