# Design

## Context

动机见 proposal.md，需求见 specs/provider-protocols/spec.md。当前相关代码的状态：

- `ProviderProtocol` 是 `'openai' | 'anthropic'`。`profiles.ts` 的 `validate` 用白名单校验它。
- `stream.ts` 的 `requestDetails` 用 `provider.protocol === 'openai' ? ... : ...` 分支。`else` 分支就是 Anthropic，所以任何新增的协议值如果不显式处理，会被当成 Anthropic 发往 `/messages`。`streamChat` 里选择解析器的三元表达式同理。
- `profiles.protocol` 是 `TEXT NOT NULL`，没有 `CHECK` 约束（见 `store.ts` 建表语句）。
- 读超时按每次 `read()` 计时，上游静默超过 60 秒才触发（`sse.ts` 的 `beginRead` / `endRead`）。
- `completedTools(tools, input)` 已有的工具校验：`id`、`name` 非空，参数能解析为对象，名称在 `input.tools` 里。
- 参考文档能确认的：`POST .../v1/responses`、`Authorization: Bearer`、请求字段（`model`、`input`、`instructions`、`stream`、`tools`、`tool_choice`、`max_output_tokens` 等）、响应对象的 `status` 取值和 `output` 条目类型（`function_call` 条目的 `call_id`、`name`、`arguments` 在条目顶层）。文档没有给出 SSE 示例。
- 已用真实服务（`spark-x2.6-preview`）的一次非流式和一次流式请求确认：流式事件的 `data` 里都带 `type`；有大量 `response.reasoning_summary_*` 推理事件；文本增量是 `response.output_text.delta`；`response.completed` 的 `status` 和 `output` 在其 `response` 对象里；服务报错（如额度不足）时发出 `response.failed`，错误在 `response.error` 里。应用的文字对话在真实服务上已能流式显示。
- 尚未用真实服务验证：工具调用（流式里的 `function_call` 条目、工具定义格式、`tool_choice`）和 `response.incomplete`。这些仍按文档和通用写法实现。

## Goals / Non-Goals

**Goals:**
- 用独立的协议值和独立的解析器接入 Responses 服务，不改变现有两种协议的行为。
- 对文档没有覆盖的部分采用保守策略：不认识的事件忽略，不完整或不合法的结果不当作成功。

**Non-Goals:**
- 不自动修正已保存的服务配置，不拒绝以 `/responses` 或 `/chat/completions` 结尾的 Base URL。
- 不展示、保存推理内容；不支持 `web_search`、`json_schema`、非流式调用。

## Decisions

**1. 新增显式的协议值 `openai-responses`。**
备选一是在 `openai` 协议里根据 Base URL 是否以 `/responses` 结尾自动切换：会破坏"Base URL 是基址，应用追加接口路径"的约定，行为也难以预期。备选二是加一个"接口路径"字段：灵活但表单更复杂，也让现有的路径契约有两套。显式协议值改动最小，行为可预测。

**2. 不做数据库迁移，`user_version` 保持 3。**
`protocol` 列无约束，白名单只在 `validate` 里。代价是：如果用户保存了 Responses 服务后又回退到本变更之前的构建，旧构建会把未知协议当成 Anthropic 发往 `/messages`。请求只会发往用户自己配置的地址，且回退本身不被支持（见数据库版本说明），因此不为此增加版本号。

**3. `stream.ts` 里对协议显式分发，不再用三元表达式的默认分支。**
路径后缀、鉴权头、请求体构造、解析器选择都改成按协议三选一，并对未知值抛出 `invalid_protocol` 的 `ProviderError`。这样以后再加协议时，漏处理会直接报错，而不是悄悄走 Anthropic 分支。

**4. 请求体映射。**
- `instructions` = 系统提示；`input` = `[{ role, content }]`，`content` 用纯字符串；`stream: true`；`model`。
- 工具（仅连接测试用）：`{ type: 'function', name, description, parameters }`（不嵌套 `function` 字段）；`tool_choice` 指定工具时用 `{ type: 'function', name }`。
- 不发送 `max_output_tokens`、`temperature`、`top_p`。
- `instructions` 加 `[{ role, content }]` 形式的 `input` 已在真实服务上跑通文字对话。工具定义和 `tool_choice` 的形状仍是按 OpenAI Responses 的通用写法实现，没有用真实服务验证。

**5. 独立的 `responsesStream` 解析器，按事件的 `type` 字段分发。**
SSE 的 `event:` 行作为后备（`data` 里没有 `type` 时使用）。与现有设计一致：每种协议各自解析，不共享一个未区分的解析器。
- `response.output_text.delta`：`delta` 必须是字符串，否则 `invalid_stream`；非空则产出文本。
- `response.completed`：事件的 `response` 对象必须存在，否则按 `invalid_stream` 处理；读取其中的 `status`。`completed` 才算成功；`incomplete` 报 `upstream_incomplete`，`failed` 报 `upstream_failed`，`cancelled` 报 `upstream_cancelled`；缺失或其他值按 `invalid_stream` 处理。成功时再处理工具，然后产出 `done` 并结束读取（Responses 没有 `[DONE]` 结束标记）。
- `response.failed` 和 `type` 为 `error` 的事件：报 `upstream_error`，文案固定，不回显 `response.error` 里的上游文字。`response.failed` 已在真实服务上观察到（额度不足）。没有单独处理 `response.incomplete` 事件：它如果出现且之后没有 `response.completed`，会落到下面的 `incomplete_stream`。
- 其他类型（`response.created`、`response.in_progress`、推理增量等）：忽略。
- 流在收到 `response.completed` 前结束：`incomplete_stream`。
- 所有错误文案沿用现有的固定中文，不回显上游文字。

**6. 工具调用只取自 `response.completed` 里的 `response.output`。**
取类型为 `function_call` 的条目，用 `call_id`、`name`、`arguments` 构造 `PendingTool`（`arguments` 是字符串就原样用，是对象就序列化，其他情况视为空）后交给已有的 `completedTools` 校验，按 `call_id` 去重。不依赖文档没有列出的"参数增量"和 `output_item.done` 事件，也就保证半段参数不会被执行。`reasoning`、`message`、`tool_search_call` 条目不产生工具请求。

**7. 超时策略不变。**
仍是每次读取 60 秒。推理模型在输出第一个文本前可能长时间没有数据；文档里的 `response.in_progress` 事件如果会周期性发送，就能避免超时，但这是推断，需要真实服务验证。

**8. 设置面板。**
协议下拉框增加"OpenAI Responses"；列表里的字母标识为 `R`；Base URL 下方的说明按协议显示，Responses 和 OpenAI 兼容都提示"填到 `/v1` 为止，Her 会追加接口路径"。该协议下不显示最大输出 token 数（保持现有的"仅 Anthropic 显示"条件），`profiles.ts` 现有逻辑已经会为非 Anthropic 协议丢弃该值。

**9. 已保存的"讯飞"服务不自动改。**
用户需要把协议改为 OpenAI Responses，并把 Base URL 改回 `https://maas-api.cn-huabei-1.xf-yun.com/v1`。协议变化会使原有连接测试结果失效（`connectionChanged` 已包含协议比较），这正是想要的行为。

## Risks / Trade-offs

- [文档未覆盖的细节可能与真实服务不符] `input` 消息结构、工具定义格式、`failed` / `incomplete` / `error` 事件的名称和结构 → 未知事件被忽略，文字对话在事件名正确时即可工作；工具测试会如实报告失败；最终以真实服务的验收为准，不一致时更新本设计和 spec。
- [流式里的工具调用未在真实服务上验证] 真实服务的 `response.completed.response.output` 里 `function_call` 条目的实际形状可能与文档不同 → 工具测试会如实报告失败，文字对话不受影响；验证前不要把工具能力当作已确认。
- [最终响应里的 `output` 可能为空] 此时工具调用拿不到，且若没有文本增量会得到 `empty_response` → 同上，连接测试暴露。
- [推理模型首包慢] 60 秒静默超时可能误伤 `spark-x2.6-preview` 这类模型 → 见规则 7，真实验收时观察；不在本变更里调整超时。
- [旧构建误路由] 见规则 2。
- [用户可能仍把完整接口地址填进 Base URL] 请求路径会重复 → 设置面板的说明文字和文档提示；不做自动校验（非目标）。
