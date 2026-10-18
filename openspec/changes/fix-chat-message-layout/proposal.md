# Proposal

## Why

聊天消息布局存在多个用户体验问题：(1) 用户消息和助手消息的布局不一致，用户消息右对齐但元信息（头像、名字、时间）没有对齐；(2) 用户消息气泡的最大宽度受限于 75%，导致长文本在宽屏上出现不必要的换行；(3) 附件（图片、文件）与文本内容之间缺少视觉层次，附件显示在文本下方但没有明确的分隔。这些问题影响了消息的可读性和整体视觉体验。

## What Changes

- 统一用户消息和助手消息的布局结构，使元信息（头像、名字、时间）在用户消息中也保持一致的对齐方式
- 调整用户消息气泡的最大宽度限制，减少不必要的文本换行
- 优化附件的显示位置和样式，在文本内容和附件之间增加视觉层次
- 改进消息元信息的间距和排版，提升整体可读性

## Capabilities

### New Capabilities

无

### Modified Capabilities

- `chat-message-layout`: 修复用户消息布局不一致、最大宽度限制过小、附件显示缺少层次等问题

## Impact

影响范围：
- `src/renderer/src/App.tsx`：消息渲染结构可能需要微调
- `src/renderer/src/styles.css`：消息布局相关的 CSS 样式（`.message-user`, `.message-body`, `.message-meta`, `.message-attachments` 等）
- 用户体验：改进后的布局将提升消息的可读性和视觉一致性
