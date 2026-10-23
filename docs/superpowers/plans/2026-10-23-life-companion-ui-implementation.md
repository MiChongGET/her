# Her 生活陪伴界面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将用户确认的深绿生活陪伴原型落实为真实 Her 界面，覆盖三个入口、主要页面状态、连续聊天、话题管理与可靠的话题衔接。

**Architecture:** 保留 Electron → IPC → ChatService/WorkspaceService → AgentHost → Pi/SQLite 的现有边界。React 重组页面与临时草稿；主进程继续决定对象归属、授权、任务状态和来源有效性。话题衔接作为独立的持久化能力实现，不直接搬用原型的内存状态机。

**Tech Stack:** Electron 44、React 19、TypeScript strict、原生 CSS、SQLite、Pi SDK 1.3.0、Vitest、Playwright Electron；本轮不新增运行时依赖。

**Spec:** [完整界面与交互方案](../specs/2026-10-23-life-companion-ui-design.md)；[已确认交互原型](../../../experiments/life-companion-prototype/README.md)。

**后续颜色修订：** 用户要求正式界面回到 Her 原有的暖白与浅灰绿配色。本文的深绿原型和 SHA 表仍记录当时的实施基线；当前颜色以 `docs/DESIGN_SYSTEM.md` 和后续 Electron 验收截图为准，页面结构与交互范围不变。

## Global Constraints

- 本文件仅为正式实现的范围与计划，所有实施项均未开始；本轮不改应用代码、不运行迁移、不清空数据、不提交或推送。
- 产品名为 Her，内置伙伴身份为 Samantha；以生活陪伴为主，内部 `work` 类型本轮继续沿用，不做无关的全仓库术语重命名。
- 三入口固定为“日常”“一起在做的事”“她记得的事”；进入话题后显示具体标题，不新增固定详情页名称。
- 空日常：“我在，想说什么都可以。”；空列表：“还没有一起在做的事”；新话题：“这件事，我们从哪里开始？”；新建入口：“另开一个话题”。
- 记忆入口仅显示“记忆功能尚未开放”；共享仅说明“这里的进展暂不能带回日常”，不提供未完成能力的操作开关。
- 旧对话均为测试数据，不设计旧会话分组、迁移或兼容；正常产生的新记录、消息历史、跨天日常和回收站仍须持久化。
- 不新增语音、虚拟世界、主动联系、提醒、临时聊天、全文搜索、消息编辑、图片粘贴/编辑、归档、置顶或话题完成状态。
- Pi 会话是对话历史权威，SQLite 投影可重建；不手写 JSONL，不把投影提升为历史或来源权威，不迁移/复制文件授权。
- 日常及通知只能携带通用待处理信息；授权、未知动作、资料撤权、队列暂停与恢复规则不得因界面简化而削弱。
- 草稿与阅读位置只承诺当前应用会话内保存；隐藏窗口不是退出，真正重启默认回到固定日常，未完成事务不自动续跑。
- 当前工作区已有大量未提交工作。执行时先记录并保留基线，只改本计划相关内容；不重置、暂存、提交或覆盖其他任务的改动。隔离工作区时明确包含哪些必要的未提交依赖，不能直接从远端分支开工而遗漏现有能力。

## Review Focus

1. 切页与迟到回包：A 的消息、文件选择、权限结果不能出现在 B，也不能把用户从 B 强制拉回；T1/T3/T5 的竞态测试负责。
2. 未读取与真实空内容：历史、队列、待处理读取失败不能显示为空或成为执行许可；T1/T6 的失败测试负责。
3. 衔接提交中断：双击、落盘中断、丢失回包和重启只能对应同一话题，不能生成回复或派发外部动作；T4/T5 的恢复测试负责。
4. 背景来源及接收服务改变：文件衍生文本、受限记忆、压缩摘要和未知来源不能被当作普通用户原话跨范围使用；T4 的三条请求路径测试负责。
5. 多委托及撤销竞态：操作只影响指定委托/调用；已开始的排队项不能反馈撤销成功，结果未知不得普通重试；T6 的对象与竞态测试负责。

---

## 1. 实现基线与范围

用户于 2026-10-23 确认：“这版原型方向可以，就按这版整理正式实现的改动范围和实施计划，先不要改应用代码。”这表示视觉和交互方向通过，可据此安排工程工作，不表示模拟能力已获产品验收或已授权开始实施。

基线固定为当前原型的 `index.html`、`prototype.css`、`prototype.js` 和 [11 张状态截图](../../../experiments/life-companion-prototype/screenshots/)。原型右上场景选择器、测试文案、外层演示框、静态回复及虚构数据都不进入产品。正式验收比较 Electron 的内容区域，不把原型网页外框再嵌入桌面窗口。

| 基线文件 | SHA-256 |
| --- | --- |
| 方案 `2026-10-23-life-companion-ui-design.md` | `1a8d3592a0b091c2109dca9b157a05ec142c216b4216ecb46084c6146cc6c25f` |
| 原型 `index.html` | `3c10deb3607d5597888b99c1405c72b25ea1961a3700a9b58759792f5cc1e48e` |
| 原型 `prototype.css` | `57a6f08095d1c90d0e9be393bbc8316f49e0a940df977f3f74e671a713bd81af` |
| 原型 `prototype.js` | `446bbaa6900aae7c4a287a66f54784729fbb4326f748a7f197fc7737f4312e5a` |

### 改动范围与当前差距

| 改动面 | 当前源码事实 | 正式实现结果 | 任务 |
| --- | --- | --- | --- |
| 外壳、导航、聊天布局 | `WorkspaceNavigation` 只有日常/工作，通用待处理在导航内；`App` 仍有大品牌、新对话、长列表和技术控件 | 深绿紧凑标题栏、纵向三入口、底部更多、生活聊天主区域；待处理进入日常内容区 | T1/T2 |
| 话题列表与标题 | `WorkspaceService.summary()` 的 `lastMessage` 为空；首句 24 字标题仅改 React 状态 | 轻量真实卡片；允许只展示标题；首句短标题真实保存且不覆盖手动改名 | T2 |
| 草稿、附件、阅读位置 | `clearSelection()` 清空草稿与文件；仅日常保存滚动位置 | 按真实 conversationId 保存临时草稿、附件引用和位置；回来重验；无模型仍可写草稿 | T3 |
| 页面状态和选择权威 | 有版本防护，但读失败后选择已变；队列/提示读取失败部分被吞掉 | 首次加载、刷新、空、失败分离，目标成功读回前不能发送或批准；失效提示有明确反馈 | T1/T6 |
| 从日常衔接话题 | 无完整预览、来源、持久化和幂等链 | 用户确认少量背景后真实创建；取消无创建；结果不明核实同一次操作；不自动回复 | T4/T5 |
| 办理与队列 | 已有真实委托/审批/队列；卡片集中堆在输入区前 | 按需、邻近相关交流；多委托独立操作；普通下一句轻量排队，控制指令仍优先 | T6 |
| 辅助页面与管理 | 设置、回收站、授权、用量/压缩、工具记录已有功能 | 保留真实行为并统一布局，技术信息收进对应详情；恢复仅查看，清理失败可重试 | T7 |
| 记忆/共享 | 有底层代码，完整产品链尚未开放 | 展示明确未开放状态；本计划不扩建记忆或分享系统 | T1/T2 |

视觉调整影响 `styles.css`、页面结构和少量图标；业务改动集中在选择状态、标题保存、附件重验与话题衔接。现有授权门、外部动作账本、模型协议、MCP 和资料解析能力优先复用，只为本次明确缺口作必要修改。

## 2. 文件责任与接口决策

以下是实施时的预定文件，不表示本轮已创建应用组件。`App.tsx` 保留装配与现有事件路由，只抽出此次页面改造需要的部分，不做全面状态管理重构。

| 文件 | 责任 |
| --- | --- |
| 修改 `src/renderer/src/App.tsx`、`WorkspaceNavigation.tsx`、`Visuals.tsx`、`styles.css` | 页面装配、三入口、视觉变量、当前对象与事件版本 |
| 新建 `src/renderer/src/TopicList.tsx`、`MemoryUnavailable.tsx` | 生活话题列表、未开放说明；不持有业务执行逻辑 |
| 新建 `src/renderer/src/conversation-drafts.ts`、`TopicHandoffDialog.tsx` | 本轮内的草稿归属、明确的衔接预览/提交/核实状态 |
| 修改 `TaskStatus.tsx`、`FileAccessPanel.tsx`、`DocumentSources.tsx`、`ConversationUsage.tsx` | 保留真实操作与校验，调整位置、展开层和状态文案 |
| 修改 `SettingsPanel.tsx`、`McpSettingsPanel.tsx`、`SkillsPanel.tsx`、`DependencyChecks.tsx`、`TrashPanel.tsx` | 辅助面板视觉、可达性；已有保存/测试/删除语义不重写 |
| 修改 `src/shared/types.ts`、`src/preload/index.ts`、`src/main/ipc.ts`、`src/main/index.ts` | 同步类型、IPC 参数校验、主框架校验和服务装配 |
| 修改 `src/core/conversation/workspace.ts`、`chat.ts` | 选择就绪门、列表、创建及衔接服务门面 |
| 新建 `src/core/conversation/topic-handoff.ts` | 预览范围、同次确认幂等、持久化恢复，不承担模型推理或委托派发 |
| 修改 `src/core/storage/store.ts` | 首句标题条件写入；衔接操作的持久状态与可见性 |
| 修改 `src/core/agent/host.ts`、`sources.ts`、`source-guard.ts` | Pi 权威背景保存/展示、后续请求的来源与接收服务限制 |
| 按 T1–T8 增改 `tests/`；更新 `docs/DESIGN_SYSTEM.md` 和实施验收记录 | 各层真实断言、Electron 对照截图及证据范围 |

### 共用契约（本计划拟新增/修改，当前尚未实现）

1. `WorkspaceSelection.section` 扩为 `'daily' | 'work' | 'memory'`；话题仍是 `TopicInfo.kind: 'daily' | 'work'`。`memory` 仅用于选择空说明页，不创建会话、不调用记忆 API；传入 conversationId 必须拒绝。列表页使用已有 `{ section: 'work' }`，具体话题使用 `{ section: 'work', conversationId }`。
2. `WorkspaceService.select(input: WorkspaceSelection): Promise<WorkspaceSnapshot>` 签名保留；内部本次选择只有完整读取成功才就绪。`assertSelected(conversationId: string): void` 同时校验归属和就绪；失败不保留新执行权威。已有运行继续按主进程规则执行，不因离开界面而取消。
3. `ConversationDraft`：`text: string; files: FileReference[]; revision: number; scroll?: { top: number; following: boolean }`，只存组件会话内、按 conversationId 索引。新 `HerApi.validateDraftFiles(input: { conversationId: string; fileIds: string[] }): Promise<{ valid: FileReference[]; invalidIds: string[] }>` 对应 `her:files-validate-draft`；无路径/正文返回，校验每个原引用，不新建授权；失败项保留为不可发送状态。发送端最终校验仍独立执行。
4. `SendMessageInput` 增加可选 `attachmentOnly?: boolean`：仅用于区分现有“请查看附件”合成提示与用户原话，`true` 必须有 fileIds 且 content 为该提示；不进入自动标题。新增 `HerStore.setInitialTopicTitle(conversationId: string, requestId: string, text: string): void`，只处理首个已接纳的非重试、非控制、非合成输入；标题压缩空白后取前 24 个 Unicode 字符，手动标题和日常不变。现有 `enqueueInput(conversationId, content, attachments, id?, target?): string` 的 target 增加 `initialTitleText?: string`；宿主仅为可命名的普通原话传入，由该存储方法在插入输入的同一事务调用标题方法。`conversations` 增加可空 `initial_title_request_id`，一次性条件认领，避免首句恰好等于“新对话”时被后句再次改名；局部幂等补列不改变 user_version，不批量回填测试会话。
5. 衔接公共 DTO：`TopicHandoffPreview { id: string; digest: string; sourceConversationId: string; excerpts: { messageId: string; role: 'user' | 'assistant'; text: string; createdAt: string }[]; receiverLabel: string; omittedCount: number }`；renderer 不能提交正文、来源证明或接收服务标识。
6. 新增 `HerApi.previewTopicHandoff(input: { conversationId: string; messageIds: string[] }): Promise<TopicHandoffPreview>`、`commitTopicHandoff(input: { operationId: string; previewId: string; digest: string }): Promise<TopicHandoffOperation>`、`getTopicHandoffOperation(operationId: string): Promise<TopicHandoffOperation | null>`，IPC 依次为 `her:topic-handoff-preview`、`her:topic-handoff-commit`、`her:topic-handoff-status`。操作结果字段固定为 `operationId: string; status: 'preparing' | 'created' | 'failed'; conversationId?: string; errorCode?: 'source-changed' | 'receiver-changed' | 'storage-failed'`；只有 `created` 返回可进入的话题 ID，不返回快照也不隐式选页。
7. 主进程 `TopicHandoffService` 提供上述三方法：`preview(input)`、`commit(input)`、`getOperation(operationId)`，类型与 HerApi 对应；额外 `recover(): Promise<void>` 只核实/补齐已确认的本地保存，不生成新确认、不调用模型。`HerStore` 的操作读写封装在该服务，不另设 renderer 可写的来源字段。
8. 仅主进程使用 `TopicHandoffCandidate`（定义于 `topic-handoff.ts`）：`excerpt: TopicHandoffPreview['excerpts'][number]; sessionId: string; entryId: string; contentDigest: string; dependencies: MemorySourceDependencies; provenanceComplete: boolean; receiverKeys: string[]`。Host 与 ChatService 门面新增 `readTopicHandoffCandidates(conversationId: string, messageIds: string[]): Promise<TopicHandoffCandidate[]>`，通过 Pi 分支与 run 标记解析 UI 消息 ID 对应的权威条目；无法完整映射的消息 provenanceComplete=false，禁止猜测为空依赖。接收服务 key 由配置及凭据版本生成不可逆指纹，不向 renderer 返回；无需为此接通记忆服务。

衔接策略的具体落点见 T4。它与未来记忆/共享产品计划分开交付；不以实现整套记忆系统作为本轮前置条件，也不为方便衔接而放开其使用权限。

## 3. 分阶段实施任务

顺序：T1 → T2 → T3；T4 → T5；再完成 T6/T7，最后 T8。T4 依赖 T1 的选择边界，T5 同时依赖 T2/T3/T4。每阶段可单独验证，但仅前三项通过不能称为完整交付。下列测试名称为拟新增用例，断言摘要使用 Vitest/Playwright 记法，不是已经通过的结果。后续获得实施指令后，先记录现有工作区/依赖基线与 `npm run check` 的原始结果，已有失败须与本次引入的回归分别记录，不能把既有未提交实现当作干净远端基线。

### Task 1：建立三入口及可信的页面读取状态

**Files:** 修改 `src/shared/types.ts`、`src/core/conversation/workspace.ts`、`src/main/ipc.ts`、`src/renderer/src/App.tsx`、`WorkspaceNavigation.tsx`；测试 `tests/workspace.test.ts`、`tests/renderer.test.tsx`。

**Interfaces:** 使用共用契约 1/2；保留 `selectWorkspace(selection): Promise<WorkspaceSnapshot>`、`resolvePendingAction({ id, version })` 及版本化事件契约；不扩充通用 notice 的私密字段。

- [ ] 写失败用例 `memory_selection_has_no_conversation_authority`：`expect(snapshot.messages).toEqual([])`，无 task/会话/工作列表；`assertSelected(oldId)` 抛错；`routeChat(oldEvent)` 为 null；拒绝 memory + conversationId。
- [ ] 写失败用例 `failed_or_superseded_selection_cannot_authorize_actions`、`failed_read_is_not_empty`：A/B 交错回包只接受最后一次；首次失败不显示空文案；同页刷新失败保留原内容并禁用依赖未核实状态的动作。发送入站先核对已就绪选中对象，再交给宿主接纳；一旦接纳，后续切页不取消该请求或把成功改报失败。
- [ ] 运行 `npm test -- tests/workspace.test.ts tests/renderer.test.tsx`，确认上述新断言因缺少入口/就绪门而失败。
- [ ] 实现三入口和局部读取状态 `loading/ready/refreshing/stale/failed`；错误重读只调用读取接口，不重发消息；切页时隐藏前页消息，公共外壳稳定。进入未开放说明页立即清除聊天展示与执行权威，不制造记忆加载过程。
- [ ] 同命令应 PASS；额外 `stale_pending_notice_keeps_draft_and_page` 断言返回 null 时显示“这件事的状态已更新”，不创建会话或导航。

**交付门：** 三入口可达，日常身份固定，读取错误和真实空内容分离，旧对象不能借迟到事件获得执行入口。

### Task 2：还原深绿外壳、生活话题与真实标题

**Files:** 修改 `App.tsx`、`WorkspaceNavigation.tsx`、`Visuals.tsx`、`styles.css`、`src/core/storage/store.ts`、`src/core/agent/host.ts`、`src/shared/types.ts`；新建 `TopicList.tsx`、`MemoryUnavailable.tsx`；测试 `tests/renderer.test.tsx`、`tests/storage.test.ts`、`tests/host-queue.test.ts`。

**Interfaces:** 消费 T1 snapshot 与 `WorkspaceListItem[]`；新增组件 `TopicList({ items, onOpen, onCreate, onRename, onTrash })`，Props 为 `items: WorkspaceListItem[]; onOpen(id: string): void; onCreate(): void; onRename(id: string): void; onTrash(id: string): void`；`MemoryUnavailable({ onDaily }: { onDaily(): void })`。生产标题使用共用契约 4，原 `createConversation(): Promise<WorkspaceSnapshot>` 保留。

- [ ] 写 `three_entries_and_distinct_empty_states`，断言三入口、四种准确空/未开放文案、真实话题标题；没有名为“工作”的导航入口、完成率、大欢迎区、旧对话分组或记忆开关。写 `initial_title_survives_reopen_and_custom_rename_wins`：持久层重开后为首句前 24 字；首句恰为“新对话”也不被后句重命名；手动改名竞态不被覆盖；日常、附件合成提示、重试和控制指令不自动命名。
- [ ] 运行 `npm test -- tests/renderer.test.tsx tests/storage.test.ts tests/host-queue.test.ts`，确认新增断言失败。
- [ ] 替换旧壳及会话长列表为原型布局；纵向导航、紧凑 Her 标题、主区聊天/日期/轻量卡片、简洁输入。设置和回收站移到底部更多，模型/用量等入口由 T7 收拢；未迁移功能的入口先保留可达。
- [ ] 在真实普通输入持久接纳点、同一次事务中条件保存首句标题，不能只在 IPC 返回/renderer 更新；以输入接纳顺序处理首句，已有自定义标题用 SQL 条件保护。`attachmentOnly` 接入参数校验与 renderer 发送；未接纳失败不改标题。
- [ ] 列表只列真实 `kind: 'work'` 话题；没有可信交流线索就只显示标题，不新建摘要管道、不批量读取或选中所有话题。手动创建为空白且不调用模型；请求未完成禁用重复创建，晚结果只更新真实列表，不强制导航。
- [ ] 同命令应 PASS；人工对照原型日常/列表/话题/记忆截图；本文不规定额外的排序、归档或话题状态。

**交付门：** 从新建、首句、离开到重开都使用真实话题与标题；生活话题可以只有讨论，没有委托也可持续交流。

### Task 3：补齐草稿、附件及阅读连续性

**Files:** 新建 `src/renderer/src/conversation-drafts.ts`；修改 `App.tsx`、`FileAccessPanel.tsx`、`DocumentSources.tsx`、`src/shared/types.ts`、`src/preload/index.ts`、`src/main/ipc.ts`；测试 `tests/renderer.test.tsx`、`tests/files.test.ts`、`tests/attachments.test.ts`。

**Interfaces:** 消费共用契约 3；文件模块导出 `ConversationDraft`，由 App 持有 `Map<string, ConversationDraft>`；沿用 `selectFiles`、`addDroppedFiles`、`getFilePreview`、`revokeFileGrant`；新重验接口只包装现有 `FileAccessService.validateSources()`，不扩充格式/数量限制。

- [ ] 写 `draft_and_scroll_return_to_owner`、`late_file_result_never_moves_to_another_topic`：A 的字/文件/位置切到 B 再回来恢复，B 没有 A 文件；迟到文件结果只更新仍有效的原草稿版本，不覆盖新输入。无模型可输入，发送不可用。
- [ ] 写 `revoked_or_changed_file_cannot_revive_from_draft`、`remove_chip_does_not_revoke_or_delete_file`：回来重验、撤权与版本变化均保持失效；删除 chip 不调用撤权或文件删除。重验期间不可发送，局部预览失败不清空其余内容。
- [ ] 运行 `npm test -- tests/renderer.test.tsx tests/files.test.ts tests/attachments.test.ts`，确认上述测试失败。
- [ ] 在离页前存草稿和滚动，成功选定原对象后恢复并重验引用；采用草稿 revision 与选择 generation 双重校验。发送失败只恢复对应版本，不覆盖用户后续输入。新建未有 ID 前不把草稿放入“通用新话题”共享槽。
- [ ] 保留发送前主进程版本/模型能力最终检查；输入法组合期间 Enter 不发送，Shift+Enter 换行；用户上翻时不跟随流式滚动。隐藏/面板开关不清草稿，不使用 localStorage 扩大跨重启承诺。
- [ ] 同命令应 PASS；测试 `composition_enter_does_not_send` 断言 sendMessage 调用数为 0，再确认后普通 Enter 才发送。

**交付门：** 同一应用会话内交流连续，附件所属对象和授权始终真实；文件权限不依赖浏览器原型的模拟值。

### Task 4：实现可恢复、有来源限制的话题衔接后端

**Files:** 新建 `src/core/conversation/topic-handoff.ts`；修改 `src/core/conversation/chat.ts`、`workspace.ts`、`src/core/storage/store.ts`、`src/core/agent/host.ts`、`sources.ts`、`source-guard.ts`、`src/shared/types.ts`、`src/main/index.ts`、`ipc.ts`、`src/preload/index.ts`；新建 `tests/topic-handoff.test.ts`；扩展 `tests/source-filter.test.ts`、`tests/projection.test.ts`、`tests/ipc-policy.test.ts`。

**Interfaces:** 实现共用契约 5/6/7/8；Host 和 ChatService 门面新增 `saveTopicHandoffBackground(conversationId: string, operationId: string, preview: TopicHandoffPreview): Promise<void>`，仅接收服务内部已核实预览，通过 Pi 公共接口幂等保存；来源证明由主进程操作记录关联，绝不信任 renderer 传回的 text。`TopicHandoffService` 构造依赖为 store、chat、workspace、profiles，Host 的 Pi 访问仍通过 chat 门面。

- [ ] 写 `confirmed_snapshot_is_the_only_saved_background`、`same_operation_creates_one_topic`：确认后恰好一个话题/一个背景标记，内容等于预览；原日常不变，模型/MCP 调用数为 0；同 operationId + 同 digest 返回同对象，不同 digest 拒绝。
- [ ] 写 `recover_after_pi_append_before_sqlite_commit`、`failed_source_check_creates_nothing`：在各保存边界注入中断并重开；只核实同操作，背景不重复；无有效来源不创建可见话题，落盘失败明确标识，不把失败当空白成功。
- [ ] 写 `restricted_background_is_never_laundered`：原始文件、文件衍生回复、受限记忆、共享摘要、未知依赖分别做哨兵；预览/保存/首次请求均不向未经许可服务发送。写 `receiver_change_filters_seed_and_derivatives_in_all_paths`，在普通请求、压缩、重启继续三路径检查实际假服务请求体，不仅检查 UI 或源函数返回值。
- [ ] 运行 `npm test -- tests/topic-handoff.test.ts tests/source-filter.test.ts tests/projection.test.ts tests/ipc-policy.test.ts`，确认新增测试失败。
- [ ] 实现主进程预览：仅允许当前已就绪的日常，按用户明确选择的消息 ID，从 Pi 完整性校验后的当前分支解析，不从展示投影抽取背景。一次最多 6 条且合计 6000 Unicode 字符，超限要求缩小，不悄悄截断；这些是工程限制，不是原型既有能力。无需模型判断相关性、摘要或命名，不能自行搬最近整段历史。无模型时先引导配置再生成接收服务明确的预览。
- [ ] 对候选关联原 conversation/session/entry、内容摘要、完整可证明的依赖与当前接收服务指纹；预览只保留可证明允许带入的文本。来源明确、无依赖的用户自述可以由本次预览确认用于所示服务；伙伴回复还须有对应服务的既有使用许可。文件衍生内容、记忆、共享摘要、未知或跨服务许可不明的材料本轮不搬，显示省略数量与缺少背景原因；不通过新增记忆权限机制临时放行。命名也只用已经批准的文本。接收服务配置、端点或凭据版本改变会使原指纹失效；每个异步边界后、发布和模型派发前都重验，不只在预览时检查。
- [ ] 持久化 `topic_handoffs` 操作日志：operation_id 主键、preview_id、digest、source/target conversation、不可变预览及主进程来源证明、接收服务指纹、状态、错误码、Pi entry ID。确认前预览仅在主进程内存，取消不写话题；确认时先登记操作并预留目标 ID。SQLite user_version 仍为 1，用局部幂等建表，不重置已有表或导入旧数据。
- [ ] 使用 Pi 1.3.0 `SessionManager.appendCustomMessageEntry('her.topic-handoff', content, true, details)` 保存已确认背景，details 记录 operationId 和来源关联；通过扫描同 operationId 幂等核实已有 entry。随后把操作置为 created，话题才可被列表/选择/发送使用；preparing/failed 的预留话题不能被默认列表漏出。重启只完成已确认的本地保存核实，不执行模型或外部动作。
- [ ] 扩展 Host 投影重建，背景展示为“从日常带来的背景”及原始时间/角色线索，不伪装新发送消息。扩展来源索引处理 `custom_message`，为背景及之后衍生回复/摘要保留依赖；不能因 Pi 将 custom message 转为 user context 就当成无来源的新原话。请求前重验源记录可用性与接收服务指纹；失效时移除相关背景及衍生内容并说明缺少背景，原始记录不改写。过滤失败必须阻断该材料，不让 Pi 捕获异常后回退发送原文；压缩和恢复路径同样覆盖。
- [ ] 同命令应 PASS；加入 `delete_or_trash_cleans_handoff_without_deleting_source` 验证来源删除/移入回收站会使背景不可使用，目标永久删除只清其关联与本地文件，不删除日常或用户原文件。操作日志与 Pi 的失败核实规则记录到验收文档。

**交付门：** 真正落盘、同次幂等和来源约束三项同时通过；不能用一个“创建后跳转”的前端按钮替代本任务。公共 SDK 的 custom message 及过滤路径必须由本地假服务探针证明，接口形状存在不等于行为已通过。

### Task 5：连接话题衔接预览、确认和结果核实

**Files:** 新建 `src/renderer/src/TopicHandoffDialog.tsx`；修改 `App.tsx`、`styles.css`；测试 `tests/renderer.test.tsx`；新建 `tests/e2e/life-companion-ui.spec.ts`。

**Interfaces:** `TopicHandoffDialog({ sourceConversationId, onCreated, onClose })`，回调为 `onCreated(conversationId: string): void`、`onClose(): void`；消费 T4 三个 HerApi 方法。确认第一次生成 operationId，之后核实与重试沿用它；导航和服务选择仍由 App 控制。

- [ ] 写 `cancel_before_submit_keeps_original_context`、`late_created_result_does_not_navigate`：预览前不创建，取消保存日常文字/文件/滚动；确认后离页，不把用户拉回；操作完成可明确打开既有话题。
- [ ] 写 `lost_commit_reply_queries_same_operation`：丢回包后只查询原 operationId，重复点击不新生成 ID；状态 preparing 显示核实中；failed 展示原因；null 不推断肯定未创建，更不能自动用新 ID 再建。
- [ ] 运行 `npm test -- tests/renderer.test.tsx`，确认新增断言失败。
- [ ] 日常更多中的“单独聊这件事”进入少量交流选择与预览，可缩小选择；没有明确相关范围时保留日常，不凭空自动挑选。预览显示确切引用、来源、接收服务与省略说明；确认按钮只保存背景。既有明确办事请求仍走原委托接纳链，不强制经过此对话框。
- [ ] 保存/核实结果与视图 generation 分离：关闭不等于撤销已提交创建；异常仅就近说明；成功后只有原操作仍拥有当前导航时才主动进入。进入目标读回真实快照，不自动发送；首句/改名沿用 T2。
- [ ] 单测应 PASS；运行 `npm run test:e2e -- tests/e2e/life-companion-ui.spec.ts --grep handoff`，用真实 Electron 与隔离临时目录验证创建后重启仍能读回背景，假模型调用数保持 0。

**交付门：** 预览所见、确认所存、再次打开所见一致；提交前取消与提交后结果不明有不同且真实的反馈。

### Task 6：按需办理卡片与真实排队状态

**Files:** 修改 `App.tsx`、`TaskStatus.tsx`、`styles.css`；必要时扩展 `src/core/conversation/chat.ts` 的只读详情；测试 `tests/delegation-ui.test.tsx`、`tests/renderer.test.tsx`、`tests/host-queue.test.ts`、`tests/delegation-denial.test.ts`、`tests/pending-work-notifier.test.ts`；调整 `tests/e2e/delegations.spec.ts`、`companion-workspace.spec.ts` 的真实入口选择器。

**Interfaces:** 沿用 `getDelegationDetails(conversationId): Promise<DelegationDetails>` 及每个 delegation 的 id/revision/canResume；沿用 `decideToolApproval`、`pauseDelegation`、`cancelDelegation`、`resumeDelegation`、`getQueue`、`cancelQueuedMessage`、`resumeQueue`。需要多委托关联展示时，只读详情新增 `latestTask: TaskEvent | null` 到每个 delegation 项，由其 own run 查询并过滤，不能复用话题最后一次 task 冒充。

- [ ] 写 `two_delegations_keep_independent_controls`、`unknown_is_not_retryable_chat`：控制参数精确匹配各自 id/revision/run/call；active 不等于 running；拒绝步骤、暂缓与取消后果分别准确，不提供一键全部继续或未知动作重试。
- [ ] 写 `queue_read_failure_is_not_idle`、`cancel_racing_start_reports_actual_result`：读取失败不能显示空队列/闲置；撤销已开始项重新核实并显示正在回应，不称撤销成功。普通排队只在正常完成后接续；停止/失败/撤权/服务改变/压缩/重启仍暂停；明确控制输入保持优先。
- [ ] 运行 `npm test -- tests/delegation-ui.test.tsx tests/renderer.test.tsx tests/host-queue.test.ts tests/delegation-denial.test.ts tests/pending-work-notifier.test.ts`，确认新增 UI/竞态断言失败，既有业务断言保持有效。
- [ ] 通用待处理放日常主区；定位核实后才展示真实详情。当前待确认动作邻近相关消息，历史过程折叠进记录，无法可靠关联时作为当前话题内明确标识的卡片，不编造关联或把所有历史铺在输入框前。办理权限、macOS 能力和浏览器连接同意分别呈现，返回后真实复核，重启明确待续。
- [ ] 普通待发条文案为“接下来聊这句”；保留用户文本、撤销和真实暂停原因。停止保留部分回应；继续当前任务、继续排队、纯聊天重试仍是不同操作；权限/详情读取失败时相关按钮不可操作。
- [ ] 同单测命令应 PASS；运行 `npm run test:e2e -- tests/e2e/delegations.spec.ts tests/e2e/companion-workspace.spec.ts`。保留通知载荷仅 opaque id/status/version 的哨兵测试；不把旧测试会话兼容用例当本轮交付门，也不顺手删除无关的安全测试。

**交付门：** 普通聊天没有任务看板；真实需处理事项及时可达，多个对象不串，授权和队列规则无回退。

### Task 7：统一设置、回收站、资料和对话详情

**Files:** 修改 `App.tsx`、`styles.css`、`SettingsPanel.tsx`、`McpSettingsPanel.tsx`、`SkillsPanel.tsx`、`DependencyChecks.tsx`、`TrashPanel.tsx`、`FileAccessPanel.tsx`、`ConversationUsage.tsx`；测试 `tests/renderer.test.tsx`、`tests/credentials.test.ts`、`tests/model-selection.test.ts`、`tests/purge.test.ts`；调整 `tests/e2e/credentials.spec.ts`、`sidebar.spec.ts`、`composer-usage.spec.ts`。

**Interfaces:** 保留现有面板 Props、六个设置类别与 HerApi 保存/测试/恢复/清理方法；仅改变入口与展开方式，不建立另一套配置状态或权限状态。

- [ ] 写 `more_menu_retains_settings_and_trash_operations`、`details_keep_model_usage_and_compaction`：各现有入口可用，空闲模型切换条件不变；未保存/失败状态不假称生效。写 `closing_panel_restores_focus_and_draft`：关闭返回原触发器与交流位置，迟到配置测试结果不覆盖新对象，凭据不回显。
- [ ] 写 `trash_restore_is_view_only_and_purge_failure_stays_retryable`：运行话题删除确认说明准确，成功回日常；恢复同一 ID 不续跑、不恢复审批；清理失败保留状态及重试；批量清理保留；不删除用户原文件。
- [ ] 运行 `npm test -- tests/renderer.test.tsx tests/credentials.test.ts tests/model-selection.test.ts tests/purge.test.ts`，确认新入口/状态断言失败。
- [ ] 辅助页面统一居中深绿对话框和内部滚动；当前授权从“文字与附件”就近展开，长期授权在设置；模型选择、用量、压缩和原始工具记录从当前对话更多可达。危险操作继续准确说明对象和后果，不用陪伴文案替代。
- [ ] 同单测命令应 PASS；运行 `npm run test:e2e -- tests/e2e/credentials.spec.ts tests/e2e/sidebar.spec.ts tests/e2e/composer-usage.spec.ts`。不因原型只演示部分表单而删减现有模型协议、工具、技能、桌面偏好或提示词类别。

**交付门：** 简洁主界面不牺牲现有管理、授权和诊断能力，辅助操作后能接回原交流。

### Task 8：真实 Electron 对照验收与交付记录

**Files:** 完成 `tests/e2e/life-companion-ui.spec.ts`；调整受本次入口变化影响的现有 e2e；更新 `docs/DESIGN_SYSTEM.md`；新建 `experiments/life-companion-ui-acceptance/README.md` 和 `screenshots/`。仅把受控虚构数据放入隔离 HER_DATA_DIR。

**Interfaces:** 消费 T1–T7 已实现契约；复用现有 `_electron.launch`、本地假服务和 `HER_TEST_APP_EXECUTABLE`，截图来自真实应用，不复用原型图片充当实机证据。

- [ ] 新增 `life_companion_visual_and_keyboard_states`：1034×749 内容区域与 850×620 窗口核对日常、列表、话题、记忆、衔接、审批、设置、回收站、详情及空/加载/失败/无模型/排队/未知状态；主入口、发送/停止、确认可达，无横向溢出。长中文、长标题、代码、多个附件、长错误都不挤出输入区。
- [ ] 新增键盘与窗口断言：导航/更多/卡片/文件/确认可键盘访问，焦点可见且关闭弹窗返回；中文输入法不误发；上翻不抢滚动；隐藏再显示保持草稿；真正退出重开固定日常且未完成队列不自动派发。
- [ ] 运行 `npm run check`，预期类型检查、完整单测、构建全部通过；再运行 `npm run test:e2e`，现有真实 Electron 回归全部通过。失败按所属任务修复，不以删除断言或扩大超时掩盖竞态。
- [ ] 运行 `npm run package`，使用实际产物绝对路径设置 `HER_TEST_APP_EXECUTABLE`，执行同一 `life-companion-ui.spec.ts` 和 `window-lifecycle.spec.ts`；记录产物路径、系统、窗口/内容尺寸、版本及命令。打包应用与源码应用结果分别写明。
- [ ] 以同尺寸、同受控内容并排比较原型和正式应用，逐页记录布局、留白、色彩、消息宽度、输入区与弹层偏差，修正后保存正式截图。补齐设计系统的深绿变量、字体、圆角、间距和焦点规则；不依赖截图存在就宣称原型还原。
- [ ] 验收记录区分：静态检查、模拟组件、本地假服务、源码 Electron、打包 Electron、真实服务/系统权限；真实外部动作仅在另行明确范围时验证，不用假服务通过推断实际系统已授权。

**交付门：** 全部目标页面及行为有真实应用证据，关键竞态、来源过滤和恢复有底层测试；此时才能称完整方案已落实。用户未要求本轮提交，后续执行也不从本计划自动推导 Git 提交、推送或发布。

## 4. 覆盖核对与实施注意点

| 方案部分 | 实施/验收责任 |
| --- | --- |
| §1–3 生活陪伴、能力边界与深绿基线 | T1/T2/T8；不扩展记忆和共享产品 |
| §4 三入口、具体标题、辅助页面 | T1/T2/T7 |
| §5 输入、标题、附件、排队 | T2/T3/T6 |
| §6 背景预览、真实保存、来源限制、结果核实 | T4/T5；不能缩为视觉任务 |
| §7 加载、失败、能力未就绪、过期提示 | T1/T3/T5/T6/T7 |
| §8 管理、窗口与阅读连续性 | T3/T6/T7/T8 |
| §9 键盘与内容适配 | T3/T7/T8 |
| §10 验收矩阵、§11 决定追溯 | T8 汇总；本计划不重新解释 Q9–Q12 为已接受需求 |

已自查：五类 Review Focus 均对应命名测试；新接口在相邻任务沿用同一 DTO/签名；没有将 mock 视作现成业务；没有旧数据迁移、清库或未开放功能的隐含实施项。表中源码事实只证明当前改动落点，不代表本轮已运行测试。

执行时最需要优先证明的是 T4：Pi custom message 的请求转换、来源过滤失败处理与 SQLite/Pi 两阶段保存不能只凭接口文档推断。若探针失败，应在 T4 内修正方案并保留完整需求，不用无来源复制、假成功或省掉衔接来过关。其余工程细节按本计划和现有代码约定落实，无需继续拆成产品问卷。

本轮交付为本计划、原型确认记录及文档一致性核对。当前没有修改应用源码，没有实施结果、测试通过或发布结论。
