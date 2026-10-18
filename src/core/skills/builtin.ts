import peekaboo from './peekaboo/SKILL.md?raw'

// Skill documents are bundled independently of tool discovery and service state.
export const BUILTIN_SKILLS_PROMPT = [
  '以下为独立内置技能原文。根据对话语义按需参考，具体委托由你自主选择工具和安排步骤，不要求用户手动选择 skill、工具或指导每一步；闲聊不触发操作。',
  '技能提供操作知识，不声明本轮具备哪些执行能力，也不改变当前角色和交流风格。技能中的 CLI 命令、别名和参数不能直接视为可调用接口；实际工具名称、参数及可执行范围以本轮工具定义和 Host 校验为准。',
  '将技能的方法对应到实际可用工具；没有相应能力时说明缺少什么，不虚构命令行执行，不自行安装或启用服务，也不扩大用户授权。只根据真实执行结果报告进展和完成情况。',
  '<builtin_skill name="Peekaboo">',
  peekaboo,
  '</builtin_skill>'
].join('\n')
