# Proposal

## Why

现在一个模型服务只能保存一个 Model ID。同一个地址和密钥下常有多个可用模型，用户要换模型只能新建一份重复的服务，或者反复改配置；聊天窗口也只能切换服务，不能切换模型。同时，Anthropic 协议的输出上限默认是 4096、可填上限是 200000，对长输出的模型偏小。

## What Changes

- 一个服务可以配置多个模型 ID，其中一个是该服务的默认模型。服务编辑表单把单个 Model ID 输入框改为模型列表：可添加、删除、指定默认。
- 聊天窗口在"当前模型服务"旁新增模型选择器，列出当前服务的所有模型，可随时切换；切换后的下一条消息使用所选模型。新建对话时选中该服务的默认模型。所选模型只是界面状态，不写库。
- 每条助手消息已记录实际使用的模型，历史消息显示不变。
- 连接测试（文字、工具）按模型分别记录和显示；增删模型只影响对应模型的测试状态。
- Anthropic 协议的默认最大输出 token 数由 4096 改为 262144。
- 服务级"最大输出 token 数"输入框保留，作为覆盖值，可填上限由 200000 放宽到 1000000。
- 每个模型多一个"1M"开关，Anthropic、OpenAI 兼容、OpenAI Responses 三种协议都有。开启后该模型的请求带 1000000 的输出上限：Anthropic 的 `max_tokens`、OpenAI 兼容的 `max_tokens`、Responses 的 `max_output_tokens`。Anthropic 的优先级：模型 1M 开关 > 服务级覆盖值 > 默认 262144。OpenAI 兼容和 Responses 未开启 1M 时，请求与现在完全一致，不带输出上限字段。
- 本地 SQLite 的 `profiles` 表新增 `models` 列，`user_version` 由 3 升到 4；旧库启动时自动迁移，原有的 Model ID 和连接测试结果归入迁移后的唯一模型。
- **BREAKING**：未配置覆盖值的现有 Anthropic 服务，请求上限从 4096 变为 262144。部分模型或网关的真实上限低于此值，上游可能返回 HTTP 错误，需要用户在设置里填覆盖值。
- **BREAKING**：`ProviderProfile` 不再有顶层 `tests`，改为每个模型各有 `tests`；`testProfile` 增加模型参数；升级后无法回退到旧版本。

不在范围内：已有对话各自记住所选模型、从上游自动拉取模型列表、按模型单独设置输出上限数值（只有 1M 开关）、OpenAI 兼容和 Responses 协议在未开启 1M 时的输出长度参数、服务级"最大输出 token 数"输入框对这两种协议的开放。

## Capabilities

### New Capabilities
- `service-models`: 一个服务下的多个模型 ID、默认模型、聊天窗口按模型切换、按模型记录连接测试，以及每个模型的 1M 输出开关。

### Modified Capabilities
- `provider-profiles`: 默认最大输出 token 数改为 262144，可填上限改为 1000000，设置面板占位提示与升级场景随之改变，连接测试结果的保留改为按模型。注意该 capability 目前只存在于尚未归档的 `configurable-anthropic-max-tokens` 变更里（`openspec/specs/` 为空），本变更的归档必须排在它之后。

## Impact

- 代码：`src/shared/types.ts`、`src/core/storage/store.ts`（迁移、读写 `models`）、`src/core/storage/profiles.ts`（校验、保存、`resolve(id, model?)`、`recordTest`）、`src/core/providers/probe.ts`（按模型测试）、`src/core/providers/stream.ts`（默认值）、`src/core/conversation/chat.ts`（校验并使用所选模型）、`src/main/ipc.ts`、`src/preload/index.ts`、`src/renderer/src/App.tsx`（模型选择器）、`src/renderer/src/SettingsPanel.tsx`（模型列表、1M 开关、按模型测试）、`src/renderer/src/styles.css`。
- 数据：`user_version` 3 → 4，不可回退；升级前可手动备份 `her.sqlite`。
- 测试：`tests/storage.test.ts`、`tests/profiles.test.ts`、`tests/providers.test.ts`、`tests/chat.test.ts`、`tests/renderer.test.tsx` 中涉及顶层 `tests`、4096、200000 的断言需要更新。
- 依赖：无新增。IPC 通道无新增，但 `her:profile-test` 与 `her:message-send` 的参数增加可选的模型字段。
- 并行变更：`chat-ui-redesign` 也会改动 `App.tsx` / `styles.css`，实现时注意合并。
