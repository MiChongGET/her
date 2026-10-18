# Design

## Context

动机见 proposal.md。当前相关代码的状态：

- `stream.ts` 的 `requestDetails` 在 Anthropic 分支写死 `body.max_tokens = 4096`。
- `HerStore` 在构造函数里用 `CREATE TABLE IF NOT EXISTS` 建表并把 `PRAGMA user_version` 设为 1；版本大于 1 时拒绝打开。`saveProfile` 用位置参数 `INSERT INTO profiles VALUES (?, ?, ...)` 写 10 列。
- `ProfileService.save` 里 `connectionChanged` 只比较协议、基址、模型和凭据；变化时重置连接测试并让 `revision` 加 1。
- `probe.ts` 的 `testConnection` 通过 `profiles.resolve(id)` 取运行时配置，再调用 `streamChat`。

## Goals / Non-Goals

**Goals:**
- 把输出上限变成服务配置的一部分，经 `resolve()` 流到 `streamChat`，聊天和连接测试共用同一个值。
- 旧库升级后行为不变。

**Non-Goals:**
- 不为不同模型内置输出上限表，也不探测上游的真实上限。
- 不改 OpenAI 协议的请求体。
- 不改截断时的错误文案。

## Decisions

**1. 新增可空列 `max_output_tokens INTEGER`，`NULL` 表示使用默认值。**
默认值 4096 仍只在 `stream.ts` 里出现一次（`provider.maxOutputTokens ?? 4096`），数据库不存默认值。备选是迁移时给旧行写入 4096，但这样以后调整默认值时旧服务不会跟着变，也分不清"用户选了 4096"和"没选"。

**2. 迁移用 `user_version` 判断，加列前再查 `PRAGMA table_info`。**
- 新库：建表语句直接包含该列，`user_version` 设为 2。
- `user_version` 为 1 的旧库：在一个事务里 `ALTER TABLE profiles ADD COLUMN max_output_tokens INTEGER`，成功后设为 2。
- 拒绝打开的阈值从 `> 1` 改为 `> 2`。

现有代码每次启动都无条件执行 `PRAGMA user_version = 1`，必须一并改掉，否则会把已升级的库降回 1，下次启动重复加列并报错。加列前查 `table_info` 是为了在版本号和实际结构不一致时（例如上次迁移中途崩溃）仍然安全。
`saveProfile` 改为带列名的 `INSERT`，避免位置参数和列顺序耦合。

**3. 保存语义：`undefined` 保持不变，`null` 清除，数字为设置。**
`SaveProfileInput.maxOutputTokens?: number | null`。它不是机密，但沿用 API Key 的"省略即保留"约定，这样没有传该字段的旧调用方（例如现有测试）不会意外清掉已保存的值。设置面板每次保存都显式传值：输入框为空传 `null`。
协议为 `openai` 时，无论传入什么，落库一律为 `NULL`，对应 spec 里"OpenAI 服务不保存该值"。

**4. 校验放在 `ProfileService` 的 `validate` 里。**
规则是 `Number.isInteger(v) && v >= 1 && v <= 200000`，错误信息为中文，与现有校验风格一致。200000 是防止误输入的合理性上限，不代表任何模型的真实上限，真正的上限以上游返回为准。校验失败发生在写库之前，所以原配置不变。

**5. 修改该值不计入 `connectionChanged`。**
连接测试验证的是地址、鉴权、协议和流式/工具能力，不依赖输出上限，因此不重置测试结果、不增加 `revision`。`probe.ts` 不需要改动：它走 `resolve()`，自然使用已保存的值。

**6. 运行时与公开 DTO。**
`RuntimeProvider` 和 `ProviderProfile` 都新增可选的 `maxOutputTokens`（缺省表示未配置）。设成可选而不是必填，是为了不破坏现有测试里直接构造 provider 对象的写法。

**7. 设置面板用 `type="number"` 输入框，仅在协议为 Anthropic 时渲染。**
空值显示占位提示"留空使用默认 4096"。切换协议、新建服务、选择其他服务时，和现有字段一样重置该状态。

## Risks / Trade-offs

- [不可回退] `user_version` 升到 2 后，旧版应用会拒绝打开该数据库 → 这是现有版本检查的设计行为；在 tasks 里加一条文档说明，升级前可手动备份 `her.sqlite`。
- [迁移中断] 加列和设版本号分两步，中途崩溃会出现"列已存在但版本仍为 1" → 加列前检查 `table_info`，并把两步放进同一个事务。
- [测试被自己的设置误伤] 用户把值设得很小（如 1）时，连接测试和聊天都会因 `stop_reason: max_tokens` 报"输出长度限制" → 这是该设置的预期后果，报错文案已提示重试或缩短请求，本次不另做防护。
- [上限不准] 200000 可能高于或低于某些模型的真实上限 → 超出时由上游返回 HTTP 错误，现有错误映射会提示检查配置。
- [范围] 把默认值常量留在 `stream.ts` 意味着 UI 的占位文案里的 4096 是第二处出现 → 数量很少，tasks 里用测试锁定请求体的默认值，改动时测试会提醒。
