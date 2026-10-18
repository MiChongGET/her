# Design

## Context

动机见 proposal.md，需求见 specs/conversation-management/spec.md。当前相关代码的状态：

- `conversations` 表只有 `id, title, created_at, updated_at` 四列，`createConversation` 用位置参数 `INSERT INTO conversations VALUES (?, ?, ?, ?)`。
- `HerStore.addMessages` 在插入对话的第一条用户消息时，无条件把标题改成消息的前 24 个字符。
- `messages.conversation_id` 是外键，没有 `ON DELETE CASCADE`，删对话前必须先删消息。
- `hasConversation` 被 `ChatService.send` 和 `her:messages` 通道用来判断对话是否可用。
- `ChatService.active` 只记录请求 id、`AbortController` 和 `message`；`message` 要等 `profiles.resolve` 的异步步骤之后才赋值，期间无法知道请求属于哪个对话。
- 主进程启动时，如果 `listConversations()` 为空就自动新建一个空白对话。
- `store.ts` 的迁移段目前每次启动无条件执行 `PRAGMA user_version = 1`，拒绝打开的阈值是 `> 1`。

## Goals / Non-Goals

**Goals:**
- 删除是可恢复的：回收站里的对话保持完整数据，仅对列表、发送和消息读取不可见。
- 把"能不能删"的判断放在能做单元测试的地方，而不是只在 IPC 处理函数里。

**Non-Goals:**
- 不做自动过期清理、清空回收站、回收站内预览消息。
- 不做磁盘层面的安全擦除（见 Risks）。

## Decisions

**1. 软删除用 `deleted_at TEXT`（NULL 表示未删除），自定义标题用 `title_custom INTEGER NOT NULL DEFAULT 0`。**
备选是单独建 `trashed_conversations` 表并搬移数据，但消息外键会跟着复杂化，恢复时还要搬回去。加两列后：
- `listConversations` 加 `WHERE deleted_at IS NULL`，排序不变。
- 新增 `listTrashedConversations`，`WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`。
- `hasConversation` 改为"存在且未删除"。这样 `send` 和读取消息自动拒绝回收站里的对话，spec 中"已删除的对话不能发送消息"无需在调用方各写一遍。
- 永久删除需要判断"是否在回收站"，用单独的内部检查，不复用 `hasConversation`。

**2. 重命名、移入回收站、恢复都不更新 `updated_at`。**
现有 `touchConversation` 会更新 `updated_at` 并影响排序。这三个操作直接写各自的列，不调用它。这样重命名不会让对话跳到列表顶部，恢复后也回到原来的位置。

**3. 自动标题只在 `title_custom = 0` 时生效。**
`addMessages` 里更新标题的分支加上该条件。重命名同时设置 `title_custom = 1`。
渲染进程 `App.send` 目前在本地也会按"标题等于 '新的对话'"推算新标题。如果用户恰好把标题改成"新的对话"，界面会显示与数据库不一致的标题。为此给 `ConversationSummary` 增加可选的 `titleCustom?: boolean`，渲染进程的本地推算改为"标题等于 '新的对话' 且不是自定义"。可选字段保证现有测试里的对话对象无需修改。

**4. 标题校验放在 `HerStore.renameConversation` 内。**
trim 后非空，且按 Unicode 码点计数不超过 80（用 `Array.from(title).length`，避免 emoji 被算成两个字符）。对话不存在或已在回收站时抛出"该对话已经不存在"。校验在存储层，单元测试可以直接覆盖，IPC 层只检查参数类型。

**5. "生成中不能删除"由 `ChatService` 负责。**
- `ActiveRequest` 在创建时就记录 `conversationId`，消除 `message` 尚未赋值的空窗。
- 新增 `ChatService.trashConversation(id)`：若 `active?.conversationId === id` 则抛出"这段对话正在生成回答，请先停止"，否则调用 `store.trashConversation(id)`。
- `ipc.ts` 的回收站通道只调用这个方法，不自己判断。

判断与写库之间没有 `await`，主进程是单线程，所以不会出现"检查通过后请求才开始"的竞态。备选是在 IPC 处理函数里写判断，但 `ipc.ts` 依赖 Electron，现有测试不覆盖它。

**6. 永久删除在一个事务内先删消息再删对话，且只接受回收站里的对话。**
对话不在回收站时抛错。永久删除不依赖 `ChatService`：回收站里的对话不可能正在生成（规则 5），也不能再接收新请求（规则 1）。

**7. 迁移：按列是否存在判断，版本号取"当前最新 + 1"。**
- 新库：建表语句直接包含两个新列。
- 旧库：在一个事务里，对 `conversations` 查 `PRAGMA table_info`，缺哪列补哪列，再设置新的 `user_version`。
- `createConversation` 改为带列名的 `INSERT`，否则列数不匹配会报错。
- 去掉每次启动无条件写 `user_version` 的语句，拒绝打开的阈值同步调整。

**与 `configurable-anthropic-max-tokens` 的关系：** 两个变更都要提升 `user_version`，都改 `store.ts` 的迁移段。具体版本号取决于谁先应用：先应用的升到 2，后应用的升到 3，并复用先应用者已经建立的迁移结构。应用本变更时必须先看 `store.ts` 当时的状态，不要照抄这里写的数字。由于每步都按列是否存在判断，两个变更无论哪个在前，结果都一致。

**8. 渲染进程的交互。**
- 侧栏行拆成包裹元素加两个按钮：原来的选择按钮保持不变（保留 `aria-label={item.title}`，现有测试依赖它），旁边新增删除图标按钮，悬停或获得焦点时显示。不能把按钮嵌进按钮里。
- 重命名入口放在对话头部标题旁的编辑按钮，点击后标题变成输入框：Enter 或失焦提交，Esc 取消。
- 删除当前对话后：从列表移除，清除该对话缓存的消息和"已加载"标记，切换到列表里第一个剩余对话，没有则 `currentId = null`。后者复用 `send` 里已有的"没有对话就新建"路径。
- 回收站是新组件 `TrashPanel`，沿用 `SettingsPanel` 的模态结构、焦点陷阱和 Esc 关闭。打开时才调用 `listTrashedConversations`。永久删除用行内二次确认，与设置里"确认删除服务"一致。
- 恢复接口返回恢复后的 `ConversationSummary`，渲染进程插入列表并按 `updatedAt` 倒序排好，不重新拉取整个 bootstrap，以免覆盖尚在流式更新的本地状态。
- `Visuals.tsx` 新增 `edit` 图标；删除用已有的 `trash`，恢复用已有的 `retry`。

## Risks / Trade-offs

- [数据仍在磁盘上] 移入回收站不删任何数据，永久删除也只是 `DELETE`，没有 `VACUUM`，SQLite 文件里的空闲页可能还残留旧内容 → 与设计文档里"逻辑清理、不承诺取证级擦除"的立场一致；界面文案用"回收站"和"永久删除"，不写"彻底擦除"。
- [回收站无限增长] 不自动清理 → 这是用户明确选择的行为，列为非目标。
- [两个变更改同一段迁移代码] 后应用的需要处理合并 → 见规则 7，按列判断使结果与顺序无关，但版本号要现看现定。
- [旧版无法打开升级后的库] 与另一个变更相同 → 现有版本检查的设计行为，文档里说明升级前可备份。
- [IPC 层缺单元测试] `ipc.ts` 依赖 Electron，参数校验靠类型检查和 e2e 覆盖 → 业务规则都已下沉到 store 和 `ChatService`，IPC 只做类型检查和转发。
- [启动时仍会自动新建空白对话] 全部对话都进回收站后重启，会出现一个空白对话 → 这是现有启动行为，保持不变，不与 spec 冲突（spec 只约束运行中删除后的界面）。
