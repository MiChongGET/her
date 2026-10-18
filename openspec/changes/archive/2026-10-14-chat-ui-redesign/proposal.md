# Proposal

## Why

聊天界面里用户和 Her 的消息都靠左排列，没有背景色，只靠头像和名字区分（`styles.css` 的 `.message` 是 `display: flex` 加 `align-items: flex-start`，`.message-body` 为 `flex: 1` 撑满整行）。长对话里要逐条看名字才能分清是谁说的。用户希望采用常见的聊天布局：自己的消息在右、Her 的在左，且两种角色用不同底色的扁平气泡。

## What Changes

- 用户消息靠右排列，头像在气泡右侧；Her 的消息靠左，头像在气泡左侧。
- 每条消息的内容区有实心背景和圆角，两种角色底色不同，且都与聊天区底色有区分。
- 气泡为扁平样式：纯色、无渐变、无阴影、无毛玻璃，也不加描边。
- 气泡宽度随内容变化，并有最大宽度，避免长文本撑满整行。Markdown 中的代码块、引用、表格在气泡内仍要清晰可辨。
- 流式生成、失败、已停止、重试等状态提示仍显示在对应气泡内。
- 本次只改样式，不改消息数据、IPC 和现有的 `article.message-user` / `article.message-assistant`、`data-status` 标记。

不在范围内：深色模式、气泡尾巴、可调节的主题色、头像样式、侧栏和输入框样式、消息操作菜单（复制、引用等）。

## Capabilities

### New Capabilities
- `chat-message-layout`: 聊天消息在界面中的排列、气泡底色与样式，以及各种消息状态在气泡中的呈现。项目目前没有任何 spec，之后聊天界面的其他展示要求可以补充到这里。

### Modified Capabilities
<!-- openspec/specs/ 目前为空，没有可修改的既有 capability。 -->

## Impact

- 代码：`src/renderer/src/styles.css`（`.message`、`.message-body`、`.message-meta`、`.user-text`、`.markdown` 相关规则）。预计不需要改 `App.tsx`。
- 测试：`tests/e2e/desktop.spec.ts` 增加布局与样式断言（真实 Chromium 才能量位置和计算样式）；`tests/renderer.test.tsx` 现有用例依赖的标记不变，应保持通过。
- 依赖、IPC、数据库：无变化。
- 假设（已记录在 design.md）：具体色值是我按现有绿灰色系给出的建议，没有设计稿，实现后需要你目视确认。
