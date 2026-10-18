# Design

## Context

动机见 proposal.md，行为要求见 specs。当前相关代码的状态：

- 服务只有一个 `model` 字符串。`StoredProfile` / `ProviderProfile` / `RuntimeProvider` / `SaveProfileInput` 都是单个 `model`；`profiles` 表有 `model`、`tests`（整个服务一份 JSON）、`revision`、`max_output_tokens` 列。
- `ProfileService.save` 的 `connectionChanged` 比较协议、基址、**model** 和凭据，变化时重置 `tests` 并让 `revision` 加 1；`recordTest(id, kind, result, expectedRevision?)` 按 `revision` 丢弃过期结果。
- `testConnection` 通过 `profiles.resolve(id)` 取运行时配置；`ChatService.send` 同样用 `resolve(input.profileId)`，并把 `provider.model` 写进助手消息。
- `HerStore` 构造函数每次启动都按列是否存在补列，最后写 `PRAGMA user_version = 3`，大于 3 拒绝打开。
- 聊天窗口只有"当前模型服务"下拉，当前服务保存在 `settings.activeProfileId`。输出上限在 `stream.ts` 里是 `provider.maxOutputTokens ?? 4096`，校验上限 200000 写在 `profiles.ts`。

## Goals / Non-Goals

**Goals:**
- 模型成为服务下的一个列表项，测试结果、1M 开关挂在模型上，其余配置（协议、基址、密钥、请求头、服务级覆盖值）仍属于服务。
- 所选模型只经 `SendMessageInput` 和 `testProfile` 的参数流动，不新增持久化状态。

**Non-Goals:**
- 不让每个对话记住自己的模型，不为对话表加列。
- 不从上游拉取模型列表，不内置各模型的真实输出上限。
- 不为 1M 自动添加任何 beta 请求头；需要时用户通过"额外请求头"自行配置。

## Decisions

**1. 新增 `models TEXT` 列，存模型数组的 JSON；`model` 列保留，含义改为默认模型 ID。**
数组元素为 `{ id, longOutput, tests }`。不另建 `models` 表：模型数量上限 20、总是随服务整体读写，JSON 列避免外键和联表，也沿用 `tests` 已有的 JSON 存法。备选是新表加外键，但读写路径和迁移都更重，收益只是能按模型查询，而当前没有这种需求。
旧的 `tests` 列因 `NOT NULL` 无法直接删除，保留但不再读取，之后写入固定的 `'{}'`。

**2. 迁移沿用现有"按列是否存在补列"的写法，在同一事务里完成。**
- 列 `models` 不存在时 `ALTER TABLE profiles ADD COLUMN models TEXT`；新库的建表语句直接带该列。
- 对 `models IS NULL` 的行，用 JS 逐行写入 `[{ id: model, longOutput: false, tests: 解析原 tests }]`，这样重复执行无副作用，中途崩溃也能在下次启动补完。
- 最后 `PRAGMA user_version = 4`，拒绝打开的阈值改为 `> 4`。`tests/storage.test.ts` 里"版本 4 被拒绝"的现有用例要改成版本 5。

**3. 保存输入：`model` 是默认模型 ID，新增可选的 `models: { id, longOutput? }[]`。**
`models` 省略时等价于只含 `model` 的单元素列表，这样只传 `model` 的现有调用方和测试不用改；设置面板始终显式传 `models`。校验放在 `validate`：至少 1 个、最多 20 个、ID 去空白后非空且 ≤2048 字符、不重复、`model` 必须在列表中。`longOutput` 对所有协议原样保存；服务级覆盖值仍只对 Anthropic 保存（沿用现有行为）。
保存时按 ID 与旧列表匹配：保留同 ID 模型的 `tests`，新 ID 为"未验证"。

**4. `revision` 与测试失效：`connectionChanged` 去掉 `model`，只看协议、基址、凭据。**
变化时所有模型的 `tests` 重置、`revision` 加 1，与现在一致。增删模型、改默认模型、改 1M、改服务级覆盖值都不加 `revision`，只影响被增删的模型。代价是：某个模型的测试进行中，如果该模型被删后用同名 ID 加回，旧结果会被写入新条目；`recordTest` 对已不存在的模型返回 `false`，这种极端时序可接受，不为它增加按模型的版本号。

**5. `recordTest(id, kind, result, expectedRevision?, model?)`，`testConnection(profiles, id, kind, stream?, model?)`。**
`model` 都放在末尾且可省略，省略时用默认模型，现有调用方不用改。`testConnection` 先读 `revision` 再 `resolve(id, model)`，顺序不变。

**6. 输出上限在 `resolve(id, model?)` 里合成，默认值仍只在 `stream.ts` 出现一次。**
`resolve`：所选模型 `longOutput` 为真则任何协议都得到 `maxOutputTokens = 1_000_000`；否则 Anthropic 用服务级覆盖值、没有则不带该字段，其余协议不带该字段。`stream.ts` 里 Anthropic 分支为 `provider.maxOutputTokens ?? 262144`；OpenAI 兼容分支仅在有值时写 `max_tokens`；Responses 分支仅在有值时写 `max_output_tokens`，因此未开启 1M 时这两种请求体与现在逐字节一致。
OpenAI 兼容选 `max_tokens` 而不是较新的 `max_completion_tokens`：目标是各类兼容网关，它们普遍只认前者。备选是按服务再加一个字段名开关，但超出本次范围。`model` 不在列表中时 `resolve` 抛中文错误，`ChatService.send` 和 `testConnection` 因此自动得到校验，不必各写一份。校验上限常量改为 1_000_000，与 1M 开关共用同一个数值常量。
设置面板占位提示里的 262144 是第二处出现，与之前 4096 的处理一致，用测试锁定请求体默认值。

**7. 对外形状。**
- `ProviderProfile`：`model`（默认模型 ID）+ `models: { id, longOutput, tests }[]`；去掉顶层 `tests`。
- `RuntimeProvider`：仍是单个 `model`，调用 `streamChat` 的代码不变。
- `SendMessageInput.model?: string`；`HerApi.testProfile(id, kind, model?)`；IPC `her:message-send`、`her:profile-test` 增加相应的可选参数，主进程校验为 ≤2048 字符的字符串。其余通道不变。

**8. 聊天窗口的所选模型是 `App` 里的一个 `useState<string | null>`，不写库。**
`null` 表示用服务默认模型。有效模型 = 所选值在当前服务的模型列表中则用它，否则回退默认模型，因此服务被改动或模型被删除时不需要额外处理。以下情形把它置回 `null`：新建对话、`activeProfileId` 变化（用 effect 监听，覆盖聊天窗口切换、设置面板里"设为当前"、首次保存自动选中、删除服务）。应用重启后状态自然丢失。在已有对话之间切换时不重置，保持简单，需要时再扩展。
发送时把有效模型放进 `SendMessageInput.model`；重试沿用当前选择，与 spec 一致。模型选择器放在现有 `.model-picker` 容器旁，样式复用其 `select` 规则。

**9. 设置面板：模型列表 + 按模型测试。**
- Model ID 单输入框改为行列表：单选（默认）、输入框、所有协议都显示的"1M"复选框、删除按钮（仅剩一行时禁用）、列表下方"添加模型"按钮，到 20 个时禁用。默认模型用行下标记录，避免编辑 ID 时和默认标记脱节。
- 表单 identity（用于外部刷新时重置表单）纳入 `models` 的 JSON。
- 连接测试区在模型多于 1 个时增加一个"测试模型"下拉，选项来自**已保存**的模型列表，显示和运行该模型的结果；切换服务时重置为默认模型。测试仍只使用已保存的配置，沿用现有提示。

## Risks / Trade-offs

- [默认值 4096 → 262144 影响现有服务] 许多模型或网关的真实输出上限低于 262144，上游会返回 HTTP 400，现有错误映射只提示"检查服务状态和配置" → 在 docs 的服务配置契约里写明，并在设置面板的说明里提示"如被拒绝，请填写服务级最大输出 token 数"。这是用户明确选择的行为，不做自动探测或降级重试。
- [1M 可能需要上游额外开关] 某些网关要求 beta 请求头才接受极大的 `max_tokens` → 不自动添加，用户可用"额外请求头"配置；spec 只约定请求体里的上限。
- [OpenAI 系上游可能拒绝 `max_tokens`] 官方 OpenAI 的新模型（如 o 系列）只接受 `max_completion_tokens`，Responses 上游对 1000000 也可能报错 → 开关默认关闭，只在用户主动开启时才发送；被拒绝时现有错误映射提示检查配置，用户关闭开关即可恢复。不做自动降级重试。
- [不可回退] `user_version` 升到 4 后旧版应用拒绝打开该库 → 沿用现有版本检查的设计行为；在文档里说明升级前可手动备份 `her.sqlite`。
- [破坏性的内部接口变更] 顶层 `tests` 移除，`tests/profiles.test.ts`、`tests/renderer.test.tsx` 中读取 `.tests` 或构造 `ProviderProfile` 的地方都要改 → 在 tasks 中逐项列出，由 `npm run typecheck` 兜底。
- [与 `chat-ui-redesign` 冲突] 两个变更都改 `App.tsx` 和 `styles.css` → 本变更只在 `.model-picker` 附近加一个 `select`、在 `send` 里多传一个字段；后实现的一方需要合并。
- [归档顺序] `provider-profiles` 的 MODIFIED 依赖 `configurable-anthropic-max-tokens` 先归档，否则归档时找不到被修改的需求 → 在 tasks 的收尾项中写明。

## Migration Plan

1. 应用启动时 `HerStore` 在一个事务内补 `models` 列、回填、把 `user_version` 设为 4。
2. 回填只处理 `models IS NULL` 的行，可重复执行。
3. 回滚：无。升级后旧版本无法打开该库；升级前手动备份 `her.sqlite` 是唯一退路。
