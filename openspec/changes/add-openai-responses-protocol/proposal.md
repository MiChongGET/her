# Proposal

## Why

讯飞星火 MaaS 的模型接口是 Responses 风格（`POST /v1/responses`，请求体用 `input` / `instructions`，流式事件为 `response.output_text.delta` 等），而应用只支持 OpenAI Chat Completions 和 Anthropic Messages 两种协议，所以这类服务现在无法使用。

当前本机保存的"讯飞"服务是 OpenAI 协议，Base URL 填的是 `https://maas-api.cn-huabei-1.xf-yun.com/v1/responses`。`stream.ts` 会在基址后追加 `/chat/completions`，实际请求路径会变成 `.../v1/responses/chat/completions`。这是我读代码得出的推断，没有向该服务发过真实请求确认。

## What Changes

- 新增第三种服务协议"OpenAI Responses"（内部值 `openai-responses`）。
- 该协议向 `<Base URL>/responses` 发送流式 POST，使用 `Authorization: Bearer`，自定义请求头的处理与现有协议一致。
- 请求体：系统提示放进 `instructions`，对话历史放进 `input`，固定 `stream: true`。不发送 `max_output_tokens`、`temperature`、`top_p`（文档建议不传，且 `max_output_tokens` 把推理 token 也计入，设低了容易截断）。
- 新增独立的 Responses 流式解析：增量文本取自 `response.output_text.delta`，收到 `response.completed` 且状态为 `completed` 才算完成；`failed`、`incomplete`、`cancelled`、错误事件和提前结束的流都报为失败，保留已收到的文字。
- 文档没有列出的事件类型（如推理增量）一律忽略，不报错。
- 工具调用只从完整的响应对象里取，名称必须在允许列表内、参数必须能解析成对象，否则不执行。
- 设置面板的协议下拉框增加该选项，并按协议显示 Base URL 的填写提示。
- 连接测试（文字、工具）沿用现有流程，对新协议同样可用。
- 数据库不需要迁移：`profiles.protocol` 是无约束的文本列，`user_version` 保持 3。

不在范围内：自动修正已保存的服务配置（用户需自己改协议并把 Base URL 改回 `.../v1`）、拒绝以 `/responses` 或 `/chat/completions` 结尾的 Base URL、展示或保存推理内容、`web_search` 工具、`json_schema` 输出、非流式调用、`max_output_tokens` 配置。

## Capabilities

### New Capabilities
- `provider-protocols`: 应用支持哪些模型服务协议，以及每种协议如何构造请求、解析流式响应和处理失败。项目目前没有任何 spec；本次只描述 OpenAI Responses 协议和"其他协议不受影响"，现有两种协议的完整要求之后可补充到这里。

### Modified Capabilities
<!-- openspec/specs/ 目前为空。未归档的 configurable-anthropic-max-tokens 会创建 provider-profiles，它规定"只有 Anthropic 服务保存最大输出 token 数"，与本变更不冲突：Responses 服务同样不保存该值。 -->

## Impact

- 代码：`src/shared/types.ts`（`ProviderProtocol`）、`src/core/storage/profiles.ts`（协议白名单）、`src/core/providers/stream.ts`（请求构造、新增 `responsesStream`、协议分发）、`src/renderer/src/SettingsPanel.tsx`（选项、图标、提示）。`probe.ts`、`chat.ts`、IPC 和存储层不需要改。
- 测试：`tests/providers.test.ts`、`tests/profiles.test.ts`、`tests/renderer.test.tsx` 增加用例；`tests/helpers/mock-provider.ts` 增加 `/responses` 路由；`tests/e2e/desktop.spec.ts` 增加一个场景。
- 文档：`docs/implementation/stage-a.md` 的服务配置契约。
- 验证状态：文字流式和 `response.failed` 已在真实服务上观察到，应用里文字对话已能流式显示；工具调用（流式里的 `function_call`、工具定义格式、`tool_choice`）和 `response.incomplete` 尚未用真实服务验证，详见 design.md。
- 依赖：无新增。
