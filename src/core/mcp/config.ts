// @ts-nocheck - TODO 10.5: Fix MCP service storage after core agent integration
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { ConnectionTestResult, McpServiceConfig, McpTransportConfig, SaveMcpServiceInput } from '../../shared/types'
import type { SecretCodec } from '../storage/profiles'
import { HerStore, type StoredMcpService } from '../storage/store'

// Main-process only: never include this object in an IPC response.
export interface RuntimeMcpConfig extends McpServiceConfig {
  env?: Record<string, string>
  headers?: Record<string, string>
}

export interface McpConfigChange {
  serviceId: string
  revision: number
  removed: boolean
}

const conflict = () => new Error('MCP 配置已变更，请刷新后重试。')
const validString = (value: unknown, max = 2048): value is string =>
  typeof value === 'string' && value.length <= max && !value.includes('\0')
const forbiddenHeaders = ['host', 'content-length', 'connection', 'transfer-encoding']

function secretKey(key: string, transport: McpTransportConfig['transport']): string {
  if (transport === 'stdio') {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('环境变量名称不正确。')
    return key
  }
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || forbiddenHeaders.includes(key.toLowerCase())) {
    throw new Error('请求头名称不正确。')
  }
  return key.toLowerCase()
}

function validate(input: SaveMcpServiceInput): SaveMcpServiceInput {
  if (!input || typeof input !== 'object' || !validString(input.name) || !input.name.trim() || typeof input.enabled !== 'boolean') {
    throw new Error('请填写有效的 MCP 服务名称和启用状态。')
  }
  if (input.id !== undefined && (!validString(input.id, 128) || !input.id)) throw new Error('MCP 服务标识不正确。')
  if (input.presetId !== undefined && (!validString(input.presetId, 128) || !input.presetId)) throw new Error('MCP 预设标识不正确。')
  if (input.allowAllOperations !== undefined && typeof input.allowAllOperations !== 'boolean') throw new Error('MCP 自动操作开关必须为布尔值。')
  if (input.expectedRevision !== undefined && (!input.id || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) {
    throw new Error('MCP 配置版本不正确。')
  }
  let transport: McpTransportConfig
  if (input.transport === 'stdio') {
    if (!validString(input.command) || !input.command.trim() || /[\r\n]/.test(input.command) ||
        !Array.isArray(input.args) || input.args.some(arg => !validString(arg, 16384))) {
      throw new Error('请分别填写可执行命令和参数数组。')
    }
    if (input.cwd !== undefined && (!validString(input.cwd) || !isAbsolute(input.cwd))) throw new Error('工作目录必须为绝对路径。')
    transport = { transport: 'stdio', command: input.command, args: [...input.args], ...(input.cwd !== undefined ? { cwd: input.cwd } : {}) }
  } else if (input.transport === 'streamable-http') {
    if (!validString(input.url)) throw new Error('请填写有效的 MCP 服务地址。')
    let url: URL
    try { url = new URL(input.url.trim()) } catch { throw new Error('请填写有效的 MCP 服务地址。') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
      throw new Error('MCP 地址应为 HTTP/HTTPS URL，认证信息请放在请求头中。')
    }
    transport = { transport: 'streamable-http', url: url.toString() }
  } else throw new Error('MCP 传输类型不正确。')
  if (input.secretValues !== undefined && (!input.secretValues || typeof input.secretValues !== 'object' || Array.isArray(input.secretValues))) {
    throw new Error('MCP 凭据应为字符串键值对象。')
  }
  const entries = Object.entries(input.secretValues ?? {}).map(([key, value]) => {
    const name = secretKey(key, input.transport)
    if (!validString(value, 16384) || (input.transport === 'streamable-http' && /[\r\n]/.test(value))) throw new Error('MCP 凭据值不正确。')
    return [name, value] as const
  })
  if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error('MCP 凭据名称不能重复。')
  if (input.clearSecretKeys !== undefined && (!Array.isArray(input.clearSecretKeys) || input.clearSecretKeys.some(key => typeof key !== 'string'))) {
    throw new Error('请选择要清除的凭据名称。')
  }
  return {
    ...transport, name: input.name.trim(), enabled: input.enabled,
    ...(input.allowAllOperations !== undefined ? { allowAllOperations: input.allowAllOperations } : {}),
    ...(input.id !== undefined ? { id: input.id } : {}),
    ...(input.presetId !== undefined ? { presetId: input.presetId } : {}),
    ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
    secretValues: Object.assign(Object.create(null), Object.fromEntries(entries)) as Record<string, string>,
    clearSecretKeys: (input.clearSecretKeys ?? []).map(key => secretKey(key, input.transport))
  }
}

export class McpConfigService {
  private readonly subscribers = new Set<(change: McpConfigChange) => void>()

  constructor(private readonly store: HerStore, private readonly codec: SecretCodec, readonly lifetime?: AbortSignal) {}

  list(): McpServiceConfig[] { return this.store.listMcpServices().map(service => service.config) }

  async getEnvironment(id: string, expectedRevision: number): Promise<Record<string, string>> {
    this.lifetime?.throwIfAborted()
    const service = this.store.getMcpService(id)
    if (!service || service.config.revision !== expectedRevision) throw conflict()
    if (service.config.transport !== 'stdio') throw new Error('仅本地 stdio 服务提供环境变量。')
    const environment = await this.readSecrets(service)
    this.lifetime?.throwIfAborted()
    if (this.store.getMcpService(id)?.config.revision !== expectedRevision) throw conflict()
    return environment
  }

  subscribe(listener: (change: McpConfigChange) => void): () => void {
    this.subscribers.add(listener)
    return () => { this.subscribers.delete(listener) }
  }

  async save(rawInput: SaveMcpServiceInput): Promise<McpServiceConfig> {
    this.lifetime?.throwIfAborted()
    const input = validate(rawInput)
    const previous = input.id ? this.store.getMcpService(input.id) : undefined
    if (input.id && !previous) throw conflict()
    if (input.expectedRevision !== undefined && previous?.config.revision !== input.expectedRevision) throw conflict()
    const sameTransport = previous?.config.transport === input.transport
    const oldKeys = sameTransport ? previous.config.secretKeys : []
    const replacements = input.secretValues!
    const cleared = new Set(input.clearSecretKeys)
    const preserve = oldKeys.some(key => !cleared.has(key) && !replacements[key]?.trim())
    const secrets = preserve ? await this.readSecrets(previous!) : Object.create(null) as Record<string, string>
    for (const key of cleared) delete secrets[key]
    for (const [key, value] of Object.entries(replacements)) if (value.trim() && !cleared.has(key)) secrets[key] = value
    const secretKeys = Object.keys(secrets).sort()
    let sealedSecrets: string | null = null
    if (secretKeys.length) {
      try { sealedSecrets = (await this.codec.encrypt(JSON.stringify(secrets))).toString('base64') }
      catch { throw new Error('系统凭据保护暂不可用，无法保存 MCP 凭据；请检查钥匙串后重试。') }
    }
    const { secretValues: _secretValues, clearSecretKeys: _clearSecretKeys, expectedRevision: _expectedRevision, ...fields } = input
    const config: McpServiceConfig = {
      ...fields, id: input.id ?? randomUUID(), revision: (previous?.config.revision ?? 0) + 1,
      allowAllOperations: input.allowAllOperations ?? previous?.config.allowAllOperations ?? false,
      secretKeys, hasSecrets: secretKeys.length > 0
    }
    this.lifetime?.throwIfAborted()
    if (!this.store.saveMcpService({ config, sealedSecrets }, previous?.config.revision)) throw conflict()
    this.changed({ serviceId: config.id, revision: config.revision, removed: false })
    return config
  }

  remove(id: string): void {
    const revision = this.store.removeMcpService(id)
    if (revision === undefined) throw new Error('MCP 服务已经不存在。')
    this.changed({ serviceId: id, revision, removed: true })
  }

  async resolve(id: string): Promise<RuntimeMcpConfig> {
    this.lifetime?.throwIfAborted()
    const service = this.store.getMcpService(id)
    if (!service) throw new Error('MCP 服务已经不存在。')
    if (!service.config.enabled) throw new Error('MCP 服务已停用。')
    const secrets = await this.readSecrets(service)
    if (!this.isCurrent(id, service.config.revision)) throw conflict()
    return { ...service.config, ...(service.config.transport === 'stdio' ? { env: secrets } : { headers: secrets }) }
  }

  isCurrent(id: string, revision: number): boolean {
    if (this.lifetime?.aborted) return false
    const current = this.store.getMcpService(id)?.config
    return !!current?.enabled && current.revision === revision
  }

  recordTest(id: string, expectedRevision: number, result: ConnectionTestResult): boolean {
    if (this.lifetime?.aborted) return false
    return this.store.recordMcpTest(id, expectedRevision, result)
  }

  getTestResult(id: string, expectedRevision: number): ConnectionTestResult | undefined {
    return this.store.getMcpTest(id, expectedRevision)
  }

  private async readSecrets(service: StoredMcpService): Promise<Record<string, string>> {
    if (!service.sealedSecrets) return Object.create(null) as Record<string, string>
    try { return Object.assign(Object.create(null), JSON.parse(await this.codec.decrypt(Buffer.from(service.sealedSecrets, 'base64')))) as Record<string, string> }
    catch { throw new Error('系统凭据保护暂不可用，无法读取 MCP 凭据；请检查钥匙串后重试。') }
  }

  private changed(change: McpConfigChange): void {
    for (const listener of this.subscribers) {
      // A consumer failure must not skip other invalidators or report a committed save as failed.
      try { listener(change) } catch { /* consumer owns its connection cleanup */ }
    }
  }
}
