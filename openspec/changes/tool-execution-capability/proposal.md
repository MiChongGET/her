# Proposal

## Why

Her 已经能解析多种协议的 Function Calling 流，但工具调用执行层直接拒绝。这意味着模型可以返回工具调用意图，Her 却无法响应，对话流程被迫中断。解锁工具执行能力可以让 Her 从纯聊天伙伴升级为能执行实际任务的助手——读文件、查时间、发请求，跑通"工具调用 → 执行 → 结果回填 → 续生成"的完整闭环。

## What Changes

- 新增工具执行器，在 Electron 主进程中接收模型返回的工具调用事件，执行对应工具后将结果回传给模型，继续生成回答
- 初始实现 5 个高价值工具：文件读取、文件写入、时间查询、HTTP 请求、天气查询
- 工具执行全程在主进程完成，不暴露给渲染进程，符合现有安全模型
- 工具列表通过 `StreamChatInput.tools` 动态注入，与模型能力对齐
- 对话历史中记录工具调用的输入和输出，作为对话上下文保留

## Capabilities

### New Capabilities
- `tool-execution`: 定义工具执行的核心生命周期——工具发现、调用执行、结果回填、错误处理、续生成，以及工具列表的动态注入机制

### Modified Capabilities
<!-- 无现有 spec 涉及工具执行行为变更 -->

## Impact

- `src/core/providers/stream.ts`：`ProviderEvent` 的 `tool` 事件已有解析，执行层接入 `ChatService`
- `src/core/conversation/chat.ts`：`generate()` 中 `event.type === 'tool'` 分支从抛错改为执行工具
- `src/core/tools/`：新增工具定义、执行器和注册表
- `src/shared/types.ts`：扩展 `ModelTool` 和 `ProviderEvent` 类型以支持工具结果回填
- 测试：工具执行器单元测试、流式响应集成测试
- 无破坏性变更——现有对话流在未配置工具时行为不变