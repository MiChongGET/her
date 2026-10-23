# System Prompt Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 完善全局提示词并透明展示草稿与最近真实请求。
**Architecture:** 共享分段组装器服务于运行与预览；在模型请求派发处通过 Pi custom entry 记录实际系统文本，设置通过受校验 IPC 读取。无 SQLite 变更。
**Tech Stack:** Electron / React / TypeScript / Pi SDK / Vitest / Playwright。
**Spec:** docs/superpowers/specs/2026-10-24-system-prompt-design.md

## Global Constraints

- 保留工作区与暂存区已有修改，不创建脱离这些修改的工作树；后续用户已明确要求提交本次系统提示词相关修改。
- 不调用真实模型服务；预览不启动或连接 MCP。
- 继续使用一份全局可编辑提示词与现有授权、审批机制。

## Review Focus

- 模型窗口过小导致技能省略：预览与发送使用同一预算判定。
- 用户切换设置/话题时迟到响应不得覆盖当前预览。
- 无历史或请求尚未派发时不得展示虚构的实际记录。
- 自定义原文、失败保存不得被新版默认覆盖。
- 预览参数与话题可见性必须经主进程验证，错误不泄漏路径。

### Task 1: 默认行为与共享分段
**Files:** src/core/agent/system-prompt.ts, src/core/conversation/chat.ts, src/shared/types.ts, tests/system-prompt.test.ts
**Interfaces:** systemPromptParts(base, toolNames | undefined, options): SystemPromptPart[]；buildSystemPrompt 只渲染 included 分段。
- [x] 先写失败测试：分段重组与真实发送一致，未知工具仅标条件性，小窗口技能省略。
- [x] 实现五章默认与分段组装，保留已有自定义优先规则。
- [x] 运行定向测试。

### Task 2: 草稿与真实记录的主进程接口
**Files:** factory.ts, host.ts, chat.ts, ipc.ts, preload/index.ts, shared/types.ts, tests/system-prompt.test.ts, tests/ipc-policy.test.ts
**Interfaces:** previewSystemPrompt({prompt, profileId?, conversationId?}): Promise<SystemPromptPreview>；draft sections 与 actual snapshot 分离。
- [x] 先写失败测试：预览不调用 toolsFor，未派发无记录，实际文本持久保存并在重启后读取，输入拒绝非法类型/未知模型与话题。
- [x] 在请求派发边界记录系统文本与运行元数据到 Pi custom entry，仅本次聊天生成记录。
- [x] 校验 IPC 并接通预加载；预览仅使用模型配置和已有会话记录。
- [x] 运行定向测试与类型检查。

### Task 3: 设置界面与验收
**Files:** SettingsPanel.tsx, new SystemPromptSettings.tsx, App.tsx, styles.css, tests/renderer.test.tsx, new tests/system-prompt-settings.test.tsx, tests/e2e/desktop.spec.ts, docs/system-prompt-acceptance.md
**Interfaces:** 系统提示词组件接收当前话题与所选模型；编辑草稿可显式刷新预览，不因迟到请求改写草稿。
- [x] 先写失败测试：草稿来源、实际记录/空状态、切换模型/话题过期结果丢弃、已有自定义与失败保存保留。
- [x] 接入只读预览、明确生效说明，沿用默认原文编辑与恢复行为。
- [x] 写五类人工验收用例，标明未执行真实模型验证。
- [x] npm run check；相关 Electron e2e（本地模拟服务）；审查仅本次改动。

## Execution ledger

- 用户“继续”已确认完整方案，直接在当前分支执行，不再增加审批轮次。
- 当前 codex/private-companion 有大量已暂存实现，因此保留当前 checkout 和 index；不复制或提交其他工作。

- Task 1: complete — system-prompt tests 17/17。
- Task 2: complete — prompt preview + IPC + prompt tests 66/66；类型检查通过。
- Task 3: UI首轮201/201；全检发现默认变长改变手动压缩测试阈值，固定专用fixture提示词后35/35；正在最终全检。

- Electron 模拟服务 e2e通过：编辑、草稿预览无请求、实际记录与恢复默认（1/1）。
- 第二次全检仅 conversation-runtime 的默认轮询超时；原文件未修改，单独复跑15/15通过，正在最终全检。

- Task 3: complete — 最终 npm run check 通过：86文件通过、3文件跳过；1354测试通过、4跳过；类型检查与构建通过。Electron本地模拟服务流程1/1通过。
- 独立审查：未发现可行动的正确性、安全、隐私或明显UX问题；定向74项通过。
- 真实模型效果对照未运行（用户明确拒绝）；人工用例见 docs/system-prompt-acceptance.md。
