import { describe, expect, it } from 'vitest'
import { createDefaultRegistry, SimpleToolRegistry } from '../src/core/tools/registry'

describe('default tool registry', () => {
  it('exposes get_current_time with an object schema', () => {
    const definitions = createDefaultRegistry().getDefinitions()
    expect(definitions.map(tool => tool.name)).toEqual(['get_current_time'])
    expect(definitions[0].parameters).toMatchObject({ type: 'object' })
  })

  it('formats the time in the requested timezone', async () => {
    const result = await createDefaultRegistry().execute('get_current_time', { timezone: 'UTC' }, { runId: 'run', conversationId: 'conversation', callId: 'call', signal: new AbortController().signal })
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringMatching(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/) })
  })

  it('returns an explicit error result for an invalid timezone instead of throwing', async () => {
    const result = await createDefaultRegistry().execute('get_current_time', { timezone: 'Not/AZone' }, { runId: 'run', conversationId: 'conversation', callId: 'call', signal: new AbortController().signal })
    expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringMatching(/^Tool execution failed:/) }] })
  })

  it('returns an explicit error result for an unknown tool', async () => {
    const result = await createDefaultRegistry().execute('nope', {}, { runId: 'run', conversationId: 'conversation', callId: 'call', signal: new AbortController().signal })
    expect(result).toEqual({ isError: true, content: [{ type: 'text', text: 'Unknown tool: nope' }] })
  })
})

describe('synchronous tool input validation', () => {
  const context = { runId: 'run', conversationId: 'conversation', callId: 'call', signal: new AbortController().signal }
  const dialects = ['http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2019-09/schema', 'https://json-schema.org/draft/2020-12/schema']

  it.each(dialects)('rejects async input before authorization/dispatch with no rejected validation Promise: %s', async $schema => {
    const registry = new SimpleToolRegistry()
    let authorized = 0
    let dispatched = 0
    let rejected: unknown
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown) => { unhandled.push(error) }
    process.on('unhandledRejection', onUnhandled)
    try {
      try {
        registry.register({ name: 'remote_async', description: '', parameters: { $schema, $async: true, type: 'object', properties: { value: { type: 'integer' } }, required: ['value'] } }, async () => { dispatched++; return { content: [] } })
      } catch (error) { rejected = error }
      const result = await registry.execute('remote_async', { value: 'invalid-integer' }, { ...context, authorize: async () => { authorized++ } })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect.soft(rejected).toBeInstanceOf(Error)
      expect.soft(registry.getDefinitions()).toEqual([])
      expect.soft(result.isError).toBe(true)
      expect.soft(authorized).toBe(0)
      expect.soft(dispatched).toBe(0)
      expect.soft(unhandled).toEqual([])
    } finally { process.removeListener('unhandledRejection', onUnhandled) }
  })

  it.each([
    { properties: { value: { $async: true, type: 'integer' } } },
    { $defs: { asyncValue: { $async: true, type: 'integer' } }, properties: { value: { $ref: '#/$defs/asyncValue' } } },
    { definitions: { asyncValue: { $async: true, type: 'integer' } }, properties: { value: { $ref: '#/definitions/asyncValue' } } },
    { allOf: [{ $async: true, properties: { value: { type: 'integer' } } }] },
    { properties: { value: { items: { $async: true, type: 'integer' } } } },
    { dependentSchemas: { value: { $async: true, required: ['other'] } } },
    // A JSON pointer can turn instance-data/extension locations into schemas.
    { default: { schema: { $async: true, type: 'integer' } }, properties: { value: { $ref: '#/default/schema' } } },
    { extension: { $async: true, type: 'integer' }, properties: { value: { $ref: '#/extension' } } },
    { $async: 'truthy-nonboolean', properties: { value: { type: 'integer' } } }
  ])('rejects async schema positions or referenced schemas without registration: %j', parameters => {
    const registry = new SimpleToolRegistry()
    expect(() => registry.register({ name: 'remote_nested', description: '', parameters: { type: 'object', ...parameters } }, async () => ({ content: [] }))).toThrow()
    expect(registry.getDefinitions()).toEqual([])
  })

  it('preserves $async instance data in enum/const/default and a property named $async', async () => {
    const registry = new SimpleToolRegistry()
    registry.register({ name: 'literal', description: '', parameters: {
      type: 'object', properties: {
        enumValue: { enum: [{ $async: true }] },
        constValue: { const: { $async: true } },
        defaultValue: { type: 'object', default: { $async: true } },
        $async: { type: 'boolean' }
      }, required: ['enumValue', 'constValue', '$async']
    } }, async () => ({ content: [{ type: 'text', text: 'validated literal data' }] }))
    expect(await registry.execute('literal', { enumValue: { $async: true }, constValue: { $async: true }, $async: true }, { ...context, authorize: async () => {} })).toMatchObject({ content: [{ text: 'validated literal data' }] })
    expect(await registry.execute('literal', { enumValue: { $async: false }, constValue: { $async: true }, $async: true }, context)).toMatchObject({ isError: true })
  })
})
