# Proposal

## Why

Anthropic Messages 协议要求每次请求带 `max_tokens`，`src/core/providers/stream.ts` 里写死为 4096，设置界面没有入口。长回答会在 4096 token 处被服务端截断，`anthropicStream` 收到 `stop_reason: max_tokens` 后把消息标为失败并提示"输出长度限制"。用户无法通过配置避开，只能换模型或缩短请求。不同模型的输出上限不同，这个值应该跟着模型服务配置走。

## What Changes

- 模型服务配置新增可选字段"最大输出 token 数"，仅对 Anthropic 协议生效；未填写时沿用现在的 4096，已有服务的行为不变。
- 设置面板的服务编辑表单在选择 Anthropic 协议时显示该字段，选择 OpenAI 兼容协议时隐藏。
- `streamChat` 构造 Anthropic 请求时使用该字段的值，不再使用写死的常量。
- 保存时校验该字段为正整数，非法值给出中文错误提示。
- 本地 SQLite 的 `profiles` 表增加一列，`user_version` 从 1 升到 2，旧库启动时自动迁移。
- 修改该字段不会使已有的连接测试结果失效（见 design.md 中的取舍）。

不在范围内：OpenAI 协议的输出长度参数、按对话或按消息调整、根据模型自动推断上限、新增对话以外的任何功能。

## Capabilities

### New Capabilities
- `provider-profiles`: 模型服务配置的持久化与校验，以及配置如何决定发往上游的请求参数。本次只新增"最大输出 token 数"相关要求；项目目前没有任何 spec，该 capability 之后可继续承载协议、基址、密钥等配置要求。

### Modified Capabilities
<!-- openspec/specs/ 目前为空，没有可修改的既有 capability。 -->

## Impact

- 代码：`src/shared/types.ts`（`ProviderProfile`、`SaveProfileInput`、`RuntimeProvider`）、`src/core/storage/store.ts`（建表、迁移、读写）、`src/core/storage/profiles.ts`（校验、公开 DTO、`resolve`）、`src/core/providers/stream.ts`（请求体）、`src/renderer/src/SettingsPanel.tsx`（表单）。
- 数据：`user_version` 1 → 2。旧版应用打开新库会被现有的版本检查拒绝，这是现有机制，不是新增风险，但升级后无法回退到旧版本。
- 测试：`tests/providers.test.ts` 现有断言 `max_tokens > 0`，需要补充"使用配置值"和"未配置时为 4096"；`tests/profiles.test.ts`、`tests/storage.test.ts` 需要补校验和迁移用例。
- 依赖与 IPC 通道：无新增。
