import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { McpConfigService } from '../src/core/mcp/config'
import { HerStore } from '../src/core/storage/store'
import type { SecretCodec } from '../src/core/storage/profiles'
import type { SaveMcpServiceInput } from '../src/shared/types'

const directories: string[] = []
const stores: HerStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const key = randomBytes(32)
const codec: SecretCodec = {
  async encrypt(text) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), data])
  },
  async decrypt(data) {
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12))
    decipher.setAuthTag(data.subarray(12, 28))
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8')
  }
}
const stdio: SaveMcpServiceInput = { name: '本地服务', enabled: true, transport: 'stdio', command: '/a path/node', args: ['--flag', 'an argument with spaces'], cwd: '/tmp' }
const http: SaveMcpServiceInput = { name: '远程服务', enabled: true, transport: 'streamable-http', url: 'https://example.com/mcp' }
function setup(path = ':memory:', secretCodec = codec) {
  const store = new HerStore(path)
  stores.push(store)
  return { store, service: new McpConfigService(store, secretCodec) }
}
function path() {
  const directory = mkdtempSync(join(tmpdir(), 'her-mcp-config-'))
  directories.push(directory)
  return join(directory, 'her.sqlite')
}
function delayedCodec(operation: 'encrypt' | 'decrypt') {
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  return {
    ready, release: () => release(), codec: { ...codec, [operation]: async (value: never) => {
      entered(); await gate
      return (codec[operation] as (value: never) => Promise<Buffer | string>)(value)
    } } as SecretCodec
  }
}

describe('MCP configuration', () => {
  it('ignores legacy global grants after restart and rejects all new writes of the retired field', async () => {
    const file = path(), { service, store } = setup(file)
    const initial = await service.save(stdio)
    const persisted = store.getMcpService(initial.id)!
    store.saveMcpService({ ...persisted, config: { ...persisted.config, allowAllOperations: true } }, initial.revision)
    store.close(); stores.splice(stores.indexOf(store), 1)
    const reopened = setup(file).service
    expect(reopened.list()[0]).not.toHaveProperty('allowAllOperations')
    expect(await reopened.resolve(initial.id)).not.toHaveProperty('allowAllOperations')
    for (const value of [true, false, 'true']) await expect(reopened.save({ ...stdio, allowAllOperations: value } as unknown as SaveMcpServiceInput)).rejects.toThrow(/自动操作/)
    const renamed = await reopened.save({ ...stdio, id: initial.id, expectedRevision: initial.revision, name: '改名' })
    expect(renamed.name).toBe('改名')
    expect(renamed).not.toHaveProperty('allowAllOperations')
  })

  it('reads actual environment values for disabled services without exposing HTTP headers or changing encrypted storage', async () => {
    const file = path()
    const { service, store } = setup(file)
    const saved = await service.save({ ...stdio, enabled: false, secretValues: { PEEKABOO_ALLOW_TOOLS: 'app,window', TOKEN: 'saved-environment-value' } })
    const remote = await service.save({ ...http, secretValues: { Authorization: 'saved-header-value' } })
    expect(await service.getEnvironment(saved.id, saved.revision)).toEqual({ PEEKABOO_ALLOW_TOOLS: 'app,window', TOKEN: 'saved-environment-value' })
    await expect(service.getEnvironment(remote.id, remote.revision)).rejects.toThrow('本地 stdio')
    await expect(service.getEnvironment(saved.id, saved.revision + 1)).rejects.toThrow('配置已变更')
    expect(JSON.stringify(service.list())).not.toMatch(/saved-environment-value|saved-header-value/)
    store.close(); stores.splice(stores.indexOf(store), 1)
    expect(readFileSync(file).toString('latin1')).not.toMatch(/saved-environment-value|saved-header-value/)
  })

  it.each(['changed', 'removed'] as const)('rejects a late environment read when its configuration was %s', async action => {
    const delayed = delayedCodec('decrypt')
    const { service } = setup(':memory:', delayed.codec)
    const saved = await service.save({ ...stdio, enabled: false, secretValues: { FLAG: 'original' } })
    const reading = service.getEnvironment(saved.id, saved.revision)
    await delayed.ready
    if (action === 'removed') service.remove(saved.id)
    else await service.save({ ...stdio, id: saved.id, expectedRevision: saved.revision, secretValues: { FLAG: 'changed' } })
    delayed.release()
    await expect(reading).rejects.toThrow('配置已变更')
  })

  it('secrets_never_appear_in_public_config', async () => {
    const file = path()
    const { service, store } = setup(file)
    const saved = await service.save({ ...stdio, secretValues: { TOKEN: 'private-env-for-test' } })
    const remote = await service.save({ ...http, secretValues: { Authorization: 'private-header-for-test' } })
    expect(saved).toMatchObject({ secretKeys: ['TOKEN'], hasSecrets: true })
    expect(remote).toMatchObject({ secretKeys: ['authorization'], hasSecrets: true })
    expect(JSON.stringify(service.list())).not.toMatch(/private-env-for-test|private-header-for-test|sealedSecrets|secretValues/)
    expect(await service.resolve(saved.id)).toMatchObject({ command: '/a path/node', args: ['--flag', 'an argument with spaces'], env: { TOKEN: 'private-env-for-test' } })
    expect(await service.resolve(remote.id)).toMatchObject({ headers: { authorization: 'private-header-for-test' } })
    store.close(); stores.splice(stores.indexOf(store), 1)
    expect(readFileSync(file).toString('latin1')).not.toMatch(/private-env-for-test|private-header-for-test/)
  })

  it('blank_secret_keeps_and_explicit_clear_removes', async () => {
    const { service } = setup()
    const first = await service.save({ ...stdio, secretValues: { TOKEN: 'original', OTHER: 'keep' } })
    const second = await service.save({ ...stdio, id: first.id, expectedRevision: first.revision, name: '改名', secretValues: { TOKEN: '' } })
    expect(await service.resolve(first.id)).toMatchObject({ env: { TOKEN: 'original', OTHER: 'keep' } })
    const third = await service.save({ ...stdio, id: first.id, expectedRevision: second.revision, clearSecretKeys: ['TOKEN'] })
    expect(third.secretKeys).toEqual(['OTHER'])
    expect(await service.resolve(first.id)).toMatchObject({ env: { OTHER: 'keep' } })
    const last = await service.save({ ...stdio, id: first.id, clearSecretKeys: ['OTHER'] })
    expect(last).toMatchObject({ secretKeys: [], hasSecrets: false })
  })

  it('stale_revision_cannot_overwrite_config', async () => {
    const { service } = setup()
    const first = await service.save(stdio)
    const second = await service.save({ ...stdio, id: first.id, expectedRevision: first.revision, name: 'new' })
    expect(second.revision).toBeGreaterThan(first.revision)
    await expect(service.save({ ...stdio, id: first.id, expectedRevision: first.revision, name: 'stale' })).rejects.toThrow('配置已变更')
    expect(service.list()[0].name).toBe('new')
  })

  it('service_survives_restart with secrets, revision, test and unchanged settings/profile', async () => {
    const file = path()
    const { service, store } = setup(file)
    const settings = { activeProfileId: null, shortcut: 'Custom', stopShortcut: 'CommandOrControl+Shift+Escape', launchAtLogin: true, appearance: 'light' as const, systemPrompt: '保留' }
    store.setSettings(settings)
    const saved = await service.save({ ...http, secretValues: { Authorization: 'restart-secret' } })
    service.recordTest(saved.id, saved.revision, { status: 'passed', message: 'connected' })
    store.close(); stores.splice(stores.indexOf(store), 1)
    const reopened = setup(file)
    expect(reopened.service.list()).toEqual([saved])
    expect(await reopened.service.resolve(saved.id)).toMatchObject({ headers: { authorization: 'restart-secret' }, revision: saved.revision })
    expect(reopened.service.getTestResult(saved.id, saved.revision)).toEqual({ status: 'passed', message: 'connected' })
    expect(reopened.store.getSettings()).toEqual(settings)
    expect(reopened.store.listProfiles()).toEqual([])
  })

  it('preserves routing query parameters and encoded values through save, list, resolve and restart', async () => {
    const file = path()
    const { service, store } = setup(file)
    const url = 'https://example.com/mcp?tenant=team-a&route=a%2Fb%20c&label=%E4%B8%AD%E6%96%87&literal=x%26y%3Dz&tenant=team-b'
    const saved = await service.save({ ...http, url, secretValues: { Authorization: 'sealed-header' } })
    expect(saved.url).toBe(url)
    expect(service.list()[0].url).toBe(url)
    expect(await service.resolve(saved.id)).toMatchObject({ url, headers: { authorization: 'sealed-header' } })
    store.close(); stores.splice(stores.indexOf(store), 1)
    const reopened = setup(file)
    expect(reopened.service.list()[0].url).toBe(url)
    expect(await reopened.service.resolve(saved.id)).toMatchObject({ url, headers: { authorization: 'sealed-header' } })
  })

  it.each([
    { ...stdio, command: '' }, { ...stdio, command: 'node\0' }, { ...stdio, args: 'a b' },
    { ...stdio, args: ['ok', 2] }, { ...stdio, args: ['bad\0arg'] }, { ...stdio, cwd: 'relative' },
    { ...http, url: 'file:///tmp/service' }, { ...http, url: 'https://user:password@example.com/mcp' },
    { ...http, url: 'https://example.com/mcp#fragment' },
    { ...stdio, secretValues: { 'BAD=KEY': 'value' } }, { ...stdio, secretValues: { KEY: 'bad\0value' } },
    { ...http, secretValues: { Authorization: 'bad\r\nheader' } }, { ...http, secretValues: { Host: 'override' } },
    { ...http, secretValues: { 'bad name': 'value' } }, { ...http, enabled: 'yes' },
    { ...stdio, name: ' ' }, { ...stdio, expectedRevision: 0 },
    { ...stdio, secretValues: { KEY: 123 } }, { ...http, clearSecretKeys: 'Authorization' }
  ])('rejects invalid config without writing: %j', async input => {
    const { service } = setup()
    await expect(service.save(input as SaveMcpServiceInput)).rejects.toThrow()
    expect(service.list()).toEqual([])
  })

  it('validates transport fields independently and never forwards other-transport fields or secrets', async () => {
    const { service } = setup()
    const local = await service.save({ ...stdio, url: 'not a URL', secretValues: { TOKEN: 'local-only' } } as SaveMcpServiceInput)
    expect(local).not.toHaveProperty('url')
    const remote = await service.save({ ...http, id: local.id, command: '', args: 'invalid' } as unknown as SaveMcpServiceInput)
    expect(remote).not.toHaveProperty('command')
    expect(remote).toMatchObject({ secretKeys: [], hasSecrets: false })
    expect(await service.resolve(local.id)).toMatchObject({ headers: {} })
    const back = await service.save({ ...stdio, id: local.id })
    expect(await service.resolve(back.id)).toMatchObject({ env: {} })
  })

  it.each(['remove', 'disable', 'edit'] as const)('late encryption cannot undo %s and does not notify a stale commit', async change => {
    const { service, store } = setup()
    const original = await service.save({ ...stdio, secretValues: { TOKEN: 'original' } })
    const delayed = delayedCodec('encrypt')
    const other = new McpConfigService(store, delayed.codec)
    const events: unknown[] = []
    other.subscribe(event => events.push(event))
    const saving = other.save({ ...stdio, id: original.id, expectedRevision: original.revision, secretValues: { TOKEN: 'late' } })
    await delayed.ready
    if (change === 'remove') service.remove(original.id)
    else await service.save({ ...stdio, id: original.id, enabled: change !== 'disable', name: 'current' })
    delayed.release()
    await expect(saving).rejects.toThrow('配置已变更')
    expect(events).toEqual([])
    if (change === 'remove') expect(service.list()).toEqual([])
    else expect(service.list()[0]).toMatchObject({ name: 'current', enabled: change !== 'disable' })
  })

  it('two instances cannot win the same awaited revision, even without expectedRevision', async () => {
    const { service, store } = setup()
    const first = await service.save({ ...stdio, secretValues: { TOKEN: 'original' } })
    const delayed = delayedCodec('decrypt')
    const stale = new McpConfigService(store, delayed.codec)
    const saving = stale.save({ ...stdio, id: first.id, name: 'stale' })
    await delayed.ready
    await service.save({ ...stdio, id: first.id, name: 'winner' })
    delayed.release()
    await expect(saving).rejects.toThrow('配置已变更')
    expect(service.list()[0].name).toBe('winner')
  })

  it.each(['remove', 'disable', 'edit'] as const)('late resolve and test cannot use config after %s', async change => {
    const { service, store } = setup()
    const first = await service.save({ ...stdio, secretValues: { TOKEN: 'original' } })
    const delayed = delayedCodec('decrypt')
    const resolving = new McpConfigService(store, delayed.codec).resolve(first.id)
    await delayed.ready
    if (change === 'remove') service.remove(first.id)
    else await service.save({ ...stdio, id: first.id, enabled: change !== 'disable' })
    delayed.release()
    await expect(resolving).rejects.toThrow('配置已变更')
    expect(service.recordTest(first.id, first.revision, { status: 'passed', message: 'late' })).toBe(false)
    expect(service.getTestResult(first.id, first.revision)).toBeUndefined()
    if (change === 'disable') await expect(service.resolve(first.id)).rejects.toThrow('停用')
  })

  it('notifies synchronously after commits, invalidates tests on edit/disable/re-enable/remove, and unsubscribes', async () => {
    const { service } = setup()
    const observed: unknown[] = []
    const unsubscribe = service.subscribe(event => observed.push({ event, list: service.list() }))
    const first = await service.save(stdio)
    expect(observed).toEqual([{ event: { serviceId: first.id, revision: first.revision, removed: false }, list: [first] }])
    expect(service.recordTest(first.id, first.revision, { status: 'passed', message: 'ok' })).toBe(true)
    const disabled = await service.save({ ...stdio, id: first.id, enabled: false })
    expect(service.getTestResult(first.id, disabled.revision)).toBeUndefined()
    expect(service.recordTest(first.id, disabled.revision, { status: 'passed', message: 'disabled' })).toBe(false)
    const enabled = await service.save({ ...stdio, id: first.id })
    expect(enabled.revision).toBeGreaterThan(disabled.revision)
    service.remove(first.id)
    expect(observed.at(-1)).toEqual({ event: { serviceId: first.id, revision: enabled.revision + 1, removed: true }, list: [] })
    await expect(service.save({ ...stdio, id: first.id })).rejects.toThrow()
    unsubscribe()
    await service.save(http)
    expect(observed).toHaveLength(4)
  })

  it('crypto failures leave config, revision and subscriptions untouched', async () => {
    const { service, store } = setup()
    const original = await service.save({ ...stdio, secretValues: { TOKEN: 'original' } })
    const failing = new McpConfigService(store, { ...codec, encrypt: async () => { throw new Error('protection failed') } })
    const events: unknown[] = []
    failing.subscribe(event => events.push(event))
    await expect(failing.save({ ...stdio, id: original.id, secretValues: { TOKEN: 'replacement' } })).rejects.toThrow('凭据保护')
    expect(service.list()).toEqual([original])
    expect(events).toEqual([])
  })
  it('treats whitespace-only edits as blank without trimming meaningful secret values', async () => {
    const { service } = setup()
    const first = await service.save({ ...http, secretValues: { Authorization: ' original ', 'X-Token': 'keep' } })
    await service.save({ ...http, id: first.id, secretValues: { AUTHORIZATION: '   ', 'X-Token': '' } })
    expect(await service.resolve(first.id)).toMatchObject({ headers: { authorization: ' original ', 'x-token': 'keep' } })
    await service.save({ ...http, id: first.id, clearSecretKeys: ['AUTHORIZATION'] })
    expect(await service.resolve(first.id)).toMatchObject({ headers: { 'x-token': 'keep' } })
  })

  it('notifies all invalidators even when one subscriber throws after commit', async () => {
    const { service } = setup()
    service.subscribe(() => { throw new Error('subscriber failed') })
    const events: unknown[] = []
    service.subscribe(event => events.push(event))
    const first = await service.save(stdio)
    expect(events).toEqual([{ serviceId: first.id, revision: first.revision, removed: false }])
    service.remove(first.id)
    expect(events).toHaveLength(2)
    expect(service.list()).toEqual([])
  })

  it.each(['encrypt', 'decrypt'] as const)('does not expose %s failure details containing credentials', async operation => {
    const { store, service } = setup()
    const original = await service.save({ ...stdio, secretValues: { TOKEN: 'private-token' } })
    const broken = new McpConfigService(store, { ...codec, [operation]: async () => { throw new Error('private-token in codec error') } })
    const saving = broken.save({ ...stdio, id: original.id })
    await expect(saving).rejects.not.toThrow('private-token')
    expect(service.list()).toEqual([original])
    if (operation === 'decrypt') await expect(broken.resolve(original.id)).rejects.not.toThrow('private-token')
  })

  it('can explicitly clear all secrets even when old decryption is unavailable', async () => {
    const { store, service } = setup()
    const original = await service.save({ ...stdio, secretValues: { TOKEN: 'private-token' } })
    const unavailable = new McpConfigService(store, { ...codec, decrypt: async () => { throw new Error('unavailable') } })
    await unavailable.save({ ...stdio, id: original.id, clearSecretKeys: ['TOKEN'] })
    expect(await unavailable.resolve(original.id)).toMatchObject({ env: {} })
  })

  it('persists the removed revision as a tombstone and cannot restore a deleted service after restart', async () => {
    const file = path()
    const { store, service } = setup(file)
    const original = await service.save(stdio)
    service.remove(original.id)
    store.close(); stores.splice(stores.indexOf(store), 1)
    const reopened = setup(file)
    await expect(reopened.service.save({ ...stdio, id: original.id, expectedRevision: original.revision })).rejects.toThrow('配置已变更')
    expect(reopened.service.list()).toEqual([])
    expect(reopened.service.recordTest(original.id, original.revision, { status: 'passed', message: 'late' })).toBe(false)
  })

  it('preserves and replaces valid secret keys that match JavaScript object properties', async () => {
    const { service } = setup()
    const first = await service.save({ ...stdio, secretValues: { constructor: 'first' } })
    await service.save({ ...stdio, id: first.id, secretValues: { TOKEN: 'keep' } })
    expect(await service.resolve(first.id)).toMatchObject({ env: { constructor: 'first', TOKEN: 'keep' } })
    await service.save({ ...stdio, id: first.id, secretValues: JSON.parse('{"__proto__":"sealed","constructor":"replaced"}') })
    const runtime = await service.resolve(first.id)
    expect(Object.entries(runtime.env!)).toEqual(expect.arrayContaining([['__proto__', 'sealed'], ['constructor', 'replaced'], ['TOKEN', 'keep']]))
    await service.save({ ...stdio, id: first.id, clearSecretKeys: ['__proto__', 'constructor'] })
    expect(await service.resolve(first.id)).toMatchObject({ env: { TOKEN: 'keep' } })
    expect(service.list()[0].secretKeys).toEqual(['TOKEN'])
  })

})
