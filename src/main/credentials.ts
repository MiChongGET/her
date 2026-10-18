import { safeStorage } from 'electron'
import type { SecretCodec } from '../core/storage/profiles'

export const secretCodec: SecretCodec = {
  async encrypt(plaintext) {
    if (!await safeStorage.isAsyncEncryptionAvailable()) {
      throw new Error('系统凭据保护暂不可用，无法保存密钥；请检查钥匙串后重试。')
    }
    return safeStorage.encryptStringAsync(plaintext)
  },
  async decrypt(encrypted) {
    if (!await safeStorage.isAsyncEncryptionAvailable()) {
      throw new Error('系统凭据保护暂不可用，无法读取密钥；请检查钥匙串后重试。')
    }
    return (await safeStorage.decryptStringAsync(encrypted)).result
  }
}
