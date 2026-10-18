import type { ConnectionTestResult, ProviderEvent, StreamChatInput, TestKind } from '../../shared/types'
import { ProfileService } from '../storage/profiles'
import { ProviderError, streamChat } from './stream'

// Fixed 16x16 red PNG; the expected answer is not included in the prompt.
const VISION_PNG = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII='

export async function testConnection(
  profiles: ProfileService,
  id: string,
  kind: TestKind,
  stream: (input: StreamChatInput) => AsyncGenerator<ProviderEvent> = streamChat,
  model?: string
): Promise<ConnectionTestResult> {
  const revision = profiles.revision(id)
  const provider = await profiles.resolve(id, model)
  const signal = AbortSignal.any([AbortSignal.timeout(20_000), ...(profiles.lifetime ? [profiles.lifetime] : [])])
  let result: ConnectionTestResult
  try {
    let text = ''
    let toolPassed = false
    let done = false
    const tool = {
      name: 'report_connection', description: '报告此次连接检测是否成功',
      parameters: {
        type: 'object', properties: { ok: { type: 'boolean', const: true } },
        required: ['ok'], additionalProperties: false
      }
    }
    for await (const event of stream({
      provider, signal, system: '这是连接测试，请严格遵守请求。',
      messages: [{ role: 'user', content: kind === 'vision' ? [
        { type: 'text', text: '图片的主要颜色是什么？只回复一个英文大写颜色名。' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: VISION_PNG } }
      ] : kind === 'chat'
        ? '请只回复“连接成功”。'
        : '请调用 report_connection 工具，参数为 {"ok":true}，不要执行任何其他操作。' }],
      ...(kind === 'tools' ? { tools: [tool], forceTool: tool.name } : {})
    })) {
      if (event.type === 'text') text += event.text
      if (event.type === 'tool') {
        toolPassed = event.name === tool.name && event.arguments.ok === true && Object.keys(event.arguments).length === 1
      }
      if (event.type === 'done') done = true
    }
    if (!done) throw new Error('incomplete')
    const passed = kind === 'vision' ? text.trim().toUpperCase() === 'RED' : kind === 'chat' ? !!text.trim() : toolPassed
    result = {
      status: passed ? 'passed' : 'failed',
      message: passed
        ? kind === 'vision' ? '已识别测试图片；实际任务图片能力仍需验证。' : kind === 'chat' ? '文字流式连接成功。' : '已验证完整工具调用；当前阶段只检测能力，不执行业务工具。'
        : kind === 'vision' ? '未正确识别测试图片，请检查当前模型的视觉能力和协议兼容性，必要时切换模型。' : kind === 'chat' ? '服务没有返回文字，请检查模型和协议。' : '未收到有效的指定工具调用，该服务仍可用于普通文字聊天。',
      checkedAt: new Date().toISOString()
    }
  } catch (error) {
    result = {
      status: 'failed',
      message: signal.aborted ? '连接测试超时，请检查网络和服务地址。'
        : error instanceof ProviderError ? error.message : '连接检测未完成，请检查服务配置后重试。',
      checkedAt: new Date().toISOString()
    }
  }
  if (!profiles.recordTest(id, kind, result, revision, provider.model)) {
    return { status: 'failed', message: '测试期间配置发生变化，请重新测试。', checkedAt: result.checkedAt }
  }
  return result
}
