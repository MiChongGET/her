# Design

## Context

动机见 proposal.md 的 Why；产品决策 Q1–Q16 与完整方案见 `docs/superpowers/specs/2026-10-19-her-pi-adapter-design.md`（下称“方案”）与 ADR-0001～0006。

当前实现中与本设计相关的事实（已读源码确认）：

- `src/core/conversation/chat.ts`：`ChatService` 持有单个 `active?: ActiveRequest`，第 94 行在已有活跃请求时拒绝发送；第 300 行按 50 条 / 64,000 字符截断历史；模型/工具往返由 `generate()` 驱动，调用 `src/core/providers/stream.ts` 的 `streamChat`。
- `src/core/storage/store.ts`：`node:sqlite` 的 `DatabaseSync`，表包括 profiles、settings、conversations、messages、task_runs、tool_executions（含 `dispatch_phase`、启动时 running→unknown）、tool_resolutions、file_grants、file_references、documents、document_owners、artifact_owners、tool_artifacts、mcp_services。
- `src/core/storage/profiles.ts`：`SecretCodec` 由 `src/main/credentials.ts` 用 Electron `safeStorage` 异步加解密；协议限 openai / anthropic / openai-responses。
- `src/core/mcp/manager.ts`：`McpConnectionManager` 以 serviceId 为键的全局连接 Map，所有会话共享同一连接。
- `src/main/index.ts`：数据目录为 `userData`（可被 `HER_DATA_DIR` 覆盖），`her.sqlite` 位于其下；已有单实例锁与 `second-instance` 聚焦；窗口 `close` 时隐藏而非退出；`src/main/shutdown.ts` 提供统一 5 秒退出期限。
- IPC 现有 `her:message-send / her:message-cancel / her:task-get / her:task-continue / her:task-approval / her:task-resolve-unknown / her:conversation-trash / her:conversation-purge` 等通道（实际为 `her:xxx-yyy` 形式，与 AGENTS.md 所写 `conversation:create` 示例不同）；新通道沿用代码中的实际形式。
- `experiments/pi-ai-compat/REPORT.md`：pi-ai 1.2.0 在 Electron 44（内置 Node 24.21）主进程和 `.app + asar` 中可运行；同时记录了宽松 JSON 修复、不完整流被视为完成、`apiKey=''` 发送前失败、Anthropic 基址重复 `/v1`、错误含密钥标记、读取超时不足等差异。这些是 1.2.0 的风险样本，1.3.0 需重新验证。

约束：Electron 44 / Node 24、TypeScript strict、vitest、electron-vite、`@electron/packager`；依赖使用精确版本。

## Goals / Non-Goals

**Goals:**
- 每个会话一个 Pi `AgentSession`，Her 只做宿主：接纳、队列、授权、资源、账本、投影、生命周期。
- 一切外部副作用只能通过 Her 工具执行门发生。
- 每个阶段都有可运行的隔离验证；SDK 能力未经验证前不进入正式路径。

**Non-Goals:**
- 不构建通用调度框架、插件系统或可配置调参界面。
- 不提供旧/新底座运行时开关；不迁移旧数据。
- 不做每任务独立 OS 进程，不承诺进程崩溃时的隔离。
- 不重做视觉设计，只增加必要状态与入口。

## Decisions

### D1. 嵌入主进程，显式注入全部依赖

在 Electron 主进程内直接调用 `createAgentSession`，为每个会话注入：Her 管理的 `agentDir`（`Her-Pi-v1/pi/`）、受控 `cwd`（`pi/workspaces/<conversationId>`）、只返回 Her 系统提示的 `ResourceLoader`、带 Her `CredentialStore` 的 `ModelRuntime`、内存/受控 `SettingsManager`、`SessionManager.create/open`（目录 `pi/sessions/`），`customTools` 为 Her 工具适配结果，并设置 `noTools: "builtin"`。会话创建后读取实际工具列表，与快照白名单比对，不一致即拒绝启动任务。

- 备选：Pi 作为子进程（RPC 模式）。隔离更好，但事件、凭据和工具门要跨进程再实现一遍，首期否决（方案 §3）。
- 备选：只用 pi-ai 做协议层、保留 Her 循环。无法获得 Pi 压缩和会话重建，与 Q1 冲突。

### D2. 新增 `src/core/agent/`：工厂 + 会话句柄

- `factory.ts`：唯一创建 `AgentSession` 的入口，集中受控注入与白名单校验。
- `handle.ts`：`ConversationHandle`，按 conversationId 持有 session、`generation`、当前 `runId`、AbortController、事件订阅、配置快照、MCP 客户端引用；所有事件附带 `{conversationId, runId, seq}`，seq 单调递增，generation 或 runId 不符的事件丢弃。
- `host.ts`：`AgentHost`，`Map<conversationId, ConversationHandle>`，懒创建、空闲可释放；对外提供 send/enqueue/cancelQueued/stop/continue/compact/switchModel/getState。
- `events.ts`：把 Pi 事件（`message_*`、`tool_*`、`compaction_*`、`entry_appended`、`agent_settled` 等）映射为 Her `TaskEvent`，并做错误脱敏。

`ChatService` 收缩为 IPC 门面并委托 `AgentHost`；删除 `active` 单例、`generate()`、历史截断。

### D3. 任务结束判定与持久队列

任务结束需同时满足：`session.prompt()` 的 Promise settle、收到 `agent_settled`、Her 侧没有在途工具派发。只有 `completed` 才从 SQLite `input_queue` 取下一条（按 `seq`，状态 `pending→dispatched` 用单条 UPDATE 条件更新保证只取一次），为其创建新 `task_run` 并调用同一 session 的 `prompt()`。不使用 Pi 内部 follow-up 队列，避免同一消息两个队列竞争（方案 §7）。其余终态把会话队列置为 `paused`。

### D4. 工具执行门与适配

`src/core/tools/gate.ts` 把现有 `ToolRegistry` 中每个工具包装为 Pi custom tool（TypeBox schema 由现有 JSON schema 转换，保留严格校验：Pi 修复后的参数仍按 Her schema 重新校验）。`execute()` 中依次：校验 → 授权/目标隔离检查 → 审批（复用 `ToolApprovalService`，键改为 `runId+callId+toolVersion+argsHash+target`）→ `ResourceQueue.acquire(keys, signal)` → 重新预检（授权、配置版本、generation、桌面重新观察）→ 写 `tool_executions` 为 `dispatched` → 调用 → 写结果 → 释放资源。账本写失败直接抛错不执行。

- `resources.ts`：小型资源锁。键：`desktop`（焦点/键鼠/剪贴板）、`write:<规范化路径或目标>`、`mcp:<serviceId>`（作用域未知的有状态服务）。多键按字典序获取；FIFO；signal 中止即出队；`finally` 释放。不做读写锁之外的复杂调度。
- 未知动作：沿用 `tool_executions.status='unknown'` 与 `tool_resolutions`，新增 `target_quarantine` 表（target key、来源 call、不含正文），执行门在授权检查时查询，跨会话与重启生效。

### D5. MCP 连接按会话

`McpConnectionManager` 的键从 `serviceId` 改为 `(conversationId, serviceId)` 用于有状态服务（Peekaboo、Playwright 浏览器）；无状态服务（如 web-search）可共享传输，但每次调用使用独立 AbortSignal，取消只中止该调用的请求，不调用 `disconnect`。会话句柄释放或进入回收站时关闭其专属连接。

### D6. 资料布局与存储分工

`main/index.ts` 统一调用 `dataPaths(app.getPath('userData'))`，根目录为 `<userData>/Her-Pi-v1/`（`HER_DATA_DIR` 覆盖 userData，用于隔离测试），布局见方案 §6。新建 `her.sqlite` schema（v1，不含旧迁移代码）：profiles、settings、conversations（含 trash/tombstone 状态）、input_queue、task_runs、tool_executions、tool_resolutions、target_quarantine、file_grants、file_references、artifacts/owners、documents/owners、mcp_services、projection（entry_id 主键、conversation_id、kind、payload、projection_version）、drafts（中断片段）、purge_jobs。

- 会话历史只经 `SessionManager` 解释和写入，不手工改写 JSONL。打开前允许 Her 只读检查原始行与 Pi 公开 `parseSessionEntries` 的结果数量，发现坏行即拒绝打开，并在 `pi/quarantine/<conversationId>` 留下隔离标记；用户恢复有效文件后重新校验并解除隔离（用户于 2026-10-20 确认）。
- 关联：任务开始时用 `appendCustomEntry` 写入 `{type:'her.run', runId, requestId}`（不进入模型上下文），恢复时据此把 Pi 条目对齐到 `task_run`。
- 投影：在 `turn_end`、`agent_settled` 和启动时从 `SessionManager.getEntries()` 按顺序拉取，以 entry ID 幂等 upsert，比较投影游标补齐缺失。1.3.0 实测普通消息在 `message_end` 监听器之后才 `appendMessage()` 且不派发 `entry_appended`（见 `experiments/pi-sdk-1.3.0/REPORT.md`），所以不依赖该事件。流式中的文本只进 drafts。排序使用条目在 SessionManager 中的顺序，不用随机 ID。
- 恢复：`task_runs` 中非终态 → `interrupted`；`input_queue` 中 `dispatched` 但无对应 `her.run` 条目 → 回到 `pending` 并置队列 `paused`；`tool_executions` running/dispatched → `unknown` 并写隔离。
- 旧 `store.ts` 中旧版 schema 迁移代码与旧 messages 表随之删除。

### D7. 凭据

`CredentialStore` 实现由主进程提供：按 Her profileId 存取，值为 `safeStorage` 加密后的 BLOB（复用 `SecretCodec`）。认证方式 `api-key | headers | none` 存在 profile 上。每个 profile 注册为独立 provider ID（`her-<profileId>`），避免同供应商共用槽位；对非 `her-` 前缀 id 一律返回 `undefined`。

无密钥与仅请求头（1.4 实测 1.3.0 无公开的无凭据路径，用户 2026-10-19 选定方案）：`CredentialStore` 对这类 profile 在内存中返回每进程随机生成的内部值，不落盘；该 provider 以 `streamSimple` 包装注入 Her 的 `fetch`，发出前删除值等于该内部值的 `Authorization` / `x-api-key` 头。同一个 `fetch` 包装统一设置 `redirect: 'error'`，所有 profile 都经过它。事件与错误脱敏同时屏蔽该内部值。

### D8. 压缩

开启 Pi 自动压缩；`reserveTokens` 与 `keepRecentTokens` 按模型窗口计算：`reserve = min(默认值, floor(window*0.25))`，`keepRecent` 同理按比例收缩，保证二者之和小于窗口（具体系数在容量测试后定稿）。手动压缩调用 `session.compact()`，停止调用 `abortCompaction()`。压缩失败：会话队列 `paused`，任务 `failed` 并带 `compaction_failed` 原因。超大单条：发送前估算，单条 + 系统提示 + 工具定义 + 预留已超窗口则直接失败并提示。

### D9. 来源与撤权

附件发送前和工具读取前重新校验 grant/文件存在/mtime+size+hash。派生依赖存 `provenance(entry_id, source_key, source_version)`。撤权时：停止引用该来源的在途任务；通过 Pi 公开的上下文转换/压缩入口（`transformContext` 类钩子或 extension context 事件，阶段 1 验证可用项）在每次请求和压缩前过滤依赖失效来源的条目。若公开入口无法覆盖全部发送路径，作为阻塞问题上报，不 fork。

### D10. 生命周期与删除

- 关闭窗口：保持现有隐藏行为（已满足后台继续）。
- 退出：`createShutdown` 的 `stop()` 改为 `AgentHost.stopAll()`（阻止新任务 → 并发 stop 每个句柄），`drain()` 等待全部句柄终态和账本落盘；超时只强杀 Her 启动的子进程。
- 回收站：`conversations.state='trashed'` → 句柄 generation+1 → stop → 队列 paused → 释放句柄与专属 MCP 连接。
- 永久删除：写 `purge_jobs` 墓碑 → 关闭句柄 → 删除 Pi 会话文件（经 SessionManager 已知路径）→ 删除投影/草稿/队列/缓存 → 附件引用计数归零才删 → 完成后删墓碑。失败保留墓碑与原因，回收站显示重试。用户于 2026-10-20 确认允许给现有 Her-Pi-v1 增加 `purge_jobs` 表，不迁移旧版资料；启动时只恢复已获用户批准的清理任务。会话扫描与投影重建跳过有墓碑的 ID。

### D11. 删除旧协议层的时点

`src/core/providers/` 中 `stream.ts`、`sse.ts`、`message-format.ts` 在新路径完整验收后删除。连接测试（`probe.ts`）改为用 Pi ModelRuntime 发一次最小请求，旧实现同时删除。

## Risks / Trade-offs

- [Pi 1.3.0 行为与声明不符（落盘顺序、并发隔离、隐式全局 provider 状态）] → 阶段 1 先在隔离脚本与 Electron 中验证；关键能力缺失则暂停并重新呈现取舍，不 fork。
- [Pi 宽松修复坏工具 JSON] → 执行门按 Her schema 二次校验；无法识别“被修好的”坏 JSON 的情况作为已知限制记录。
- [不完整流被视为完成] → 阶段 1 用模拟服务复现 1.3.0 行为；若仍存在，在 Her 事件适配层以 `stopReason` 等公开字段判断并标记失败。
- [Pi 文件与 SQLite 无共同原子性] → `her.run` 关联条目 + 启动对账；只补投影，不补执行。
- [同进程多会话，单会话异常拖垮全应用] → 任务边界 try/catch；进程级崩溃靠重启恢复，接受该限制。
- [native 依赖 photon-node 打包失败] → 阶段 1 即做打包验证；若仅图片处理依赖它且失败，作为阻塞上报。
- [体积约 +67 MiB（1.2.0 测得）] → 接受；不做裁剪优化。
- [在途 change 与本 change 冲突] → 本 change 不修改它们的文件；归档前由用户决定这些 change 的去留。

## Migration Plan

阶段顺序与方案 §14 一致，每阶段结束 `npm run check` 通过：

1. 锁定依赖与隔离验证（不接入正式路径）。
2. 新资料目录、新 schema、会话权威与投影。
3. Agent 宿主、工具执行门、资源队列、MCP 按会话、并发隔离。
4. 队列、压缩、模型接入与切换、来源过滤。
5. UI、回收站/永久删除、生命周期。
6. 删除旧循环与旧协议层，完整验收与打包。

回滚：阶段 6 之前旧代码仍在仓库中，可回退提交；发布后新版不读旧目录，回退到旧版本即使用旧资料。新版资料不交给旧版。

## Open Questions

- `reserveTokens` / `keepRecentTokens` 的最终比例系数：容量测试后确定，不影响任务划分。
- 用于来源过滤的具体 Pi 钩子名称：阶段 1 验证；若不存在则按 D9 上报阻塞。
