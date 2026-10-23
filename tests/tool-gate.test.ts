import { describe, expect, it } from 'vitest'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import { createGatedTools } from '../src/core/tools/gate'

const schema = { type: 'object', properties: { target: { type: 'string' } }, required: ['target'], additionalProperties: false }
const setup = (effect: 'read' | 'send') => {
  const registry = new SimpleToolRegistry()
  const dispatched: unknown[] = []
  registry.register({ name: 'act', description: 'act', parameters: schema },
    async args => { dispatched.push(args); return { content: [{ type: 'text', text: 'done' }] } },
    { assess: async args => ({ effect, target: String(args.target), summary: 'act' }) })
  const controller = new AbortController()
  const tools = createGatedTools(registry.snapshot(), { runId: 'run', conversationId: 'conversation', signal: controller.signal })
  return { tools, dispatched, controller, call: (name: string, params: unknown) =>
    tools.find(tool => tool.name === name)!.execute('call-1', params as never, undefined, undefined, undefined as never) }
}

describe('Pi tool gate', () => {
  it('exposes only registered tools', () => {
    expect(setup('read').tools.map(tool => tool.name)).toEqual(['act'])
  })

  it('an unverified read cannot dispatch just because of its effect label', async () => {
    const s = setup('read')
    await expect(s.call('act', { target: 'a' })).rejects.toThrow('需要用户确认')
    expect(s.dispatched).toEqual([])
  })

  it('does not execute invalid arguments', async () => {
    const s = setup('read')
    await expect(s.call('act', { target: 1 })).rejects.toThrow('Invalid tool arguments')
    await expect(s.call('act', { target: 'a', extra: true })).rejects.toThrow('Invalid tool arguments')
    expect(s.dispatched).toEqual([])
  })

  it('fails closed for non-read actions without an authorizer', async () => {
    const s = setup('send')
    await expect(s.call('act', { target: 'a' })).rejects.toThrow('需要用户确认')
    expect(s.dispatched).toEqual([])
  })

  it('does not execute after the run is stopped', async () => {
    const s = setup('read')
    s.controller.abort(new Error('stopped'))
    await expect(s.call('act', { target: 'a' })).rejects.toThrow('stopped')
    expect(s.dispatched).toEqual([])
  })

  it('has no tool for a name only remembered from history', () => {
    expect(setup('read').tools.find(tool => tool.name === 'old_tool')).toBeUndefined()
  })
})
