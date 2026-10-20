# Pi SDK 1.3.0 接入验证报告

对象：`@earendil-works/pi-coding-agent@1.3.0`（pi-agent-core / pi-ai 1.3.0），作为 Her 正式依赖精确锁定。测试使用真实 SDK 与 `tests/helpers/mock-provider.ts` 回环 SSE 服务（OpenAI Chat Completions），不访问真实供应商。测试文件：`tests/pi-sdk/`。

本报告随任务 1.2–1.5 逐步补充；未列出的项尚未验证。

## 1.2 受控注入（`tests/pi-sdk/isolation.test.ts`）

| 检查 | 结果 |
| --- | --- |
| `noTools: "builtin"` + `customTools` 后 `getActiveToolNames()` 与请求体 `tools` 仅含注入工具 | 通过 |
| 临时 HOME 下的 `~/.pi/agent` auth.json / settings.json / AGENTS.md / extensions 未被读取或执行 | 通过 |
| 进程环境 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` 未出现在自定义 provider 请求头 | 通过 |
| 持久会话只写入注入的 `agentDir/sessions`，不生成 auth.json，HOME 下无新文件 | 通过 |
| 注入的 `CredentialStore` 提供的 Key 以 `Bearer` 头发送 | 通过 |

观察：`ModelRuntime` 会对目录中约 40 个内置 provider id 调用 `CredentialStore.read()` 做可用性检查。Her 的 store 只为 `her-<profileId>` 返回凭据，其余返回 `undefined`，不构成泄漏；实现时 store 不得对未知 id 回退到任何默认值。

## 1.3 会话行为（`tests/pi-sdk/sessions.test.ts`）

| 检查 | 结果 |
| --- | --- |
| 两个会话同时 prompt：两请求在 400ms 内先后到达服务（实际重叠），文本与认证头各归其会话 | 通过 |
| `abort()` A：A `agent_settled.aborted=true`，B 正常完成 `aborted=false` | 通过 |
| 流式期间无 steer/followUp 选项的 `prompt()` 被拒绝 | 通过 |
| `agent_end` 先于 `agent_settled` | 通过 |
| `appendCustomEntry('her.run', …)` 写入会话文件，不出现在模型请求体 | 通过 |
| 会话文件在首个 user 消息时创建；user 消息在模型请求发出前已同步落盘（`appendFileSync`） | 通过 |
| 系统提示作为 `role: "system"` 的 message 条目持久化 | 观察 |

**与设计不符的发现**：普通 user/assistant/toolResult 消息由 `AgentSession` 在派发 `message_end` 给监听器**之后**调用 `SessionManager.appendMessage()` 持久化，且**不派发 `entry_appended`**（该事件只用于 custom entry、context edit、virtual model state 等）。因此 design D6 “订阅 `entry_appended` 幂等 upsert 投影”不可行；改为在 `turn_end` / `agent_settled` / 启动时从 `SessionManager.getEntries()` 按顺序拉取并以 entry ID 幂等更新。`message_end` 监听器内此时条目尚未写入。

## 1.4 与 pi-ai 1.2.0 已知差异的复测（`tests/pi-sdk/differences.test.ts`）

经完整 AgentSession 路径、三协议回环服务复测，原始观察见 `results/differences.json`。

| 1.2.0 差异 | 1.3.0 AgentSession 实测 | Her 处理 |
| --- | --- | --- |
| 坏工具 JSON 被修复后执行 | `{"ok":trueoops}`、`{"ok":` 三协议均**不执行**工具（schema 校验失败回给模型） | 改善；执行门仍按 Her schema 二次校验（D4） |
| 同批合法+坏参数 | 合法调用执行、坏调用不执行（逐个判定） | 接受逐调用判定，Her 原“整批拒绝”不再保留 |
| 不完整流被视为完成 | Anthropic 缺 `message_stop`、Responses 缺终止事件 → `stopReason: error`；OpenAI 缺 `[DONE]` 但有 `finish_reason` → 成功；OpenAI 缺 `finish_reason` → error | OpenAI 缺 `[DONE]` 视为可接受（finish_reason 已明确）；记录为已知差异 |
| Responses 仅在 `completed.output` 中的工具调用丢失 | 仍丢失（`final-only-tool` 未执行，Chat/Anthropic 无此问题） | 已知限制；工具不会被误执行，只是不执行 |
| Responses `queued` / 缺 status 被接受 | 仍接受 | 已知差异，影响仅为把异常完成当完成文本 |
| Anthropic 基址 `/proxy/v1` → `/proxy/v1/v1/messages` | 仍存在 | profile 层在注册 Anthropic 自定义服务时去掉末尾 `/v1`（任务 3.1） |
| JSON Content-Type 的 SSE 正文 | 三协议仍接受 | 已知差异，不做原始 SSE 再解析 |
| 同源重定向被跟随 | 仍跟随 | 需在 Her 注入的 fetch 中设 `redirect: 'error'`（与下方 fetch 包装同一位置） |
| 错误含敏感标记 | `synthetic_secret_marker` 原样出现在 `assistant.errorMessage` | 事件适配层必须脱敏（任务 3.4） |
| 响应体停滞需外部 abort | `abort()` 后 200ms 内以 `aborted` 结束，无工具执行 | 满足停止需求；逐次读取超时由 Her 另设（SettingsManager `httpIdleTimeoutMs` 待用） |

### 阻塞项：无密钥 / 仅请求头认证

1.3.0 没有公开方式让自定义 provider 不带凭据发出请求：

- `AgentSession.prompt()` 先检查 `hasConfiguredAuth`，没有凭据即报 `No API key found`，请求不发出。
- `authHeader: false`、空 key、仅 `env`、仅 `headers` 的凭据都不被视为已配置（6 种组合实测，均 0 请求）。
- `streamSimple` 包装中把 `apiKey` 置空，会被 pi-ai 适配器拒绝（`No API key for provider`）。

唯一能跑通的公开路径：凭据仓库为该 profile 返回一个内部固定值作为 key，同时通过 `streamSimple` 包装为请求注入自定义 `fetch`，在发出前删除携带该固定值的 `Authorization` / `x-api-key` 头。OpenAI Chat 实测请求不带认证头、自定义头正常发送。Anthropic 实测因基址 `/v1` 重复返回 404，与认证无关。

该路径对外满足“请求不携带认证信息”，但内部仍需一个占位值，和 spec `model-access`「MUST NOT 使用占位密钥替代无密钥模式」以及 design D7「不填充占位 Key」字面冲突。2026-10-19 用户选定该方案；spec `model-access` 与 design D7 已改为“请求不携带认证值，内部值不落盘、不外发、不显示”。

## 1.5 Electron 构建与打包（`electron/run.mjs`）

运行：`HER_ELECTRON_ZIP_DIR=<本机 electron 44.7.0 zip 缓存目录> node experiments/pi-sdk-1.3.0/electron/run.mjs`（不设时由 packager 下载）。

方法：在临时目录用 Her 的 package.json / package-lock.json 执行 `npm ci --omit=dev`，得到正式生产依赖闭包；以 `electron/probe.ts` 为主进程入口，经 electron-vite 构建；用与 `scripts/package.mjs` 相同的 packager 选项（`prune: true, asar: false`）打包 `.app`，并从无关目录启动，`HOME` 指向空临时目录。正式源码与配置未改动。

| 检查 | 构建后 Electron | 打包 `.app` |
| --- | --- | --- |
| Electron 44.7.0 / 内置 Node 24.21.0 主进程（`processType: browser`） | 通过 | 通过（`isPackaged: true`） |
| 受控注入后 `activeTools = ["her_echo"]` | 通过 | 通过 |
| 工具往返（2 次请求，参数 `{"text":"茶"}`）+ 中文/emoji 流式文本 | 通过 | 通过 |
| 会话文件写入 `userData/Her-Pi-v1/pi/sessions/` | 通过 | 通过 |
| `resizeImage`（Photon WASM，worker 线程）64→16px | 通过 | 通过 |
| Pi 从 app 内 `node_modules` 解析 | 通过 | 通过 |

`@silvia-odwyer/photon-node` 是 WASM 包，不是原生 `.node` 模块，无需按 Electron ABI 重编译。

体积：打包后 `app/node_modules` 为 264 MiB，当前 Her 发布包为 95 MiB，增加约 169 MiB。最大的几项：pdfjs-dist 42（原有）、@earendil-works 42、openai 29、@napi-rs/canvas 28（原有）、@anthropic-ai/sdk 15、@google/genai 12。比 1.2.0 测得的 67 MiB 大很多，因为 1.3.0 完整 SDK 带上了全部 provider SDK。本期按 design 风险条目接受，不做裁剪。

未验证：签名、公证、Intel/Windows/Linux，以及 Her 正式 UI 下的端到端流程（任务 10.3）。

## 阶段 1 结论

关键能力全部成立：受控注入、并行会话隔离、中止、同步落盘、自定义关联条目、Electron 主进程与打包运行。对设计做了两处修订：D6 投影改为拉取对账，D7 无密钥改用 fetch 包装（用户已确认）。其余差异已分配到任务 3.1、3.3、3.4。可以进入阶段 2。
