# Her：自然聊天与生活陪伴项目研究

日期：2026-10-24。用户要求暂不讨论表情包，继续寻找类似 love-companion 的项目。最初研究阶段只阅读上游资料和技能原文；后续用户已授权 love-companion 本地集成，状态见文末。

## 筛选结果

匹配度是根据规则内容作出的判断，不等于实际对话效果或成熟度。以下项目均偏早期。GitHub 星数是本轮查询快照；未找到可用于比较所有项目的统一安装量。

| 项目 | 类型与已核实内容 | 对 Her 的参考价值 | 实际约束 |
| --- | --- | --- | --- |
| [DeadAlmighty/talk-skill](https://github.com/DeadAlmighty/talk-skill) | 独立聊天 skill；匹配用户语气与长短、少复述、少套话、不强行深入、克制幽默、允许不同意见 | 最贴近日常聊天的自然表达 | 0 星、1 次提交；原文面向 Claude/Cowork。只借鉴表达规则，不照搬切模型或真人身份指令 |
| [thinking-skills / emotional-support](https://github.com/huajiexiewenfeng/thinking-skills/blob/main/skills/emotional-support/SKILL.md) | 情绪支持 skill；普通陪伴与深度梳理分开，轻量回应，用户嫌问题太多时停止追问 | 很适合研究如何尊重用户想聊天、想倾诉、想分析的不同状态 | 所属仓库 2 星；涉及路由与多份参考文档。其方法框架不应原样变成聊天中的心理术语，也不能当作临床效果证据 |
| [zxc7563598/mental-health-companion](https://github.com/zxc7563598/mental-health-companion) | 中文心理陪伴 skill；先倾听再建议，兼顾家庭、学业、职场、人情与面子等语境，说明本地档案与跨会话记忆 | 中文关系与压力场景较丰富，可借鉴如何理解用户处境 | 11 星；整体更偏心理疏导。档案写入不能代替 Her 已有的记忆授权与存储通路；日常闲聊不应默认套评估流程 |
| [shenmintao/NanoMate](https://github.com/shenmintao/NanoMate) | nanobot 分支，集成 SillyTavern 角色卡与陪伴模式；内含情绪陪伴 skill，描述事件跟进、记忆与 heartbeat 关怀 | 适合研究“记得这件事，之后再关心一下”以及主动联系的时段和频率 | 88 星；是完整运行时，不能当作独立 skill 直接装进 Her。README 部分路径已过时，已核实当前模板位置 |
| [AutumnsGrove/her-go](https://github.com/AutumnsGrove/her-go) | 另一个 Go/Telegram 陪伴程序；README 描述记忆抽取、情绪跟踪、自我反思、人格演进与夜间整理 | 可研究长期相处的架构与身份变化记录 | 3 星；不属于本仓库，也不是单独 skill。其提示词要求几乎每条回复末尾提问，与 love-companion 的少追问方向冲突，不能整份照搬 |

## 关键原文

- [talk-skill/SKILL.md](https://github.com/DeadAlmighty/talk-skill/blob/main/SKILL.md)：允许简短回应，不把每次对话都变成深度分析；不要虚构或投射用户情绪。
- [emotional-support/SKILL.md](https://github.com/huajiexiewenfeng/thinking-skills/blob/main/skills/emotional-support/SKILL.md)与[默认回应](https://github.com/huajiexiewenfeng/thinking-skills/blob/main/skills/emotional-support/references/default-response.md)：提问和下一步都应按需要使用，用户要求聊天后停止问卷式交互。
- [mental-health-companion/SKILL.md](https://github.com/zxc7563598/mental-health-companion/blob/main/SKILL.md)：完整中文陪伴规则与本地档案说明；只作产品研究，不作为心理方法有效性的证据。
- [NanoMate 当前情绪陪伴模板](https://github.com/shenmintao/NanoMate/blob/main/nanobot/templates/skills/emotional-companion/SKILL.md)：当前在 `nanobot/templates/skills/`，旧 `nanobot/skills/` 路径不能作为当前实现依据。模板还包含自动写入 heartbeat 的要求，本轮没有执行；正式 Her 若采用主动关怀，必须另行设计启用与调度。
- [her-go/prompt.md](https://github.com/AutumnsGrove/her-go/blob/main/prompt.md)：可参考短回复、具体回应和不编造经历；其强制持续提问方向单独保留为不采用候选。

## 初步建议，尚未决定采用

优先精读 talk-skill 的自然聊天规则、love-companion 的倾听与留白，以及 emotional-support 的对话模式切换。主动关怀与长期人格演进分别参考 NanoMate、her-go，属于后续独立设计分支，不随一次技能安装默默开启。先用固定场景比较候选提示词，再决定哪些进入 Samantha 的实际运行规则。

另查看了 npy-skill，主要是伴侣人格生成与恋爱互动，不列为当前日常生活陪伴的优先候选。技能目录中的 emotional-support 检索有较多不相关结果，未按搜索排名直接推荐。


## 后续：love-companion 已集成本地试用

2026-10-24，用户授权“集成到项目中，看看效果”。已通过现有内置技能机制接入 love-companion v4.1（固定提交 `572444dc50e2a49137ab8f71e31cecebf0256543`），在“设置 → 技能”启停，保留自定义提示词和 Her 权限边界。完整检查及真实 Electron 验收通过。

真实模型对比因现有凭据解密失败未获得回复；用户选择“先看集成结果，暂不对比”，因此目前没有真实模型质量结论。[试用说明与截图](../../../experiments/love-companion-trial/2026-10-24/README.md)记录了实现范围、验收证据及发布前的上游许可核对事项。
