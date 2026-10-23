import { afterEach, describe, expect, it, vi } from 'vitest'
import { HerStore } from '../src/core/storage/store'
import { ProfileService } from '../src/core/storage/profiles'
import { testConnection } from '../src/main/test-connection'
import { startFixtureServer, type Protocol, type Scenario } from './pi-sdk/wire'
import type { TestKind } from '../src/shared/types'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function setup(protocol: Protocol, scenario: Scenario = 'text', apiKey = 'fixture-key', headers = {}, beforeReply?: () => Promise<void>) {
  const server = await startFixtureServer(protocol, scenario, { beforeReply })
  cleanup.push(() => server.close())
  const store = new HerStore(':memory:')
  cleanup.push(() => store.close())
  const lifetime = new AbortController()
  const profiles = new ProfileService(store, {
    encrypt: async text => Buffer.from(text), decrypt: async data => data.toString()
  }, lifetime.signal)
  const profile = await profiles.save({
    name: 'Connection fixture', protocol, baseUrl: server.baseUrl + '/prefix/v1',
    model: 'test-model', contextWindow: 128000, authMethod: apiKey ? 'api-key' : Object.keys(headers).length ? 'headers' : 'none', apiKey, customHeaders: headers
  })
  return { server, store, profiles, profile, lifetime,
    run: (kind: TestKind = 'chat') => testConnection(profiles, profile.id, kind) }
}

describe('real model connection probes', () => {
  for (const protocol of ['openai', 'anthropic', 'openai-responses'] as const) {
    it(`${protocol}: sends the saved model and credentials and persists a streamed result`, async () => {
      const fixture = await setup(protocol)
      const result = await fixture.run()
      expect(fixture.server.requests).toHaveLength(1)
      const request = fixture.server.requests[0]
      const suffix = protocol === 'openai' ? '/chat/completions' : protocol === 'anthropic' ? '/messages' : '/responses'
      expect(new URL(request.url, fixture.server.baseUrl).pathname).toBe('/prefix/v1' + suffix)
      expect(request.body).toMatchObject({ model: 'test-model', stream: true })
      expect(request.headers[protocol === 'anthropic' ? 'x-api-key' : 'authorization'])
        .toBe(protocol === 'anthropic' ? 'fixture-key' : 'Bearer fixture-key')
      expect(result).toMatchObject({ status: 'passed', message: expect.stringContaining('文字增量') })
      expect(fixture.profiles.list()[0].models[0].tests.chat).toEqual(result)
    })

    for (const scenario of ['http-error', 'invalid-content-type', 'missing-finish', 'missing-terminal', 'truncated', 'malformed-json', 'tool-without-calls', 'empty-text'] as const) {
      if (protocol !== 'openai' && scenario === 'missing-finish') continue
      if (protocol === 'openai-responses' && scenario === 'tool-without-calls') continue
      it(`${protocol}: rejects ${scenario} instead of reporting configuration success`, async () => {
        const fixture = await setup(protocol, scenario)
        const result = await fixture.run()
        expect(result.status).toBe('failed')
        expect(result.message).not.toMatch(/synthetic_secret_marker|fixture-key|配置验证通过/)
        expect(fixture.server.requests).toHaveLength(1)
        expect(fixture.profiles.list()[0].models[0].tests.chat).toEqual(result)
      })
    }
  }

  it('rejects a completed valid tool call followed by an unfinished unknown call', async () => {
    const fixture = await setup('anthropic', 'mixed-unfinished')
    expect((await fixture.run('tools')).status).toBe('failed')
    expect(fixture.server.requests).toHaveLength(1)
  })

  it.each(['openai', 'anthropic', 'openai-responses'] as const)('%s: supports header-only authentication without sending synthetic credentials', async protocol => {
    const fixture = await setup(protocol, 'text', '', { 'X-Fixture-Auth': 'header-key' })
    expect((await fixture.run()).status).toBe('passed')
    expect(fixture.server.requests[0].headers.authorization).toBeUndefined()
    expect(fixture.server.requests[0].headers['x-api-key']).toBeUndefined()
    expect(fixture.server.requests[0].headers['x-fixture-auth']).toBe('header-key')
  })

  it.each(['chat', 'tools', 'vision'] as const)('%s: sends the selected non-default model and updates only that model test result', async kind => {
    const fixture = await setup('openai', kind === 'tools' ? 'tool' : kind === 'vision' ? 'vision-correct' : 'text')
    await fixture.profiles.save({ ...fixture.profile, models: [{ id: 'test-model' }, { id: 'second-model' }] })
    const result = await testConnection(fixture.profiles, fixture.profile.id, kind, 'second-model')
    expect(result.status).toBe('passed')
    expect(fixture.server.requests[0].body.model).toBe('second-model')
    expect(fixture.profiles.list()[0].models.map(model => model.tests[kind].status)).toEqual(['untested', 'passed'])
  })

  it('does not follow a redirect carrying the saved credentials', async () => {
    const fixture = await setup('openai', 'redirect')
    expect((await fixture.run()).status).toBe('failed')
    expect(fixture.server.requests).toHaveLength(1)
  })

  it.each(['edit', 'delete', 'replace-model'] as const)('does not publish a stale result after a service %s during the request', async action => {
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const fixture = await setup('openai', 'text', 'fixture-key', {}, () => held)
    const pending = fixture.run()
    try {
      await vi.waitFor(() => expect(fixture.server.requests).toHaveLength(1))
      if (action === 'edit') await fixture.profiles.save({ ...fixture.profile, apiKey: 'replacement-key' })
      else if (action === 'replace-model') await fixture.profiles.save({ ...fixture.profile, model: 'replacement-model', models: [{ id: 'replacement-model' }] })
      else fixture.profiles.delete(fixture.profile.id)
    } finally { release() }
    await expect(pending).rejects.toThrow('测试期间配置已变化')
    if (action !== 'delete') expect(fixture.profiles.list()[0].models[0].tests.chat.status).toBe('untested')
    else expect(fixture.profiles.list()).toHaveLength(0)
  })

  it('records the originally tested model when the default changes during a request', async () => {
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const fixture = await setup('openai', 'text', 'fixture-key', {}, () => held)
    const pending = fixture.run()
    try {
      await vi.waitFor(() => expect(fixture.server.requests).toHaveLength(1))
      await fixture.profiles.save({ ...fixture.profile, model: 'second-model', models: [{ id: 'test-model' }, { id: 'second-model' }] })
    } finally { release() }
    expect((await pending).status).toBe('passed')
    expect(fixture.server.requests[0].body.model).toBe('test-model')
    expect(fixture.profiles.list()[0].models.map(model => model.tests.chat.status)).toEqual(['passed', 'untested'])
  })

  it('does not display legacy configuration-only checks as verified model capabilities', async () => {
    const fixture = await setup('openai')
    fixture.profiles.recordTest(fixture.profile.id, 'chat', { status: 'passed', message: '配置验证通过 (openai://fixture)' })
    expect(fixture.profiles.list()[0].models[0].tests.chat.status).toBe('untested')
  })

  it.each(['chat', 'tools', 'vision'] as const)('%s: fails a stalled stream at the probe deadline', async kind => {
    const fixture = await setup('openai', 'hang')
    vi.useFakeTimers()
    const pending = fixture.run(kind)
    await vi.waitFor(() => expect(fixture.server.requests).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await pending).toMatchObject({ status: 'failed', message: expect.stringContaining('超时') })
  })

  it.each(['chat', 'tools', 'vision'] as const)('%s: cancels in-flight requests on shutdown without persisting a test result', async kind => {
    const fixture = await setup('openai', 'hang')
    const pending = fixture.run(kind)
    await vi.waitFor(() => expect(fixture.server.requests).toHaveLength(1))
    fixture.lifetime.abort()
    await expect(pending).rejects.toThrow()
    expect(fixture.store.getService(fixture.profile.id)!.models[0].tests[kind].status).toBe('untested')
  })

  for (const protocol of ['openai', 'anthropic', 'openai-responses'] as const) {
    it(`${protocol}: verifies the requested function and exact arguments from a real tool stream`, async () => {
      const fixture = await setup(protocol, 'tool')
      const result = await fixture.run('tools')
      expect(result).toMatchObject({ status: 'passed', message: expect.stringContaining('工具调用') })
      expect(fixture.server.requests).toHaveLength(1)
      const body = fixture.server.requests[0].body
      expect(body).toMatchObject({ model: 'test-model', stream: true })
      const tools = body.tools as any[]
      const declaration = protocol === 'openai' ? tools[0].function : tools[0]
      expect(declaration.name).toBe('report_connection')
      expect(declaration.parameters ?? declaration.input_schema).toMatchObject({
        required: ['ok'], properties: { ok: { type: 'boolean' } }
      })
      if (protocol !== 'anthropic') expect(declaration.parameters.additionalProperties).toBe(false)
      expect(body.tool_choice).toEqual(protocol === 'openai' ? { type: 'function', function: { name: 'report_connection' } }
        : protocol === 'anthropic' ? { type: 'tool', name: 'report_connection' } : { type: 'function', name: 'report_connection' })
      expect(fixture.profiles.list()[0].models[0].tests.tools).toEqual(result)
      expect(fixture.profiles.list()[0].models[0].tests.chat.status).toBe('untested')
    })

    for (const scenario of ['text', 'unknown-tool', 'bad-json-tool', 'partial-json-tool', 'array-tool', 'multi-tool', 'mixed-invalid', 'extra-tool-argument', 'false-tool-argument', 'truncated-tool', 'malformed-json', 'http-error', 'wrong-tool-finish', 'missing-block-stop', 'final-only-tool', 'tool-without-calls'] as const) {
      if (scenario === 'wrong-tool-finish' && protocol === 'openai-responses') continue
      if (scenario === 'missing-block-stop' && protocol !== 'anthropic') continue
      if (scenario === 'final-only-tool' && protocol !== 'openai-responses') continue
      it(`${protocol}: tool test rejects ${scenario}`, async () => {
        const fixture = await setup(protocol, scenario)
        const result = await fixture.run('tools')
        expect(result.status).toBe('failed')
        expect(fixture.server.requests).toHaveLength(1)
        expect(result.message).not.toMatch(/synthetic_secret_marker|fixture-key/)
        expect(fixture.profiles.list()[0].models[0].tests.tools).toEqual(result)
      })
    }

    it(`${protocol}: sends a real image even without the multimodal flag and checks its color`, async () => {
      const fixture = await setup(protocol, 'vision-correct')
      expect(fixture.profile.models[0].multimodal).toBe(false)
      const result = await fixture.run('vision')
      expect(result).toMatchObject({ status: 'passed', message: expect.stringContaining('测试图片') })
      expect(fixture.server.requests).toHaveLength(1)
      const body = fixture.server.requests[0].body
      const messages = (body.messages ?? body.input) as any[]
      const blocks = messages[0].content as any[]
      const image = blocks.find(block => ['image', 'image_url', 'input_image'].includes(block.type))
      expect(image).toBeTruthy()
      const encoded = protocol === 'anthropic' ? image.source.data
        : (protocol === 'openai' ? image.image_url.url : image.image_url).split(',')[1]
      expect(Buffer.from(encoded, 'base64').subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      expect(blocks.find(block => ['text', 'input_text'].includes(block.type)).text).not.toMatch(/RED|红/)
      expect(body.tools).toBeUndefined()
      expect(fixture.profiles.list()[0].models[0].tests.vision).toEqual(result)
    })

    for (const scenario of ['vision-wrong', 'text', 'empty-text', 'tool', 'truncated', 'malformed-json', 'http-error'] as const) {
      it(`${protocol}: vision test rejects ${scenario}`, async () => {
        const fixture = await setup(protocol, scenario)
        const result = await fixture.run('vision')
        expect(result.status).toBe('failed')
        expect(fixture.server.requests).toHaveLength(1)
        expect(result.message).not.toMatch(/synthetic_secret_marker|fixture-key/)
        expect(fixture.profiles.list()[0].models[0].tests.vision).toEqual(result)
      })
    }
  }
})
