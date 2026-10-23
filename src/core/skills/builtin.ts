import peekaboo from './peekaboo/SKILL.md?raw'
import egoBrowser from './ego-browser/SKILL.md?raw'

export interface BuiltinSkill {
  id: 'peekaboo' | 'ego-browser'
  name: string
  description: string
  version: string
  sourceUrl: string
  content: string
}

export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [
  { id: 'peekaboo', name: 'Peekaboo', description: '捕获和操作 macOS 应用、窗口与界面。', version: '未标注', sourceUrl: 'https://peekaboo.boo', content: peekaboo },
  { id: 'ego-browser', name: 'ego-browser', description: '通过 ego lite 浏览器的独立任务空间浏览网页、填写表单和检查页面。', version: '2.1.0', sourceUrl: 'https://github.com/citrolabs/ego-lite/blob/d392204d1ea1a8027a591ab2b0129c2e11d85f26/skills/ego-browser/SKILL.md', content: egoBrowser }
]

const SKILL_GUIDANCE = [
  '以下为独立内置技能原文。根据对话语义按需参考，具体委托由你自主选择工具和安排步骤，不要求用户手动选择 skill、工具或指导每一步；闲聊不触发操作。',
  '技能提供操作知识，不声明本轮具备哪些执行能力，也不改变当前角色和交流风格。技能中的 CLI 命令、别名和参数不能直接视为可调用接口；实际工具名称、参数及可执行范围以本轮工具定义和 Host 校验为准。',
  '将技能的方法对应到实际可用工具；没有相应能力时说明缺少什么，不虚构命令行执行，不自行安装或启用服务，也不扩大用户授权。只根据真实执行结果报告进展和完成情况。'
].join('\n')

// Skill documents are bundled independently of tool discovery and service state.
export function builtinSkillsPrompt(disabledSkillIds: string[] = []): string {
  const skills = BUILTIN_SKILLS.filter(skill => !disabledSkillIds.includes(skill.id))
  if (!skills.length) return ''
  return [
    SKILL_GUIDANCE,
    ...skills.flatMap(skill => [
      ...(skill.id === 'ego-browser' ? ['Her 中，ego-browser skill 对应 ego_browser_guide；ego-browser nodejs 对应 ego_browser_run({code})；安装和清理参考资料分别通过 ego_browser_guide({document: "install"})、ego_browser_guide({document: "clearing-state"}) 读取；实际能力仍以本轮工具定义为准。'] : []),
      `<builtin_skill name="${skill.name}">`,
      skill.content,
      '</builtin_skill>'
    ])
  ].join('\n')
}

export const BUILTIN_SKILLS_PROMPT = builtinSkillsPrompt()
