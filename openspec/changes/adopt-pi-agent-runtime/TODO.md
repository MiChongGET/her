# Her-Pi v1 集成清单

**阶段 10 集成工作清单**：骨架代码已完成，现在需要连接所有部分，修复编译错误，重写测试。

## 10.1 删除旧路径 ✅

- [x] 删除 `src/core/providers/stream.ts`
- [x] 删除 `src/core/providers/sse.ts`
- [x] 删除 `src/core/providers/message-format.ts`
- [x] 删除 `src/core/providers/probe.ts`
- [x] 注释掉 `chat.ts` 和 `ipc.ts` 中的旧引用

## 10.2 修复 Pi SDK 类型不匹配 ✅

### `src/core/agent/factory.ts` ✅
- [x] 修复 `HerCredentialAdapter` 实现 `CredentialStore` 接口
  - Pi 的 `CredentialStore` 有四个方法：read, list, modify, delete
  - `read()` 返回 `Credential | undefined`，其中 `Credential = { type: "api_key", key?: string }`
  - `modify()` 和 `delete()` 抛出错误（Her 管理凭据）

- [x] 修复 `customTools` 类型
  - 改用 `tools: config.tools`（allowlist）
  - `customTools` 暂时传空数组，标记为 TODO

- [x] 修复 `SessionManager.create()` 调用
  - 需要 `cwd` 和 `sessionDir` 参数

- [x] 修复 `DefaultResourceLoader` 构造
  - 需要 `{ cwd, agentDir, settingsManager }` 参数

### `src/core/agent/events.ts` ✅
- [x] 修复 Pi 事件类型映射
  - `session.subscribe()` 而不是 `session.on()`
  - `AgentEvent` 类型：agent_start, agent_end, turn_start, turn_end, message_start, message_update, message_end, tool_execution_start, tool_execution_update, tool_execution_end
  - `message_update` 的 `assistantMessageEvent.type === 'text_delta'`，字段是 `delta: string`
  - `tool_execution_start/end` 的字段是 `toolCallId, toolName, args, result, isError`
  - `agent_end` 的字段是 `messages: AgentMessage[]`

## 10.3 重写 ChatService ✅

ChatService 已完全重写为 AgentHost 的轻量包装层：

- [x] 删除旧的 `streamChat` 调用和 messages 表操作
- [x] 改用 `store.enqueueInput()` 入队消息
- [x] 改用 `store.getConversation()`, `store.getTask()` 查询
- [x] 实现所有公共方法：send, continueTask, cancel, cancelActive, decideApproval, resolveUnknownToolCall, getActiveRequest, getConversationTask, trashConversation, shutdown
- [x] 返回占位消息对象，实际内容通过事件更新
- [x] 标记 TODO：AgentHost.processNextInput(), resumeTask(), 审批队列、未知工具处理

**编译状态：**
- ChatService: ✅ 0 错误
- 总编译错误：118 个（从 157 降到 118）

**剩余工作：**
- TODO 10.3: 实现 AgentHost.processNextInput() — 出队 pending input，调用 startRun()
- TODO 10.3: 实现 AgentHost.resumeTask() — 恢复中断任务
- TODO 10.3: 连接审批队列和未知工具处理到 AgentHost

## 10.4 连接 IPC (`src/main/ipc.ts`)

- [ ] 实现 `registerAgentIpcHandlers()`（在 `src/shared/agent-ipc.ts` 中定义）
- [ ] 连接到 `AgentHost` 的方法：
  - `ENQUEUE_INPUT` → `host.startRun()`
  - `STOP_TASK` → `host.stop()`
  - `COMPACT` → `handle.session.compact()`
  - `SWITCH_MODEL` → `host.switchModel()`
  - `APPROVE_TOOL` → 工具门的审批流程
- [ ] 事件转发：`AgentHost` 的事件 → IPC → renderer
- [ ] 重写 `her:profile-test` 使用新的 probe（3.5）

## 10.5 实现缺失的功能

### 工具执行（5.1–5.6 补完）
- [ ] `src/core/agent/gate.ts`: 连接实际工具执行器
  - Pi 的 `tool_call` 事件 → Her 的工具注册表
  - 调用 Her 的工具（read, write, bash, grep 等）
  - 结果返回给 Pi session

- [ ] `src/core/agent/resources.ts`: 资源队列实现
  - 实际的队列逻辑
  - 桌面独占、文件目标排队

### 投影逻辑（2.3–2.4 补完）
- [ ] `src/core/agent/events.ts`: `reconcileProjection()` 实现
  - 从 `SessionManager.getEntries()` 拉取
  - 对比 `conversation.last_entry_id`
  - 转换 Pi entry → Her `ProjectedSessionEntry`
  - 写入 `projection_entries` 表

- [ ] Draft fragments（2.4）
  - 中断时保存文本片段到 `draft_fragments`
  - 关联 `her.run` entry

### 启动恢复（2.5, 8.1 补完）
- [ ] `src/core/agent/recovery.ts`: 实现 `recoverOnStartup()`
  - 查询非终态任务，批量标记 `interrupted`
  - 查询 `dispatched` 工具，标记 `unknown`
  - 暂停有 `running` 请求的输入队列

### 垃圾桶（2.6, 8.2 补完）
- [ ] `src/core/agent/recovery.ts`: 实现 `cleanupOldTrashed()`
  - 删除 30 天前 `deleted_at` 的会话
  - 级联删除 projection、drafts、Pi session 文件

### 模型切换（7.3 补完）
- [ ] `src/core/agent/host.ts`: `switchModel()` 容量对比
  - 从 Pi session 读取当前 token 用量
  - 对比新模型的 `contextWindow`
  - 不足时拒绝切换

### 连接测试（3.5 补完）
- [ ] 重写 `src/core/providers/probe.ts` 使用 Pi ModelRuntime
  - 构建最小 prompt
  - 调用 `model.stream()`
  - 返回测试结果

## 10.6 更新 React 组件

### `src/renderer/components/App.tsx`
- [ ] 显示多会话并行状态
- [ ] 显示输入队列（pending, running, cancelled）
- [ ] 显示任务状态（queued, running, waiting_approval, compacting, completed, stopped, failed, interrupted）

### `src/renderer/components/TaskStatus.tsx`
- [ ] 新任务状态：`waiting_resource`, `compacting`, `interrupted`
- [ ] 排队消息与撤销
- [ ] 等待审批 UI

### `src/renderer/components/SettingsPanel.tsx`
- [ ] `authMethod` 选择：api-key, headers, none
- [ ] `contextWindow` 输入（自定义服务必填）
- [ ] Pi 目录模型 vs 自定义服务

### `src/renderer/components/TrashPanel.tsx`
- [ ] 清理未完成任务（interrupted）
- [ ] 清理 30 天前的已删除会话

## 10.7 重写所有测试

所有测试都需要按新 schema 和新架构重写：

### 存储层
- [ ] `tests/storage.test.ts`: v1 schema（services, conversations, tasks, tool_calls, task_usage, projection_entries, draft_fragments）

### Agent 层
- [ ] `tests/agent/factory.test.ts`: createHerAgentSession, 工具白名单
- [ ] `tests/agent/handle.test.ts`: generation, runId, 事件隔离
- [ ] `tests/agent/host.test.ts`: 并行会话、停止隔离
- [ ] `tests/agent/events.test.ts`: Pi 事件转换、投影对账
- [ ] `tests/agent/gate.test.ts`: 工具门、资源队列
- [ ] `tests/agent/recovery.test.ts`: 启动恢复、垃圾桶清理

### 凭据层
- [ ] `tests/credentials.test.ts`: HerCredentials, safeStorage 加密, 独立 provider ID

### IPC 层
- [ ] `tests/ipc.test.ts`: agent IPC 通道、事件转发

### 端到端
- [ ] `tests/e2e/conversation.test.ts`: 创建会话 → prompt → 响应 → UI 更新
- [ ] `tests/e2e/parallel.test.ts`: 并行会话不串线
- [ ] `tests/e2e/stop.test.ts`: 停止只影响本会话
- [ ] `tests/e2e/switch-model.test.ts`: 切换模型保留历史
- [ ] `tests/e2e/compaction.test.ts`: 压缩成功/失败
- [ ] `tests/e2e/recovery.test.ts`: 启动恢复 interrupted 任务
- [ ] `tests/e2e/trash.test.ts`: 垃圾桶清理

## 10.8 文档更新

- [ ] `AGENTS.md`: 更新技术栈、项目结构、IPC、数据目录说明
- [ ] 更新 README（如果有涉及架构的说明）

## 10.9 端到端验收

验收标准（所有测试通过 + 手动验证）：

- [ ] `npm run check` 通过（typecheck + lint）
- [ ] `npm test` 通过（所有单元测试和集成测试）
- [ ] 手动验证：创建会话 → 发送消息 → 收到回复 → 界面正确显示
- [ ] 手动验证：并行会话（两个会话同时 prompt，互不干扰）
- [ ] 手动验证：停止任务（只影响当前会话）
- [ ] 手动验证：切换模型（历史保留）
- [ ] 手动验证：手动压缩成功
- [ ] 手动验证：重启后 interrupted 任务不可恢复，新输入正常工作
- [ ] 手动验证：垃圾桶（删除会话 → 30 天后清理）

## 当前编译错误总结

```
src/core/agent/events.ts: Pi 事件类型字段名不匹配（14 个错误）
src/core/agent/factory.ts: CredentialStore 接口、customTools 类型、SessionManager.create() 参数（4 个错误）
src/core/conversation/chat.ts: 旧 store 方法（预期的，待重写）
```

修复优先级：
1. **factory.ts** — 修复 Pi SDK 接口不匹配（影响所有会话创建）
2. **events.ts** — 修复事件类型映射（影响所有事件处理）
3. **chat.ts** — 重写或删除（影响 IPC 入口）
4. **补完缺失功能** — 工具门、投影、恢复、垃圾桶
5. **React 组件** — UI 更新
6. **测试** — 全部重写
