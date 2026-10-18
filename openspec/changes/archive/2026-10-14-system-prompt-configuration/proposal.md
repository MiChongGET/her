# Proposal

## Why

Her 的系统提示词（system prompt）目前硬编码在 `src/core/conversation/chat.ts` 中。用户无法自定义 AI 伙伴的性格、语气或行为风格，也无法针对不同场景调整提示词。将提示词暴露为可配置项，让用户可以定制属于自己的 Her。

## What Changes

- 在设置面板新增"系统提示词"独立栏目
- 将当前硬编码的提示词作为默认值持久化到数据库
- 提供文本框让用户编辑和保存提示词
- 聊天时从数据库读取提示词并传入模型请求
- 支持恢复默认提示词

## Capabilities

### New Capabilities
- `settings/system-prompt`: 用户可以在设置中查看、编辑和保存系统提示词，系统在发起聊天请求时使用用户配置的提示词

### Modified Capabilities
<!-- 无需修改现有 capability 的 requirements -->

## Impact

- **数据库**: `settings` 表需要能够存储系统提示词（当前 `settings.value` 是 JSON 字符串，可扩展字段）
- **设置面板**: 新增第三个 tab "系统提示词"
- **聊天逻辑**: `ChatService` 从数据库读取提示词而非使用常量
- **向后兼容**: 现有数据库若无提示词字段，使用当前硬编码的默认值
