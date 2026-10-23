import { Client, SdkError, SdkErrorCode, StreamableHTTPClientTransport, type CallToolResult, type JsonSchemaType, type Transport } from '@modelcontextprotocol/client'
import { StringDecoder } from 'node:string_decoder'
import { StrictStdioTransport } from './stdio'
import { McpPrerequisiteError } from './errors'
import type { McpConnectionStatus, ToolResult } from '../../shared/types'
import { ToolArtifactStore } from '../tools/artifacts'
import { SimpleToolRegistry } from '../tools/registry'
import { normalizeToolResult } from '../tools/results'
import { synchronousJsonSchemaValidator } from '../tools/schema'
import type { ToolDefinition, ToolExecutionContext } from '../tools/types'
import { McpConfigService, type RuntimeMcpConfig } from './config'
import { McpRegistryAdapter, type McpServicePolicy } from './registry-adapter'
import { SCOPED_PRESETS } from './presets'
import { abortable } from '../tools/abort'

// Four maximum-sized images plus JSON overhead; still bounded before parsing.
const MAX_WIRE_BYTES = 64 * 1024 * 1024
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const failure = (text: string): ToolResult => ({ isError: true, content: [{ type: 'text', text }] })

interface Connection {
  /** serviceId, or serviceId::conversationId for a scoped service. */
  key: string
  serviceId: string
  conversationId?: string
  registry: SimpleToolRegistry
  revision: number
  controller: AbortController
  adapter: McpRegistryAdapter
  client?: Client
  transport?: Transport
  config?: RuntimeMcpConfig
  policy: McpServicePolicy
  opening?: Promise<void>
  discovery?: Promise<void>
  documentInput?: ReturnType<typeof synchronousJsonSchemaValidator.getValidator>
  discovered: boolean
  generation: number
  catalog?: string
  stderr: string
  /** Requests cancelled or timed out whose late responses the SDK will report as unknown IDs. */
  abandoned: number
  closing?: Promise<void>
  failureMessage?: string
}

function diagnostic(error: unknown): string {
  if (error instanceof McpPrerequisiteError) return error.message
  // Never copy SDK errors: they can include response bodies, URLs, headers or env values.
  const message = error instanceof Error ? error.message : ''
  const staleObservation = '观察已失效或目标发生变化，请重新观察后再决定，不能重复未知动作。'
  if ([staleObservation, 'MCP 工具清单已失效。'].includes(message)) return message
  if (/401|403|unauthorized|forbidden|authentication/i.test(message)) return 'MCP 认证或授权失败，请检查静态请求头；暂不支持 OAuth 交互登录。'
  if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) return 'MCP 工具调用超时，结果可能未知。请先核对目标状态，不要重复操作。'
  if (/重复|冲突/.test(message)) return 'MCP 工具名称重复或冲突。'
  if (/10 MiB/.test(message)) return 'MCP 图片超过每张 10 MiB 的限制。'
  return 'MCP 连接、协议或工具内容不兼容，请检查服务、JSON Schema 和所需能力；暂不支持 OAuth、sampling 或交互请求。'
}

// Bound JSON bodies and individual SSE lines before the SDK assembles/parses them.
const boundedFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init)
  if (!response.body) return response
  const sse = response.headers.get('content-type')?.includes('text/event-stream')
  let bytes = 0
  let lineHasData = false
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      for (const byte of chunk) {
        bytes++
        if (bytes > MAX_WIRE_BYTES) throw new Error('MCP wire size limit exceeded')
        if (sse) {
          if (byte === 10) { if (!lineHasData) bytes = 0; lineHasData = false }
          else if (byte !== 13) lineHasData = true
        }
      }
      controller.enqueue(chunk)
    }
  }))
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}

export class McpConnectionManager {
  private readonly connections = new Map<string, Connection>()
  private readonly statuses = new Map<string, McpConnectionStatus>()
  private readonly owned = new Set<Connection>()
  private readonly cleanups = new Set<Promise<void>>()
  private readonly unsubscribe: () => void
  private stopped = false

  constructor(private readonly configs: McpConfigService, private readonly registry: SimpleToolRegistry,
    private readonly artifacts: ToolArtifactStore,
    private readonly policyFor: (config: RuntimeMcpConfig) => McpServicePolicy | Promise<McpServicePolicy> = () => ({}),
    private readonly isScoped: (config: { presetId?: string }) => boolean = config => !!config.presetId && SCOPED_PRESETS.has(config.presetId)) {
    this.unsubscribe = configs.subscribe(change => {
      this.invalidate(change.serviceId)
      this.statuses.set(change.serviceId, { serviceId: change.serviceId, revision: change.revision, state: 'disconnected', toolCount: 0 })
    })
  }

  onConfigChanged(listener: (serviceId: string) => void): () => void {
    return this.configs.subscribe(change => listener(change.serviceId))
  }

  /** Service identities behind the tools in a task's frozen snapshot. */
  servicesForTools(names: Iterable<string>): Set<string> {
    const visible = new Set(names), services = new Set<string>()
    for (const connection of this.connections.values()) {
      if (connection.adapter.definitions().some(tool => visible.has(tool.name))) services.add(connection.serviceId)
    }
    return services
  }

  getStatus(serviceId: string): McpConnectionStatus {
    return { ...(this.statuses.get(serviceId) ?? { serviceId, revision: this.configs.list().find(c => c.id === serviceId)?.revision ?? 0, state: 'disconnected', toolCount: 0 }) }
  }

  /** A scoped service has one connection per conversation; calls without a conversation share the plain one. */
  private keyFor(serviceId: string, conversationId?: string): { key: string; scoped: boolean } {
    const config = this.configs.list().find(c => c.id === serviceId)
    return config && conversationId && this.isScoped(config) ? { key: `${serviceId}::${conversationId}`, scoped: true } : { key: serviceId, scoped: false }
  }

  /**
   * Connects every enabled service for this conversation and returns the registries holding its MCP tools:
   * the shared one plus the private registry of each scoped connection. A service that fails to connect is
   * skipped, so one broken server never blocks the conversation.
   */
  async prepare(conversationId: string, signal: AbortSignal): Promise<SimpleToolRegistry[]> {
    signal.throwIfAborted()
    const enabled = this.configs.list().filter(config => config.enabled)
    await abortable(Promise.allSettled(enabled.map(config => this.connect(config.id, conversationId))), signal)
    const scoped = enabled.flatMap(config => {
      const connection = this.connections.get(this.keyFor(config.id, conversationId).key)
      return connection && connection.registry !== this.registry && this.current(connection) && connection.discovered ? [connection.registry] : []
    })
    return [this.registry, ...scoped]
  }

  /** Tool registry for this service in this conversation; scoped connections keep their tools private. */
  registryFor(serviceId: string, conversationId?: string): SimpleToolRegistry {
    return this.connections.get(this.keyFor(serviceId, conversationId).key)?.registry ?? this.registry
  }

  connect(serviceId: string, conversationId?: string): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('MCP 管理器已关闭。'))
    const { key, scoped } = this.keyFor(serviceId, conversationId)
    const existing = this.connections.get(key)
    if (existing) return existing.opening ?? this.discover(existing)
    const config = this.configs.list().find(c => c.id === serviceId)
    if (!config?.enabled) return Promise.reject(new Error('MCP 服务不存在或已停用。'))
    const registry = scoped ? new SimpleToolRegistry() : this.registry
    const connection: Connection = { key, serviceId, ...(scoped ? { conversationId } : {}), registry, revision: config.revision, controller: new AbortController(), adapter: new McpRegistryAdapter(registry, config.name), policy: {}, discovered: false, generation: 0, stderr: '', abandoned: 0 }
    this.connections.set(key, connection)
    this.statuses.set(serviceId, { serviceId, revision: config.revision, state: 'connecting', toolCount: 0 })
    connection.opening = this.open(connection).finally(() => { connection.opening = undefined })
    return connection.opening
  }

  async listTools(serviceId: string, conversationId?: string): Promise<ToolDefinition[]> {
    await this.connect(serviceId, conversationId)
    const connection = this.connections.get(this.keyFor(serviceId, conversationId).key)
    if (!connection || !this.current(connection)) throw new Error('MCP 配置已失效。')
    await this.discover(connection)
    return connection.adapter.definitions()
  }

  async call(serviceId: string, toolName: string, args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    context.signal.throwIfAborted()
    const connection = this.connections.get(this.keyFor(serviceId, context.conversationId).key)
    const name = connection?.adapter.name(toolName)
    if (!connection || !this.current(connection) || !connection.discovered || !name || !this.allowed(connection, toolName)) throw new Error('MCP 工具未连接、已失效或不在允许清单中。')
    // Public calls and advertised tools enter the exact same Host schema/approval gate.
    return connection.registry.execute(name, args, context)
  }

  /** Main-only seam for the authorized document wrapper; never registered or exposed via IPC. */
  async convertDocument(serviceId: string, uri: string, context: ToolExecutionContext): Promise<string> {
    context.signal.throwIfAborted()
    await this.connect(serviceId, context.conversationId)
    const connection = this.connections.get(this.keyFor(serviceId, context.conversationId).key)!
    const generation = connection.generation
    const valid = () => {
      context.signal.throwIfAborted(); this.assertCurrent(connection)
      if (!connection.discovered || connection.generation !== generation || !connection.policy.privateDocumentConversion ||
          !connection.documentInput || context.validateRuntime?.() === false) throw new Error('文档解析器配置已失效。')
    }
    valid()
    const args = { uri }
    if (!connection.documentInput!(args).valid || new URL(uri).protocol !== 'file:') throw new Error('文档转换参数不正确。')
    try {
      const result = await connection.client!.callTool({ name: 'convert_to_markdown', arguments: args }, {
        signal: AbortSignal.any([context.signal, connection.controller.signal]), timeout: 120000, maxTotalTimeout: 120000
      })
      valid()
      if (result.isError) throw new Error('conversion failed')
      // FastMCP duplicates the same string in content and structuredContent.result. Read it once.
      const text = (result.structuredContent as Record<string, unknown> | undefined)?.result
      if (typeof text !== 'string' || result.content.some(block => block.type !== 'text') ||
          result.content.length !== 1 || result.content[0].type !== 'text' || result.content[0].text !== text || text.length > 16 * 1024 * 1024) throw new Error('unsupported document output')
      valid()
      return text
    } catch {
      context.signal.throwIfAborted(); valid()
      throw new Error('文档转换失败：文件可能损坏、加密或缺少格式依赖，请检查解析器安装，解密或重新导出文件后再试。')
    }
  }

  /** Releases every scoped connection this conversation holds, across all services; shared connections are untouched. */
  async disconnectConversation(conversationId: string): Promise<void> {
    const targets = [...this.connections.values()].filter(connection => connection.conversationId === conversationId)
    await Promise.all(targets.map(connection => this.close(this.invalidateConnection(connection))))
  }

  async disconnect(serviceId: string): Promise<void> {
    const closed = this.invalidate(serviceId)
    this.statuses.set(serviceId, { serviceId, revision: this.configs.list().find(c => c.id === serviceId)?.revision ?? this.getStatus(serviceId).revision, state: 'disconnected', toolCount: 0 })
    await Promise.all(closed.map(connection => this.close(connection)))
  }

  getOwnedProcesses(): { serviceId: string; pid: number }[] {
    return [...this.owned].flatMap(c => c.transport instanceof StrictStdioTransport && c.transport.pid ? [{ serviceId: c.serviceId, pid: c.transport.pid }] : [])
  }

  // T06 may call this at its five-second exit deadline. Only a still-owned transport's live child is signalled.
  forceCloseOwnedProcesses(): void {
    for (const connection of this.owned) {
      if (connection.transport instanceof StrictStdioTransport && connection.transport.pid) {
        try { connection.transport.forceClose() } catch { /* child already exited */ }
      }
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true
    this.unsubscribe()
    await Promise.all([...new Set([...this.connections.values()].map(c => c.serviceId))].map(id => this.disconnect(id)))
    await Promise.all([...this.cleanups])
  }

  private current(connection: Connection): boolean {
    return !connection.controller.signal.aborted && this.connections.get(connection.key) === connection && this.configs.isCurrent(connection.serviceId, connection.revision)
  }
  private allowed(connection: Connection, toolName: string): boolean { return !connection.policy.allowedTools || connection.policy.allowedTools.includes(toolName) }
  private assertCurrent(connection: Connection): void { if (!this.current(connection)) throw new Error('MCP 配置或工具清单已失效。') }

  /** Drops every connection of a service, e.g. when its configuration changes. */
  private invalidate(serviceId: string): Connection[] {
    return [...this.connections.values()].filter(c => c.serviceId === serviceId).map(c => this.invalidateConnection(c))
  }

  private invalidateConnection(connection: Connection): Connection {
    connection.adapter.clear()
    connection.discovered = false
    connection.controller.abort(new Error('MCP 连接已失效。'))
    this.connections.delete(connection.key)
    void this.close(connection)
    return connection
  }

  private close(connection: Connection): Promise<void> {
    if (connection.closing) return connection.closing
    const closing = (async () => {
      try { await connection.client?.close() } catch { /* errors have already been diagnosed */ }
      // Resolve may finish after invalidation; open checks identity before constructing/starting transports.
      this.owned.delete(connection)
    })()
    connection.closing = closing
    this.cleanups.add(closing)
    void closing.finally(() => this.cleanups.delete(closing))
    return closing
  }

  private fail(connection: Connection, error: unknown): void {
    if (this.connections.get(connection.key) !== connection) return
    const message = diagnostic(error)
    connection.failureMessage = message
    this.invalidateConnection(connection)
    this.statuses.set(connection.serviceId, { serviceId: connection.serviceId, revision: connection.revision, state: 'error', toolCount: 0, message: message + (connection.stderr ? '\n' + connection.stderr : '') })
  }

  private captureStderr(connection: Connection, transport: StrictStdioTransport): void {
    const secrets = Object.values(connection.config?.env ?? {}).flatMap(value => [value, ...value.split(/[\r\n]/)]).filter(Boolean).sort((a, b) => b.length - a.length)
    let line = ''
    let dropping = false
    const decoder = new StringDecoder('utf8')
    transport.stderr?.on('data', (chunk: Buffer) => {
      for (const character of decoder.write(chunk)) {
        if (character === '\n') {
          if (!dropping) {
            let safe = line
            for (const secret of secrets) safe = safe.split(secret).join('[redacted]')
            connection.stderr = (connection.stderr + safe + '\n').slice(-2048)
          }
          line = ''; dropping = false
        } else if (!dropping) {
          line += character
          if (line.length > 16_384) { line = ''; dropping = true }
        }
      }
    })
  }

  private async open(connection: Connection): Promise<void> {
    try {
      connection.config = await this.configs.resolve(connection.serviceId)
      this.assertCurrent(connection)
      connection.policy = await this.policyFor(connection.config)
      this.assertCurrent(connection)
      const client = new Client({ name: 'Her', version: '0.1.0' }, { capabilities: {}, versionNegotiation: { mode: 'legacy' }, inputRequired: { autoFulfill: false }, jsonSchemaValidator: synchronousJsonSchemaValidator })
      connection.client = client
      const config = connection.config
      const transport = config.transport === 'stdio'
        ? new StrictStdioTransport({ command: config.command!, args: config.args, cwd: config.cwd, env: config.env, maxBufferSize: MAX_WIRE_BYTES })
        : new StreamableHTTPClientTransport(new URL(config.url!), { requestInit: { headers: config.headers }, fetch: boundedFetch })
      connection.transport = transport
      this.owned.add(connection)
      if (transport instanceof StrictStdioTransport) this.captureStderr(connection, transport)
      client.onerror = error => {
        // A server may still answer a request we cancelled; that is not a protocol failure, but an unexplained unknown ID is.
        if (connection.abandoned > 0 && error instanceof Error && error.message.startsWith('Received a response for an unknown message ID')) { connection.abandoned--; return }
        this.fail(connection, error)
      }
      client.onclose = () => this.fail(connection, new Error('MCP disconnected'))
      client.setNotificationHandler('notifications/tools/list_changed', () => {
        if (!this.current(connection)) return
        connection.generation++
        connection.discovered = false
        this.statuses.set(connection.serviceId, { serviceId: connection.serviceId, revision: connection.revision, state: 'connecting', toolCount: 0, message: '工具清单已变化，下次发现时刷新。' })
      })
      await client.connect(transport, { signal: connection.controller.signal, timeout: 60_000 })
      this.assertCurrent(connection)
      await this.discover(connection)
    } catch (error) {
      this.fail(connection, error)
      throw new Error(connection.failureMessage ?? diagnostic(error))
    }
  }

  private async discover(connection: Connection): Promise<void> {
    this.assertCurrent(connection)
    if (connection.discovered) return
    if (connection.discovery) return connection.discovery
    const generation = connection.generation
    connection.discovery = (async () => {
      try {
        const result = await connection.client!.listTools(undefined, { signal: connection.controller.signal, timeout: 60_000, cacheMode: 'refresh' })
        this.assertCurrent(connection)
        if (generation !== connection.generation) throw new Error('MCP 工具清单已失效。')
        if (connection.policy.privateDocumentConversion) {
          const documents = result.tools.filter(tool => tool.name === 'convert_to_markdown')
          if (documents.length !== 1) throw new Error('Document converter unavailable')
          connection.documentInput = synchronousJsonSchemaValidator.getValidator(documents[0].inputSchema as JsonSchemaType)
          if (documents[0].outputSchema) synchronousJsonSchemaValidator.getValidator(documents[0].outputSchema)
        }
        // SDK caches output compilation failures until callTool. Reject them before
        // advertisement/approval so an unsupported schema never starts an action.
        for (const tool of result.tools) {
          if (this.allowed(connection, tool.name) && tool.outputSchema) synchronousJsonSchemaValidator.getValidator(tool.outputSchema)
        }
        const catalog = JSON.stringify([...result.tools].sort((left, right) => left.name.localeCompare(right.name)))
        if (connection.catalog !== catalog) {
          connection.adapter.clear()
          connection.adapter.register(connection.serviceId, connection.revision, result.tools, connection.policy,
            () => this.current(connection) && connection.discovered && catalog === connection.catalog,
            toolName => (args, context) => this.dispatch(connection, catalog, toolName, args, context))
          connection.catalog = catalog
        }
        connection.discovered = true
        this.statuses.set(connection.serviceId, { serviceId: connection.serviceId, revision: connection.revision, state: 'ready', toolCount: connection.adapter.definitions().length })
      } catch (error) { this.fail(connection, error); throw new Error(connection.failureMessage ?? diagnostic(error)) }
    })().finally(() => { connection.discovery = undefined })
    return connection.discovery
  }

  private async dispatch(connection: Connection, catalog: string, toolName: string, args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const valid = () => {
      context.signal.throwIfAborted()
      this.assertCurrent(connection)
      if (!connection.discovered || catalog !== connection.catalog || !this.allowed(connection, toolName)) throw new Error('MCP 工具清单已失效。')
    }
    const revalidate = async () => {
      context.signal.throwIfAborted(); this.assertCurrent(connection)
      if (!connection.discovered) await this.discover(connection)
      valid()
    }
    valid()
    const dispatch = async (name: string, arguments_: Record<string, unknown>, phase: 'preflight' | 'action' = 'action'): Promise<ToolResult> => {
      await revalidate()
      if (!this.allowed(connection, name)) throw new Error('MCP 工具不在允许清单中。')
      if (connection.policy.deferDispatch) context.markDispatched?.(phase)
      let result: CallToolResult
      try {
        result = await connection.client!.callTool({ name, arguments: arguments_ }, { signal: AbortSignal.any([context.signal, connection.controller.signal]), timeout: connection.policy.timeoutMs ?? 60_000, maxTotalTimeout: connection.policy.timeoutMs ?? 60_000 }) as CallToolResult
      } catch (error) {
        // Stopping one call must not disconnect: only the request is abandoned, the connection stays open.
        if (this.current(connection)) connection.abandoned++
        throw error
      }
      await revalidate()
      const converted = await this.convert(result, context, valid)
      await revalidate()
      if (connection.policy.deferDispatch && phase === 'preflight' && !converted.isError) context.completePreflight?.()
      return converted
    }
    try {
      const result = connection.policy.execute ? await connection.policy.execute(toolName, args, context, dispatch) : await dispatch(toolName, args)
      await revalidate()
      return result
    } catch (error) { context.signal.throwIfAborted(); return failure(diagnostic(error)) }
  }

  private async convert(result: CallToolResult, context: ToolExecutionContext, valid: () => void): Promise<ToolResult> {
    const converted: ToolResult = { content: [], ...(result.isError ? { isError: true } : {}) }
    for (const block of result.content) {
      valid()
      if (block.type === 'text') converted.content.push({ type: 'text', text: block.text })
      else if (block.type === 'image') {
        if (block.data.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3) || (block.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(block.data))) throw new Error('MCP image content invalid or exceeds 10 MiB')
        const bytes = Buffer.from(block.data, 'base64')
        if (bytes.length > MAX_IMAGE_BYTES) throw new Error('MCP image exceeds 10 MiB')
        const reference = await this.artifacts.put(bytes, { conversationId: context.conversationId }, block.mimeType)
        valid()
        await this.artifacts.read(reference.id, context)
        converted.content.push({ type: 'image', artifactId: reference.id, mimeType: reference.mimeType })
      } else if (block.type === 'resource_link') converted.content.push({ type: 'resource_link', uri: block.uri, name: block.name })
      else { converted.isError = true; converted.content.push({ type: 'text', text: `不支持的 MCP 内容类型：${block.type}，未自动读取。` }) }
    }
    for (const [key, value] of [['structuredContent', result.structuredContent], ['meta', result._meta]] as const) {
      if (value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)) {
        if (JSON.stringify(value).length <= 30_000) converted[key] = value as Record<string, unknown>
        else { converted.truncated = true; converted.content.push({ type: 'text', text: `MCP ${key} 超过返回限制。` }) }
      }
    }
    valid()
    return normalizeToolResult(converted)
  }
}
