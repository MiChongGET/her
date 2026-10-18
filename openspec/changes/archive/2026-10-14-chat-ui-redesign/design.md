# Design

## Context

动机和范围见 proposal.md，需求见 specs/chat-message-layout/spec.md。当前状态：

- `App.tsx` 里每条消息是 `<article class="message message-{role}" data-status=...>`，内部为 `.message-avatar` 加 `.message-body`；`.message-body` 里依次是 `.message-meta`、正文（用户为 `.user-text`，Her 为 `.markdown`）、状态提示和重试按钮。
- `styles.css` 中 `.message` 是 `display: flex; align-items: flex-start; gap: 13px`，`.message-body` 为 `flex: 1`，所以内容撑满整行、全部靠左，没有背景。
- 测试依赖的标记：e2e 用 `article.message-assistant[data-status=...]`，渲染测试用文字和 `aria-label="聊天消息"`。这些标记本次都不改。
- 聊天区底色是 `#f8f7f3`（`.chat-main` 的径向渐变中心略亮）。窗口最小宽度 850，`body` 的 `min-width` 为 760。

## Goals / Non-Goals

**Goals:**
- 只用 CSS 完成左右排列、角色底色和扁平气泡，不改 DOM 结构和类名。
- 所有文字与气泡底色的对比度达到 4.5:1，包括次要文字、链接和错误提示。

**Non-Goals:**
- 深色模式、主题色可配置、气泡尾巴、头像样式、侧栏和输入框样式。
- 解决流式生成时气泡宽度逐字增长带来的轻微抖动（见 Risks）。

## Decisions

**1. 让 `.message-body` 本身成为气泡，不新增包裹元素。**
元信息（名字、时间、模型名）、正文、状态提示和重试按钮都在 `.message-body` 里，把底色、圆角和内边距加在它上面，这些内容自然都落在气泡内，满足 spec 中"状态显示在气泡内"。备选是新增 `.message-bubble` 并把元信息留在气泡外：需要改 `App.tsx` 的标记，还要同步渲染测试，收益只是版面上更接近某些聊天软件，不值得。

**2. 用 `flex-direction: row-reverse` 实现用户消息靠右。**
`.message-user` 设为 `row-reverse` 并 `justify-content: flex-start`，头像自然落在气泡右侧。`.message-body` 从 `flex: 1` 改为 `flex: 0 1 auto` 加 `max-width`，宽度随内容变化。备选是 `margin-left: auto`：头像和气泡的相对顺序需要另外处理，`row-reverse` 更直接。

**3. 最大宽度：用户气泡 `min(75%, 560px)`，Her 气泡 `min(88%, 680px)`。**
Her 的回答常含表格和代码，需要更宽；用户消息多是短句，窄一些更接近聊天观感。表格和代码块已有 `overflow-x: auto`，超出时在气泡内滚动。具体数值是我的建议，需目视确认。

**4. 色值（已计算对比度，聊天区底色 `#f8f7f3`）：**

| 用途 | 色值 | 说明 |
| --- | --- | --- |
| 用户气泡 | `#d3e0c0` | 与聊天区对比 1.29 |
| Her 气泡 | `#eceae1` | 与聊天区对比 1.12，与用户气泡 1.15 |
| 正文 | `#2f362b` | 用户气泡 9.03，Her 气泡 10.35 |
| 次要文字（名字、时间、模型名、状态提示） | `#4f5a45` | 用户气泡 5.27，Her 气泡 6.05 |
| 链接 | `#3f5530` | 用户气泡 5.95，Her 气泡 6.82 |
| 错误提示 | `#8a4f3a` | Her 气泡 5.34（错误只出现在 Her 的回答里） |
| 代码块、行内代码背景 | `#f8f8f3` | 与 Her 气泡 1.13，其上文字 11.71 |

现有的 `#6f7966`、`#667951`、`#a06752` 在新气泡上只有约 3.6 到 4.1，不达标，所以气泡内的次要文字、链接、错误提示要换成更深的颜色；气泡外的同色文字不动。扁平样式下两种气泡本身对比很低（1.15），区分主要靠左右位置和绿与灰的色相差，这是"不用阴影和描边"这一要求的直接后果。

**5. 气泡内其他元素。**
- 气泡内的 `blockquote`、`th`、行内代码背景改用与气泡有区别的色值，避免和 Her 气泡的底色融在一起（现有 `#eef0e7` 与 `#eceae1` 几乎相同）。
- 气泡内不再需要 `.message-body` 的 `padding-top: 1px`，改为统一的内边距 `10px 14px`。

**6. 测试策略：用 Playwright 量真实渲染结果。**
jsdom 不做布局，量不出位置和计算样式。e2e 里用 `boundingBox()` 比较左右位置，用 `getComputedStyle` 读取背景色、`box-shadow`、`background-image`、`border-width`，并在测试里计算对比度。渲染测试只需保持通过。

## Risks / Trade-offs

- [流式时气泡宽度逐字变宽，肉眼可见轻微抖动] → 宽度随内容变化是 spec 要求；气泡有最大宽度，长回答很快就稳定在上限。如果实际观感不好，再考虑给 Her 气泡设固定宽度，需要另行修改 spec。
- [色值没有设计稿，是我按现有绿灰色系推算的] → 对比度是算过的，但"好不好看"只能由你目视判断；任务里保留了一步截图确认。
- [扁平气泡之间对比度很低（1.15）] → 靠位置和色相区分。如果你觉得区分度不够，最直接的调整是加深用户气泡，这不影响其他部分。
- [窗口最窄 850 时气泡最大宽度按百分比计算，可能与头像和内边距挤压] → 最大宽度取百分比与像素的较小值，并在任务里用最窄窗口截图确认。
- [基线] 写这份设计时仓库有 3 项单元测试失败，已在清理 Responses 协议时修复，现在 `npm run check` 与 e2e 都是绿的，本变更的验证直接用它们。
