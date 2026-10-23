import { randomUUID } from 'node:crypto'
import type {
  CatalogModel, ConnectionTestResult, ProviderProfile, RuntimeProvider, SaveProfileInput, ServiceModel, TestKind
} from '../../shared/types'
import { HerStore, untestedConnections, type StoredProfile } from './store'

export interface SecretCodec {
  encrypt(plaintext: string): Promise<Buffer>
  decrypt(encrypted: Buffer): Promise<string>
}

const LONG_OUTPUT_TOKENS = 1_000_000
const MAX_MODELS = 20

type ValidatedInput = Omit<SaveProfileInput, 'models'> & { models: { id: string; longOutput: boolean; multimodal: boolean }[] }

function publicProfile(profile: StoredProfile): ProviderProfile {
  const models = profile.models.map(model => {
    const tests = { ...model.tests }
    for (const kind of ['chat', 'tools', 'vision'] as const) {
      if (tests[kind].status === 'passed' && tests[kind].message.startsWith('配置验证通过')) {
        tests[kind] = { status: 'untested', message: '旧结果只验证了配置，请重新测试模型能力。' }
      }
    }
    return { ...model, tests }
  })
  return {
    id: profile.id,
    name: profile.name,
    protocol: profile.protocol,
    baseUrl: profile.baseUrl,
    model: profile.defaultModel,
    models,
    ...(profile.models.find(model => model.id === profile.defaultModel)?.catalogProvider ? { catalogProvider: profile.models.find(model => model.id === profile.defaultModel)!.catalogProvider } : {}),
    ...(profile.contextWindow !== null ? { contextWindow: profile.contextWindow } : {}),
    authMethod: profile.authMethod,
    hasApiKey: profile.hasApiKey,
    hasCustomHeaders: profile.hasCustomHeaders,
    ...(profile.maxOutputTokens !== null ? { maxOutputTokens: profile.maxOutputTokens } : {})
  }
}

function validate(input: SaveProfileInput): ValidatedInput {
  if (!input || typeof input !== 'object') throw new Error('模型配置不正确。')
  if (!['api-key', 'headers', 'none'].includes(input.authMethod)) throw new Error('请选择有效的认证方式。')
  if (!input.catalogProvider && input.contextWindow == null) throw new Error('请填写自定义服务的上下文容量。')
  if (input.protocol !== 'openai' && input.protocol !== 'anthropic' && input.protocol !== 'openai-responses') throw new Error('请选择有效的服务协议。')
  for (const field of ['name', 'baseUrl', 'model'] as const) {
    if (typeof input[field] !== 'string' || !input[field].trim() || input[field].length > 2048) {
      throw new Error('请填写服务名称、地址和模型名称。')
    }
  }
  if (input.id !== undefined && (typeof input.id !== 'string' || !input.id || input.id.length > 128)) {
    throw new Error('服务标识不正确。')
  }
  let url: URL
  try { url = new URL(input.baseUrl.trim()) } catch { throw new Error('请填写有效的服务地址。') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('服务地址应为 HTTP/HTTPS API 基址，请将认证信息放在密钥或请求头中。')
  }
  if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 16384)) {
    throw new Error('API 密钥格式不正确。')
  }
  if (input.maxOutputTokens !== undefined && input.maxOutputTokens !== null &&
      (!Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens < 1 || input.maxOutputTokens > LONG_OUTPUT_TOKENS)) {
    throw new Error('最大输出 token 数应为 1 到 1000000 之间的整数。')
  }
  if (input.contextWindow !== undefined && input.contextWindow !== null &&
      (!Number.isInteger(input.contextWindow) || input.contextWindow < 1024 || input.contextWindow > 10_000_000)) {
    throw new Error('上下文窗口应为 1024 到 10000000 之间的整数。')
  }
  const rawModels = input.models ?? [{ id: input.model }]
  if (!Array.isArray(rawModels) || rawModels.length < 1 || rawModels.length > MAX_MODELS) {
    throw new Error('每个服务需要 1 到 20 个模型。')
  }
  const models = rawModels.map(item => ({
    id: typeof item?.id === 'string' ? item.id.trim() : '', longOutput: item?.longOutput === true, multimodal: item?.multimodal === true
  }))
  if (models.some(item => !item.id || item.id.length > 2048)) throw new Error('模型 ID 不能为空，且不超过 2048 个字符。')
  if (new Set(models.map(item => item.id)).size !== models.length) throw new Error('模型 ID 不能重复。')
  if (!models.some(item => item.id === input.model.trim())) throw new Error('默认模型必须在模型列表中。')
  if (input.customHeaders !== undefined) {
    if (!input.customHeaders || typeof input.customHeaders !== 'object' || Array.isArray(input.customHeaders)) {
      throw new Error('额外请求头应为字符串键值对象。')
    }
    for (const [key, value] of Object.entries(input.customHeaders)) {
      if (!/^[!#$%&'*+.^_\x60|~0-9A-Za-z-]+$/.test(key) ||
          typeof value !== 'string' || /[\r\n]/.test(value) || value.length > 16384 ||
          ['host', 'content-length', 'connection', 'transfer-encoding'].includes(key.toLowerCase())) {
        throw new Error('额外请求头包含无效名称或值。')
      }
    }
  }
  return { ...input, models, name: input.name.trim(), model: input.model.trim(), baseUrl: url.toString().replace(/\/+$/, '') }
}

export class ProfileService {
  private catalog?: Promise<CatalogModel[]>

  private readonly saving = new Set<string>()

  private readonly listeners = new Set<(profileId: string, reason: 'deleted' | 'connection-changed') => void>()
  constructor(private readonly store: HerStore, private readonly codec: SecretCodec, readonly lifetime?: AbortSignal) {}

  /** Told when a service is deleted, or its address, protocol or credentials change. A rename or a model-list edit is not announced. */
  onChanged(listener: (profileId: string, reason: 'deleted' | 'connection-changed') => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private announce(profileId: string, reason: 'deleted' | 'connection-changed'): void {
    for (const listener of this.listeners) try { listener(profileId, reason) } catch { /* one listener must not block the rest */ }
  }

  list(): ProviderProfile[] { return this.store.listProfiles().map(publicProfile) }

  listCatalog(): Promise<CatalogModel[]> {
    return this.catalog ??= (async () => {
      const { ModelRuntime } = await import('@earendil-works/pi-coding-agent')
      const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false, credentials: {
        read: async () => undefined, list: async () => [], modify: async () => {}, delete: async () => {}
      } })
      return runtime.getModels().flatMap(model => {
        const protocol = model.api === 'openai-completions' ? 'openai' : model.api === 'anthropic-messages' ? 'anthropic' : model.api === 'openai-responses' ? 'openai-responses' : undefined
        return protocol ? [{ provider: model.provider, id: model.id, name: model.name, protocol, baseUrl: model.baseUrl,
          contextWindow: model.contextWindow, maxOutputTokens: model.maxTokens, multimodal: model.input.includes('image') }] : []
      })
    })()
  }

  async save(rawInput: SaveProfileInput): Promise<ProviderProfile> {
    this.lifetime?.throwIfAborted()
    const catalog = rawInput?.catalogProvider ? await this.listCatalog() : []
    const selected = catalog.find(model => model.provider === rawInput.catalogProvider && model.id === rawInput.model)
    if (rawInput?.catalogProvider && !selected) throw new Error('目录中没有这个模型，请重新选择。')
    const input = validate(selected ? { ...rawInput, protocol: selected.protocol, baseUrl: selected.baseUrl,
      contextWindow: selected.contextWindow, maxOutputTokens: selected.maxOutputTokens } : rawInput)
    const id = input.id ?? randomUUID()
    if (this.saving.has(id)) throw new Error('该服务正在保存，请稍后再试。')
    this.saving.add(id)
    try {
      const previous = this.store.getProfile(id)
      if (input.id && !previous) throw new Error('该服务已经不存在。')
      const preserveSecrets = previous && (
        (input.apiKey === undefined && previous.hasApiKey) ||
        (input.customHeaders === undefined && previous.hasCustomHeaders)
      )
      const oldSecrets = preserveSecrets ? await this.readSecrets(previous) : { apiKey: '', customHeaders: {} }
      let secrets = {
        apiKey: input.apiKey === undefined ? oldSecrets.apiKey : input.apiKey.trim(),
        customHeaders: input.customHeaders === undefined ? oldSecrets.customHeaders : input.customHeaders
      }
      if (input.authMethod === 'none') secrets = { apiKey: '', customHeaders: {} }
      else if (input.authMethod === 'headers') secrets.apiKey = ''
      const hasApiKey = !!secrets.apiKey
      const hasCustomHeaders = Object.keys(secrets.customHeaders).length > 0
      const sealedSecrets = hasApiKey || hasCustomHeaders
        ? (await this.codec.encrypt(JSON.stringify(secrets))).toString('base64')
        : null
      const connectionChanged = !previous || previous.protocol !== input.protocol || previous.authMethod !== input.authMethod ||
        previous.baseUrl !== input.baseUrl ||
        (!preserveSecrets && !!previous.sealedSecrets) ||
        JSON.stringify(oldSecrets) !== JSON.stringify(secrets)
      this.lifetime?.throwIfAborted()
      const latest = this.store.getProfile(id)
      if (input.id && !latest) throw new Error('该服务已经不存在。')
      const maxOutputTokens = input.maxOutputTokens === undefined ? previous?.maxOutputTokens ?? null : input.maxOutputTokens
      const models: ServiceModel[] = input.models.map(item => {
        const catalogModel = input.catalogProvider ? catalog.find(model => model.provider === input.catalogProvider && model.id === item.id) : undefined
        if (input.catalogProvider && !catalogModel) throw new Error('目录中没有这个模型，请重新选择。')
        return {
          id: item.id, longOutput: catalogModel ? false : item.longOutput, multimodal: catalogModel?.multimodal ?? item.multimodal,
          ...(input.catalogProvider ? { catalogProvider: input.catalogProvider } : {}),
          tests: connectionChanged ? untestedConnections() : latest!.models.find(old => old.id === item.id)?.tests ?? untestedConnections()
        }
      })
      const profile: StoredProfile = {
        id,
        name: input.name,
        protocol: input.protocol,
        baseUrl: input.baseUrl,
        defaultModel: input.model,
        authMethod: input.authMethod || 'api-key',
        contextWindow: input.contextWindow ?? previous?.contextWindow ?? null,
        sealedSecrets,
        hasApiKey,
        hasCustomHeaders,
        maxOutputTokens,
        models,
        revision: (previous?.revision ?? 0) + Number(connectionChanged),
        tests: untestedConnections()
      }
      this.store.saveProfile(profile)
      if (previous && connectionChanged) this.announce(id, 'connection-changed')
      return publicProfile(profile)
    } finally { this.saving.delete(id) }
  }

  async resolve(id: string, model?: string): Promise<RuntimeProvider> {
    this.lifetime?.throwIfAborted()
    const profile = this.requireProfile(id)
    const entry = profile.models.find(item => item.id === (model ?? profile.defaultModel))
    if (!entry) throw new Error('该服务没有这个模型，请重新选择。')
    const secrets = await this.readSecrets(profile)
    this.lifetime?.throwIfAborted()
    const catalogModel = entry.catalogProvider ? (await this.listCatalog()).find(model => model.provider === entry.catalogProvider && model.id === entry.id) : undefined
    const maxOutputTokens = catalogModel ? catalogModel.maxOutputTokens : entry.longOutput ? LONG_OUTPUT_TOKENS : profile.maxOutputTokens
    return {
      id: profile.id, name: profile.name, protocol: profile.protocol,
      baseUrl: profile.baseUrl, model: entry.id, multimodal: entry.multimodal, ...secrets,
      ...(maxOutputTokens !== null ? { maxOutputTokens } : {}),
      ...(catalogModel ? { contextWindow: catalogModel.contextWindow } : profile.contextWindow !== null ? { contextWindow: profile.contextWindow } : {})
    }
  }

  select(id: string): void {
    this.requireProfile(id)
    const settings = this.store.getSettings() || {
      activeProfileId: null,
      shortcut: '',
      stopShortcut: '',
      launchAtLogin: false
    }
    this.store.setSettings({ ...settings, activeProfileId: id })
  }

  delete(id: string): void {
    this.requireProfile(id)
    this.store.deleteProfile(id)
    this.announce(id, 'deleted')
  }

  revision(id: string): number { return this.requireProfile(id).revision }

  recordTest(id: string, kind: TestKind, result: ConnectionTestResult, expectedRevision?: number, model?: string): boolean {
    if (this.lifetime?.aborted) return false
    const profile = this.store.getProfile(id)
    if (!profile || (expectedRevision !== undefined && profile.revision !== expectedRevision)) return false
    const target = model ?? profile.defaultModel
    if (!profile.models.some(item => item.id === target)) return false
    this.store.saveProfile({
      ...profile,
      models: profile.models.map(item => item.id === target ? { ...item, tests: { ...item.tests, [kind]: result } } : item)
    })
    return true
  }

  private requireProfile(id: string): StoredProfile {
    const profile = this.store.getProfile(id)
    if (!profile) throw new Error('请选择一个已保存的模型服务。')
    return profile
  }

  private async readSecrets(profile: StoredProfile): Promise<{ apiKey: string; customHeaders: Record<string, string> }> {
    if (!profile.sealedSecrets) return { apiKey: '', customHeaders: {} }
    const text = await this.codec.decrypt(Buffer.from(profile.sealedSecrets, 'base64'))
    return JSON.parse(text) as { apiKey: string; customHeaders: Record<string, string> }
  }
}
