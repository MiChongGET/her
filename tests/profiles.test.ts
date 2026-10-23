import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProviderEvent, StreamChatInput } from '../src/shared/types'
import { HerStore } from '../src/core/storage/store'
import { ProfileService, type SecretCodec } from '../src/core/storage/profiles'

const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function setup() {
  const path = mkdtempSync(join(tmpdir(), 'her-profiles-'))
  directories.push(path)
  const file = join(path, 'her.sqlite')
  const store = new HerStore(file)
  const key = randomBytes(32)
  const codec: SecretCodec = {
    async encrypt(text) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), body])
    },
    async decrypt(data) {
      const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12))
      decipher.setAuthTag(data.subarray(12, 28))
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8')
    }
  }
  return { store, profiles: new ProfileService(store, codec), file, codec }
}

const base = { contextWindow: 128000, authMethod: 'none' as const, name: '我的服务', protocol: 'openai' as const, baseUrl: 'https://models.example.com/proxy/v1/', model: 'my-model' }

describe('model configuration and credential boundary', () => {
  it('stores secrets encrypted and never returns them in the public profile', async () => {
    const { store, profiles, file } = setup()
    const profile = await profiles.save({
      ...base, contextWindow: 128000, authMethod: 'api-key' as const, apiKey: 'private-api-key-for-test', customHeaders: { 'X-Token': 'private-header-for-test' }
    })
    expect(profile).toMatchObject({ hasApiKey: true, hasCustomHeaders: true, baseUrl: 'https://models.example.com/proxy/v1' })
    expect(profile).not.toHaveProperty('apiKey')
    expect(profile).not.toHaveProperty('customHeaders')
    expect(await profiles.resolve(profile.id)).toMatchObject({
      apiKey: 'private-api-key-for-test', customHeaders: { 'X-Token': 'private-header-for-test' }
    })
    store.close()
    const contents = readFileSync(file).toString('latin1')
    expect(contents).not.toContain('private-api-key-for-test')
    expect(contents).not.toContain('private-header-for-test')
  })

  it('preserves omitted credentials, but explicitly clears empty credentials', async () => {
    const { store, profiles } = setup()
    const created = await profiles.save({ ...base, contextWindow: 128000, authMethod: 'api-key' as const, apiKey: 'original-secret', customHeaders: { 'X-Test': 'original-header' } })
    await profiles.save({ ...base, authMethod: 'api-key', id: created.id, name: '改个名字' })
    expect(await profiles.resolve(created.id)).toMatchObject({
      apiKey: 'original-secret', customHeaders: { 'X-Test': 'original-header' }
    })
    await profiles.save({ ...base, id: created.id, apiKey: '', customHeaders: {} })
    expect(await profiles.resolve(created.id)).toMatchObject({ apiKey: '', customHeaders: {} })
    expect(profiles.list()[0]).toMatchObject({ hasApiKey: false, hasCustomHeaders: false })
    store.close()
  })

  it('invalidates previous verification when model or credentials change', async () => {
    const { store, profiles } = setup()
    const profile = await profiles.save(base)
    profiles.recordTest(profile.id, 'chat', { status: 'passed', message: '连接成功', checkedAt: new Date().toISOString() })
    await profiles.save({ ...base, id: profile.id, name: '仅重命名' })
    expect(profiles.list()[0].models[0].tests.chat.status).toBe('passed')
    await profiles.save({ ...base, id: profile.id, model: 'different-model' })
    expect(profiles.list()[0].models[0].tests.chat.status).toBe('untested')
    store.close()
  })

  it('rejects credentials embedded in URLs, unknown protocols, and invalid headers', async () => {
    const { store, profiles } = setup()
    await expect(profiles.save({ ...base, baseUrl: 'https://user:secret@example.com/v1' })).rejects.toThrow('地址')
    await expect(profiles.save({ ...base, baseUrl: 'https://example.com/v1?token=secret' })).rejects.toThrow('地址')
    await expect(profiles.save({ ...base, protocol: 'unknown' as 'openai' })).rejects.toThrow('协议')
    await expect(profiles.save({ ...base, contextWindow: 128000, authMethod: 'headers' as const, customHeaders: { 'X-Key': 'one\r\ntwo' } })).rejects.toThrow('请求头')
    expect(profiles.list()).toEqual([])
    store.close()
  })

  it('fails closed if credential protection fails and leaves the old configuration intact', async () => {
    const { store, profiles } = setup()
    const original = await profiles.save({ ...base, contextWindow: 128000, authMethod: 'api-key' as const, apiKey: 'original-secret' })
    const broken = new ProfileService(store, {
      encrypt: async () => { throw new Error('凭据保护不可用') },
      decrypt: async () => { throw new Error('凭据保护不可用') }
    })
    await expect(broken.save({ ...base, contextWindow: 128000, authMethod: 'api-key' as const, id: original.id, apiKey: 'replacement-secret' })).rejects.toThrow()
    expect(await profiles.resolve(original.id)).toMatchObject({ apiKey: 'original-secret', model: 'my-model' })
    store.close()
  })

  it('clears active selection when deleting it, without selecting another endpoint', async () => {
    const { store, profiles } = setup()
    const first = await profiles.save(base)
    await profiles.save({ ...base, name: '另一个服务' })
    profiles.select(first.id)
    profiles.delete(first.id)
    expect(store.getSettings().activeProfileId).toBeNull()
    store.close()
  })

  it('can clear or fully replace old credentials even when the old ciphertext cannot be decrypted', async () => {
    const { store, profiles, codec } = setup()
    const original = await profiles.save({ ...base, contextWindow: 128000, authMethod: 'api-key' as const, apiKey: 'old-key', customHeaders: { 'X-Test': 'old-header' } })
    const unavailable = new ProfileService(store, {
      encrypt: codec.encrypt,
      decrypt: async () => { throw new Error('old credentials unavailable') }
    })
    await expect(unavailable.save({ ...base, contextWindow: 128000, authMethod: 'api-key' as const, id: original.id, apiKey: 'new-key', customHeaders: {} }))
      .resolves.toMatchObject({ hasApiKey: true, hasCustomHeaders: false })
    expect(await profiles.resolve(original.id)).toMatchObject({ apiKey: 'new-key', customHeaders: {} })
    await expect(unavailable.save({ ...base, id: original.id, apiKey: '', customHeaders: {} }))
      .resolves.toMatchObject({ hasApiKey: false, hasCustomHeaders: false })
    expect(await unavailable.resolve(original.id)).toMatchObject({ apiKey: '', customHeaders: {} })
    store.close()
  })

  it('preserves a test completed during a name-only save and keeps its connection revision valid', async () => {
    const { store, profiles, codec } = setup()
    const original = await profiles.save({ ...base, contextWindow: 128000, authMethod: 'api-key' as const, apiKey: 'existing-key' })
    const revision = profiles.revision(original.id)
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const ready = new Promise<void>(resolve => { entered = resolve })
    const delayed = new ProfileService(store, {
      decrypt: codec.decrypt,
      encrypt: async text => { entered(); await gate; return codec.encrypt(text) }
    })
    const saving = delayed.save({ ...base, authMethod: 'api-key', id: original.id, name: 'new name' })
    await ready
    expect(profiles.recordTest(original.id, 'chat', { status: 'passed', message: 'connected' }, revision)).toBe(true)
    release()
    const saved = await saving
    expect(saved.models[0].tests.chat.status).toBe('passed')
    expect(profiles.recordTest(original.id, 'tools', { status: 'passed', message: 'tools available' }, revision)).toBe(true)
    store.close()
  })
})

describe('OpenAI Responses protocol', () => {
  const responses = { ...base, protocol: 'openai-responses' as const }

  it('accepts openai-responses protocol and persists it across restart', async () => {
    const { store, profiles } = setup()
    const saved = await profiles.save(responses)
    expect(saved.protocol).toBe('openai-responses')
    expect(profiles.list()[0].protocol).toBe('openai-responses')
    store.close()
  })

  it('persists maxOutputTokens for an openai-responses custom service', async () => {
    const { store, profiles } = setup()
    const saved = await profiles.save({ ...responses, maxOutputTokens: 8192 })
    expect(saved.maxOutputTokens).toBe(8192)
    expect((await profiles.resolve(saved.id)).maxOutputTokens).toBe(8192)
    store.close()
  })

  it('rejects unknown protocols and leaves existing configuration intact', async () => {
    const { store, profiles } = setup()
    const saved = await profiles.save(base)
    await expect(profiles.save({ ...base, id: saved.id, protocol: 'unknown' as 'openai' })).rejects.toThrow('请选择有效的服务协议')
    expect(profiles.list()[0].protocol).toBe('openai')
    store.close()
  })

  it('invalidates connection tests when protocol changes to openai-responses', async () => {
    const { store, profiles } = setup()
    const saved = await profiles.save(base)
    profiles.recordTest(saved.id, 'chat', { status: 'passed', message: '连接成功' })
    profiles.recordTest(saved.id, 'tools', { status: 'passed', message: '工具可用' })
    await profiles.save({ ...base, id: saved.id, protocol: 'openai-responses' as const })
    expect(profiles.list()[0].models[0].tests.chat.status).toBe('untested')
    expect(profiles.list()[0].models[0].tests.tools.status).toBe('untested')
    store.close()
  })
})

describe('Anthropic maximum output tokens', () => {
  const claude = { ...base, protocol: 'anthropic' as const }

  it('rejects invalid values and leaves the saved configuration unchanged', async () => {
    const { store, profiles } = setup()
    const saved = await profiles.save({ ...claude, maxOutputTokens: 8192 })
    for (const value of [0, -1, 1.5, Number.NaN, 1_000_001]) {
      await expect(profiles.save({ ...claude, id: saved.id, maxOutputTokens: value })).rejects.toThrow('最大输出')
    }
    expect(profiles.list()[0].maxOutputTokens).toBe(8192)
    store.close()
  })

  it('accepts the boundary values 1 and 1000000', async () => {
    const { store, profiles } = setup()
    const saved = await profiles.save({ ...claude, maxOutputTokens: 1 })
    expect(saved.maxOutputTokens).toBe(1)
    expect((await profiles.save({ ...claude, id: saved.id, maxOutputTokens: 200_000 })).maxOutputTokens).toBe(200_000)
    store.close()
  })

  it('keeps the value when omitted, clears it with null, and exposes it to the runtime provider', async () => {
    const { store, profiles } = setup()
    const saved = await profiles.save({ ...claude, maxOutputTokens: 8192 })
    await profiles.save({ ...claude, id: saved.id, name: '只改名字' })
    expect(profiles.list()[0].maxOutputTokens).toBe(8192)
    expect((await profiles.resolve(saved.id)).maxOutputTokens).toBe(8192)
    await profiles.save({ ...claude, id: saved.id, maxOutputTokens: null })
    expect(profiles.list()[0]).not.toHaveProperty('maxOutputTokens')
    expect((await profiles.resolve(saved.id))).not.toHaveProperty('maxOutputTokens')
    store.close()
  })

  it('keeps the configured output limit across protocol changes', async () => {
    const { store, profiles } = setup()
    const saved = await profiles.save({ ...claude, maxOutputTokens: 8192 })
    await profiles.save({ ...base, id: saved.id, maxOutputTokens: 8192 })
    expect(profiles.list()[0].maxOutputTokens).toBe(8192)
    await profiles.save({ ...claude, id: saved.id })
    expect(profiles.list()[0].maxOutputTokens).toBe(8192)
    store.close()
  })

  it('does not invalidate verification or bump the revision when only this value changes', async () => {
    const { store, profiles } = setup()
    const saved = await profiles.save({ ...claude, maxOutputTokens: 4096 })
    profiles.recordTest(saved.id, 'chat', { status: 'passed', message: '连接成功' })
    const revision = profiles.revision(saved.id)
    await profiles.save({ ...claude, id: saved.id, maxOutputTokens: 8192 })
    expect(profiles.list()[0].models[0].tests.chat.status).toBe('passed')
    expect(profiles.revision(saved.id)).toBe(revision)
    store.close()
  })


})

describe('multiple models per service', () => {
  const claude = { ...base, protocol: 'anthropic' as const }
  const two = { models: [{ id: 'my-model' }, { id: 'second-model' }] }
  const passed = { status: 'passed' as const, message: '连接成功' }

  it('stores several models with one default, defaulting to a single-model list when omitted', async () => {
    const { store, profiles } = setup()
    const single = await profiles.save(base)
    expect(single.models.map(item => item.id)).toEqual(['my-model'])
    const saved = await profiles.save({ ...base, id: single.id, ...two, model: 'second-model' })
    expect(saved).toMatchObject({ model: 'second-model' })
    expect(saved.models.map(item => item.id)).toEqual(['my-model', 'second-model'])
    expect((await profiles.resolve(saved.id)).model).toBe('second-model')
    expect((await profiles.resolve(saved.id, 'my-model')).model).toBe('my-model')
    store.close()
  })

  it('rejects invalid model lists and leaves the saved configuration unchanged', async () => {
    const { store, profiles } = setup()
    const saved = await profiles.save({ ...base, ...two })
    const bad: [string, Parameters<typeof profiles.save>[0]][] = [
      ['1 到 20', { ...base, id: saved.id, models: [] }],
      ['空', { ...base, id: saved.id, models: [{ id: 'my-model' }, { id: '   ' }] }],
      ['超过', { ...base, id: saved.id, models: [{ id: 'my-model' }, { id: 'x'.repeat(2049) }] }],
      ['重复', { ...base, id: saved.id, models: [{ id: 'my-model' }, { id: ' my-model ' }] }],
      ['20', { ...base, id: saved.id, models: Array.from({ length: 21 }, (_, i) => ({ id: i === 0 ? 'my-model' : `m${i}` })) }],
      ['默认', { ...base, id: saved.id, model: 'missing', models: [{ id: 'my-model' }] }]
    ]
    for (const [word, input] of bad) await expect(profiles.save(input)).rejects.toThrow(word)
    expect(profiles.list()[0].models.map(item => item.id)).toEqual(['my-model', 'second-model'])
    store.close()
  })

  it('keeps other models verified when one is added, and resets all when the address changes', async () => {
    const { store, profiles } = setup()
    const saved = await profiles.save(base)
    profiles.recordTest(saved.id, 'chat', passed)
    const revision = profiles.revision(saved.id)
    const added = await profiles.save({ ...base, id: saved.id, ...two })
    expect(added.models.map(item => item.tests.chat.status)).toEqual(['passed', 'untested'])
    expect(profiles.revision(saved.id)).toBe(revision)
    await profiles.save({ ...base, id: saved.id, ...two, baseUrl: 'https://other.example.com/v1' })
    expect(profiles.list()[0].models.map(item => item.tests.chat.status)).toEqual(['untested', 'untested'])
    expect(profiles.revision(saved.id)).toBe(revision + 1)
    store.close()
  })

  it('keeps tests and revision when only the default model, the 1M switch or the override change', async () => {
    const { store, profiles } = setup()
    const saved = await profiles.save({ ...claude, ...two })
    profiles.recordTest(saved.id, 'chat', passed, undefined, 'second-model')
    const revision = profiles.revision(saved.id)
    await profiles.save({ ...claude, id: saved.id, model: 'second-model', models: [{ id: 'my-model', longOutput: true }, { id: 'second-model' }], maxOutputTokens: 8192 })
    const after = profiles.list()[0]
    expect(after.models.map(item => item.tests.chat.status)).toEqual(['untested', 'passed'])
    expect(after.models[0].longOutput).toBe(true)
    expect(profiles.revision(saved.id)).toBe(revision)
    store.close()
  })

  it('records a test only on the tested model and ignores models that no longer exist', async () => {
    const { store, profiles } = setup()
    const saved = await profiles.save({ ...base, ...two })
    expect(profiles.recordTest(saved.id, 'tools', passed, undefined, 'second-model')).toBe(true)
    expect(profiles.list()[0].models.map(item => item.tests.tools.status)).toEqual(['untested', 'passed'])
    expect(profiles.recordTest(saved.id, 'tools', passed, undefined, 'gone')).toBe(false)
    store.close()
  })

  it('rejects an unknown model when resolving a runtime provider', async () => {
    const { store, profiles } = setup()
    const saved = await profiles.save(base)
    await expect(profiles.resolve(saved.id, 'missing')).rejects.toThrow('没有这个模型')
    store.close()
  })
})

describe('per-model 1M output limit', () => {
  const claude = { ...base, protocol: 'anthropic' as const }
  const models = [{ id: 'my-model', longOutput: true }, { id: 'plain-model' }]

  it('puts 1000000 ahead of the service override for Anthropic, only on the enabled model', async () => {
    const { store, profiles } = setup()
    const saved = await profiles.save({ ...claude, models, maxOutputTokens: 8192 })
    expect((await profiles.resolve(saved.id)).maxOutputTokens).toBe(1_000_000)
    expect((await profiles.resolve(saved.id, 'plain-model')).maxOutputTokens).toBe(8192)
    await profiles.save({ ...claude, id: saved.id, models: [{ id: 'my-model' }, { id: 'plain-model' }] })
    expect((await profiles.resolve(saved.id)).maxOutputTokens).toBe(8192)
    store.close()
  })

  it('applies 1M to OpenAI-compatible and Responses models and sends nothing when it is off', async () => {
    const { store, profiles } = setup()
    for (const protocol of ['openai', 'openai-responses'] as const) {
      const saved = await profiles.save({ ...base, protocol, models })
      expect((await profiles.resolve(saved.id)).maxOutputTokens).toBe(1_000_000)
      expect(await profiles.resolve(saved.id, 'plain-model')).not.toHaveProperty('maxOutputTokens')
    }
    store.close()
  })

  it('keeps the switch and service override when the protocol changes', async () => {
    const { store, profiles } = setup()
    const saved = await profiles.save({ ...claude, models, maxOutputTokens: 8192 })
    const changed = await profiles.save({ ...base, id: saved.id, models, maxOutputTokens: 8192 })
    expect(changed.models[0].longOutput).toBe(true)
    expect(changed.maxOutputTokens).toBe(8192)
    store.close()
  })
})

describe('vision connection tests and legacy model tests', () => {
  it('fills missing vision status on an existing stored profile without resaving', async () => {
    const { store, profiles, file, codec } = setup()
    const saved = await profiles.save(base)
    const legacy = store.getProfile(saved.id)!
    delete (legacy.models[0].tests as Partial<typeof legacy.models[0]['tests']>).vision
    store.saveProfile(legacy)
    store.close()
    const reopened = new HerStore(file)
    const profile = new ProfileService(reopened, codec).list()[0]
    expect(profile.models[0].tests.vision).toEqual({ status: 'untested', message: '尚未测试' })
    reopened.close()
  })


})

describe('Pi model catalog and explicit custom capacities', () => {
  it('rejects a custom service with missing context capacity before saving anything', async () => {
    const { store, profiles } = setup()
    await expect(profiles.save({ ...base, contextWindow: undefined })).rejects.toThrow('上下文')
    await expect(profiles.save({ ...base, contextWindow: null as unknown as number })).rejects.toThrow('上下文')
    expect(profiles.list()).toEqual([])
    store.close()
  })

  it('returns configured custom capacity to the renderer and runtime', async () => {
    const { store, profiles } = setup()
    const saved = await profiles.save({ ...base, contextWindow: 8192 })
    expect(saved.contextWindow).toBe(8192)
    expect((await profiles.resolve(saved.id)).contextWindow).toBe(8192)
    store.close()
  })

  it('takes catalog protocol, window, image capability and output limit from Pi instead of caller values', async () => {
    const { store, profiles } = setup()
    const catalog = await profiles.listCatalog()
    const selected = catalog.find(item => item.protocol === 'anthropic' && item.multimodal)!
    expect(selected.contextWindow).toBeGreaterThan(0)
    const saved = await profiles.save({ ...base, model: selected.id, catalogProvider: selected.provider, contextWindow: 1024 })
    expect(saved.protocol).toBe('anthropic')
    expect(saved.models[0].catalogProvider).toBe(selected.provider)
    expect(await profiles.resolve(saved.id)).toMatchObject({ contextWindow: selected.contextWindow, maxOutputTokens: selected.maxOutputTokens, multimodal: true })
    expect(saved.contextWindow).toBe(selected.contextWindow)
    store.close()
  })

  it('rejects unknown authentication modes and clears credentials when explicitly switching to none', async () => {
    const { store, profiles } = setup()
    await expect(profiles.save({ ...base, contextWindow: 8192, authMethod: 'invalid' as 'none' })).rejects.toThrow('认证')
    const saved = await profiles.save({ ...base, contextWindow: 8192, authMethod: 'api-key', apiKey: 'old-key' })
    await profiles.save({ ...saved, contextWindow: 128000, authMethod: 'none' })
    expect(await profiles.resolve(saved.id)).toMatchObject({ apiKey: '', customHeaders: {} })
    store.close()
  })
})
