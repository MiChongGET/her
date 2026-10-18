# Tasks

## 1. 类型与存储层

- [x] 1.1 修改 `src/shared/types.ts`：`ConversationSummary` 增加可选 `titleCustom?: boolean`，新增 `TrashedConversation`（含 `deletedAt`），`HerApi` 增加 `renameConversation`、`trashConversation`、`restoreConversation`、`purgeConversation`、`listTrashedConversations`。此时 `tests/renderer.test.tsx` 的 mock 会因缺方法而类型报错，留到 3.2 一并补齐
- [x] 1.2 修改 `src/core/storage/store.ts`：先看当时迁移段的实际状态再定版本号。新库建表直接含 `title_custom INTEGER NOT NULL DEFAULT 0` 与 `deleted_at TEXT`；旧库在一个事务内用 `PRAGMA table_info` 判断缺哪列补哪列，再设置新的 `user_version`；去掉每次启动无条件写版本号的语句并同步调整拒绝阈值；`createConversation` 改为带列名的 `INSERT`
- [x] 1.3 在 `store.ts` 实现：`listConversations` 过滤已删除并带出 `titleCustom`；`hasConversation` 改为存在且未删除；`renameConversation`（trim、非空、按码点不超过 80、置 `title_custom = 1`、不改 `updated_at`）；`trashConversation` 与 `restoreConversation`（只写 `deleted_at`，不改 `updated_at`，恢复返回摘要）；`listTrashedConversations`（按删除时间倒序）；`purgeConversation`（仅限回收站中的对话，同一事务先删消息再删对话）；`addMessages` 的自动标题仅在 `title_custom = 0` 时生效
- [x] 1.4 在 `tests/storage.test.ts` 增加用例并运行 `npx vitest run tests/storage.test.ts` 通过：旧库升级后对话与消息保留且回收站为空；重复打开已升级的库不报错；比当前版本更新的库被拒绝；重命名拒绝空白与超过 80 码点（含 emoji 边界）且原标题不变；重命名不改变排序；重命名后发送首条消息标题不变；未重命名时仍取前 24 字符；移入回收站后列表不含它、消息仍在、`hasConversation` 为 false；恢复后回到原排序位置；永久删除后对话与消息都不存在；对未进回收站的对话永久删除被拒绝；重启后回收站内容保持

## 2. 生成中不可删除

- [x] 2.1 修改 `src/core/conversation/chat.ts`：`ActiveRequest` 在创建时记录 `conversationId`；新增 `trashConversation(id)`，若 `active?.conversationId === id` 抛出"这段对话正在生成回答，请先停止"，否则调用 `store.trashConversation`。判断与写库之间不插入 `await`
- [x] 2.2 在 `tests/chat.test.ts` 增加用例并运行 `npx vitest run tests/chat.test.ts` 通过：对话 A 生成中删除 A 被拒绝且生成不受影响；生成中删除对话 B 成功且 A 继续完成；`profiles.resolve` 尚未返回的空窗期删除 A 同样被拒绝；停止后可以删除；已进回收站的对话再 `send` 失败且不产生消息

## 3. IPC 与 preload

- [x] 3.1 修改 `src/main/ipc.ts` 与 `src/preload/index.ts`：新增 5 个通道，沿用现有 `handle` 的来源校验与 `identifier` 参数检查；重命名额外检查标题为字符串；移入回收站走 `deps.chat.trashConversation`，其余走 `deps.store`。运行 `npm run typecheck` 确认 main 与 preload 部分通过
- [x] 3.2 在 `tests/renderer.test.tsx` 的 `bridge` mock 里补上 5 个新方法，让 mock 的 `backendState` 能反映重命名和回收站状态。运行 `npm run typecheck` 全部通过，运行 `npx vitest run tests/renderer.test.tsx` 确认原有用例仍通过

## 4. 渲染进程

- [x] 4.1 修改 `src/renderer/src/Visuals.tsx` 新增 `edit` 图标。修改 `src/renderer/src/App.tsx` 与 `styles.css`：侧栏行拆成包裹元素加两个按钮，选择按钮保留 `aria-label={item.title}`，旁边新增删除图标按钮（悬停或焦点时显示，带 `aria-label`）；删除后移除该对话、清除其消息缓存与已加载标记，当前对话被删时切到第一个剩余对话，没有则 `currentId = null`；生成中删除被拒绝时显示后端返回的中文提示；`send` 里本地推算标题的条件改为"标题为 '新的对话' 且不是自定义"
- [x] 4.2 在对话头部加编辑按钮与行内标题输入框：Enter 或失焦提交，Esc 取消且不发请求，失败时显示错误并保留原标题。在 `tests/renderer.test.tsx` 增加用例并运行 `npx vitest run tests/renderer.test.tsx` 通过：重命名成功与取消；空白标题被拒绝；删除当前对话后切换与无对话时的欢迎界面；生成中删除显示提示；重命名为"新的对话"后发送首条消息，界面标题不被覆盖
- [x] 4.3 新增 `src/renderer/src/TrashPanel.tsx`，沿用 `SettingsPanel` 的模态结构、焦点陷阱与 Esc 关闭；打开时调用 `listTrashedConversations`；每行显示标题与删除时间，提供"恢复"和"永久删除"，永久删除用行内二次确认；恢复后把返回的摘要插入侧栏并按 `updatedAt` 倒序；侧栏底部加"回收站"入口。在 `tests/renderer.test.tsx` 增加用例并运行通过：列出、恢复后回到侧栏原位置、永久删除需确认、取消确认不删除、列表加载失败时显示错误

## 5. 端到端、文档与整体验证

- [x] 5.1 在 `tests/e2e/desktop.spec.ts` 增加一个场景，复用现有 `launch` 与 `send`：发送一条消息后重命名，删除，重启应用确认它在回收站中，恢复，再删除并永久删除，重启确认不再存在。运行 `npm run test:e2e` 通过；若 Electron 二进制无法下载则如实记录未能运行，不要宣称通过
- [x] 5.2 更新 `docs/implementation/stage-a.md`：在已实现范围里加入重命名与回收站，说明回收站不自动清理，永久删除只是逻辑删除、不承诺磁盘擦除，以及 `user_version` 升级后旧版本无法回退、升级前可备份 `her.sqlite`。核对文档里的路径与行为和代码一致
- [x] 5.3 运行 `npm run check`（类型检查、全部 Vitest、构建）全部通过

## Workflow follow-up

- 与 `configurable-anthropic-max-tokens` 先后应用时，后应用者需先阅读 `store.ts` 当时的迁移段，再决定版本号，不要沿用 design 里的假设数字。
- 手动验收：在真实窗口里确认悬停显示删除按钮、重命名输入框的焦点与 Esc 行为、回收站面板的键盘操作。jsdom 测试不能替代这一项。
- 评审通过后归档该 change。
