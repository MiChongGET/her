# Her Tools V1 Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立能够承接真实外部动作的工具执行、MCP、配置和界面基础。

**Architecture:** 扩展现有 ChatService 和 registry，单独持久化任务/调用状态，主进程管理连接与凭据。协议转换独立于 SSE 解析，React 仅通过 HerApi 访问业务能力。

**Tech Stack:** TypeScript、Electron、SQLite、MCP TypeScript SDK、JSON Schema 校验器、Vitest、React Testing Library。

**Spec:** [定稿设计](../specs/2026-10-15-her-tools-v1.md)；[共享契约与依赖](2026-10-15-her-tools-v1.md)。

## Global Constraints

- 全局 1 个任务；任务内工具串行。
- 桌面、浏览器和文档任务沿用当前聊天模型；能力不足时提示用户切换，不自动更换端点。
- 主进程加密保存；空字段保留，显式清除；配置 revision 变化后旧测试结果和旧确认失效。
- 默认值逐项采用设计第九节；不自行初始化 Git 或提交。现有 SQLite user_version 为 4，消息状态有 CHECK 约束。

## Review Focus

- 动作派发前记录失败：不得继续执行；归 T01/T03。
- 三协议混合文本/图片/工具调用，旧图片格式：保持顺序与调用对应；归 T02。
- 确认迟到、配置停用、同时取消：不能越过当前状态；归 T03/T06。
- GUI 环境找不到命令、stdout 污染或鉴权失败：显示诊断，不无限重试；归 T05。
- IPC 调试日志、晚到数据库写入及退出进程所有权：不泄露内容或关闭用户 Chrome；归 T04/T06。

## T01：统一结果、图片引用和执行记录

**Files:** Modify `src/shared/types.ts`, `src/core/tools/types.ts`, `src/core/tools/registry.ts`, `src/core/tools/result-format.ts`, `src/core/conversation/chat.ts`, `src/core/storage/store.ts`; Create `src/core/tools/results.ts`, `src/core/tools/artifacts.ts`; Test `tests/tool-results.test.ts`, `tests/storage.test.ts`, `tests/tools.test.ts`, `tests/chat.test.ts`。

**Interfaces:** 定义总览中的 ToolResult/ToolContent/ToolMessage/ArtifactReference/TaskRun/ToolCallRecord/ToolExecutionContext。导出 `normalizeToolResult(value: string | ToolResult): ToolResult`、`ToolArtifactStore.put(bytes: Uint8Array, owner: {conversationId: string; sourceFileId?: string}, mimeType: string): Promise<ArtifactReference>`、`read(id: string, context: ToolExecutionContext): Promise<Uint8Array>`。Store 提供 `saveTaskRun(run: TaskRun): void`、`getTaskRun(id: string): TaskRun | null`、`saveToolCall(record: ToolCallRecord): void`、`listToolCalls(runId: string): ToolCallRecord[]`；批准字段在 T03 加入。

- [x] 写 `legacy_tool_result_and_v4_database_remain_readable`：载入 v4 fixture，旧 result 规范化为 text，既有附件/消息不丢；写 `image_history_uses_artifact_reference`：聊天 JSON 无原图，缺失文件可明确报错；写 `foreign_conversation_cannot_read_artifact`。
- [x] 运行 `npm test -- tests/tool-results.test.ts tests/storage.test.ts tests/tools.test.ts`，确认新契约断言失败。
- [x] 实现结果规范化与应用自管图片目录；保留 text/image/resource_link、structuredContent、isError、meta、truncated；未知块明确记录不支持。限制采用设计值，不把错误当成功文字。
- [x] 用事务新增 task_runs/tool_executions 及图片引用元数据；保持 messages 四种状态和旧记录兼容，所有受影响 INSERT 使用显式列名。重开时将未完成任务置 stopped，已 running 的调用置 unknown，不重放。
- [x] 迁移 registry、时间工具和现有聊天调用到新 context/result 接口，原文字行为保持；任务记录在执行前落盘。T02 完成前仅允许文字结果进入旧 provider 格式化路径。sourceFileId 校验在 T09 接入，未接入时拒绝读取含 sourceFileId 的 artifact，不允许默认放行。
- [x] 运行 `npm test -- tests/tool-results.test.ts tests/storage.test.ts tests/tools.test.ts tests/chat.test.ts` 和 `npm run typecheck`；Expected：旧功能和迁移断言通过，记录受影响文件。

## T02：三协议图片与工具结果序列化

**Files:** Create `src/core/providers/message-format.ts`; Modify `src/core/providers/stream.ts`, `src/core/providers/probe.ts`, `src/core/storage/profiles.ts`, `src/shared/types.ts`, `src/core/tools/result-format.ts`; Test `tests/providers.test.ts`, `tests/profiles.test.ts`。

**Interfaces:** 消费 T01 的 ToolResult 与 ArtifactReference。导出 `formatModelMessages(protocol: ProviderProtocol, messages: AnyModelMessage[], loadImage: (id: string) => Promise<Uint8Array>): Promise<unknown[]>`，仅主进程调用；TestKind 增加 vision，沿用 `testConnection(profiles, id, kind, stream?, model?)`。

- [x] 给三个协议各写请求体断言：`user_image_is_protocol_native`、`tool_image_is_model_visible`、`multiple_calls_keep_ids_and_order`、`tool_error_is_not_success`；断言请求的合法图像块及媒体类型，不只检查内部 base64。
- [x] 运行 `npm test -- tests/providers.test.ts tests/profiles.test.ts`，确认新图像/vision 测试失败。
- [x] 按各协议官方合同转换用户图片和工具图片；协议不允许 tool role 携带图片时，在合法视觉消息位置附图并明确关联原 call ID。保留 stream.ts 的解析逻辑，不能直接透传统一内部 source 对象。
- [x] 仅把操作必需的 snapshot/coordinate_context 转成模型可见文字；私有 meta 不全量上送。图片载入失败返回明确错误，不伪称看过。
- [x] 增加固定小图片的 vision 检测及可解释失败结果；旧模型 tests 补 untested，不要求用户重新保存配置。配置 revision 变化后旧测试结果不落库；不自动切模型或服务。
- [x] 运行上述目标测试与 `npm run typecheck`；Expected：三协议请求体、原 SSE/取消和旧 profile 兼容通过。真实视觉效果留 T13，不以 mock 断言代替。

## T03：任务循环、确认、停止与继续

**Files:** Create `src/core/tools/execution.ts`, `src/core/tools/approval.ts`; Modify `src/core/conversation/chat.ts`, `src/core/tools/registry.ts`, `src/core/tools/types.ts`, `src/shared/types.ts`, `src/core/storage/store.ts`; Test `tests/tool-execution.test.ts`, `tests/tool-approval.test.ts`, `tests/chat.test.ts`。

**Interfaces:** 定义 ActionAssessment/ApprovalRequest/TaskEvent/ContinueTaskInput。`ToolApprovalService.authorize(callId: string, assessment: ActionAssessment, context: ToolExecutionContext): Promise<void>`、`decide(input: ApprovalDecisionInput): void`；`ChatService.continueTask(input: ContinueTaskInput): Promise<SendMessageResult>`。Registry 注册信息增加 `assess(args, context): Promise<ActionAssessment>`；只有授权完成才调用 executor。

- [x] 写 `approval_executes_once`、`stop_invalidates_late_approval`、`disabled_service_invalidates_approval`、`cancel_skips_remaining_calls`；确认 approve 两次仅派发一次，参数/版本变化必须失效。
- [x] 写 `unknown_mutation_is_observed_before_continue`：模拟已发送后断线，继续保留原轨迹且不重复发送；纯文字失败仍能按旧入口重试。写 `call_41_pauses` 和 fake-clock `active_time_excludes_confirmation_wait`。
- [x] 运行 `npm test -- tests/tool-execution.test.ts tests/tool-approval.test.ts tests/chat.test.ts`，确认上述行为当前失败。
- [x] 实现独立 TaskRun 状态机和持久化调用轨迹；每次运行固定模型及工具/config revision。以 40 次调用/10 分钟活动时间替代固定 5 轮，到限 paused 并返回部分结果；等待确认冻结活动计时。
- [x] 确认绑定 run/call/规范化参数摘要/配置版本/观察目标；拒绝、停止或过期后不执行。read 可直接执行；interact 仅在适配器基于新观察判断后执行；send/delete/overwrite/unknown 进入确认，模型描述和 annotations 不能单独授权。
- [x] 取消不吞成普通工具失败；派发后的写操作超时或取消记 unknown，尚未派发记 cancelled。继续时恢复工具轨迹，使用 ContinueTaskInput 明确传入当前选中的 profileId/model；创建带 continuationOf 的新 TaskRun，保留旧模型与调用记录并重置本次执行上限。先重新观察未知动作，不能清空原记录重跑原句；若无法确认当前状态，等待用户处理。
- [x] 运行目标测试和 `npm run typecheck`；Expected：确认/停止竞态、防重放、原聊天重试均通过。此时测试用适配器可闭环，真实预设在 T07/T08 补观察语义。

## T04：MCP 配置、凭据和 revision

**Files:** Create `src/core/mcp/config.ts`; Modify `src/core/storage/store.ts`, `src/shared/types.ts`; Test `tests/mcp-config.test.ts`, `tests/storage.test.ts`；复用 `src/main/credentials.ts` 的 SecretCodec。

**Interfaces:** 定义 McpServiceConfig/SaveMcpServiceInput。`McpConfigService.list(): McpServiceConfig[]`、`save(input: SaveMcpServiceInput): Promise<McpServiceConfig>`、`remove(id: string): void`、`resolve(id: string): Promise<RuntimeMcpConfig>`；RuntimeMcpConfig 仅主进程可见，包含解密后的 env/headers。

- [x] 写 `secrets_never_appear_in_public_config`、`blank_secret_keeps_and_explicit_clear_removes`、`stale_revision_cannot_overwrite_config`、`service_survives_restart`；覆盖 stdio/http 各自字段验证。
- [x] 运行 `npm test -- tests/mcp-config.test.ts tests/storage.test.ts`，确认缺失实现或断言失败。
- [x] 创建 MCP 配置表及递增 revision；command/独立 argv/cwd 与 URL 分开验证；敏感 env/headers 加密存储。空值保留，清除列表显式删除，不用重新录入密钥才能编辑其他字段。
- [x] 保存/停用后通知连接层失效，测试结果绑定 revision；兼容所有旧 settings/profile 默认值，不改原模型配置行为。
- [x] 运行目标测试和 `npm run typecheck`；Expected：公共 DTO、数据库持久化、清除和并发保存断言通过。

## T05：MCP 连接、发现、调用与注册

**Files:** Create `src/core/mcp/manager.ts`, `src/core/mcp/registry-adapter.ts`, `tests/helpers/mock-mcp.ts`; Modify `package.json`, `package-lock.json`, `src/core/tools/registry.ts`; Test `tests/mcp.test.ts`。

**Interfaces:** `McpConnectionManager.connect(serviceId: string): Promise<void>`、`listTools(serviceId: string): Promise<ToolDefinition[]>`、`getStatus(serviceId: string): McpConnectionStatus`、`call(serviceId: string, toolName: string, args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult>`、`disconnect(serviceId: string): Promise<void>`、`shutdown(): Promise<void>`；注册适配器消费 T03 gate 和 T04 RuntimeMcpConfig。

- [x] 用本地 mock MCP 编写 stdio/Streamable HTTP 发现、分页、调用、图片、isError、未知块、同名工具、401/403、stdout 非协议输出、取消、断线、revision 变化测试；无需联网 npx 才能运行。
- [x] 运行 `npm test -- tests/mcp.test.ts`，确认新功能失败。
- [x] 核对当前 SDK 的发布包/API与协议支持，选择兼容的 TypeScript 客户端及 JSON Schema 校验器，固定版本和锁文件；不照旧文档硬编码 SDK 导入。以 mock 及 T07/T08/T10 的真实服务记录证明兼容。
- [x] 实现 stdio command+argv（无 shell）与 HTTP 静态 headers；服务要求 OAuth 或未实现的交互能力时给出明确不兼容原因。连接共享，调用不自动重放；stderr 有界脱敏。
- [x] 对服务 ID/工具名建立稳定合法映射并检测冲突；执行入口验证当前启用状态、允许清单、JSON Schema 和 config revision。分页收全工具；工具清单变化使旧快照失效，后续运行刷新。
- [x] 转换 text/image/structuredContent/isError 与必要 meta；图片存 T01 artifact。未知资源链接仅返回说明，不自动读取。未知自定义工具按 unknown 处理并进入确认，不能仅信任 readOnlyHint。
- [x] 运行 `npm test -- tests/mcp.test.ts tests/tools.test.ts tests/tool-execution.test.ts` 与 `npm run typecheck`；Expected：连接和协议失败可诊断、取消后无下一次派发、私有配置不泄露。

## T06：IPC、设置、任务状态与退出闭环

**Files:** Create `src/renderer/src/McpSettingsPanel.tsx`, `src/renderer/src/TaskStatus.tsx`, `src/main/shutdown.ts`; Modify `src/main/index.ts`, `src/main/ipc.ts`, `src/preload/index.ts`, `src/shared/types.ts`, `src/renderer/src/SettingsPanel.tsx`, `src/renderer/src/App.tsx`, `src/renderer/src/styles.css`; Test `tests/ipc-policy.test.ts`, `tests/renderer.test.tsx`, `tests/mcp-lifecycle.test.ts`。

**Interfaces:** HerApi 增加 `listMcpServices(): Promise<McpServiceConfig[]>`、`saveMcpService(input: SaveMcpServiceInput): Promise<McpServiceConfig>`、`deleteMcpService(id: string): Promise<void>`、`testMcpService(id: string): Promise<ConnectionTestResult>`、`setMcpServiceEnabled(id: string, enabled: boolean, expectedRevision: number): Promise<McpServiceConfig>`、`listMcpTools(id: string): Promise<ModelTool[]>`、`getMcpStatus(id: string): Promise<McpConnectionStatus>`；增加 `decideToolApproval(input: ApprovalDecisionInput): Promise<void>`、`continueTask(input: ContinueTaskInput): Promise<SendMessageResult>`、`onTaskEvent(callback: (event: TaskEvent) => void): () => void`、`getArtifactPreview(id: string, conversationId: string): Promise<{mimeType: string; dataUrl: string}>`；增加窄的会话任务查询，以便重新打开会话后显示并继续持久化任务，重启不恢复旧确认。DesktopSettings 增加 stopShortcut；新增通道沿用 `her:<action>`。

- [x] 写未可信 frame 拒绝、停止等待确认、切会话状态隔离、配置草稿不被测试覆盖、secret 空值保留、日志无 secret/原图/正文测试；运行目标测试确认 RED。
- [x] 在主进程构造单例 manager 和服务；所有新 IPC 检查输入与来源，不暴露 renderer 任意 shell 或直接调用底层工具的方法。preload 调试日志改为通道/耗时/脱敏错误元数据，不记录参数和返回正文。
- [x] 实现工具设置 CRUD/启停/测试/工具列表和当前连接状态；打开页面及操作结束后刷新状态，敏感字段只显示已设置。延续配置身份与草稿防迟到覆盖规则，来自旧 revision 的状态不能覆盖当前配置。
- [x] 实现 TaskStatus 的步骤、目标、确认详情、部分结果、继续与停止；加入 vision 测试入口和能力提示，更新 her:profile-test 的主进程 kind 校验。图像预览按 artifactId 经受控 IPC 获取，不暴露任意本地路径。
- [x] 注册独立全局停止快捷键，默认 CommandOrControl+Shift+Escape，冲突提示且按钮继续可用；窗口隐藏保持连接。真正退出按停止入场→确认失效→取消→最多 5 秒等待→终止自管进程→关闭 DB 顺序处理，不终止用户 Chrome。
- [x] 运行 `npm test -- tests/ipc-policy.test.ts tests/renderer.test.tsx tests/mcp-lifecycle.test.ts`、`npm run typecheck` 和 `npm run build`；Expected：无晚到写库、关闭窗口与退出行为不同、敏感日志断言通过。
