# Tasks

## 1. 排列与气泡样式

- [x] 1.1 修改 `src/renderer/src/styles.css`：`.message-user` 使用 `flex-direction: row-reverse`；`.message-body` 改为 `flex: 0 1 auto`，加内边距 `10px 14px`、圆角 `14px` 和实心背景；用户气泡 `#d3e0c0`、最大宽度 `min(75%, 560px)`，Her 气泡 `#eceae1`、最大宽度 `min(88%, 680px)`；不加阴影、渐变和描边。运行 `npm run typecheck` 与 `npx vitest run tests/renderer.test.tsx` 通过（标记未变，原有 37 项渲染用例应全部保持通过）
- [x] 1.2 在气泡内重设文字颜色：正文 `#2f362b`；名字、时间、模型名、流式状态提示、已停止提示用 `#4f5a45`；链接 `#3f5530`；错误提示 `#8a4f3a`。代码块、行内代码改用 `#f8f8f3` 背景，`blockquote`、`th` 的背景改为与气泡有区别的色值。气泡之外的同类文字颜色不动。运行 `npx vitest run tests/renderer.test.tsx` 通过

## 2. 布局与样式的真实渲染测试

- [x] 2.1 在 `tests/e2e/desktop.spec.ts` 增加一个场景（复用 `launch`、`saveProfile`、`send`，使用 OpenAI 协议的模拟服务）：发送一条消息并等回答完成后，断言用户气泡的左右边缘都比 Her 气泡更靠右；用户头像在气泡右侧、Her 头像在气泡左侧；两种气泡的计算背景色互不相同、非透明、也不等于聊天区背景；`box-shadow` 为 `none`，`background-image` 为 `none`，四边 `border-width` 均为 0；气泡宽度不超过各自的最大宽度；正文颜色与气泡背景的对比度不低于 4.5。运行 `npm run test:e2e` 通过
- [x] 2.2 在同一场景里加入长回答与状态的断言：用模拟服务返回的失败回答（`error-model`）检查错误提示和"重试"按钮位于 Her 气泡的包围盒内；发送"慢一点"的消息，在流式阶段检查"正在写…"提示位于 Her 气泡内。运行 `npm run test:e2e` 通过

## 3. 目视确认与收尾

- [x] 3.1 在真实窗口中查看并截图：默认窗口宽度和最窄宽度（850）各一张，内容包含短消息、长消息、代码块、表格、失败回答；确认没有挤压、溢出或头像错位。截图保存到 `test-results/`，把你的确认结果记录在本任务的完成备注里。若色值或宽度需要调整，先改 design 再改 CSS
  - 完成备注：用户目视确认了真实窗口默认宽度的截图（短消息和较长的 Her 回答），认为够用；色值和最大宽度未调整。最窄宽度 850、代码块、表格、引用、失败回答这几种情况用户没有逐张目视，依据是页面测量（850 下无横向溢出，8 条气泡都在聊天区内，头像与气泡顶部对齐，代码块在气泡内滚动，表格未撑出气泡）和 e2e 场景。截图实际保存在 `/tmp/her-shots/`，因为 `test-results/` 会被 Playwright 清空。
- [x] 3.2 运行 `npm run check`（类型检查、全部 Vitest、构建）与 `npm run test:e2e`，全部通过。基线在清理后是绿的（140 项单元测试、4 个 e2e 场景），出现失败就是本变更引起的

## Workflow follow-up

- 评审通过后归档该 change。
