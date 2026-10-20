import type { Model, ProviderStreams, StreamOptions, Tool, ToolCall } from '@earendil-works/pi-ai'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import type { ProfileService } from '../core/storage/profiles'
import type { TestKind, ConnectionTestResult, RuntimeProvider } from '../shared/types'

// Fixed 16x16 red PNG; the expected color is not included in the prompt.
const VISION_PNG = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII='
const TOOL_NAME = 'report_connection'

async function probeModel(provider: RuntimeProvider, kind: TestKind, lifetime?: AbortSignal): Promise<ConnectionTestResult> {
  const title = kind === 'chat' ? '文字流式' : kind === 'tools' ? '工具调用' : '视觉'
  const deadline = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; deadline.abort() }, 30_000)
  const signal = lifetime ? AbortSignal.any([lifetime, deadline.signal]) : deadline.signal
  let failure = '模型流式请求失败，请检查已保存的地址、协议、模型和密钥。'
  try {
    const adapter: ProviderStreams = provider.protocol === 'openai'
      ? await import('@earendil-works/pi-ai/api/openai-completions')
      : provider.protocol === 'anthropic'
        ? await import('@earendil-works/pi-ai/api/anthropic-messages')
        : await import('@earendil-works/pi-ai/api/openai-responses')
    let tools: Tool[] | undefined
    if (kind === 'tools') {
      const { Type } = await import('@earendil-works/pi-ai')
      tools = [{ name: TOOL_NAME, description: '报告此次连接检测是否成功',
        parameters: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }) }]
    }
    const model: Model<'openai-completions' | 'anthropic-messages' | 'openai-responses'> = {
      id: provider.model, name: provider.model, provider: provider.id,
      // Anthropic's SDK appends /v1/messages; Her's saved API bases already include /v1.
      baseUrl: provider.protocol === 'anthropic' ? provider.baseUrl.replace(/\/v1\/?$/, '') : provider.baseUrl,
      api: provider.protocol === 'openai' ? 'openai-completions' : provider.protocol === 'anthropic' ? 'anthropic-messages' : 'openai-responses',
      reasoning: false, input: kind === 'vision' ? ['text', 'image'] : ['text'], contextWindow: 32_000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    }
    // The SDK requires an API key even for keyless servers; this marker never leaves the host.
    const keyless = 'her-local-connection-probe'
    let normalEnd = false
    let anthropicStop = false
    const options: StreamOptions = {
      apiKey: provider.apiKey || keyless, headers: provider.customHeaders,
      signal, timeoutMs: 30_000, maxRetries: 0, maxTokens: 1024, cacheRetention: 'none',
      fetch: async (input, init) => {
        signal.throwIfAborted()
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
        if (!provider.apiKey) {
          if (headers.get('authorization') === `Bearer ${keyless}`) headers.delete('authorization')
          if (headers.get('x-api-key') === keyless) headers.delete('x-api-key')
        }
        const response = await fetch(input, { ...init, headers, signal, redirect: 'error' })
        if (!response.ok) {
          failure = response.status === 401 || response.status === 403 ? `认证失败（HTTP ${response.status}），请检查密钥和请求头。`
            : response.status === 404 ? '接口或模型不存在（HTTP 404），请检查协议、地址和模型 ID。'
              : response.status === 429 ? '请求受到限流（HTTP 429），请稍后重试。'
                : `模型服务请求失败（HTTP ${response.status}）。`
          await response.body?.cancel()
          throw new Error(failure)
        }
        if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
          failure = '服务未返回 SSE 流，请检查地址和协议。'
          await response.body?.cancel()
          throw new Error(failure)
        }
        return response
      },
      onProviderStreamEvent(data) {
        if (!data || typeof data !== 'object') return
        const event = data as { type?: string; choices?: { finish_reason?: string }[]; delta?: { stop_reason?: string }; response?: { status?: string } }
        if (provider.protocol === 'openai') {
          if (event.choices?.some(choice => choice.finish_reason === (kind === 'tools' ? 'tool_calls' : 'stop'))) normalEnd = true
        } else if (provider.protocol === 'anthropic') {
          if (event.type === 'message_delta') anthropicStop = (kind === 'tools' ? ['tool_use'] : ['end_turn', 'stop_sequence']).includes(event.delta?.stop_reason ?? '')
          if (event.type === 'message_stop') normalEnd = anthropicStop
        } else if (event.type === 'response.completed') normalEnd = event.response?.status === 'completed'
      }
    }
    let text = ''
    let deltas = 0
    let completed = false
    let startedCalls = 0
    const calls: ToolCall[] = []
    const requestOptions = {
      ...options,
      ...(kind === 'tools' ? { toolChoice: provider.protocol === 'openai'
        ? { type: 'function', function: { name: TOOL_NAME } }
        : { type: provider.protocol === 'anthropic' ? 'tool' : 'function', name: TOOL_NAME } } : {})
    }
    const stream = adapter.stream(model, normalizeContext({
      messages: [{ role: 'user', content: kind === 'vision' ? [
        { type: 'text', text: '图片的主要颜色是什么？只回复一个英文大写颜色名。' },
        { type: 'image', mimeType: 'image/png', data: VISION_PNG }
      ] : kind === 'tools' ? '请调用 report_connection 工具，参数为 {"ok":true}，不要执行任何其他操作。' : '请只回复 OK。', timestamp: Date.now() }],
      ...(tools ? { tools } : {})
    }), requestOptions)
    for await (const event of stream) {
      if (event.type === 'text_delta') { text += event.delta; if (event.delta) deltas++ }
      if (event.type === 'toolcall_start') startedCalls++
      if (event.type === 'toolcall_end') calls.push(event.toolCall)
      if (event.type === 'error') throw new Error(failure)
      if (event.type === 'done') completed = event.reason === (kind === 'tools' ? 'toolUse' : 'stop')
    }
    signal.throwIfAborted()
    if (!completed || !normalEnd) {
      failure = `${title}返回未正常结束，可能已截断或协议不兼容。`
      throw new Error(failure)
    }
    if (kind === 'tools') {
      const call = calls[0]
      if (startedCalls !== 1 || calls.length !== 1 || !call.id || call.name !== TOOL_NAME || call.argumentsError || call.arguments.ok !== true || Object.keys(call.arguments).length !== 1) {
        failure = '未收到完整的指定工具调用及合法参数，工具能力验证失败。'
        throw new Error(failure)
      }
      return { status: 'passed', message: '已验证指定工具调用及参数；未执行业务工具。', checkedAt: new Date().toISOString() }
    }
    if (!deltas || !text.trim()) {
      failure = kind === 'vision' ? '图片识别未返回非空文字，无法验证视觉能力。' : '模型没有返回非空文字增量，无法确认文字流式能力。'
      throw new Error(failure)
    }
    if (kind === 'vision') {
      if (text.trim().toUpperCase() !== 'RED') {
        failure = '未正确识别测试图片，请检查模型的视觉能力和协议兼容性。'
        throw new Error(failure)
      }
      return { status: 'passed', message: '已正确识别测试图片，视觉请求验证通过。', checkedAt: new Date().toISOString() }
    }
    return { status: 'passed', message: `已收到文字增量，流式响应正常结束（${deltas} 个增量）。`, checkedAt: new Date().toISOString() }
  } catch {
    lifetime?.throwIfAborted()
    return { status: 'failed', message: timedOut ? `${title}测试超时（30 秒），请检查服务后重试。` : failure, checkedAt: new Date().toISOString() }
  } finally {
    clearTimeout(timer)
    deadline.abort()
  }
}

export async function testConnection(
  profiles: ProfileService,
  profileId: string,
  kind: TestKind,
  model?: string
): Promise<ConnectionTestResult> {
  profiles.lifetime?.throwIfAborted()
  const revision = profiles.revision(profileId)
  const provider = await profiles.resolve(profileId, model)
  const result = await probeModel(provider, kind, profiles.lifetime)
  profiles.lifetime?.throwIfAborted()
  if (!profiles.recordTest(profileId, kind, result, revision, provider.model)) throw new Error('测试期间配置已变化，请重新测试。')
  return result
}
