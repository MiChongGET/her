# Her-Pi v1 骨架实施总结

**Date:** 2025-01-19  
**Change:** adopt-pi-agent-runtime (spec-driven)  
**Status:** 阶段 1–9 骨架完成，10.1–10.3 集成完成，进入 10.4（连接 IPC）

## 已完成骨架（方案 2：先写骨架，测试和集成在阶段 4 结束后一并修复）

### 阶段 1: 依赖锁定与 SDK 隔离验证 (✅ 1.1–1.5)
- Pi SDK 1.3.0 精确锁定
- 探针测试验证受控注入、会话隔离、工具白名单
- Electron 打包验证

### 阶段 2: 新资料空间、会话权威与投影 (✅ 2.1–2.3, ⏸ 2.4–2.6)
**完成：**
- `src/core/agent/factory.ts`: 数据目录结构（Her-Pi-v1/pi）、workspace 隔离
- `src/core/storage/store.ts`: 完全重写，v1 schema（811 行 → 600 行新代码）
- `src/core/agent/events.ts`: 事件适配器骨架（订阅 Pi 事件，转换为 Her 类型）

**待完成：**
- 2.4: drafts 与 her.run 关联
- 2.5: 启动恢复逻辑（interrupted 标记）
- 2.6: 垃圾桶清理

### 阶段 3: 模型接入与凭据 (✅ 3.1–3.4, 3.6, ⏸ 3.5)
**完成：**
- `src/shared/types.ts`: authMethod `api-key|headers|none`, contextWindow
- `src/main/credentials.ts`: HerCredentials (safeStorage 加密)
- `src/core/agent/factory.ts`: HerCredentialAdapter 实现 Pi CredentialStore
- `src/core/agent/events.ts`: 错误脱敏
- `src/core/storage/store.ts`: task_usage 表 + recordUsage()

**待完成：**
- 3.5: 连接测试（需要重写 probe）

### 阶段 4: Agent 宿主与并行会话 (✅ 4.1–4.6)
**完成：**
- `src/core/agent/factory.ts`: createHerAgentSession
- `src/core/agent/handle.ts`: ConversationHandle（generation, runId, 事件隔离）
- `src/core/agent/host.ts`: AgentHost（全局协调、并行执行、停止隔离）
- `src/core/agent/types.ts`: AgentConfig, HerCredentialStore, AgentSessionHandle

### 阶段 5–9: 其他骨架完成
- 工具门、资源协调（骨架）
- 压缩与容量（骨架）
- 切换模型（骨架）
- 启动恢复与清理（骨架）
- IPC 类型定义

## 阶段 10 集成进度

### 10.1 删除旧路径 ✅
- 删除 `src/core/providers/{stream,sse,message-format,probe}.ts`
- 注释掉引用

### 10.2 修复 Pi SDK 类型不匹配 ✅
**factory.ts：**
- ✅ HerCredentialAdapter 实现 CredentialStore（read, list, modify, delete）
- ✅ SessionManager.create() 参数修复
- ✅ DefaultResourceLoader() 参数修复
- ✅ customTools 改用 tools allowlist

**events.ts：**
- ✅ session.subscribe() 替代 session.on()
- ✅ 正确映射 Pi 事件类型（agent_end, turn_start, turn_end, message_update, tool_execution_start, tool_execution_end）
- ✅ assistantMessageEvent.type === 'text_delta', delta: string

### 10.3 重写 ChatService ✅
- ✅ 完全重写为 AgentHost 的轻量包装层（529 行 → 200 行）
- ✅ 保留所有公共方法：send, continueTask, cancel, approve, 等
- ✅ 改用 store.enqueueInput() 和新 schema
- ✅ 返回占位消息对象（实际内容通过事件更新）
- ⏸ TODO: AgentHost.processNextInput(), resumeTask(), 审批队列

### 10.4 连接 IPC ⏸
- [ ] 实现 registerAgentIpcHandlers()
- [ ] 连接到 AgentHost
- [ ] 事件转发到 renderer
- [ ] 重写 profile-test

### 10.5–10.9 待完成
- 补完缺失功能（工具门、投影、恢复）
- React 组件
- 重写所有测试
- 文档更新
- 端到端验收

## 当前编译状态

**核心 Agent 文件：0 错误** ✅
- `src/core/agent/{factory,events,handle,host,types,recovery}.ts`
- `src/core/conversation/chat.ts`
- `src/core/storage/store.ts`
- `src/main/credentials.ts`
- `src/shared/{types,agent-ipc}.ts`

**总编译错误：118 个**（从初始 157 → 118）
- 主要在 `access.ts`, `tools.ts` 等引用旧 store 方法的文件

## 下一步

按 TODO.md，继续 10.4（连接 IPC），然后 10.5–10.9 补完功能和验收。
