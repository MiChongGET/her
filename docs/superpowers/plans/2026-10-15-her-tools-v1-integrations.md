# Her Tools V1 Integrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 接通真实 Mac、现有 Chrome 与可选搜索服务，完成本机应用包和端到端验收。

**Architecture:** 预设提供经过验证的命令、工具允许清单和动作判断，仍通过统一 manager/registry 执行。依赖检查返回可操作诊断；外部运行时分别安装，Her 管理服务进程。

**Tech Stack:** Peekaboo、Playwright MCP Chrome 扩展、open-webSearch、MCP SDK、Electron Packager、Vitest、Playwright Electron。

**Spec:** [定稿设计](../specs/2026-10-15-her-tools-v1.md)；[共享契约与依赖](2026-10-15-her-tools-v1.md)。

## Global Constraints

- 任务需要时允许使用前台焦点及共享输入；展示操作目标，提供全局停止快捷键。
- 依赖分别安装，Her 检查并引导；本地工具进程由 Her 管理。
- Playwright 连接现有 Chrome，承担默认网页搜索与操作；open-webSearch 保留为默认关闭的可选预设。
- 发送、删除、覆盖前确认；未知效果先观察。真实动作验收使用专用测试页面、临时文件和测试应用窗口。
- 签名、公证和自动更新不属于本次工具能力交付；当前无 package 脚本，T13 必须增加。

## Review Focus

- Terminal 有权限而 Her 子进程无权限：检测实际执行宿主，不能只验证终端；T07/T13。
- Retina、窗口变化、旧 snapshot：不能误点另一窗口；T07。
- 扩展断开或标签范围变化：不能悄悄接其他 profile/标签；T08。
- 模型直接指定隐藏的脚本/嵌套 agent：Host 执行入口必须拒绝；T07/T08。
- 打包后依赖路径、PDF worker 或退出行为变化：逐项复验；T13。

## T07：预设依赖检查与 Peekaboo

**Files:** Create `src/core/mcp/presets.ts`, `src/core/mcp/dependencies.ts`, `src/core/mcp/peekaboo.ts`, `docs/implementation/her-tools-v1-compatibility.md`; Modify `src/core/mcp/registry-adapter.ts`, `src/main/index.ts`, `src/renderer/src/McpSettingsPanel.tsx`, `src/shared/types.ts`; Test `tests/dependencies.test.ts`, `tests/peekaboo.test.ts`, `tests/renderer.test.tsx`。

**Interfaces:** `checkPresetDependencies(presetId: string, serviceId: string): Promise<DependencyCheck[]>`；DependencyCheck 含 component/status(ready/missing/incompatible/permission_required)/message/resolvedPath?/version?。`createPeekabooAdapter(manager: McpConnectionManager, serviceId: string)` 返回 registry 注册项，其 assess 使用 T03 ActionAssessment。

- [x] 编写无终端 PATH、命令不存在、权限缺失、版本不匹配、旧 snapshot、Retina 坐标、输入后超时、隐藏工具直调测试；运行 `npm test -- tests/dependencies.test.ts tests/peekaboo.test.ts` 观察 RED。
- [x] 实现四个预设的依赖元数据与只读检测接口；检测不安装软件、不触发业务操作。保存验证后的绝对 executable 路径，提供 Node/npm、Python、Peekaboo 和扩展的分项安装指引。
- [x] 验证 Peekaboo 发布版本，记录版本/命令/宿主/协议/工具 schema；使用支持的 `mcp --allow-foreground`。默认进程内宿主；若实际需要外部 Bridge，显式指定 socket 并检测能力，不能自动切到另一个宿主。允许前台权限由 Host 设置，不由模型自改。
- [x] 只注册必要的应用/窗口发现、观察、点击、输入、键盘、滚动、菜单等经验证工具；排除 browser、嵌套 agent/analyze 和任意脚本。模型伪造被隐藏名字也拒绝执行。
- [x] 将 see 图片、snapshot、坐标映射和目标所有权纳入统一结果；动作使用新观察及同一目标。把已派发但无确认的输入/点击保留为 unknown，重新观察后再决定；UI 展示前台正在操作的应用。
- [x] 运行目标测试与 `npm run typecheck`。然后从开发版 Her 操作专用 TextEdit 窗口完成打开、读取、中文输入、结果复查、停止；记录实际 Screen Recording/Accessibility/输入能力。不得把这次开发验收替代 T13 的 .app 验收。

官方依据：[MCP 命令](https://github.com/openclaw/Peekaboo/blob/main/docs/commands/mcp.md)、[权限](https://github.com/openclaw/Peekaboo/blob/main/docs/permissions.md)。以发布包实测为准。

> T07 验收补充：原生菜单限读取；无法绑定文档窗口的点击拒绝。后台 AX 中文替换由随后独立 fresh see 确认，原始派发 unknown 保留；前台追加未获成功证明，未重试。实际开发宿主与本地模型桩链路已验证，.app/TCC、物理停止按键和坐标点击实机验收仍在 T13。

## T08：现有 Chrome 与可选 open-webSearch

**Files:** Create `src/core/mcp/browser.ts`, `src/core/mcp/web-search.ts`; Modify `src/core/mcp/presets.ts`, `src/core/mcp/dependencies.ts`, `src/core/mcp/registry-adapter.ts`, `src/renderer/src/McpSettingsPanel.tsx`, `docs/implementation/her-tools-v1-compatibility.md`; Test `tests/browser-tools.test.ts`, `tests/web-search.test.ts`。

**Interfaces:** `createBrowserAdapter(manager, serviceId)`、`createWebSearchAdapter(manager, serviceId)` 返回与 T07 相同的注册项；工具按已锁定发布版本发现，不能猜测名字或 schema。搜索结果保留 title/url/snippet 与来源引擎；失败与零结果区分。

- [x] 写已有登录态/获准标签、断开连接、页面提交确认、禁止 evaluate/代码工具、WebMCP 不暴露、OWS 默认关闭、搜索失败不冒充零结果测试；运行 `npm test -- tests/browser-tools.test.ts tests/web-search.test.ts` 观察 RED。
- [x] 固定并验证 Playwright MCP 发布版，使用 `--extension`，保留扩展连接批准及标签组范围；禁用页面 WebMCP（使用该版支持的参数），Host 允许清单仅含导航、快照、点击、输入、表单、标签、截图及必要等待。
- [x] 将页面身份/URL/元素引用/观察版本送入 action assessment；导航、标签变化后重新观察。提交、发送、删除、覆盖或无法判断的动作在 T03 确认；不自动通过切换 profile、任意 JS 或 Peekaboo 绕过浏览器连接范围。
- [x] 固定 open-webSearch 发布版，显式 `MODE=stdio`，预设默认 disabled。用户启用后可搜索和提取公开网页；不配置到用户的已登录 Chrome，不自动带入其 Cookie；搜索引擎阻断/验证码/网络错误给出可操作状态。
- [ ] 运行目标测试和 `npm run typecheck`。真实 Chrome 完成连接选择、登录态复用、搜索→阅读→带来源回答、测试表单提交前确认、断开再连；启用 OWS 后单独验证并退出清理。将版本与真实结果加入兼容记录。

官方依据：[Playwright MCP](https://github.com/microsoft/playwright-mcp)、[扩展](https://github.com/microsoft/playwright/blob/main/packages/extension/README.md)、[open-webSearch](https://github.com/Aas-ee/open-webSearch)。


> T08 软件验收通过：fix1 独立复审通过，463 项测试、类型/构建、隔离 Electron 3 项通过；OWS 真实检索与请求提取通过。用户明确延后 Chrome 扩展安装，最后一项真实浏览器连接/登录态/标签/表单验收转入 T13，保持未勾选。公开接口没有稳定标签身份；所有 Chrome 调用经明确确认覆盖可能的崩溃标签清理，未知结果可由人工单独处理，原记录保留。

## T13：应用包、综合回归与真实验收

**Files:** Create `scripts/package.mjs`, `tests/e2e/tools.spec.ts`, `docs/implementation/her-tools-v1-acceptance.md`; Modify `package.json`, `package-lock.json`, `electron.vite.config.ts`, `playwright.config.ts`, `tests/helpers/mock-provider.ts`, `tests/helpers/mock-mcp.ts`, `README.md`, `docs/implementation/her-tools-v1-compatibility.md`。

**Interfaces:** 新增 `npm run package`：先构建再用固定版本 `@electron/packager` 生成当前 Mac 架构的 `.app`，输出至 release，bundle ID 固定为 `com.her.desktop`；不执行签名、公证、上传或发布。E2E 可通过测试入口替换 MCP/模型地址与数据目录，产品入口不暴露测试后门。

- [x] 写 E2E：配置 mock MCP→多步任务→等待确认→批准/停止；添加文档→解析→来源；扫描页→合法图片请求；重启→旧记录可见且任务不续做。运行 `npm run test:e2e -- tests/e2e/tools.spec.ts` 确认新行为 RED。
- [x] 扩充本地 mock 的工具图片、延迟、已执行后断线、401 和多协议请求记录；只记录必要断言，不输出密钥/原文。测试旧聊天、设置草稿、图片附件与回收站不回归。
- [x] 增加打包脚本，打包 out、运行依赖和 PDF 资源，排除 experiments、用户资料、开发缓存和测试数据；检查从 Finder 启动的运行路径及外部依赖检测。采用官方 [Electron Packager](https://github.com/electron/packager)，锁定兼容版本。
- [x] 运行 `npm run check`、`npm run test:e2e`、`npm run package`；Expected：全部成功，生成可启动 .app。失败时修复对应任务，不通过降低断言或删除原测试绕过。
- [ ] 从 .app 验证 Peekaboo 权限/中文输入/前台停止、Chrome 扩展登录态/标签范围、真实 MarkItDown 四种格式、全扫描/混合 PDF、静态鉴权 HTTP MCP、自管进程退出；对支持的三种模型协议分别验证真实图片工具结果，缺少端点的项目如实记未验证。
- [x] 验收记录逐项填写应用/服务/模型版本、操作、预期、实际、证据路径和通过/失败/未验证；不能用 mock 证明真实服务兼容。正文不保存凭据和私人资料。
- [x] README 写清依赖分装、授权/撤销、停止/继续、扩展连接、可选搜索、OAuth 边界、运行与卸载自管数据说明；独立复核功能范围与验收记录后才勾选完成。

> final-fix1 历史记录：592 项检查、源码 Electron23通过/1既有可选跳过、包20通过；整体审查 I1 已修复并通过限定范围复审，schema12。M1历史撤销来源展示、M2既有日志 warning 明确延期。当时真实 Mac、现有 Chrome、外部模型及最终包实网验收尚未全部完成；最新状态见下方续验与完整验收文档。

> 2026-10-16 续验：已取得真实 Mac 权限/中文/专用按钮独立读回、选择器/来源打开、公司/Haiku 图片与扫描/混合 PDF、实体 Command+Option+Shift+S 停止证据；最终包 open-webSearch 实网通过。另修正观察失效被误报为工具名称冲突，经两项回归与独立复核通过；当前完整594项、源码23通过/1既有跳过、fix2包20通过。默认停止键和 TextEdit focus/click 限制、用户暂缓 Chrome、未列通过的真实场景仍保留，不勾上方综合项。实机调用的 unknown 原样保留，隔离数据与进程已清理。
