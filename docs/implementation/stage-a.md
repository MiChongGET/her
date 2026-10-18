# Her Stage A 实施与验收说明

日期：2026-10-13。

Stage A 已实现可运行的 Electron + React Mac 桌面文字应用、自定义 OpenAI / Anthropic 兼容服务、流式聊天和本地历史恢复。它是[完整设计](../superpowers/specs/2026-10-13-her-design.md)中的第一阶段；完整第一版仍需后续阶段。安装与首次配置见 [README](../../README.md)，任务拆分见[Stage A 计划](../superpowers/plans/2026-10-13-her-stage-a.md)。

## 已实现范围

| 模块 | 当前行为 | 主要代码 |
| --- | --- | --- |
| 桌面入口 | 主窗口、菜单栏、关闭隐藏、显式退出、单实例唤出、可配置快捷键、登录自启设置及安装版限制 | `src/main/index.ts` |
| 进程边界 | 隔离与沙箱；只开放固定 preload 接口，主进程检查窗口、主 frame、页面来源及输入 | `src/main/ipc.ts`、`src/main/ipc-policy.ts`、`src/preload/index.ts` |
| 服务配置 | 名称、协议、API 基址、模型、密钥和额外请求头；公共配置只返回凭据存在标记 | `src/core/storage/profiles.ts` |
| 凭据保护 | 主进程通过 Electron `safeStorage` 保护密钥与请求头，保护失败不降级明文 | `src/main/credentials.ts` |
| 协议适配 | OpenAI Chat Completions / Anthropic Messages，统一文字、完整工具请求和终止事件 | `src/core/providers/stream.ts`、`src/core/providers/sse.ts` |
| 能力测试 | 文字与工具分别检测，工具测试只校验 `report_connection` 请求 | `src/core/providers/probe.ts` |
| 文字会话 | 流式文字、停止、错误提示、失败重试、模型切换、对话隔离、Markdown 展示 | `src/core/conversation/chat.ts`、`src/renderer/src/App.tsx` |
| 对话管理 | 重命名（最长 80 个字符，自定义标题不再被首条消息覆盖）；删除先进回收站，可恢复或二次确认后永久删除；生成中的对话不能删除 | `src/core/storage/store.ts`、`src/core/conversation/chat.ts`、`src/renderer/src/App.tsx`、`src/renderer/src/TrashPanel.tsx` |
| 本地持久化 | SQLite 保存服务配置、设置、会话、消息及部分生成内容；启动时标记未完成回答 | `src/core/storage/store.ts` |

本阶段不包含语音、长期记忆、关系摘要、临时会话、资料授权和读取、办事工具、笔记、提醒、主动联系、虚拟世界、导出恢复或签名安装包。界面中的工具能力测试不表示已接入这些业务工具。

## 服务配置契约

Base URL 去掉末尾斜杠后，OpenAI 兼容追加 `/chat/completions`，Anthropic 追加 `/messages`，OpenAI Responses 追加 `/responses`。代码不自动增加 `/v1`。例如 `https://example.com/proxy/v1/` 分别请求 `/proxy/v1/chat/completions`、`/proxy/v1/messages` 或 `/proxy/v1/responses`；完整接口地址不能直接作为 Base URL，否则会导致路径重复（如 `/proxy/v1/responses/responses`），正确填法是填到 `/v1` 即可。

- 基址限 HTTP / HTTPS；拒绝 URL 用户名、密码、查询参数及片段。
- OpenAI 兼容与 OpenAI Responses 默认使用 Bearer API Key；Anthropic 使用 `x-api-key` 和 `anthropic-version: 2023-06-01`。
- 额外请求头必须是字符串键值对象,可覆盖同名默认头；拒绝换行及 `Host`、`Content-Length`、`Connection`、`Transfer-Encoding` 等头。
- 一个服务可以保存 1 到 20 个模型 ID（去空白后非空、不超过 2048 字符、不重复），其中一个是默认模型；地址、协议、密钥和请求头由所有模型共用。聊天窗口的”当前模型”下拉列出当前服务的全部模型，切换后的下一条消息使用所选模型；所选模型只是界面状态，不写入本地数据，新建对话、切换服务或重启后回到默认模型。
- Anthropic 服务可选填服务级”最大输出 token 数”（1 到 1000000 的整数），作为请求的 `max_tokens`；留空时使用默认值 262144。许多模型或网关的真实上限低于 262144，上游被拒绝（如 HTTP 400）时请填写较小的覆盖值。OpenAI 兼容与 OpenAI Responses 不保存该覆盖值。1000000 只是防止误输入的合理性上限，实际上限以上游服务为准。
- 每个模型有”1M”开关（三种协议都可用）：开启后该模型的请求带 1000000 的输出上限——Anthropic 与 OpenAI 兼容写 `max_tokens`，OpenAI Responses 写 `max_output_tokens`。Anthropic 的优先级是模型 1M 开关 > 服务级覆盖值 > 262144；未开启 1M 时，OpenAI 兼容与 Responses 的请求体不带任何输出上限字段。OpenAI 兼容用 `max_tokens` 而非 `max_completion_tokens`，官方 OpenAI 的 o 系列等新模型可能拒绝它。Her 不会自动添加 1M 所需的 beta 请求头，需要时请用”额外请求头”配置。
- OpenAI Responses 协议将系统提示词作为 `instructions` 字段、用户与助手消息数组作为 `input` 字段发送；不发送 `temperature`、`top_p` 等采样参数（当前实现保留默认行为）。未开启 1M 时不发送 `max_output_tokens`，开启后发送 1000000。流式解析读取每个事件数据里的 `type`（缺失时用 SSE 的 `event:` 行）：`response.output_text.delta` 的 `delta` 是文字；`response.completed` 必须带 `response` 对象，其中 `status` 为 `completed` 才算完成，工具调用取自 `response.output` 里顶层带 `call_id`、`name`、`arguments` 的 `function_call` 条目；`response.failed` 和 `error` 事件报通用的上游错误，不回显上游文字；推理相关等未识别的事件一律忽略。文字流式和 `response.failed` 已在真实服务（`spark-x2.6-preview`）上观察到；工具调用和 `response.incomplete` 尚未用真实服务验证。
- 本地数据库版本为 4（`user_version`）。启动时会按列是否存在自动为旧库补列（服务的模型列表，对话的自定义标题与删除时间），旧服务原有的单个模型成为唯一模型和默认模型，其连接测试结果一并归入，已有服务、对话和历史不变。升级后旧版本 Her 无法打开该数据库，升级前如需回退，请先手动备份 `her.sqlite`。
- 已保存密钥和请求头不返回界面；留空保留，输入新值替换，显式清除选项清除。
- 协议、基址或凭据变化会使该服务下所有模型的连接验证失效；新增模型从”未验证”开始，其余模型的结果保留；仅改默认模型、1M 开关或服务级覆盖值不会使验证失效。测试使用保存后的配置，按模型、文字和工具分别记录结果，设置面板在多个模型时可选择要测试的模型。
- 检测总超时为 20 秒；聊天等待响应头或下一批流数据的超时为 60 秒。错误信息不回显原始上游错误正文。
- 不跟随 HTTP 重定向，不自动切换其他模型服务。切换由用户选择，已经开始的回答保留自己的服务和模型归属。

## 历史与桌面状态

本地数据库使用 SQLite WAL 模式，位于 Electron `userData` 下的 `her.sqlite`；macOS 通常为 `~/Library/Application Support/Her`。桌面设置显示实际目录，也可在启动前通过 `HER_DATA_DIR` 指定独立目录。该变量供开发和测试隔离使用，不会自动复制或迁移原目录。

普通配置、会话和消息保存在未做整库加密的 SQLite 中；密钥及自定义请求头作为 `safeStorage` 加密内容保存。渲染进程只能拿到 `hasApiKey` / `hasCustomHeaders` 标记，不能读取已保存值。

每次请求传入当前对话近期至多 50 条、约 64000 字符的上下文；保存完整历史和将全部历史发给模型是两个不同范围。取消、流截断、输出长度上限、错误或退出都不能将半段回答标记为完成。重启恢复保存过的片段，并将遗留 `streaming` 消息标记为 `cancelled`。

删除对话只是把它移入回收站：消息完整保留，侧栏不再显示，也不能继续发送。回收站不会自动清空，对话会一直保留到用户永久删除。永久删除会在一个事务里删除该对话及其全部消息，不可撤销；它只是 SQLite 层面的 `DELETE`，没有执行 `VACUUM`，不承诺磁盘层面的安全擦除，数据库文件的空闲页里可能仍残留旧内容。

关闭窗口保留后台进程；菜单栏、Dock 激活和全局快捷键可以唤出。默认快捷键为 `CommandOrControl+Shift+H`，Mac 对应 `Command+Shift+H`；更换时验证是否可注册。显式“退出 Her”会中止当前请求并关闭数据库。

登录自启默认关闭，源码运行尝试启用时明确提示“需要安装版，当前源码运行暂不支持”。代码保留打包后的 Electron 接入，但 macOS 未打包、签名和公证时可能静默失败；安装版的系统验收仍待后续完成。[Electron 登录项文档](https://www.electronjs.org/docs/latest/api/app#appsetloginitemsettingssettings-macos-windows)

## 可重复验证

需要 macOS、Node.js 24 或更新版本，以及能够下载 npm 依赖和 Electron 的网络。项目目录运行：

```bash
npm install
npm run check
npm run test:e2e
```

`check` 依次运行类型检查、Vitest 测试和构建；`test:e2e` 重新构建，再用 Playwright 启动实际 Electron。只运行开发界面可使用 `npm run dev`；构建预览使用 `npm run build` 后的 `npm start`。

当前 Electron 版本首次运行会按需下载二进制。遇到网络故障时，可按照 [Electron 官方安装文档](https://www.electronjs.org/zh/docs/latest/tutorial/installation)使用其列出的第三方镜像，显式运行下载脚本；该命令已在本次开发环境中成功：

```bash
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" node node_modules/electron/install.js
```

这只调整本次 Electron 下载地址，正常首次运行无需换源；仅重跑 `npm install` 不保证触发当前版本的二进制下载。

### 当前验收记录

2026-10-13 最终复验：`npm run check && npm run test:e2e` 成功退出。**83 个核心/界面测试、3 个实际 Electron 端到端测试全部通过**，TypeScript 检查与 main/preload/renderer 构建通过。

独立审阅发现的整轮消息非原子写入、旧凭据无法清除/替换、重命名丢失并发测试结果、旧设置回包覆盖新配置，均已修复并补回归；还覆盖了关闭弹窗后后台提交同步，以及相同配置刷新不覆盖表单草稿。

| 验证层 | 覆盖内容 | 证据边界 |
| --- | --- | --- |
| 协议测试 | 三种协议（OpenAI 兼容、Anthropic、OpenAI Responses）的路径、鉴权、分包 UTF-8 / SSE、工具完整性、流截断、流内错误、HTTP 错误、重定向、取消及超时 | 使用确定性响应或独立本地 HTTP 服务；不证明第三方代理全部兼容 |
| 存储与配置测试 | 数据库重开恢复、中断状态、加密内容与公共 DTO、保留/清除/替换密钥、验证失效、并发测试与重命名、删除服务 | 加密测试使用测试用 codec；不等同于真实 macOS 钥匙串凭据验收 |
| 会话与界面测试 | 整轮写入回滚、上下文、取消、失败重试、模型归属、并发发送、IME、事件先于确认、历史加载重试、设置回包与草稿竞态 | 核心或 jsdom 确定性测试，不替代实际窗口验收 |
| Electron E2E 1 | 实际应用启动；两种 HTTP 协议配置及文字/工具测试；流式聊天、模型切换、取消、重启历史、preload 隔离、源码自启拒绝提示、关闭隐藏及重新显示 | 本地模拟服务；重新显示通过 `BrowserWindow.show()` 验证，没有模拟真实系统快捷键或菜单栏点击 |
| Electron E2E 2 | 实际应用中模型返回 HTTP 401；修改配置后重试，用户历史不重复 | 本地模拟错误和恢复，不使用用户真实第三方账户 |
| Electron E2E 3 | OpenAI Responses 协议的连接测试（文字与工具）、消息发送、请求格式验证（`instructions`、`input`、不含 `max_output_tokens` 等采样参数） | 本地模拟服务；不证明第三方 Responses 服务全部兼容 |
| 开发窗口实测 | 通过 CDP 验证开发模式下实际 Electron 页面载入与 reload，未出现 `pageerror`，CSP nonce 与 React Refresh 脚本一致 | 证明本机开发窗口可加载，不替代安装包及真实模型验收 |

E2E 启动 `tests/helpers/mock-provider.ts` 的独立本地 HTTP 模拟服务。每个场景使用 `mkdtemp` 创建的临时目录，并通过 `HER_DATA_DIR` 传给应用；测试结束关闭服务和 Electron，并清理临时资料。它不覆盖个人聊天数据库。

## 仍需实际验收

- 用户选择的真实第三方地址、模型和鉴权，以及该服务自己的文字和工具兼容程度。
- 真实 macOS 钥匙串的密钥写入、读取与应用重启后的恢复。现有 Electron E2E 使用无密钥的模拟端点。
- 完整设计要求提前验证的本机中文 ASR 可行性小样尚未进行；本轮按文字聊天范围实施，没有申请麦克风或录音权限。
- 系统层面的菜单栏点击、Dock 唤出、真实全局快捷键及冲突提示、登录自启和关闭自启；自动化覆盖代码与部分窗口行为，不宣称已完成这些系统交互的全部实测。
- 后续阶段的产品能力、签名与打包、连续日常使用验收。

本地 HTTP 模拟服务与实际 Electron 联通，证明应用链路可运行；它不证明用户真实模型账户、生产服务、费用或系统级权限已通过验收。
