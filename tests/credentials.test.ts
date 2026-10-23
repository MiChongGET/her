import { afterEach, describe, expect, it, vi } from 'vitest'
import { HerStore } from '../src/core/storage/store'
import { ProfileService } from '../src/core/storage/profiles'

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (text: string) => Buffer.from(text),
    decryptStringAsync: async (bytes: Buffer) => ({ result: bytes.toString(), shouldReEncrypt: false })
  }
}))

import { secretCodec } from '../src/main/credentials'
import { safeStorage } from 'electron'

let store: HerStore | undefined
afterEach(() => { store?.close(); store = undefined })

describe('Electron credential decoding', () => {
  it('refuses to persist credentials when native encryption is unavailable', async () => {
    vi.spyOn(safeStorage, 'isAsyncEncryptionAvailable').mockResolvedValueOnce(false)
    store = new HerStore(':memory:')
    const profiles = new ProfileService(store, secretCodec)
    await expect(profiles.save({ name: 'p', protocol: 'openai', baseUrl: 'http://127.0.0.1/v1', model: 'm', contextWindow: 128000, authMethod: 'api-key', apiKey: 'must-not-persist' })).rejects.toThrow('凭据保护')
    expect(profiles.list()).toEqual([])
  })

  it('returns the plaintext result from the native async decryption response', async () => {
    const payload = '{"apiKey":"fixture-key","customHeaders":{}}'
    expect(await secretCodec.decrypt(Buffer.from(payload))).toBe(payload)
  })

  it('resolves and preserves saved profile secrets using the Electron codec', async () => {
    store = new HerStore(':memory:')
    const profiles = new ProfileService(store, secretCodec)
    const input = {
      name: 'Credential fixture', protocol: 'openai-responses' as const,
      baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture-model', contextWindow: 128000, authMethod: 'api-key' as const
    }
    const saved = await profiles.save({ ...input, apiKey: 'fixture-key', customHeaders: { 'X-Fixture': 'fixture-header' } })
    expect(await profiles.resolve(saved.id)).toMatchObject({ apiKey: 'fixture-key', customHeaders: { 'X-Fixture': 'fixture-header' } })
    await profiles.save({ ...input, id: saved.id, name: 'Renamed fixture' })
    expect(await profiles.resolve(saved.id)).toMatchObject({ apiKey: 'fixture-key', customHeaders: { 'X-Fixture': 'fixture-header' } })
    expect(profiles.list()[0]).not.toHaveProperty('apiKey')
  })
})
