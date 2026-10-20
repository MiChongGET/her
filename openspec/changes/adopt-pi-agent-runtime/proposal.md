# Proposal

## Why

Her 现在用自写的模型/工具循环。为控制上下文，每次请求只取最近 50 条或 64,000 字符的历史，并且全局同时只允许一个回答在生成。会话越聊越长，旧内容就被静默截掉；多个任务也不能并行。ADR-0001～0006 已确认改用 Pi 完整会话 SDK 作为 Agent 底座：由 Pi 接管模型调用、Agent 循环、上下文重建和压缩，Her 保留工具授权、任务协调和产品数据。完整方案见 `docs/superpowers/specs/2026-10-19-her-pi-adapter-design.md`。

## What Changes

- 引入固定版本的 `@earendil-works/pi-coding-agent` 1.3.0（含 pi-agent-core、pi-ai），在 Electron 主进程中显式注入 agentDir、cwd、ResourceLoader、ModelRuntime、SettingsManager、SessionManager 和 customTools。禁用 Pi 内置工具、默认 MCP 扩展，以及对用户目录的各类扫描。
- 每个会话持有独立的 AgentSession。不同会话可以并行，同一会话同时只运行一个任务。**BREAKING**：取消全局单活跃请求限制。
- **BREAKING**：删除 ChatService 中的模型/工具往返循环和固定 50 条 / 64,000 字符的截断，上下文改由 Pi 自动压缩和手动压缩管理。
- 新增按会话持久保存的消息队列：任务运行中提交的消息进入队列，可查看、可撤销，任务正常结束后依次处理。停止、出错和重启后不自动执行。
- 工具改为 Pi custom tools，统一走 Her 的执行门：校验 → 授权 → 审批 → 资源等待 → 重新预检 → 记录派发 → 执行。只有发生冲突的资源步骤排队（桌面、同一写入目标），结果未知的动作会隔离对应目标。
- 模型接入改为 Pi 模型目录加自定义兼容服务，支持 API Key、自定义请求头和显式无密钥模式；凭据由主进程加密保存，通过 Her CredentialStore 提供给 Pi。不做 OAuth。
- **BREAKING**：资料改放到独立目录 `Her-Pi-v1/`。旧聊天、服务配置、API Key、MCP 配置和任务都不迁移，旧目录不读取也不删除。Pi 会话条目是运行历史的权威记录，SQLite 存产品数据和可重建的展示投影。
- 任务状态细化为 queued / running / waiting_approval / waiting_resource / compacting / retrying / stopping / completed / stopped / failed / interrupted，界面相应展示队列、审批、资源等待、压缩、失败和中断。
- 关闭窗口时任务在后台继续，真正退出时停止全部任务，重启后只恢复记录、不自动续跑。回收站会停止相关任务；永久删除通过持久清理任务协调多个存储。
- 附件和派生内容记录来源依赖。撤权或来源失效后，相关材料和摘要不再进入普通请求、压缩请求或恢复请求。
- 新路径验收后删除 `src/core/providers/` 中不再使用的协议实现，不保留双底座开关。

不在本期范围：跨会话长期记忆、Graphiti、OAuth、分支树编辑 UI、独立虚拟桌面、每任务独立 OS 进程、通用扩展市场。

## Capabilities

### New Capabilities
- `agent-runtime`：Pi SDK 的受控初始化、按会话的 AgentSession 句柄、并行会话隔离、模型请求重试，以及会话空闲时切换模型。
- `model-access`：Pi 模型目录与自定义兼容服务，认证方式（API Key / 请求头 / 无密钥）、凭据加密与隔离、按任务冻结配置及撤权。
- `task-runs`：任务身份与状态、按会话的持久消息队列、停止与继续、窗口关闭与应用退出、重启恢复。
- `context-compaction`：自动和手动压缩、容量预算、压缩失败处理、超大单条请求的明确结果、原始记录保留。
- `tool-authorization`：Her 工具执行门、审批绑定、资源冲突排队、桌面重新观察、动作账本、未知动作与目标隔离。
- `session-data`：独立资料目录、Pi 会话条目与 SQLite 的权威分工、展示投影、多存储恢复、单写入者保护。
- `conversation-trash`：新底座下的回收站、恢复和永久删除，包括持久清理、删除墓碑和共享附件的引用计数。
- `attachment-provenance`：附件与派生内容的来源依赖、发送前复核、撤权后从请求、压缩和恢复路径中排除。

### Modified Capabilities
- `chat-message-layout`：“消息状态显示在气泡内”加入排队中、等待审批、资源等待、压缩中和中断片段等新状态。“已停止”和“失败”的触发条件改由任务状态决定，不再沿用旧循环的条件。

## Impact

- 依赖：新增 `@earendil-works/pi-coding-agent@1.3.0`（精确版本，含传递依赖和 native 包 `@silvia-odwyer/photon-node`），要求 Node >=22.19.0。Electron 44 内置的 Node 24.21 满足要求。需要验证 electron-vite 构建和打包。
- 代码：
  - 新增 `src/core/agent/`。
  - 重写 `src/core/conversation/chat.ts`（宿主入口）和 `src/core/storage/store.ts`（新 schema 和投影）。
  - 调整 `src/core/tools/`（执行门、账本、资源队列）和 `src/core/mcp/manager.ts`（按会话的客户端）。
  - 修改 `src/main/index.ts`（数据目录、生命周期）、`src/main/ipc.ts`、`src/preload/index.ts`、`src/shared/types.ts`（新的 IPC 和事件类型）。
  - 修改 `src/renderer/src/App.tsx`、`TaskStatus.tsx`、`TrashPanel.tsx`、`SettingsPanel.tsx`。
  - 删除 `src/core/providers/` 中的旧协议层。
- 数据：用户升级后看到空白的新资料空间，需要重新配置服务。旧目录保留。
- 测试：现有 `tests/chat.test.ts`、`providers.test.ts`、`storage.test.ts` 等需要按新底座重写，另新增并发、队列、压缩、恢复、清理和打包验收。
- 与在途 change 的关系：`tool-execution-capability`、`agent-memory-tools`、`multi-model-per-service` 和 `conversation-rename-and-trash` 都基于旧循环和旧数据结构。本 change 落地后需要重新评估：tool-execution 的执行生命周期由本 change 的 `tool-authorization` 取代；记忆功能按 Q4 留到后续另行设计。
