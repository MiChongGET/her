# Proposal

## Why

当前回收站只支持逐个恢复或永久删除对话，用户需要多次点击才能清理多个已删除对话。增加批量删除和全部删除功能可提升用户操作效率，尤其是在需要清理大量已删除对话时。

## What Changes

- 在回收站界面增加"全选"复选框，支持批量选择已删除对话
- 增加"批量删除"和"清空回收站"操作按钮
- 批量删除前展示二次确认对话框，显示将删除的对话数量
- 清空回收站前展示明确的警告确认对话框
- 更新后端 API 支持批量永久删除操作
- 保持单个对话的恢复和删除功能不变

## Capabilities

### New Capabilities

- `trash/batch-operations`: 回收站批量操作功能，包括批量选择、批量永久删除和清空回收站

### Modified Capabilities

<!-- No existing capabilities are being modified -->

## Impact

影响的代码和系统：

- **前端**：`src/renderer/src/TrashPanel.tsx` - 增加批量选择 UI、批量操作按钮和确认对话框
- **后端存储层**：`src/core/storage/store.ts` - 增加批量删除方法
- **IPC 通信层**：`src/main/ipc.ts` 和 `src/preload/index.ts` - 增加批量删除的 IPC 通道
- **类型定义**：`src/shared/types.ts` - 增加批量操作相关类型定义

不涉及外部 API 或依赖变更，仅为内部功能增强。
