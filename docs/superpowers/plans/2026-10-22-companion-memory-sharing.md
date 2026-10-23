# Her 记忆与进展共享 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现有来源和范围的记忆、工作进展共享，以及纠正、别记、遗忘和共享撤回，覆盖设计 Q4、Q7、Q11 与 Q13 的模型边界。

**Architecture:** Pi 会话继续作为聊天历史权威；SQLite 保存记忆状态、来源依赖、共享版本和清理任务。扩展现有 SourceGuard，使普通请求、压缩、重启继续使用同一来源资格检查；MemoryService 统一管理记忆与共享开关事务。完整遗忘通过公开 Pi API 重建经过验证的替代会话，不直接修改 JSONL。

**Tech Stack:** Electron 44、React 19、TypeScript strict、node:sqlite、Pi SDK 1.3.0、Vitest、Playwright Electron。

**Spec:** [私人伙伴交互与授权设计](../specs/2026-10-22-private-companion-interaction-design.md)，并沿用 [原产品设计 §7.4](../specs/2026-10-13-her-design.md) 的纠正、别记、遗忘定义。

## Global Constraints

- 执行顺序为 A 工作空间 → B 委托授权 → C 本计划；A 提供 `TopicInfo{conversationId,kind:'daily'|'work',shareProgress:boolean,shareRevision:number}`。
- Q4 仅共享简短工作进展和用户明确表达的感受；原始文档、代码、详细讨论留在工作话题，个人偏好与工作记忆按范围区分。
- Q7 普通整理在已允许范围内不逐条弹窗；推测不得冒充用户事实，纠正、别记和遗忘各有真实效果。
- Q11 关闭共享立即收回既有摘要及派生记忆的后续日常使用；日常可见历史保留，原工作话题仍能使用自己的资料。
- Q13 未共享话题的待确认提示只进入界面状态，标题、目标、正文和隐藏通知载荷不得进入日常模型上下文。
- 保持 SQLite `user_version=1`；新表是本计划提出的工程扩展，不回读旧库、不执行旧 v7→v8 迁移、不改变 Pi 历史权威。
- 不默认导入或整理启用前的历史；不纳入旧方案的 FTS、经验卡、独立整理模型配置、每日配额或旧后台调度。
- “别记”保留原文但阻止长期记忆/关系整理；“遗忘”按明确选择清理原文、摘要、衍生及索引，不能以隐藏代替清理。
- 不声称能够撤回已经送达模型服务的内容；操作生效后禁止后续请求及迟到本地提交重新引入。
- 本文件只规划；每任务记录命令、结果与剩余证据缺口；只有用户请求提交时才暂存、提交及推送任务文件。

## Review Focus

- 关闭共享恰逢工具续轮或整理完成：旧版本不能再发布或送出，其他话题继续运行；归属任务 2、3。
- 相同正文分别来自个人陈述和工作摘要：按独立来源及范围判断，不能因去重扩大共享；归属任务 1、3。
- 纠正后又恢复回收站、切换模型或重启：旧状态不能复活，“别记”阻断仍有效；归属任务 4。
- 多分支、工具调用配对、压缩记录、未知 Pi entry：保留合法历史与展示时间，无法重建时明确 blocked；归属任务 5。
- 遗忘在每个持久化阶段崩溃或删除旧文件失败：先隔离后恢复清理，不能提前显示完成；归属任务 6、7。

---

## 文件职责与共享契约

| 文件 | 职责 |
| --- | --- |
| `src/shared/types.ts` | 记忆、来源、纠正/排除/遗忘、共享切换与展示接口；复用 A 的 TopicInfo |
| `src/core/storage/store.ts` | v1 增量业务表、共享版本事务、记忆版本、清理任务、Pi 会话映射切换 |
| `src/core/memory/service.ts`（新增） | 来源资格、记忆写入/读取、共享撤回、提交前校验与变更事件 |
| `src/core/memory/extraction.ts`（新增） | 本轮有限材料的结构化整理，复用本轮模型配置，不引入独立后台平台 |
| `src/core/memory/tools.ts`（新增） | 明确记住/纠正/别记/遗忘的内置工具与宿主局部授权 |
| `src/core/memory/history-cleanup.ts`（新增） | 公开 Pi API 重建、映射验证、清理恢复状态机 |
| `src/core/agent/sources.ts`、`source-guard.ts` | 可追踪来源及普通请求/压缩/恢复过滤 |
| `src/core/agent/host.ts`、`factory.ts`、`budget.ts` | 请求来源绑定、撤回停派发、整理触发、现有容量预算接入与清理中的会话隔离 |
| `src/main/index.ts`、`ipc.ts`、`src/preload/index.ts` | 服务装配、受检 IPC、主窗口桥接 |
| `src/renderer/src/MemoryPanel.tsx`（新增）、`App.tsx`、`styles.css` | 增加真实记忆入口、列表、依据、编辑与遗忘预览，接通 A 的工作页共享开关 |

以下接口均为待实现契约，引用已有接口时按当前源码核对，不把本文件视为运行能力证明。

- `MemorySourceRef`：`{kind:'pi-entry'|'memory'|'progress',id:string,revision:number,conversationId:string,sessionId?:string,entryId?:string}`；Pi 来源必须有后两个字段，宿主解析、验证身份。
- `MemorySourceDependencies`：`{memorySources:MemorySourceRef[],fileSources:FileSources}`；每条 Pi/记忆/摘要来源保存其上游依赖，不能以 entry 仍存在替代 file/grant 或共享版本核验。
- `MemoryScope`：`{kind:'personal'} | {kind:'work',conversationId:string}`；工作材料不能自行晋升为个人事实。
- `MemoryRecord`：`{id:string,content:string,revision:number,scope:MemoryScope,status:'active'|'superseded'|'excluded',sources:MemorySourceRef[],validFrom:string,validUntil?:string}`。
- `ProgressDraft`：`{conversationId:string,summary:string,feelingQuote?:string,sources:MemorySourceRef[],expectedShareRevision:number,operationId:string}`；感受必须对应用户原句，摘要不能含原始资料正文。
- `MemoryWriteContext`：`{conversationId:string,userEntry:MemorySourceRef,operationId:string,signal:AbortSignal}`，仅宿主创建；工具和 renderer 不得提供“已获批准”布尔值。
- `MemorySelection`：`{memoryIds:string[],sourceRefs:MemorySourceRef[]}`。
- `ForgetPreview`：`{selection:MemorySelection,conversationIds:string[],memoryIds:string[],progressIds:string[],retainedArtifacts:Array<{id:string,label:string}>,revisionToken:string}`；预览不复制待删除正文。
- `ForgetResult`：`{jobId:string,status:'completed'|'pending'|'blocked',reason?:string}`；pending/blocked 不得显示“已遗忘”。
- `MemoryUpdateInput`：`{id:string,expectedRevision:number,content:string,operationId:string}`；`MemoryExcludeInput`：`{selection:MemorySelection,operationId:string}`；`MemoryForgetInput`：`{preview:ForgetPreview,operationId:string}`。
- `MemoryEntryBaseline`：`{conversationId:string,sessionId:string,entryIds:string[]}`；只存启用时已有 ID 集合，不能以新时间戳把旧来源重新认作新增。
- `MemoryContextSelection`：`{text:string,sources:MemorySourceRef[],estimatedTokens:number}`；仅是本次有界请求材料，不持久化另一份资料全文。

### Task 1: 建立来源与范围存储，不读取旧数据

**Files:** Modify `src/shared/types.ts`、`src/core/storage/store.ts`；Create `src/core/memory/service.ts`；Test `tests/memory-store.test.ts`。

**Interfaces:**
- Consumes：A 的 `HerStore.getTopicInfo(id: string): TopicInfo | null`、`listTopicInfo(): TopicInfo[]`；现有 `HerStore.getConversation(id: string): StoredConversation | null`。
- Produces：`MemoryService.listMemories(scope: MemoryScope): MemoryRecord[]`、`getSources(memoryId: string): MemorySourceRef[]`、`isUsable(refs: MemorySourceRef[], targetConversationId: string): boolean`。
- Produces：Store 的 `getMemory(id: string): MemoryRecord | null`、`saveMemory(input: MemoryRecord, expectedRevision: number | null): void`；写入、来源引用与排除状态在同一事务提交。

- [ ] **Step 1: 写失败测试。** `stores_scoped_memory_without_old_database` 断言新数据根之外的旧 SQLite/JSONL 未读；已有 v1 可重开、版本仍为 1，其他版本仍拒绝。
- [ ] **Step 2: 加入范围断言。** `same_text_different_sources_keeps_scope` 断言相同正文不能合并成跨范围授权；`sharing_off_is_denied_from_first_read` 断言 share=false 的来源从第一次筛选即拒绝日常使用。
- [ ] **Step 2a: 加入上游依赖断言。** `entry_exists_but_file_grant_revoked` 在 Pi entry 仍存在时撤销/改变其 file/grant，断言由该 entry 派生的记忆和进展均不可用；循环、缺失依赖 fail closed。
- [ ] **Step 3: 运行确认红灯。** `npx vitest run tests/memory-store.test.ts`，预期缺失接口或明确的范围断言失败。
- [ ] **Step 4: 实现最小业务表。** 增加 `memories`、`memory_sources`、`memory_dependencies`、`memory_exclusions`、`memory_baselines`、`progress_summaries`；保存来源版本而非复制原聊天，辅助读取状态不得成为第二份历史权威。
- [ ] **Step 5: 设置启用边界。** 持久化 `MemoryEntryBaseline`，默认仅处理之后新进入的来源；share=false 仍可保存工作范围记忆，但不能发布进展；无来源、失效/回收站来源拒绝使用。A 的 legacy 会话没有 TopicInfo，不自动导入；新 work 保持 A 已定义的 true/1，不能因开关存在就补读旧内容。
- [ ] **Step 5a: 实现依赖闭包核验。** 校验 Pi entry 的来源 file/grant 与共享依赖，沿 memory/progress 关系递归核验版本；按来源所属话题检查原资料授权，再检查目标话题共享资格，不把工作资料授权扩成日常可直接读取文件的授权。
- [ ] **Step 6: 验证并记录。** 运行任务 1 命令，预期全绿；记录真实表、接口及未实现的后续能力，不运行旧提案迁移。

### Task 2: 扩展三路径来源过滤及共享版本事务

**Files:** Modify `src/core/memory/service.ts`、`src/core/storage/store.ts`、`src/core/agent/sources.ts`、`source-guard.ts`、`host.ts`；Test `tests/memory-sources.test.ts`、`tests/source-filter.test.ts`、`tests/attachments.test.ts`。

**Interfaces:**
- Consumes：任务 1 的 `isUsable`；现有 `indexBranch(branch: SessionEntry[]): SourceIndex`、`createSourceGuard(options: SourceGuardOptions): Extension`。
- Produces：`MemoryService.setProgressSharing(topicId: string, enabled: boolean, expectedRevision: number): Promise<TopicInfo>`、`onSourcesChanged(listener: (refs: MemorySourceRef[]) => void): () => void`。
- Produces：`AgentHost.invalidateMemorySources(refs: MemorySourceRef[]): void`；只停止依赖被撤回来源的运行/压缩，并使它们的后续派发与迟到发布失效。
- Produces：`memorySourceKey(ref: MemorySourceRef): SourceKey` 与 `parseMemorySourceKey(key: SourceKey): MemorySourceRef | null`，在 `sources.ts` 为新增来源编码/解码；file/grant 仍由 FileAccessService 判定。

- [ ] **Step 1: 写失败测试。** `sharing_revoke_filters_normal_compact_restart` 捕获三个真实请求体，断言旧摘要、派生回答、压缩 previousSummary 均不包含秘密标记，原工作话题请求仍可用本话题原文。
- [ ] **Step 2: 加入并发断言。** `revoke_during_followup_and_compaction` 在发送前闸门关闭共享，断言旧版本无后续请求；`unrelated_run_survives_revoke` 断言无依赖会话继续。
- [ ] **Step 3: 运行确认红灯。** `npx vitest run tests/memory-sources.test.ts`，预期共享版本/模型请求体断言失败。
- [ ] **Step 4: 扩展来源标记。** 保留 file/grant 解析，在 `her.run`/`her.sources` 自定义记录中持久保存新增 memorySources；通过 Pi entry 身份映射记录每次模型暴露来源及其后续助手、工具、压缩派生；不能将用户独立输入无条件染成工作来源。新增 key 不得经过 `toFileSources` 后丢失或默认有效。
- [ ] **Step 5: 实现共享事务。** CAS 校验 expectedRevision，在同一事务更新开关、递增 shareRevision、失效旧摘要/日常派生资格；提交后立即通知 Host；源消息仍保留供人查看。
- [ ] **Step 6: 封闭恢复入口。** 普通 context、自动/手动压缩、切换模型压缩、重启继续均调用同一资格规则；校验异常取消请求或过滤，未知来源不能默认通过。
- [ ] **Step 6a: 验证重新开启。** `reenable_does_not_revive_revoked_version` 断言旧共享版本仍不可用，新发布必须依据当前合法来源和新版本；不通过重新摘要自动读回启用基线之前的内容。
- [ ] **Step 7: 验证并记录。** `npx vitest run tests/memory-sources.test.ts tests/source-filter.test.ts tests/attachments.test.ts`，预期新增三路径和原文件撤权用例全绿；记录每类请求捕获证据。

### Task 3: 发布有依据的进展与普通记忆

**Files:** Create `src/core/memory/extraction.ts`；Modify `src/core/memory/service.ts`、`src/core/agent/host.ts`、`factory.ts`、`budget.ts`；Test `tests/memory-extraction.test.ts`、`tests/progress-sharing.test.ts`、`tests/memory-budget.test.ts`。

**Interfaces:**
- Consumes：任务 1 的来源资格与任务 2 的共享版本；本轮 profile/model、Pi 已完成消息及 B 的 `DelegationService.getProgressEvidence(conversationId: string): DelegationProgressEvidence[]`。
- Produces：`MemoryService.publishProgress(input: ProgressDraft): Promise<void>`、`remember(content: string, scope: MemoryScope, sources: MemorySourceRef[], context: MemoryWriteContext): Promise<MemoryRecord>`。
- Produces：`extractCandidates(input: {conversationId:string,sourceRefs:MemorySourceRef[],profileId:string,model:string,shareRevision:number}, signal: AbortSignal): Promise<{memories:Array<{content:string,scope:MemoryScope,sources:MemorySourceRef[]}>,progress?:ProgressDraft}>`。
- Produces：`MemoryService.selectContext(input: {conversationId:string,tokenBudget:number,query?:string}): MemoryContextSelection`；tokenBudget 必须为非负有限整数，不能在每轮直接注入 `listMemories` 全量。

- [ ] **Step 1: 写失败测试。** `extracts_progress_and_explicit_feeling_only` 用任务完成记录、用户感受及含秘密的附件构造输入，断言仅简短进展与有原句证据的感受进入日常，不携带附件/代码/详细讨论。
- [ ] **Step 1a: 锁定整理输入。** `progress_extractor_never_receives_raw_material` 捕获整理请求，断言只有 B 的结构化状态、有限的新用户明确陈述/感受和必要结果证据；文档/代码正文、原始工具返回、详细讨论不作为摘要器输入。
- [ ] **Step 1b: 拒绝越界候选。** `progress_candidate_with_raw_text_is_rejected` 让模型建议夹入原文、额外来源和无证据感受，断言不发布；工作状态文字按 B 状态/计数生成，候选不得覆盖真实状态，感受必须引用允许的用户感受片段。
- [ ] **Step 2: 加入资格断言。** `old_or_disabled_sources_are_not_imported`、`late_candidate_cannot_publish_after_revoke`、`same_operation_is_idempotent` 分别验证启用基线、版本变化和重复整理。
- [ ] **Step 2a: 加入容量断言。** `long_memories_fit_remaining_context_budget` 使用长中文、混合英文及大量记录验证选择结果估算不超过 tokenBudget；0 预算返回空，单条过大跳过且不截断事实，缺席条目仍可面板查看。
- [ ] **Step 3: 运行确认红灯。** `npx vitest run tests/memory-extraction.test.ts tests/progress-sharing.test.ts`，预期候选/提交接口缺失或错误发布断言失败。
- [ ] **Step 4: 连接整理触发。** 一轮已稳定落盘后合并待整理新增用户陈述与 B 结构化证据；同一话题最多一个整理请求，前台新输入优先取消过时整理。复用本轮模型配置创建受控请求，不读取完整文档/代码后再依赖模型承诺过滤，不开放外部工具、不持久保存额外原文副本、不新增独立模型设置或后台日程；未完成/unknown 不写成成功。
- [ ] **Step 5: 控制材料与发布。** 整理只读必要来源，JSON 候选不能指定权限；宿主填写 operationId/shareRevision 并核验明确陈述、引用范围、当前版本后事务提交，无证据/冲突不激活；普通有效新增不弹逐项审批。从共享摘要派生的记忆继承该摘要来源及共享版本，不能改成 personal 就摆脱撤回。
- [ ] **Step 6: 连接日常读取。** Host 从现有 `compactionBudget` 扣除当前上下文、系统/工具提示、输入和回复预留后传入 tokenBudget；用 `estimateTextTokens` 对实际附加文本计量，按相关性/有效性选取整条个人记忆和共享摘要，以用户资料而非指令注入；缓存回查权威版本，Q13 提醒/通知对象始终不作为来源。
- [ ] **Step 6a: 验证整理隔离。** `consolidation_is_data_only_and_foreground_first` 断言资料中的指令不获得工具权限，主对话新输入取消整理，失败不影响已完成的聊天也不宣布“已记住”。
- [ ] **Step 7: 验证并记录。** `npx vitest run tests/memory-extraction.test.ts tests/progress-sharing.test.ts tests/memory-budget.test.ts`，预期全绿；记录选材、schema 校验、有界上下文和请求体证据，说明真实模型抽取质量仍需任务 8 验收。

### Task 4: 落实纠正与“别记”，保持各自含义

**Files:** Create `src/core/memory/tools.ts`；Modify `src/core/memory/service.ts`、`src/core/tools/types.ts`、`src/core/tools/registry.ts`、`src/core/agent/host.ts`；Test `tests/memory-mutations.test.ts`。

**Interfaces:**
- Consumes：任务 3 的 `remember`；任务 2 的来源变更事件；B 的工具授权接点。
- Produces：`correctMemory(id: string, expectedRevision: number, content: string, context: MemoryWriteContext): Promise<MemoryRecord>`、`excludeFromMemory(selection: MemorySelection, context: MemoryWriteContext): Promise<void>`。
- Produces：内置 `remember`、`correct_memory`、`exclude_memory`；入参 JSON Schema 禁止任意来源路径、权限标志及额外字段，宿主补齐用户来源身份。

- [ ] **Step 1: 写失败测试。** `correction_replaces_current_fact_not_history` 断言新版本用于现状、旧记录保留有效期；`exclude_keeps_chat_but_blocks_consolidation` 断言原文可查看，后续整理不能写回。
- [ ] **Step 2: 加入授权与恢复断言。** 明确用户纠正可生效，模型伪造授权/工作资料自述不可成为个人事实；回收站恢复、模型切换、重启和重复工具调用不复活旧状态或重复效果。
- [ ] **Step 3: 运行确认红灯。** `npx vitest run tests/memory-mutations.test.ts`，预期缺失操作或恢复/权限断言失败。
- [ ] **Step 4: 实现版本操作。** 纠正创建新证据和 superseded 链；别记记录来源排除且清理已派生长期记忆资格；两者提交前重验用户来源、目标版本和 signal，迟到整理不得覆盖。
- [ ] **Step 5: 实现专用宿主授权。** 本地记忆操作仍标为写；仅内置操作可按明确用户意图与已允许记忆范围取得本次局部授权，不复用为 MCP/外部动作放行，也不信任模型对授权的自述。
- [ ] **Step 6: 验证并记录。** 运行任务 4 命令，预期全绿；记录“别记”与原文删除的区别，目标歧义返回候选而不猜测。

### Task 5: 用公开 Pi API 验证完整遗忘的可行性

**Files:** Create `tests/pi-sdk/forget-rebuild.test.ts`、`experiments/pi-sdk-1.3.0/forget-rebuild.md`；只在探针通过后 Create `src/core/memory/history-cleanup.ts`。

**Interfaces:**
- Consumes：`SessionManager.create(cwd, sessionDir, options)`、各公开 `append*`、`branch(id)`、`resetLeaf()`、`getEntries()`、`getTree()`、`buildSessionProjection()`。
- SDK 核对依据：当前 `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts` 已声明上述方法及 `appendContextEdit`、`appendCompaction`、`branchWithSummary`；执行时再次核对锁定 1.3.0，名称存在不代表重建探针已经通过。
- Produces：`rebuildRetainedSession(input: {conversationId:string,sourceSessionId:string,excludedEntryIds:string[],destinationDirectory:string}): Promise<{sessionId:string,sessionFile:string,entryMap:Record<string,string>,displayTimes:Record<string,string>}>`；只接受经过白名单解析的 entry。

- [ ] **Step 1: 写保留/删除断言。** 合成用户/助手、工具调用与结果、分支、压缩、context_edit、label、Her 自定义来源/结果记录；删除选定来源及派生，断言其正文不在任何新分支或摘要中。
- [ ] **Step 2: 写身份断言。** 断言所有保留父子关系、活动叶、工具配对和引用可重映射，原展示时间不变；未知 entry/customType 返回 blocked，不静默丢弃；全部删除也能形成可继续的空会话。
- [ ] **Step 2a: 写完整来源断言。** 校验 `her.run`、`her.result`、`her.sources` 中的展示正文/引用，以及 branch_summary、context_edit 的替代正文均按来源清理；不会因只处理 message entry 留下副本。
- [ ] **Step 3: 运行探针。** `npx vitest run tests/pi-sdk/forget-rebuild.test.ts`；先记录失败原因，再仅通过公开 create/append*/branch 实现受控新会话构建并复跑。
- [ ] **Step 4: 核对重开。** 用公开 open 重新读取输出及解析器校验，再比较合法树、来源引用、时间和模型投影；不调用私有 `_rewriteFile`/`_persist`，不拼写或手改 JSONL。
- [ ] **Step 5: 记录硬门槛。** 在探针报告保存 SDK 版本、命令和全部断言；若公开 API 无法满足保留/清理，任务 6 标记 blocked，禁止降级为仅隐藏或把原文件留作未披露备份。

### Task 6: 持久化遗忘清理与崩溃恢复

**Files:** Modify `src/core/memory/history-cleanup.ts`、`service.ts`、`src/core/storage/store.ts`、`src/core/agent/host.ts`、`factory.ts`；Test `tests/memory-forget.test.ts`。

**Interfaces:**
- Consumes：任务 5 全部通过的重建接口；现有 `HerStore.replaceMessageProjection(...)`、`AgentHost` 停止/派发版本边界。
- Produces：`MemoryService.previewForget(selection: MemorySelection): Promise<ForgetPreview>`、`forget(preview: ForgetPreview, context: MemoryWriteContext): Promise<ForgetResult>`、`recoverForgetJobs(): Promise<void>`。
- Produces：Store `beginForgetJob(preview: ForgetPreview, operationId: string): string`、`switchConversationSession(jobId: string, conversationId: string, replacement: {sessionId:string,sessionFile:string,entryMap:Record<string,string>,displayTimes:Record<string,string>}): void`。

- [ ] **Step 1: 写失败测试。** `forget_cleans_selected_text_and_all_known_derivatives` 检查旧/新 Pi 文件、原文投影、摘要、记忆、`input_requests.content`、检索/整理缓存与草稿均无目标正文；独立保留产物仍在且预览已列出，用户外部原文件不被删除。
- [ ] **Step 2: 注入阶段崩溃。** 在停派发、墓碑持久化、新会话写入/验证、映射切换、删旧文件、清理缓存、投影重建各点重启；断言旧源从不恢复可用、重复操作幂等、无半份结果宣称完成。
- [ ] **Step 3: 运行确认红灯。** `npx vitest run tests/memory-forget.test.ts`，预期清理/恢复接口缺失或阶段断言失败。
- [ ] **Step 4: 实现清理状态机。** 停相关派发与压缩 → 在 v1 新增 `forget_jobs`/最小墓碑并持久化 → 公共 API 构建并验证替代会话 → SQLite 事务切换会话映射及来源 ID → 删除旧文件和受影响缓存/索引 → 重建展示投影 → completed。
- [ ] **Step 5: 固定恢复与时间映射。** `openConversationHistory` 根据已提交 session 映射精确选文件，禁止“目录中第一个文件”；任务存储分支/ID/原展示时间映射但不存被删正文，切换前后都能恢复清理。
- [ ] **Step 5a: 保留动作事实。** 与被遗忘来源关联的动作账本只保留执行/unknown 身份及必要状态，清理依赖该来源的正文载荷；独立委托或产物按预览保留，遗忘不得变成取消/重放动作。
- [ ] **Step 6: 封闭失败。** 删除失败保留 job 和隔离状态、显示 pending/可重试；未知类型或不支持保留条件显示 blocked；清理结束前不恢复相关请求；新用户明确重述可作新来源，但不解除旧墓碑。
- [ ] **Step 7: 验证并记录。** 运行任务 6 命令与任务 5 探针，预期全绿；记录每阶段崩溃结果及实际文件检查，不把逻辑清理描述为磁盘取证级擦除。

### Task 7: 接通记忆入口、来源与共享开关

**Files:** Modify `src/shared/types.ts`、`src/main/index.ts`、`ipc.ts`、`src/preload/index.ts`、`src/renderer/src/App.tsx`、`styles.css`；Create `src/renderer/src/MemoryPanel.tsx`；Test `tests/memory-ipc.test.ts`、`tests/renderer.test.tsx`。

**Interfaces:**
- Consumes：任务 1–6 服务接口；A 的工作区导航、工作话题页面与 TopicInfo；记忆能力就绪后由 C 新增真实入口，不要求 A 提供假记忆面板。
- Produces：HerApi `listMemories(scope: MemoryScope): Promise<MemoryRecord[]>`、`getMemorySources(id: string): Promise<MemorySourceRef[]>`、`correctMemory(input: MemoryUpdateInput): Promise<MemoryRecord>`、`excludeMemory(input: MemoryExcludeInput): Promise<void>`。
- Produces：HerApi `previewForget(selection: MemorySelection): Promise<ForgetPreview>`、`forgetMemory(input: MemoryForgetInput): Promise<ForgetResult>`、`setProgressSharing(input: {conversationId:string,enabled:boolean,expectedRevision:number}): Promise<TopicInfo>`；IPC 内创建用户操作来源。
- Produces：`her:memory-list`、`her:memory-sources`、`her:memory-correct`、`her:memory-exclude`、`her:memory-forget-preview`、`her:memory-forget`、`her:topic-sharing-set`；禁止另建直接修改 shareProgress 的绕过入口。

- [ ] **Step 1: 写失败测试。** 断言记忆内容/来源/范围/有效状态均真实可查；人工打开历史来源不重新授权模型使用；伪造来源、跨话题 ID、陈旧 revision、非主框架 IPC 被拒绝。
- [ ] **Step 2: 写交互断言。** 纠正、别记、遗忘按钮分别展示实际效果；遗忘先显示具体影响及保留产物，确认明确范围后不重复通用审批；pending/blocked 保持真实状态且可重试/查看原因。
- [ ] **Step 3: 运行确认红灯。** `npx vitest run tests/memory-ipc.test.ts tests/renderer.test.tsx`，预期新 API/交互断言失败。
- [ ] **Step 4: 实现桥接与面板。** 复用主框架校验、错误遮蔽和真实服务，不在 renderer 保存来源权限；工作页开关调用 MemoryService 事务完成后更新 TopicInfo，失败保留实际状态。
- [ ] **Step 5: 连接自然语言遗忘。** 内置 `forget` 调用同一 preview/forget 服务；目标明确时复用明确意图，目标不明时列候选；不把“别记”转成删除，不把“忘记聊天”转成取消独立委托。
- [ ] **Step 6: 验证并记录。** 运行任务 7 命令，预期全绿；记录 Q13 界面通用提醒始终没有接入 memory/context 数据路径。

### Task 8: 完整流程验收与证据交付

**Files:** Create `tests/e2e/companion-memory.spec.ts`；Modify `docs/superpowers/specs/2026-10-22-private-companion-interaction-design.md`（仅实现/验证状态），记录本计划执行结果。

**Interfaces:** Consumes：A→B→C 全部实际入口；Produces：Q4/Q7/Q11/Q13 验收记录与尚未通过的限制，不新增产品接口。

- [ ] **Step 1: 增加真实 Electron 场景。** 工作进展进入日常 → 查看来源 → 关闭共享 → 日常下一轮/压缩/重启继续均无旧内容 → 工作原文仍可用；再分别执行纠正、别记、遗忘和清理失败恢复。
- [ ] **Step 2: 增加隐私场景。** 未共享话题待批准时日常仅有“有一件事需要你确认”，通知无标题/目标/正文，点击进入原话题；截获日常模型请求证明提示对象与私密细节均未进入。
- [ ] **Step 3: 运行集成验证。** `npm run check`，再 `npm run test:e2e -- tests/e2e/companion-memory.spec.ts`；预期类型/单元/构建与完整场景全通过。
- [ ] **Step 4: 验证真实模型边界。** 使用隔离测试数据和已配置模型复核中文明确感受、纠正、无依据回忆与工作摘要，不用模拟服务结果冒充真实抽取质量；记录模型/版本/输入和实际结果。
- [ ] **Step 5: 完成结果记录。** 对每个 Q 标明源码/假服务请求体/真实 Electron/真实模型证据；任务 5 若 blocked，则完整遗忘和本计划不得标为完成；提交仍只在用户请求后执行。
