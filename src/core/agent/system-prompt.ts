import { builtinSkillsPrompt } from '../skills/builtin'
import { estimateTextTokens } from './budget'

/** The skill documents are sent only while they stay a modest share of the window, so a small model can still hold a conversation. */
export const SKILLS_MAX_WINDOW_SHARE = 0.25

const BROWSER_COMPLETION = 'Her 浏览器收尾约定：任务成功且结果已取得后，在同一 TaskSpace 的最后一轮执行 console.log(JSON.stringify(await task.finish({ keep: [] })))，只调用一次 finish；检查真实返回结果后才报告关闭。仅在用户明确要求保留时，keep 才可非空；不得为了方便查看或可能继续而保留，已给出结果的网页、搜索页和中间页默认关闭。失败、停止、结果未知或用户接管时不得自动 finish。保护用户创建和未托管标签，不为关闭而 claim，不退出整个浏览器。收尾仍遵守工具审批；结果未知的 finish 不得重放。'

export function skillsFit(contextWindow: number, disabledSkillIds: string[] = []): boolean {
  return estimateTextTokens(builtinSkillsPrompt(disabledSkillIds)) <= contextWindow * SKILLS_MAX_WINDOW_SHARE
}

/**
 * The prompt the model actually gets: the user's own prompt, the bundled skill documents when the window can afford them,
 * and, when tools are present, the real host platform and the tool names. Skills never declare capabilities; tool definitions do.
 */
export function buildSystemPrompt(base: string, toolNames: string[], options: { contextWindow: number; platform?: string; disabledSkillIds?: string[] }): string {
  const platform = options.platform ?? process.platform
  const skills = builtinSkillsPrompt(options.disabledSkillIds)
  const withSkills = skills && skillsFit(options.contextWindow, options.disabledSkillIds) ? `${base}\n\n${skills}` : base
  if (!toolNames.length) return withSkills
  const environment = `Host 实际操作系统：${platform}。${platform === 'darwin' ? '这是 macOS，原生文本编辑器为 TextEdit，不是 Windows 的 Notepad 或 notepad.exe。' : ''}应用和文件路径以工具结果为准，不得编造当前目录，不得根据模型提供商身份推断本机环境。`
  const completion = toolNames.includes('ego_browser_run') ? `\n${BROWSER_COMPLETION}` : ''
  return `${withSkills}\n${environment}\n你可以使用以下工具：${toolNames.join('、')}。当需要获取实时信息时，调用合适的工具。结果未知的动作不得重放，先读取同一目标的当前状态。无法确认时请求用户处理。${completion}`
}
