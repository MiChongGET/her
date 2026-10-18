# Her / pi-ai@1.2.0 接入验证报告

日期：2026-10-15。结论：**Electron 运行与打包可行，正常文本、工具往返及取消能够接入；不建议现在直接替换 Her 正式协议层。**

正常流程的收益已经得到验证，但要保持 Her 已有的严格工具参数、完整流结束、无密钥服务和网络策略，仍需要专门的兼容层。这些不是把几个事件名称转换一下就能全部解决的问题。首期记忆功能继续使用现有协议层，避免与记忆设计同时引入一轮网络/工具语义迁移。

## 方法与范围

- 固定 npm 包 `@earendil-works/pi-ai@1.2.0`，独立 package.json / lockfile；没有改动正式依赖、模型配置或聊天实现。
- 测试调用真实 Pi SDK，通过回环 HTTP/SSE 服务比较现有 Her `streamChat` 与实验薄适配器。没有 mock Pi SDK，没有访问实际模型供应商。
- 协议：OpenAI Chat Completions、Anthropic Messages、OpenAI Responses。
- 应用集成：真实 `ChatService`、`ProfileService`、`HerStore`（内存 SQLite）与工具执行器。工具回传检查角色、调用 ID、参数和结果，避免仅检查“收到了后续文字”造成假通过。
- Electron：复制当前 Her 源码与配置，仅修改副本注入探针；正常启动 Her renderer 后调用适配器。不是仅设置 `ELECTRON_RUN_AS_NODE` 的测试。它验证真实主进程/构建/打包环境，不等于完成正式 UI 聊天入口迁移。
- 最终 `.app` 位于无项目祖先依赖的临时目录；Pi、OpenAI、Anthropic 的模块解析路径均位于 `app.asar` 内。

## 测试结果

| 检查 | 结果 | 证据 |
|---|---|---|
| 原 Her 基线 | 类型检查、194 个测试、构建通过 | `results/baseline.json` |
| 实验 TypeScript | 通过 | `results/verification.log` |
| 协议观察测试 | 92 个用例断言通过，包括明确的差异复现断言 | `protocol.test.ts`、`results/test-results.json` |
| 真实聊天/存储集成 | 9/9：每协议文本落库、工具执行与回传、取消保留部分 | `chat-integration.test.ts` |
| 当前 Electron Vite 配置构建 | 通过；动态导入产生可运行 chunk | `results/packaging-results.json` |
| 真实 Electron 主进程 | 每协议文本、工具往返、首段后取消，共 9 项通过 | `results/electron-built-pi.json` |
| macOS arm64 `.app + app.asar` | 同上 9 项通过，`isPackaged=true`，退出码 0 | `results/electron-packaged-pi.json` |
| 正式源码/依赖完整性 | SHA256 对照未发生变化 | `results/production-integrity.json` |

总计 **101 个实验用例通过**，不代表 101 个场景都可直接兼容。95 条协议兼容观察中有 58 条一致、37 条不同；多个观察共享同一根因，不能称为 37 个独立缺陷，也不应据此计算产品兼容率。用量能力 3 条、流停滞观察 3 条另行记录，不混入兼容计数。

正常样本中三协议均能流式显示中文和 emoji、处理字节分片、执行合法工具并回传正确调用 ID、在取消后保留已显示部分并阻止完成事件。Pi 还正确提供样本中的输入 11 / 输出 5 / 总计 16 token；当前 Her ProviderEvent 没有暴露 usage。这是可用的新能力，真实服务缺失用量时如何记账仍未验证。

## 影响正式接入的差异

| 差异 | 实际观测 | 对 Her 的影响 |
|---|---|---|
| 不合法工具 JSON 被修复 | `{"ok":trueoops}` 可变成 `{ok:true}`，`{"ok":` 可变成 `{}`；同批合法+坏参数也会释放两个工具事件 | Her 当前严格拒绝整个批次。仅在 Pi 已解析对象上检查类型不够；即使补 schema 校验，也无法识别“已被修成合法对象”的原始坏 JSON |
| 终止条件宽松 | Chat 无 `[DONE]` 仍成功；Anthropic 缺开始/块结束事件的部分样本仍成功 | 不完整流可能被视为完成。必须保留 Her 的终止确认规则 |
| Responses 的最终输出差异 | 仅在 `response.completed.output` 中出现的工具调用被丢失；`queued` 或缺少 status 的完成事件被接受 | 现有 Her 支持/拒绝的情况与 Pi 不同，需要显式兼容 |
| Anthropic API 基址 | Her `/proxy/v1` 对应 `/proxy/v1/messages`，薄适配 Pi 请求 `/proxy/v1/v1/messages` | 可通过专门的 URL 适配处理，不能原样传入当前保存的基址 |
| 无密钥服务 | 三协议 `apiKey=''` 在发送前失败；仅提供自定义网关认证头也失败 | 会影响无鉴权本地模型和只使用自定义请求头的网关。需明确认证适配，不应借用进程中的其他密钥 |
| 输出上限 | Responses 配置 7 token，实际请求 16 | 精确预算/用户配置不能假定直接等价。大上限样本通过 |
| 响应类型 | 三协议在返回 JSON Content-Type、正文却为 SSE 的样本上仍成功 | Her 当前拒绝，正式接入应检查 Content-Type |
| 重定向 | 本地同源 307 样本中 Her 拒绝，Pi 跟随并完成 | 需要明确保留 Her 的 redirect 策略；本轮没有测跨域凭据转发，不能据此声称已泄漏真实凭据 |
| 错误信息 | 合成 `synthetic_secret_marker` 出现在 SDK 最终错误及薄适配器异常中，Her 会遮蔽 | 需要保留中文安全错误映射，不能直接显示 SDK 原始异常 |
| 响应体读取超时 | Pi 配置 `timeoutMs=100`，响应头与首段文本立即到达后停滞，250ms 后仍未结束，需要外部 abort | SDK 请求超时不能替代 Her 的逐次读取超时。本轮没有真的等待 Her 的 60000ms 超时 |

另外还有 3 条查询参数/fragment 基址拼接差异；当前 `ProfileService` 已禁止保存这类 URL，所以它们属于底层接口观察，不列为当前用户可达的接入阻塞项。

实验没有加入原始 SSE 再解析、URL 修补或占位 API key，避免用补偿代码掩盖 Pi 本身与 Her 的契约差异。`contextWindow=2000000`、`maxTokens=262144` 和零价格是实验合成模型元数据，不能直接复制为生产模型目录。

## Electron 与体积

本机环境为 macOS arm64，Electron 44.7.0，内置 Node 24.21.0 / ICU 78.2 / SQLite 3.53.4。系统测试 Node 为 24.14.0。具体版本见原始运行结果。

真实 `.app` 通过正常 Electron 主进程启动，原 Her 页面 `her://app/index.html` 加载完成；打包后使用内部依赖完成 9 项探针。未签名、未公证、未发布，并关闭了 Packager 自动修改框架完整性摘要及对应 ad-hoc 重签步骤。本轮不证明商用发布流程。

默认外置依赖方案包含完整 Pi 生产依赖闭包，约 **67.4 MiB 逻辑文件字节，86 个依赖条目**。这与按 provider 子路径导入、减少实际加载量不是一回事。主进程构建增量包含实验探针和样本服务，不能当作纯 Pi 代码体积；完整 `.app` 又包含 Electron，不能当作 Pi 的增量。准确字节和路径保存在 `results/packaging-results.json`。

只做了单次运行诊断，没有进行严格冷启动、内存或跨平台性能基准；不根据某次启动更快/更慢作性能结论。

## 选型建议与后续门槛

**这轮先不正式引入。** 当前只维护三种协议时，Pi 的供应商扩展和 usage 优势，还不足以抵消兼容层、额外依赖和回归验证成本。已经确定的 Intl + FTS5、三层记忆、独立整理模型和空闲调度方案不依赖 Pi，可以继续推进。

若后续确实需要更多供应商或更复杂的 Agent 执行能力，再以这套实验作为接入基线，至少先完成：

1. 认证与 URL 适配，以及输出上限的明确映射。
2. 原始工具 JSON / 终止事件校验和 Responses 最终输出处理，保证不提前执行工具。
3. 响应类型、重定向、读取超时、错误信息和重试用量的统一约束。
4. 真实供应商服务验收、取消后迟到事件竞态、429/5xx 重试与 usage 缺失策略。
5. 生产模型元数据与密钥绑定、依赖裁剪评估和签名发行包验收。

本轮已设置 `maxRetries: 0`，但没有专门运行 429/5xx 重试样本；未使用真实密钥；未验证 Windows/Linux、Intel Mac、签名、公证或自动更新。当前结果仅覆盖固定版本和上述本地样本。
