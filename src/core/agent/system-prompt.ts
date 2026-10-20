import { BUILTIN_SKILLS_PROMPT } from '../skills/builtin'
import { estimateTextTokens } from './budget'

/** The skill documents are sent only while they stay a modest share of the window, so a small model can still hold a conversation. */
export const SKILLS_MAX_WINDOW_SHARE = 0.25

export function skillsFit(contextWindow: number): boolean {
  return estimateTextTokens(BUILTIN_SKILLS_PROMPT) <= contextWindow * SKILLS_MAX_WINDOW_SHARE
}

/**
 * The prompt the model actually gets: the user's own prompt, the bundled skill documents when the window can afford them,
 * and, when tools are present, the real host platform and the tool names. Skills never declare capabilities; tool definitions do.
 */
export function buildSystemPrompt(base: string, toolNames: string[], options: { contextWindow: number; platform?: string }): string {
  const platform = options.platform ?? process.platform
  const withSkills = skillsFit(options.contextWindow) ? `${base}\n\n${BUILTIN_SKILLS_PROMPT}` : base
  if (!toolNames.length) return withSkills
  const environment = `Host 实际操作系统：${platform}。${platform === 'darwin' ? '这是 macOS，原生文本编辑器为 TextEdit，不是 Windows 的 Notepad 或 notepad.exe。' : ''}应用和文件路径以工具结果为准，不得编造当前目录，不得根据模型提供商身份推断本机环境。`
  return `${withSkills}\n${environment}\n你可以使用以下工具：${toolNames.join('、')}。当需要获取实时信息时，调用合适的工具。结果未知的动作不得重放，先读取同一目标的当前状态。无法确认时请求用户处理。`
}
