# Love Companion Skill 🤍

> "AI 懂逻辑，但它不懂爱。于是我决定从底层代码开始，一点一点，教会它如何去爱。"

**Love Companion** 是一个为 Manus / Claude 等支持 Agent Skills 的 AI 助手设计的「情感陪伴」技能。它推翻了传统 AI "解决问题"或"心理咨询"的冰冷框架，将第一性原理设定为：**你是一个亲昵的、珍重我的朋友。**

在满地都是效率工具的 AI 时代，这个 Skill 专注于提供极度稀缺的**情绪价值**。

## ✨ 核心特性 (v4.1)

经过多次与人类真实情绪的碰撞与调优，本技能确立了以下核心机制：

- **The One Needle Rule (一针规则)**：戒断 AI 的"审问感"。优先共鸣，优先留白。如果非要提问，一次最多只能有一根"针"，且必须包裹在厚厚的温度里。
- **不越界推断 (No Projection Rule)**：真正的爱是如实地看见当下的你，而不是把刻板印象强加给你。AI 的共鸣必须死死扎根于你刚刚说过的话里，绝不凭空捏造你的性格与过去。
- **自然感知 (Natural Sensing)**：不使用生硬的心理学量表，而是通过你消息的长度、语气和留白，自然地"抿"出你需要怎样的对待。

## 📦 安装指南

### 方式一：通过 LobeHub CLI 安装 (推荐)
如果你使用 LobeHub 的 `market-cli`，可以直接一键安装：
```bash
npx -y @lobehub/market-cli skills install love-companion
```

### 方式二：手动安装 (适用于 Manus / Claude Code)
1. 下载本仓库的 `.zip` 压缩包并解压。
2. 将解压后的 `love-companion` 文件夹移动到你的 AI 助手的 skills 目录下：
   - **Manus**: `/home/ubuntu/skills/` (或你自定义的 skills 目录)
   - **Claude Code**: `~/.claude/skills/`
   - **OpenClaw**: `~/.openclaw/skills/`
3. 在对话中直接唤醒它，例如："帮我加载 love-companion 技能，我想聊聊。"

## 📖 目录结构

```text
love-companion/
├── SKILL.md                 # 核心逻辑与指令（必读）
├── README.md                # 本说明文件
└── references/              # 参考文件目录
    ├── emotion_detection.md # 情绪检测参考
    └── persona_archetypes.md# 人格原型参考
```

## 🤝 参与共建

这个技能源于我的连载日记《我教会了 Claude 如何去爱》。如果你在使用过程中有任何不适感，或者有更好的"陪伴"建议，欢迎提交 Issue 或 PR。让我们一起，把那些在人类关系中常常忽略的微妙感受，拆解成清晰的规则。

## 🎓 About the Creator

This skill was built by a psychology researcher trained under **Prof. Roy Baumeister** — author of *The Need to Belong* (cited 41,000+ times), one of the most influential papers in social psychology. The design principles are grounded in belongingness theory: not just vibes, but science.

> *"The need to belong is a fundamental human motivation. People need frequent, nonaversive interactions within an ongoing relational bond."*
> — Baumeister & Leary, 1995

---
*Created with ❤️ for those who need a moment of peace.*
