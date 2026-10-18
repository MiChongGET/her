# Tasks

## 1. 协议类型与保存校验

- [x] 1.1 `src/shared/types.ts` 的 `ProviderProtocol` 增加 `'openai-responses'`；`src/core/storage/profiles.ts` 的协议白名单接受它，错误提示保持"请选择有效的服务协议。"。在 `tests/profiles.test.ts` 增加用例：保存并读回该协议；附带 `maxOutputTokens` 保存时被丢弃；未知协议仍被拒绝且原配置不变；把已验证的服务改为该协议后文字和工具测试回到未验证。运行 `npm run typecheck` 与 `npx vitest run tests/profiles.test.ts` 通过

## 2. 请求构造与流式解析

- [x] 2.1 修改 `src/core/providers/stream.ts`：路径后缀、鉴权头、请求体构造、解析器选择改为按协议显式分发，未知协议抛 `ProviderError('invalid_protocol', ...)`；新增 `responsesStream`（文本增量、`response.completed` 的状态判定、`failed` / `error` / `incomplete` 事件、提前结束、忽略未知事件、`data.type` 缺失时用 SSE `event` 字段）。在 `tests/providers.test.ts` 增加用例：路径为 `<基址去尾斜杠>/responses`；有密钥带 `Authorization: Bearer`、无密钥不带；自定义请求头可覆盖；请求体含 `model`、`stream: true`、`instructions`、按顺序的 `input`，且不含 `max_output_tokens`、`temperature`、`top_p`；两段文本增量加 completed 得到文本和 `done`；`delta` 不是字符串报 `invalid_stream`；`failed` / `cancelled` 状态、`incomplete` 状态、错误事件、缺失 `status`、流提前结束各自的错误码，且错误文案不含上游文字；夹带推理事件时结果与没有时一致；分包 UTF-8 与 CRLF 的流也能解析；OpenAI 与 Anthropic 的既有用例仍全部通过。运行 `npx vitest run tests/providers.test.ts` 通过
- [x] 2.2 在 `responsesStream` 中处理工具调用：只在 `response.completed` 且状态为 `completed` 后，从 `response.output` 取 `function_call` 条目，用已有的 `completedTools` 校验，按 `call_id` 去重，先产出工具再产出 `done`。请求体里工具使用不嵌套的 `{ type: 'function', name, description, parameters }`，指定工具时 `tool_choice` 为 `{ type: 'function', name }`。在 `tests/providers.test.ts` 增加用例：有效调用；`arguments` 为字符串与为对象两种形式；名称不在允许列表；参数不是合法 JSON 对象；缺少 `call_id`；重复 `call_id`；`reasoning` 与 `message` 条目不产生工具；请求体里的工具与 `tool_choice` 形状。运行 `npx vitest run tests/providers.test.ts` 通过
- [x] 2.3 在 `tests/chat.test.ts` 或 `tests/profiles.test.ts` 增加用例，确认连接测试对 Responses 服务走新协议：用 `testConnection` 配合桩检查 `provider.protocol` 为 `openai-responses`，文字测试与工具测试都能得到"已验证"。运行对应测试通过

## 3. 设置面板

- [x] 3.1 修改 `src/renderer/src/SettingsPanel.tsx`：协议下拉框增加 `<option value="openai-responses">OpenAI Responses</option>`；服务列表的字母标识为 `R`；Base URL 下方的说明按协议显示（Responses 与 OpenAI 兼容提示填到 `/v1` 为止，Her 会追加接口路径）；该协议下不显示最大输出 token 数，保存时不带该字段。在 `tests/renderer.test.tsx` 增加用例：选择该协议保存时 `saveProfile` 收到 `protocol: 'openai-responses'` 且没有 `maxOutputTokens`；选择该协议时最大输出 token 数输入框不出现；列表中该服务的标识为 `R`。运行 `npm run typecheck` 与 `npx vitest run tests/renderer.test.tsx` 通过

## 4. 端到端、文档与整体验证

- [x] 4.1 修改 `tests/helpers/mock-provider.ts` 增加 `/responses` 路由：从 `body.input` 读取最后一条用户消息；文字流依次发出 `response.created`、两段 `response.output_text.delta`（中间可停顿以支持"慢一点"取消场景）、状态为 `completed` 的 `response.completed`；带 `tools` 时在 `completed` 的 `output` 里返回 `report_connection` 的 `function_call`；`error-model` 仍返回 401。运行 `npm run typecheck` 通过，现有三个 e2e 场景不受影响
- [x] 4.2 在 `tests/e2e/desktop.spec.ts` 增加一个场景：把 `saveProfile` 辅助函数的协议类型放宽，保存一个 OpenAI Responses 服务，运行文字测试和工具测试均显示已验证，发送消息得到完整回答，断言模拟服务收到的请求路径以 `/responses` 结尾、请求体含 `instructions` 与 `input` 且不含 `max_output_tokens`。运行 `npm run test:e2e` 通过；若 Electron 二进制无法下载则如实记录未能运行
- [x] 4.3 更新 `docs/implementation/stage-a.md` 的服务配置契约：三种协议各自追加的路径（`/chat/completions`、`/messages`、`/responses`）、Responses 的请求字段与不发送的参数、完成判定与失败映射、文档未覆盖而按通用写法实现的部分，以及"误把完整接口地址填进 Base URL 会导致路径重复，应改为填到 `/v1`"。核对文档中的路径、字段名与代码一致
- [x] 4.4 运行 `npm run check`（类型检查、全部 Vitest、构建）全部通过

## Workflow follow-up

- 真实服务验收（自动化测试用的是按文档事件名构造的本地模拟，不能替代）：在设置里把已保存的"讯飞"服务协议改为 OpenAI Responses，Base URL 改为 `https://maas-api.cn-huabei-1.xf-yun.com/v1`，分别运行"测试文字"和"测试工具"，再发一条真实消息。若与 design 中的假设不符（`status` 缺失、事件名、`input` 结构、工具格式、首包超时），先更新 design 与 spec，再改代码。
- 应用不会自动改动已保存的服务配置；应用过程中也不要读取或回显已保存的密钥。
- 评审通过后归档该 change。
