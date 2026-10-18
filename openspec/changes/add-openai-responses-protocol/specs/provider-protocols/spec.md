# Spec Delta

## Purpose

定义应用支持的模型服务协议，以及每种协议如何向上游发起请求、解析流式响应和处理失败。本次变更只覆盖新增的 OpenAI Responses 协议，并保证现有协议的行为不变。

## ADDED Requirements

### Requirement: 支持 OpenAI Responses 协议的服务
系统 SHALL 允许用户把模型服务的协议设为"OpenAI Responses"，并 SHALL 在聊天时向该服务的 `<Base URL>/responses` 发送流式 POST 请求。Base URL 末尾的斜杠 MUST 被忽略，系统 MUST NOT 自动补充 `/v1`。

#### Scenario: 请求路径
- **WHEN** 用户保存协议为 OpenAI Responses、Base URL 为 `https://example.com/proxy/v1/` 的服务并发送消息
- **THEN** 请求发往 `https://example.com/proxy/v1/responses`

#### Scenario: 鉴权
- **WHEN** 该服务保存了 API 密钥
- **THEN** 请求带有 `Authorization: Bearer <密钥>`；未保存密钥时不带该请求头

#### Scenario: 重启后保持
- **WHEN** 用户保存该协议的服务后重启应用
- **THEN** 该服务仍使用 OpenAI Responses 协议

### Requirement: 保存时拒绝不支持的协议
系统 SHALL 只接受 OpenAI 兼容、Anthropic 和 OpenAI Responses 三种协议。其他协议值 MUST 被拒绝并给出中文错误提示，已有配置保持不变。

#### Scenario: 未知协议
- **WHEN** 保存请求中的协议不是上述三种之一
- **THEN** 保存失败并提示"请选择有效的服务协议"

### Requirement: Responses 请求内容
系统 SHALL 把系统提示作为 `instructions`，把对话历史按时间顺序作为 `input`，并 MUST 设置 `stream` 为 true。系统 MUST NOT 向该协议的服务发送 `max_output_tokens`、`temperature` 和 `top_p`，也 MUST NOT 为该协议的服务保存最大输出 token 数。

#### Scenario: 请求体
- **WHEN** 用户向 Responses 服务发送第二轮消息
- **THEN** 请求体包含 `model`、`stream: true`、`instructions`，以及按顺序包含前面各轮用户与助手消息的 `input`，且不含上述三个参数

#### Scenario: 不保存输出上限
- **WHEN** 用户保存 Responses 服务时附带最大输出 token 数
- **THEN** 该值不被保存

### Requirement: 流式文本与完成判定
系统 SHALL 把 `response.output_text.delta` 事件的增量按顺序显示给用户。系统 SHALL 仅在收到 `response.completed` 事件且其状态为 `completed` 时，才把回答标记为完成。

#### Scenario: 正常完成
- **WHEN** 服务依次返回两个文本增量和一个状态为 completed 的 `response.completed`
- **THEN** 用户看到两段文字依次出现，回答被标记为完成

#### Scenario: 增量格式错误
- **WHEN** 文本增量事件的内容不是字符串
- **THEN** 回答失败，提示服务返回了无法识别的流式数据

### Requirement: 失败与不完整的响应
系统 SHALL 在以下情况把回答标记为失败：完成事件的状态为 `failed`、`cancelled` 或 `incomplete`，收到失败事件或错误事件，流在收到完成事件前结束。已收到的文字 MUST 保留，错误提示 MUST 为中文且 MUST NOT 回显上游返回的原始文字。

#### Scenario: 流提前结束
- **WHEN** 服务发出一个文本增量后连接结束，没有完成事件
- **THEN** 回答被标记为失败，已显示的文字保留

#### Scenario: 因长度被截断
- **WHEN** 完成事件的状态为 incomplete
- **THEN** 回答被标记为失败，提示输出长度限制导致内容不完整

#### Scenario: 上游报错
- **WHEN** 服务返回错误事件，其文字中含有服务内部信息
- **THEN** 提示为通用的中文错误，不包含该文字

#### Scenario: 服务返回 response.failed
- **WHEN** 服务在发出部分文字后发出 `response.failed` 事件，其 `response.error` 中含有错误码和说明
- **THEN** 回答被标记为失败，已显示的文字保留，提示为通用的中文错误，不包含错误码和说明

#### Scenario: 完成事件缺少 response 对象
- **WHEN** `response.completed` 事件的数据里没有 `response` 对象
- **THEN** 回答失败，提示服务返回了无法识别的流式数据

### Requirement: 忽略未识别的事件
系统 SHALL 忽略不认识的流式事件类型，例如推理内容的增量。忽略这些事件 MUST NOT 影响文本的显示和完成判定。

#### Scenario: 夹带推理事件
- **WHEN** 流中在文本增量之间出现推理相关的事件
- **THEN** 这些事件不显示，文本和完成状态与没有它们时一致

### Requirement: 工具调用只在完整时执行
系统 SHALL 仅在响应完成后，才把其中类型为 `function_call` 的条目作为工具请求。工具名称 MUST 在本轮允许的工具列表内，参数 MUST 能解析为 JSON 对象，否则系统 MUST NOT 执行该工具并报告工具无效。同一个 `call_id` 只产生一个工具请求。

#### Scenario: 有效的工具调用
- **WHEN** 完成的响应中含有名称在允许列表内、参数为合法 JSON 对象的 function_call
- **THEN** 系统得到一个对应的工具请求

#### Scenario: 无效的工具调用
- **WHEN** function_call 的名称不在允许列表内，或参数不是合法的 JSON 对象
- **THEN** 不产生工具请求，回答失败并提示工具无效

#### Scenario: 重复条目
- **WHEN** 同一个 call_id 在响应中出现多次
- **THEN** 只产生一个工具请求

### Requirement: 连接测试支持 Responses 协议
系统 SHALL 对 Responses 服务分别提供文字与工具两项连接测试，测试使用该服务已保存的配置和 Responses 协议发起请求，结果的记录与失效规则与其他协议一致。

#### Scenario: 文字测试
- **WHEN** 用户对一个 Responses 服务运行文字测试，服务返回文字并正常完成
- **THEN** 测试结果为已验证

#### Scenario: 修改协议使验证失效
- **WHEN** 用户把一个已验证的服务的协议改为 OpenAI Responses 并保存
- **THEN** 该服务的文字和工具测试状态回到未验证

### Requirement: 现有协议的行为不变
系统 MUST 保持 OpenAI 兼容协议向 `<Base URL>/chat/completions`、Anthropic 协议向 `<Base URL>/messages` 发起请求，请求内容和流式解析与本变更之前一致。

#### Scenario: 其他协议的请求路径
- **WHEN** 用户向 OpenAI 兼容服务和 Anthropic 服务各发送一条消息
- **THEN** 请求分别发往 `/chat/completions` 和 `/messages`
