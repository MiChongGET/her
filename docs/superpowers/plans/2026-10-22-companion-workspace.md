# Companion Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立固定日常、独立工作话题和私密待处理入口，完成切换、审批、隐藏窗口提醒与重启恢复的真实 Electron 流程。

**Architecture:** Her 持久保存话题元数据及日常指针，Pi 继续保存各会话历史。主进程按当前界面选择提供详情，另外生成无内容的工作状态概览；UI 概览不进入模型输入。第一阶段沿用单次动作审批，委托授权交给计划 B，进展共享与记忆交给计划 C。

**Tech Stack:** Electron 44、React 19、TypeScript strict、SQLite、Pi SDK 1.3.0、Vitest、Playwright Electron。

**Spec:** [私人伙伴交互与授权设计](../specs/2026-10-22-private-companion-interaction-design.md)，本计划负责 Q1、Q13 及对应布局；Q3 的业务授权字段由计划 B 实现。

## Global Constraints

- “日常主聊天是默认入口。”工作、历史、日常各自保留原 Pi 会话身份，不合并历史。
- “不显示话题标题、操作对象或正文。”此限制包含日常概览、菜单栏和系统通知。
- “该提示只表达待处理状态，不恢复进展共享，也不使日常对话获得该话题的内容。”
- “同一等待事项不反复催促；未响应不构成批准，其他不冲突的获准工作继续。”
- “只有系统通知已获准时才发出不含敏感正文的简短提醒。”无法确认许可时只保留 Tray。
- 仅增量扩展 Her-Pi-v1 的产品元数据，保留数据库版本 1；不读取或迁移旧版数据目录。
- 现有会话不自动成为日常、不自动共享。无 `TopicInfo` 的会话在工作页“历史对话”分区保留。
- 新工作话题 `shareProgress=true` 表达 Q4 默认语义；计划 C 完成前没有共享摘要生成或注入。
- “她记得的事”到计划 C 具备真实能力后才启用；本计划不展示示例记忆或虚构伙伴活动。
- 保留既有回收站、队列、未知动作、来源撤权规则；不将 TaskRun 状态冒充委托生命周期。
- 不自动 Git 提交；仅在用户明确要求后按实际改动提交，不纳入执行步骤。

## Review Focus

- 已有多段对话且最新一段包含私密内容：首次升级创建独立日常，旧内容不进入日常（Task 1、5）。
- 当前日常被回收、恢复旧日常或双重初始化：始终只有一个活动日常指针，恢复不抢占（Task 1）。
- 切换期间旧话题流事件迟到：主进程与渲染进程同时按选择版本丢弃详情，工作本身继续（Task 2、3）。
- 待处理项已结束、原话题已回收、通知点击迟到：失效入口不打开其他话题或批准动作（Task 2、4）。
- 系统通知许可被拒绝、撤销、探针异常或应用未打包：不发通知，Tray 仍可定位待处理项（Task 4、5）。

---

## File Structure

| 文件 | 职责 |
| --- | --- |
| `src/core/storage/store.ts`、`src/shared/types.ts` | 话题元数据、日常指针、共享契约 |
| 新增 `src/core/conversation/workspace.ts` | 主进程界面选择、状态概览、详情读取与失效定位 |
| `src/main/ipc.ts`、`src/preload/index.ts`、`src/main/index.ts` | 校验入口、事件选择、启动与桌面装配 |
| `src/renderer/src/App.tsx`、`styles.css`、新增 `WorkspaceNavigation.tsx` | 日常与工作导航、历史分区、通用待处理入口 |
| 新增 `src/main/pending-work-notifier.ts`、`notification-permission.ts` | Tray 状态、通知去重、许可检查 |
| 新增 `native/notification-permission/`、`scripts/build-notification-permission.mjs` | 在 Her 主进程内查询 macOS 通知授权的最小原生桥接 |
| `scripts/package.mjs`、`package.json`、`package-lock.json` | 原生桥接构建与打包；依赖仅限必要构建工具 |

## Shared Contracts

- `TopicInfo { conversationId: string; kind: 'daily' | 'work'; shareProgress: boolean; shareRevision: number }`；由本计划定义，计划 C 使用相同字段。
- `WorkspaceSelection { section: 'daily' | 'work'; conversationId?: string }`；日常 ID 由主进程确定，工作无 ID 表示事项列表。
- `PendingActionNotice { id: string; status: 'waiting_approval' | 'paused' | 'unknown'; version: number }`；`id` 是不含业务信息的不透明定位符，计划 B 复用并补委托状态来源。
- `resolvePendingAction(input: { id: string; version: number }): Promise<{ conversationId: string } | null>`；仅解析有效入口，调用方进入原话题后再读取详情，过期或已处理返回 null。
- `WorkspaceListItem { conversation: ConversationSummary; topic: TopicInfo | null }`；无 topic 的项进入历史分区，不创造第三种 kind。
- `WorkspaceSnapshot { selection: WorkspaceSelection; version: number; conversation: ConversationSummary | null; topic: TopicInfo | null; messages: ChatMessage[]; task: TaskEvent | null; activeRequest?: { requestId: string; conversationId: string } | null; workItems: WorkspaceListItem[] }`。
- 日常 snapshot 的 `workItems=[]`，`conversation/messages/task` 仅来自日常；工作列表 snapshot 不携带任一话题消息或审批详情，activeRequest 为 null。选定话题的 activeRequest 只包含本话题准备中或运行中请求；Host 与 ChatService 的 getActiveRequest 增加可选 conversationId，以查询指定话题，不能过滤全局第一项冒充按会话查询。
- 旧 `BootstrapState.conversations` 改为 `dailyConversationId: string`；配置和模型字段保留。工作标题由选中工作页后的 snapshot 获取。
- `WorkspaceChatEvent { selectionVersion: number; event: ChatEvent }`、`WorkspaceRequestEvent { selectionVersion: number; event: RequestEvent }`、`WorkspaceTaskEvent { selectionVersion: number; event: TaskEvent }` 仅分发当前选中的会话；后台使用独立 `PendingActionNotice[]` 事件。
- `HerStore.getTopicInfo(id: string): TopicInfo | null` 位于 `src/core/storage/store.ts`，为计划 C 的读取入口；共享修改只能走 C 的 `MemoryService.setProgressSharing(topicId: string, enabled: boolean, expectedRevision: number): Promise<TopicInfo>`，A 不暴露共享 setter。
- 状态概览不是模型工具、记忆、消息或 system prompt 的输入；不得写进 Pi 会话或展示投影。

### Task 1: 持久化日常身份并保留历史

**Files:** Modify `src/core/storage/store.ts`、`src/shared/types.ts`、`src/main/index.ts`；Test `tests/storage.test.ts`、`tests/host-trash.test.ts`。

**Interfaces:** 新增 `HerStore.ensureDailyConversation(): StoredConversation`、`getTopicInfo(id: string): TopicInfo | null`、`createWorkConversation(id: string, piSessionId: string, title: string): TopicInfo`、`listTopicInfo(): TopicInfo[]`。

- [x] **Step 1: 写失败测试。** `daily_identity_is_stable_and_does_not_promote_legacy`：两个既有 ID/标题/Pi ID/消息保持原值；新日常 ID 不等于它们；重复初始化和重开数据库返回同一日常 ID。

```ts
expect([legacyA.id, legacyB.id]).not.toContain(daily.id)
expect(store.ensureDailyConversation().id).toBe(daily.id)
expect(store.getConversation(legacyA.id)).toEqual(legacyA)
expect(store.getTopicInfo(legacyA.id)).toBeNull()
```

- [x] **Step 2: 写回收与默认值失败测试。** `restored_daily_does_not_replace_current_daily`：回收当前日常后产生一个新日常，恢复原会话仅回到历史；工作默认 `{kind:'work',shareProgress:true,shareRevision:1}`，旧会话 `getTopicInfo` 为 null。
- [x] **Step 3: 运行失败检查。** `npm test -- tests/storage.test.ts tests/host-trash.test.ts`；预期新增断言因接口未实现失败，既有断言不作为预期失败。
- [x] **Step 4: 实现存储方法。** 新增 `conversation_topics`（conversation_id 主键及外键）和单行 `companion_workspace` 日常指针表，以 `BEGIN IMMEDIATE` 原子创建/切换日常及其 Pi ID。
- [x] **Step 4a: 固定元数据默认值。** 日常使用 `{kind:'daily',shareProgress:false,shareRevision:1}`，工作使用 `{kind:'work',shareProgress:true,shareRevision:1}`；不扫描或补写历史会话的 TopicInfo。
- [x] **Step 5: 实现单例与回收策略。** `ensureDailyConversation()` 只接受未回收的现有指针；无效时移除旧日常 TopicInfo、创建新日常，旧会话历史保持原状。恢复原日常不重建其 TopicInfo；永久清理指针引用后仍可正常初始化。
- [x] **Step 6: 接入启动。** 替换 `src/main/index.ts` 的“空列表创建新对话”为 `ensureDailyConversation()`；初始化不读取旧历史、不生成摘要、不改现有时间戳。
- [x] **Step 7: 运行通过检查。** `npm test -- tests/storage.test.ts tests/host-trash.test.ts`；所有新增及原有用例 PASS。

### Task 2: 建立主进程的选择范围与详情服务

**Files:** Create `src/core/conversation/workspace.ts`；Modify `src/shared/types.ts`（新增类型，不在本任务移除旧桥接）；Test 新增 `tests/workspace.test.ts`。实际 IPC、事件和 UI 一起在 Task 3 切换，避免中间版本接口已移除而消费者仍在使用。

**Interfaces:** `WorkspaceService(store: HerStore, chat: ChatService)`；`select(input: WorkspaceSelection): Promise<WorkspaceSnapshot>`、`getPendingActions(): PendingActionNotice[]`、`resolvePendingAction(input: { id: string; version: number }): Promise<{ conversationId: string } | null>`、`routeChat(event: ChatEvent): WorkspaceChatEvent | null`、`routeRequest(event: RequestEvent): WorkspaceRequestEvent | null`、`routeTask(event: TaskEvent): WorkspaceTaskEvent | null`。

- [x] **Step 1: 写失败测试。** `daily_snapshot_and_overview_exclude_private_content`：向工作标题、正文、审批 target/summary 放不同哨兵串；序列化日常 snapshot、overview 后均无这些串（bootstrap 在 Task 3 切换后验证），overview 每项键严格只有 `id/status/version`。

```ts
expect(Object.keys(notice).sort()).toEqual(['id', 'status', 'version'])
expect(JSON.stringify([dailySnapshot, notices])).not.toContain('工作秘密哨兵')
expect(dailySnapshot.workItems).toEqual([])
expect(await workspace.resolvePendingAction({id: notice.id, version: notice.version - 1})).toBeNull()
```

- [x] **Step 2: 写竞态与失效失败测试。** `late_detail_read_cannot_cross_selection` 延迟 A 消息读取后选 B，A 结果不能覆盖 B；`stale_pending_never_opens_another_topic` 验证过期版本、已处理和已回收项返回 null；`background_task_details_never_reach_daily` 在日常选中时断言 `routeTask(privateTask) === null`，订阅输出不含其 approval.target/summary 哨兵串。
- [x] **Step 3: 运行失败检查。** `npm test -- tests/workspace.test.ts`；预期新增接口缺失失败。
- [x] **Step 4: 实现选择与概览。** 工作页列出工作话题及无 TopicInfo 的历史；只有选定话题后调用 `ChatService.getMessages(id)` 与 `getConversationTask(id)`。选择读取完成前版本已变化则抛出不含详情的“界面已切换。”，渲染端忽略旧请求的错误与结果。
- [x] **Step 4a: 派生待处理项。** 审批映射 `waiting_approval`，未知动作映射 `unknown`，中断待续映射 `paused`；普通运行不冒充待处理事项。主进程保存不透明 notice ID 到原任务、话题和修订的映射，任务变化使旧版本失效。
- [x] **Step 5: 提供受检服务接口。** 服务校验 section、对象标识、有限正整数版本和未知字段；提供 `assertSelected(conversationId: string): void` 供 Task 3 的旧详情入口收紧使用。不在本任务注册第二套生产桥接。
- [x] **Step 6: 运行通过检查。** `npm test -- tests/workspace.test.ts tests/host-events.test.ts` 与 `npm run typecheck`；新旧用例 PASS。Task 2 只证明服务规则，生产隐私切换由 Task 3 完成后验收。

### Task 3: 日常、工作列表与原话题审批导航

**执行补充（A3 审查裁决）:** 恢复工作列表使用仅元数据 `WorkspaceService.listWorkItems()` / `HerApi.listWorkItems(): Promise<WorkspaceListItem[]>`（`her:workspace-list`），只允许当前 work 分区读取，不改变选择/版本，不读话题消息；不能复用 select 清空当前输入或在失败时切断事件。

**Files:** Create `src/renderer/src/WorkspaceNavigation.tsx`；Modify `src/renderer/src/App.tsx`、`src/renderer/src/styles.css`、`src/main/ipc.ts`、`src/main/index.ts`、`src/preload/index.ts`、`src/shared/types.ts`、`src/core/conversation/workspace.ts`、`chat.ts`、`src/core/agent/host.ts`；Test `tests/renderer.test.tsx`、`tests/ipc-policy.test.ts`、`tests/workspace.test.ts` 及所有受桥接契约变更影响的现有测试夹具。

**Interfaces:** 消费 Task 2 的服务与类型，注册 HerApi 桥接；`WorkspaceNavigation({ selection, overview, onSelect, onOpenPending })` 只接受选择和无内容概览，不接收所有话题详情。

- [x] **Step 1: 写失败测试。** `daily_is_default_and_work_history_is_reachable`：默认日常、工作列表分“工作话题/历史对话”、新建工作进入该话题、返回日常恢复原聊天位置；不可见记忆示例或启用的记忆入口。
- [x] **Step 2: 写隐私与状态失败测试。** `private_pending_requires_opening_original_topic`：日常仅见“有一件事需要你确认”和“查看”，无私密字符串；bootstrap 与日常事件载荷同样无私密哨兵串；点击查看后才呈现原话题的现有单次审批卡。

```ts
expect(screen.getByText('有一件事需要你确认')).toBeVisible()
expect(screen.queryByText('工作秘密哨兵')).not.toBeInTheDocument()
await user.click(screen.getByRole('button', {name: '查看'}))
expect(bridge.resolvePendingAction).toHaveBeenCalledWith({id: notice.id, version: notice.version})
```

- [x] **Step 3: 写导航竞态失败测试。** `late_workspace_event_does_not_replace_selection`、`trash_current_work_returns_to_daily`；分别检查旧 selectionVersion 被忽略、删除工作后不跳到另一私密会话。
- [x] **Step 4: 运行失败检查。** `npm test -- tests/renderer.test.tsx tests/ipc-policy.test.ts`；新增用例失败，记录被旧导航假设影响的现有断言。
- [x] **Step 4a: 原子切换桥接。** 新增 `her:workspace-select/pending/resolve-pending` 与 HerApi 的 `selectWorkspace/getPendingActions/resolvePendingAction`；使用 Task 2 校验并继续主窗口主框架校验。Bootstrap 改为 dailyConversationId，createConversation 返回新工作话题 WorkspaceSnapshot；her:messages/task-get 用 assertSelected 限定详情，不返回后台标题。
- [x] **Step 4b: 同步切换事件。** index.ts 经 routeChat/routeRequest/routeTask 仅发送当前会话详情及选择版本，后台只发送通用概览；preload 暴露 onWorkspaceChatEvent/onWorkspaceRequestEvent/onWorkspaceTaskEvent/onPendingActions，移除旧全局 onTaskEvent 与未过滤 ChatEvent.task 提取路径。生产者、消费者和测试夹具在同一任务适配。
- [x] **Step 4c: 保留准备阶段停止。** WorkspaceSnapshot.activeRequest 仅查询选中话题；增加 A 已运行、B 正准备时选中 B 刷新仍能停止 B 的测试，A 信息不随快照返回。列表 activeRequest 为 null；Host 与 ChatService 的无参数调用保留既有用途。
- [x] **Step 5: 实现界面。** 从 Task 2 snapshot 渲染；删除 `App.tsx` 启动遍历所有会话读取任务的路径，切换时清理旧详情并保留日常滚动位置。新建、附件入口和发送使用当前 snapshot 的 conversation ID。
- [x] **Step 6: 保留审批真实性。** 原 `TaskStatus` 单次审批仅在所属话题显示；此任务不修改按钮业务含义、不添加尚不存在的委托边界，也不移除 B 负责的权限旁路。
- [x] **Step 7: 收纳技术信息。** 模型、用量及原始工具记录进入现有设置/详情折叠区，继续可达；沿用绿色与宋体设计变量，保证 850×620 最小窗口、键盘导航与焦点返回。
- [x] **Step 8: 运行通过检查。** `npm run typecheck` 与 `npm test -- tests/renderer.test.tsx tests/ipc-policy.test.ts tests/workspace.test.ts tests/host-events.test.ts`；所有用例 PASS，回收站、附件、停止、队列和未知动作的既有断言继续通过。

### Task 4: 通用 Tray 状态与经过真实许可检查的通知

**Files:** Create `src/main/pending-work-notifier.ts`、`src/main/notification-permission.ts`、`native/notification-permission/permission.mm`、`scripts/build-notification-permission.mjs`；Modify `src/main/index.ts`、`scripts/package.mjs`、`package.json`；Test 新增 `tests/pending-work-notifier.test.ts`、`tests/notification-permission.test.ts`。构建使用经 SHA256 校验的精确 Electron headers 与 xcrun，不新增 node-gyp、gyp 或构建依赖；首次需网络与 Xcode CLI tools。

**Interfaces:** `NotificationPermission = 'authorized' | 'denied' | 'not-determined' | 'unknown'`；`getNotificationPermission(): Promise<NotificationPermission>`；`PendingWorkNotifier.update(items: PendingActionNotice[], windowVisible: boolean): Promise<void>`、`dispose(): void`；点击先消费 `resolvePendingAction({id, version})`，有效时按 Host 的日常身份/话题归属选择原分区，并协调 renderer 的 snapshot/version；不能硬编码 work 或只改变主进程选择。

- [x] **Step 1: 写失败测试。** `unknown_or_denied_permission_only_updates_tray`：denied、not-determined、unknown、探针异常均不调用 Notification.show；authorized 且窗口隐藏时只发送固定通用文案。

```ts
permission.mockResolvedValue('unknown')
await notifier.update([notice], false)
expect(showNotification).not.toHaveBeenCalled()
expect(updateTray).toHaveBeenCalled()
```

- [x] **Step 2: 写去重与撤权失败测试。** `same_wait_is_not_repeated`、`permission_is_checked_before_each_new_notice`、`stale_notice_click_is_harmless`；同一 id/version 只提醒一次，每个新事项重新查许可，过期点击不恢复审批。
- [x] **Step 3: 运行失败检查。** `npm test -- tests/pending-work-notifier.test.ts tests/notification-permission.test.ts`；预期模块缺失失败。
- [x] **Step 4: 实现 macOS 探针。** 使用 Her 主进程内的最小 Node-API 原生桥接调用 `UNUserNotificationCenter.getNotificationSettings`；仅明确 authorized 返回 authorized，其余非明确许可或查询失败返回对应拒绝/未知状态；不调用授权申请接口。
- [x] **Step 5: 接入构建和包装。** 构建脚本按锁定 Electron 版本及当前架构编译，产物放 `out/native/notification-permission.node`，现有 packager 保留该文件；必要构建依赖作为精确版本 devDependency 锁定。开发模式、加载失败或不支持平台返回 unknown。
- [x] **Step 6: 实现提醒器。** Tray 始终保留通用状态；只有许可明确且窗口隐藏才调用 Electron Notification。文案不含标题/目标/正文，通知点击显窗并通过 Task 2 校验定位，不使用系统通知自动操作审批。
- [x] **Step 7: 运行自动检查。** `npm test -- tests/pending-work-notifier.test.ts tests/notification-permission.test.ts`、`npm run build`、`npm run package`；测试和构建 PASS，包内存在正确架构的原生模块。
- [ ] **Step 8: 完成实机许可验证门。** 在 bundle ID 为 `com.her.desktop` 的安装包中查询并记录已允许、已拒绝、未决定、撤销后的实际状态；证明探针查询的是 Her 自身。`Notification.isSupported()`、浏览器权限或外部 Swift/osascript 进程结果不能替代此证据。
- [x] **Step 9: 验证未通过时保持降级。** 原生通知交付状态标为未验收、运行策略保持 unknown→Tray，禁止为了展示通知跳过门槛；其余已通过的工作区流程仍可独立验收。

通知验收状态：工程与安全降级已通过独立审查；真实 bundle 仅实测 not-determined。已允许、拒绝、撤权与实际通知送达仍未验收，不将第 8 步计为完成。

### Task 5: Electron 端到端与模型输入边界验收

**Files:** Create `tests/e2e/companion-workspace.spec.ts`；Modify `tests/e2e/startup.spec.ts`、`tests/e2e/conversation-runtime.spec.ts`、`tests/e2e/desktop.spec.ts`；Test 复用 `tests/pi-sdk/wire.ts`；证据写入新增 `experiments/companion-workspace/README.md`。

**执行补充（契约回归）:** A3 改变了全局 Bootstrap 与选择版本，其他现有本地 e2e 若仍以 API select 轮询或假设默认最新会话，须在复现后同步修正并保留原断言；真实服务与额外依赖的 opt-in 默认保持关闭，不扩大到无关产品重构。

**Interfaces:** 消费 Task 1–4 的产品入口与本地假模型服务；不使用 renderer mock 代替真实主进程、数据库和 Pi 文件。

- [x] **Step 1: 写失败 e2e。** `daily_work_private_approval_round_trip`：启动日常→创建工作→触发本地受控工具的单次审批→回日常只见通用提示→查看原话题→拒绝或批准→返回日常→重启日常 ID 不变。
- [x] **Step 2: 写数据边界 e2e。** `legacy_and_work_secrets_never_enter_daily_requests`：预置旧会话及工作秘密，执行日常真实流式请求，断言 fixture 收到的请求体无秘密；重启和删除 SQLite 展示投影后重建，断言仍成立。

```ts
expect(JSON.stringify(dailyRequest.body)).not.toContain('工作秘密哨兵')
expect(JSON.stringify(dailyRequest.body)).not.toContain('旧历史秘密哨兵')
expect(afterRestart.dailyConversationId).toBe(beforeRestart.dailyConversationId)
expect(restoredWorkMessages.map(message => message.content)).toContain('工作秘密哨兵')
```

- [x] **Step 3: 写回收与晚到事件 e2e。** `restoring_old_daily_keeps_current_daily` 和 `hidden_pending_open_resolves_owner`；验证恢复不抢占、原话题删除后的入口失效、后台工作不因返回日常而取消。
- [x] **Step 4: 运行失败检查。** `npm run test:e2e -- tests/e2e/companion-workspace.spec.ts`；将真正缺失行为作为失败原因，修正旧测试对“最近会话即默认”的假设。
- [x] **Step 5: 完成最小修正。** 仅修 Task 1–4 暴露的问题；从现有 Pi `openConversationHistory` 重建投影，不新增 SQLite 消息权威或跨话题消息复制。
- [x] **Step 6: 运行完整通过检查。** `npm run check`；`npm run test:e2e -- tests/e2e/companion-workspace.spec.ts tests/e2e/startup.spec.ts tests/e2e/conversation-runtime.spec.ts tests/e2e/desktop.spec.ts`；全部 PASS。
- [x] **Step 7: 记录证据边界。** 写明源码测试、本地假服务请求体、真实 Electron、安装包通知/权限各自结果；未完成的实机门列出具体缺项，不将模拟授权、fixture 或构建成功写成实际权限可用。

## Self-Review

- Q1 覆盖：Task 1 固定日常身份、Task 2/3 工作与历史导航、Task 5 重启连续性与历史保留。
- Q13 覆盖：Task 2 在主进程裁剪日常数据、Task 3 通用入口、Task 4 隐藏窗口提醒、Task 5 请求体证据。
- Q3/Q12 不在本阶段冒领：保留现有单次审批，可信业务字段和全局/会话旁路修复由计划 B 执行。
- Q4/Q7/Q11 对接：TopicInfo 契约已定义；没有摘要或记忆注入，计划 C 实现后才启用对应能力。
- Review Focus 五类均对应具名失败测试；类型、方法及接口消费名称已逐项核对。
- 真实 macOS 许可是独立验收门，未通过时仍严格保持 Tray；无任何无响应自动授权路径。
- 计划只定义可验收工作区流程及必要接口，不包含产品实现、自动 Git 提交或提前部署。
