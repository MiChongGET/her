# Proposal

## Why

对话的标题只能由第一条用户消息自动截取 24 个字符生成，之后无法修改；对话一旦创建也无法移除，侧栏只会越来越长。`HerApi` 没有重命名和删除接口，`HerStore` 也没有对应方法。误删对话的代价很高（聊天记录是本机唯一一份），所以删除先进回收站，再从回收站彻底删除。

## What Changes

- 对话可以重命名：标题去掉首尾空白后不能为空，最长 80 个字符；重命名不改变对话在侧栏的排序。
- 手动设置过的标题不会再被"第一条用户消息自动命名"覆盖。
- 删除对话时只是移入回收站：从侧栏消失，不能再发送消息，消息内容完整保留。
- 正在生成回答的对话不能删除，需先停止生成。
- 侧栏新增"回收站"入口，列出已删除的对话和删除时间，可以恢复，或经二次确认后永久删除。永久删除会同时删除该对话的全部消息，且不可撤销。
- 回收站不自动清空，对话会一直保留到用户永久删除。
- 本地 SQLite 的 `conversations` 表增加两列（标题是否自定义、删除时间），旧库启动时自动升级，已有对话按未删除、自动标题处理。
- 新增 5 个 IPC 通道和对应的 `HerApi` 方法：重命名、移入回收站、恢复、永久删除、列出回收站。

不在范围内：清空回收站、回收站自动过期清理、回收站内预览消息、批量选择、对话搜索、对话排序方式调整、导出。

## Capabilities

### New Capabilities
- `conversation-management`: 对话列表的管理行为，包括重命名、移入回收站、恢复和永久删除，以及它们对标题生成、列表显示和发送消息的影响。项目目前没有任何 spec，对话的创建、历史恢复等已有行为之后可以补充到这里。

### Modified Capabilities
<!-- openspec/specs/ 目前为空，没有可修改的既有 capability。 -->

## Impact

- 代码：`src/shared/types.ts`（新增 `TrashedConversation`，`HerApi` 增加 5 个方法）、`src/core/storage/store.ts`（迁移、列表过滤、重命名/回收站方法、自动标题逻辑）、`src/core/conversation/chat.ts`（记录进行中请求所属的对话，新增生成中检查）、`src/main/ipc.ts`、`src/preload/index.ts`、`src/renderer/src/App.tsx` 与新增的回收站面板。
- 数据：与 `configurable-anthropic-max-tokens` 一样需要提升 `user_version`，两个变更都会改 `store.ts` 的迁移段。先应用的占用下一个版本号，后应用的顺延；详见 design.md。
- 测试：`tests/storage.test.ts`、`tests/chat.test.ts`、`tests/renderer.test.tsx` 增加用例，渲染测试里模拟的 `window.her` 需要补上新方法；`tests/e2e/desktop.spec.ts` 增加一个重启后仍可恢复的场景。
- 依赖：无新增。
