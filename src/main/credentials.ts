// Task 3.2: Her's credential store using Electron safeStorage. Each service gets
// an independent provider ID registered with Pi ModelRuntime. Credentials are
// encrypted with safeStorage and stored per service. When safeStorage is unavailable,
// credential operations fail explicitly.

import { safeStorage } from 'electron'
import type { HerStore, StoredService } from '../core/storage/store'
import type { HerCredentialStore } from '../core/agent/types'
import type { SaveProfileInput } from '../shared/types'

/**
 * SecretCodec interface for ProfileService and McpConfigService.
 */
export interface SecretCodec {
  encrypt(plaintext: string): Promise<Buffer>
  decrypt(encrypted: Buffer): Promise<string>
}

/**
 * Electron safeStorage-based codec for encrypting secrets.
 */
export const secretCodec: SecretCodec = {
  async encrypt(plaintext: string): Promise<Buffer> {
    if (!await safeStorage.isAsyncEncryptionAvailable()) {
      throw new Error('系统凭据保护暂不可用，无法保存密钥；请检查钥匙串后重试。')
    }
    return safeStorage.encryptStringAsync(plaintext)
  },
  async decrypt(encrypted: Buffer): Promise<string> {
    if (!await safeStorage.isAsyncEncryptionAvailable()) {
      throw new Error('系统凭据保护暂不可用，无法读取密钥；请检查钥匙串后重试。')
    }
    return (await safeStorage.decryptStringAsync(encrypted)).result
  }
}

/**
 * Seal credentials (apiKey + customHeaders) with Electron safeStorage. Returns base64.
 * Throws if safeStorage is not available.
 */
export function sealCredentials(apiKey: string | null, customHeaders: Record<string, string> | null): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage 不可用，无法保存凭据。请检查系统钥匙串访问权限。')
  }

  const payload = JSON.stringify({ apiKey, customHeaders })
  const encrypted = safeStorage.encryptString(payload)
  return encrypted.toString('base64')
}

/**
 * Unseal credentials. Returns { apiKey, customHeaders }.
 * Throws if safeStorage is not available or decryption fails.
 */
export function unsealCredentials(sealed: string): { apiKey: string | null; customHeaders: Record<string, string> | null } {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage 不可用，无法读取凭据。')
  }

  const buffer = Buffer.from(sealed, 'base64')
  const decrypted = safeStorage.decryptString(buffer)
  return JSON.parse(decrypted)
}

/**
 * Her's credential store implementation. Each service is registered with a unique
 * provider ID (the service ID itself). Credentials are sealed with safeStorage and
 * stored in the services table.
 */
export class HerCredentials implements HerCredentialStore {
  constructor(private readonly store: HerStore) {}

  /**
   * Get the API key for the given provider (service ID). Returns null for keyless
   * services (authMethod 'none'), undefined when the service does not exist or has
   * no credentials, or the actual key for 'api-key' services.
   */
  async getApiKey(providerId: string): Promise<string | null | undefined> {
    const service = this.store.getService(providerId)
    if (!service) return undefined

    if (service.authMethod === 'none') {
      return null
    }

    if (!service.sealedSecrets) {
      return undefined
    }

    try {
      const { apiKey } = unsealCredentials(service.sealedSecrets)
      return apiKey
    } catch (error) {
      console.error(`Failed to unseal credentials for service ${providerId}:`, error)
      return undefined
    }
  }

  /**
   * Get custom headers for the given provider (service ID). Returns empty object
   * when the service has no custom headers.
   */
  async getCustomHeaders(providerId: string): Promise<Record<string, string>> {
    const service = this.store.getService(providerId)
    if (!service || !service.sealedSecrets) {
      return {}
    }

    try {
      const { customHeaders } = unsealCredentials(service.sealedSecrets)
      return customHeaders || {}
    } catch (error) {
      console.error(`Failed to unseal custom headers for service ${providerId}:`, error)
      return {}
    }
  }

  /**
   * Save a service profile with credentials. If apiKey or customHeaders are provided,
   * they are sealed with safeStorage. Throws if safeStorage is unavailable.
   */
  saveProfile(input: SaveProfileInput): string {
    const id = input.id || crypto.randomUUID()
    const hasApiKey = input.authMethod === 'api-key' && !!input.apiKey
    const hasCustomHeaders = input.authMethod === 'headers' && !!input.customHeaders && Object.keys(input.customHeaders).length > 0

    let sealedSecrets: string | null = null
    if (hasApiKey || hasCustomHeaders) {
      sealedSecrets = sealCredentials(
        input.apiKey || null,
        input.customHeaders || null
      )
    }

    // Custom services require contextWindow
    if (!input.contextWindow && input.authMethod !== 'none') {
      // Pi directory models have implicit context windows; custom services must declare
      throw new Error('自定义服务必须指定上下文容量（contextWindow）')
    }

    const service: StoredService = {
      id,
      name: input.name,
      protocol: input.protocol,
      baseUrl: input.baseUrl,
      defaultModel: input.model,
      authMethod: input.authMethod,
      sealedSecrets,
      hasApiKey,
      hasCustomHeaders,
      maxOutputTokens: input.maxOutputTokens ?? null,
      contextWindow: input.contextWindow ?? null,
      models: (input.models || []).map(m => ({
        id: m.id,
        longOutput: m.longOutput ?? false,
        multimodal: m.multimodal ?? false,
        tests: { chat: { status: 'untested', message: '尚未测试' }, tools: { status: 'untested', message: '尚未测试' }, vision: { status: 'untested', message: '尚未测试' } }
      })),
      revision: 1,
      tests: { chat: { status: 'untested', message: '尚未测试' }, tools: { status: 'untested', message: '尚未测试' }, vision: { status: 'untested', message: '尚未测试' } }
    }

    this.store.saveService(service)
    return id
  }

  /**
   * Delete a service and its sealed credentials.
   */
  deleteProfile(id: string): void {
    this.store.deleteService(id)
  }
}
