# Her Tools V1 Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在用户授权范围内查找和读取资料，支持普通 Office/PDF 和扫描页，显示真实来源。

**Architecture:** 主进程用 fileId 引用本地文件、统一检查授权；文本直接读取，文档通过受控 MarkItDown 调用提取并缓存。PDF 逐页在本地渲染，作为工具图像送入当前模型。

**Tech Stack:** Node 文件 API、SQLite、MarkItDown MCP、PDF.js（pdfjs-dist）、Electron Chromium Canvas、Vitest、React Testing Library。

**Spec:** [定稿设计](../specs/2026-10-15-her-tools-v1.md)；[共享契约与依赖](2026-10-15-her-tools-v1.md)。

## Global Constraints

- 添加文件即允许当前对话读取；文件夹支持本次对话或长期授权；长期授权可撤销。
- 文件读取授权不自动增加对原文件的写入授权。
- 桌面、浏览器和文档任务沿用当前聊天模型；能力不足时提示用户切换，不自动更换端点。
- 新文档最大 50 MiB；目录列表每页最多 100 项；文本每次最多 30,000 字符；保留现有图片附件限制。
- 单次最多渲染 3 页，长边最多 2,000 像素；物理页序从 1 开始；不一次渲染整本文档。

## Review Focus

- 越界软链接、目录名前缀、文件替换：真实路径检查与读取对象一致；T09。
- 解析/渲染中撤销授权：返回结果及图像进模型前再次检查；T10/T11。
- 混合 PDF、仅有页眉文字、图表页：不能因全文有文本就跳过视觉需求；T11。
- 无页码/无公式缓存值：不能编造位置或声称 Excel 公式已重算；T10。
- 切换对话后的选择器/解析迟到结果：不能把资料加到新会话；T12。

## T09：文件授权、引用和只读工具

**Files:** Create `src/core/files/access.ts`, `src/core/files/tools.ts`; Modify `src/core/storage/store.ts`, `src/core/tools/registry.ts`, `src/core/tools/artifacts.ts`, `src/core/conversation/chat.ts`, `src/shared/types.ts`, `src/main/ipc.ts`, `src/preload/index.ts`; Test `tests/files.test.ts`, `tests/storage.test.ts`, `tests/ipc-policy.test.ts`。

**Interfaces:** 定义 FileGrant/FileReference。`FileAccessService.grant(paths: string[], input: {scope: 'conversation' | 'persistent'; conversationId?: string; kind: 'file' | 'directory'}): Promise<FileGrant[]>` 仅主进程受控入口调用；`resolve(fileId: string, context: ToolExecutionContext): Promise<{path: string; reference: FileReference}>`、`revoke(grantId: string): Promise<void>`、`listGrants(conversationId: string): FileGrant[]`。SendMessageInput 新增 fileIds，ChatMessage 新增 files 引用，旧 attachments 保留。

- [x] 写跨会话隔离、长期授权重启恢复、../、目录前缀混淆、越界软链接、文件消失、读取过程中替换/撤销、缓存 sourceFileId 撤销测试；写 101 项目录分页和 30,001 字符截断断言。运行 `npm test -- tests/files.test.ts tests/storage.test.ts tests/ipc-policy.test.ts` 观察 RED。
- [x] 持久化 grants 和 file references；解析真实路径并检查范围，读取时核对实际文件身份，返回前再次确认 revision。模型不能调用 grant，也不能把自造 fileId 或路径当授权；路径仅留主进程。
- [x] 注册 `list_files({grantId, relativePath?, cursor?})`、`search_files({grantId, query, cursor?})`、`search_text({grantId, query, cursor?})`、`read_text({fileId, offset?, length?})`；全部消费 T01 context、返回 ToolResult，结构化部分带来源/实际范围/truncated/nextCursor。搜索和读取支持取消，不扫描授权外路径。
- [x] 将 sourceFileId 校验接入 artifact 读取和模型输入准备，运行开始及后续每次发送前检查。保留旧消息已显示内容；撤销后不重新注入受控文件/缓存片段，尚未发送的迟到内容丢弃。
- [x] 单文件选择创建会话授权；永久删除会话清理专属引用与临时授权，保留长期授权和其他会话引用；回收站暂存不当永久删除。工具输出截断只表示本次片段，不声称读完。
- [x] 运行目标测试与 `npm run typecheck`；Expected：授权、撤销、分页和现有存储行为通过，首版无新增写入/移动/删除文件工具。

> T09 已验收：两轮聚焦修复后独立复审通过；493 项全量、154 项聚焦、类型与构建通过。受控引用和模型来源过滤、实际可见分页及路径错误脱敏已验证；文件/目录选择界面、拖入、图片桥接和来源打开仍按 T12 实施。纯 Node 文件访问规则不构成 OS 沙箱，原子祖先目录 ABA 不在保证内。

## T10：MarkItDown 提取、片段与缓存

**Files:** Create `src/core/documents/service.ts`, `src/core/documents/cache.ts`, `tests/fixtures/documents/`; Modify `src/core/mcp/presets.ts`, `src/core/mcp/dependencies.ts`, `src/core/tools/registry.ts`, `src/core/storage/store.ts`, `src/shared/types.ts`, `docs/implementation/her-tools-v1-compatibility.md`; Test `tests/documents.test.ts`。

**Interfaces:** 定义 DocumentReference/DocumentChunk。`DocumentService.extract(fileId: string, context: ToolExecutionContext): Promise<DocumentReference>`、`read(documentId: string, input: {offset?: number; length?: number; query?: string}, context: ToolExecutionContext): Promise<DocumentChunk>`；注册 `read_document({fileId, offset?, length?, query?})` 自动提取并返回片段。

- [x] 准备不含私人资料的文字 PDF、DOCX、PPTX、多工作表 XLSX、长文本、损坏和加密文件；记录预期文字/表格而非完整字节快照。写缓存命中、源文件变化、解析器版本变化、解析中撤销、无页码不产生 pageNumber 测试。
- [x] 运行 `npm test -- tests/documents.test.ts`，确认 RED。
- [x] 固定 MarkItDown 发布版本与格式依赖，通过 T05 manager 以 stdio 调用 `convert_to_markdown(file URI)`；该原始工具不进入模型可见 registry，模型只能使用 read_document。转换前后检查 T09 授权和文件版本。
- [x] 缓存键包含文件内容版本、解析器版本及配置；结果和片段保存在应用目录，引用元数据存库。命中缓存也重新授权；源文件变化失效，缓存丢失可重提取但先检查源文件授权。
- [x] 输出全文/部分状态、片段范围及实际存在的章节/工作表信息；没有页号不推测。XLSX 只提取内容；损坏、加密、缺依赖、转换超时、空提取分别给出可操作提示。单次最多 30,000 字符、提取超时 120 秒。
- [x] 运行目标测试和 `npm run typecheck`，再用真实 MarkItDown 提取各格式 fixture，将发布版本和结果写兼容记录；Expected：已知内容存在、原始 URI 工具不可直调、授权撤销后无新内容返回。

T10 已通过独立初审后的 I1 修复复核：510 项测试、类型与构建通过；真实永久 MarkItDown 运行时 52 项重点测试通过。PDF 提取保守标为部分，不能保证损坏/加密的精细诊断，不推测页号或重算公式；真实 GUI/应用包验收归 T13。schema v11 持久记录解析自管字节归属，清理失败保留待恢复记录，并加入现有 5 秒退出等待。

## T11：PDF 本地分页和视觉读取

**Files:** Create `src/core/documents/pdf.ts`, `src/main/pdf-renderer.ts`, `src/preload/pdf.ts`, `src/renderer/pdf/index.html`, `src/renderer/pdf/render.ts`; Modify `package.json`, `package-lock.json`, `electron.vite.config.ts`, `src/core/tools/registry.ts`, `src/core/tools/artifacts.ts`, `src/shared/types.ts`; Test `tests/pdf.test.ts`, `tests/providers.test.ts`，补充 `tests/fixtures/documents/`。

**Interfaces:** `PdfService.inspect(fileId: string, context: ToolExecutionContext): Promise<{pageCount: number; pages: {pageNumber: number; textStatus: 'present' | 'empty' | 'unknown'}[]}>`；`render(fileId: string, pageNumbers: number[], context: ToolExecutionContext): Promise<{pageNumber: number; image: ArtifactReference; width: number; height: number}[]>`。模型工具 `inspect_pdf({fileId})`、`read_pdf_pages({fileId, pageNumbers})` 返回 ToolResult 图片及真实页序。

- [x] 写扫描、混合、仅页眉文字、含图表文字页、错误页号、批量 4 页拒绝、取消中途、撤销后缓存拒绝、无视觉能力、PDF 加密测试。运行 `npm test -- tests/pdf.test.ts tests/providers.test.ts` 观察 RED。
- [x] 采用固定发布版 pdfjs-dist，按 [PDF.js 官方分页与 Canvas 示例](https://mozilla.github.io/pdf.js/examples/) 实现；用受限隐藏 Electron 渲染窗口处理选定 PDF 页，主进程只传授权字节及页请求。该窗口仅加载本地专用页面、sandbox/contextIsolation 开启、无 Node、拒绝导航/新窗口，不拥有普通 HerApi 或网络能力。
- [x] 打包独立 PDF worker/字体等必要资源；小样验证 Electron 实际环境的文字提取和 PNG 输出。若已选发布版不可用，记录证据后调整版本，不改为云端解析或另一个模型服务。
- [x] inspect 逐页记录文本可用性；“有文字”不代表图像内容已理解，用户要求图表或扫描内容时仍可渲染。render 每批最多 3 页、长边最多 2,000 像素，使用 T01 artifact 并关联 sourceFileId，完成后再次授权与取消检查。
- [x] 将页图送入当前聊天模型的工具循环，不启动独立 OCR agent；物理页序从 1 开始。文本模型或上游拒绝图片时明确提示切换，不能记作已读；部分失败保留已读页集合和不确定说明。
- [x] 运行目标测试、`npm run typecheck`、`npm run build`；在 Electron 用 fixture 验证真实渲染尺寸、页序和图像内容。T13 再验证 .app 资源路径与真实视觉识别。

T11 已通过 fix1 独立复审：542 项测试、类型与构建通过；真实生产/开发 PDF worker、本地字体、PNG 页序与像素、授权撤销和取消清理均验证。超限页保留同批成功页与明确原因；撤销/取消仍阻止全部新内容。`.app` 与真实视觉模型识别、特殊 PDF 编码按 T13 实际证据登记，未据此声称通过。

## T12：资料入口、授权管理与来源展示

**Files:** Create `src/renderer/src/FileAccessPanel.tsx`, `src/renderer/src/DocumentSources.tsx`; Modify `src/renderer/src/App.tsx`, `src/renderer/src/SettingsPanel.tsx`, `src/renderer/src/styles.css`, `src/main/ipc.ts`, `src/preload/index.ts`, `src/shared/types.ts`, `src/core/conversation/chat.ts`; Test `tests/renderer.test.tsx`, `tests/ipc-policy.test.ts`, `tests/chat.test.ts`。

**Interfaces:** HerApi 增加 `selectFiles(conversationId): Promise<FileReference[]>`、`addDroppedFiles(conversationId, files: File[]): Promise<FileReference[]>`、`selectDirectory(conversationId, scope): Promise<FileGrant | null>`、`listFileGrants(conversationId): Promise<FileGrant[]>`、`revokeFileGrant(id): Promise<void>`。Drop 在 preload 使用 webUtils.getPathForFile，只把真实磁盘来源路径传受限 IPC；File 对象不跨主进程序列化。

- [x] 写文件/目录选择取消、切换对话后迟到选择、解析迟到、撤销、长期授权列表、文档失败/部分状态、来源页序和原图片附件兼容测试；运行 `npm test -- tests/renderer.test.tsx tests/ipc-policy.test.ts tests/chat.test.ts` 观察 RED。
- [x] 文件按钮覆盖图片与普通资料，新增拖入和目录入口；选择器由主进程创建。preload 拒绝空 getPathForFile 结果，主进程复核文件类型/大小/身份；不把 renderer 任意字符串路径当工具授权。使用当前 Electron 的 [webUtils API](https://www.electronjs.org/docs/latest/api/web-utils)。
- [x] 普通文档保存 FileReference，消息正文仅带名称和可用 fileId；模型按需调用读取工具。维持旧图片链路，不将 PDF/Office 全文件编码到消息 JSON。绑定发起选择时的 conversationId，过期回复不写进新会话。
- [x] 展示临时资料、目录作用范围、解析状态及来源片段；设置管理长期目录和解析器依赖状态。引用只展示服务返回的真实字段；点击来源通过受控应用行为打开原文件/已支持的位置，不对外暴露任意 file URL。
- [x] 撤销与永久删除调用 T09/T10 清理路径；已发送历史保留可见，UI 清楚说明后续不能继续读取。展示按需发送内容到当前模型服务的说明，不增加范围内每次读取弹窗。
- [x] 运行目标测试与 `npm run typecheck`；Expected：新资料功能可经 UI 操作，旧聊天/设置草稿/图片行为通过。完整文件→模型回答→来源链路归 T13 E2E。

T12 已通过 fix1 独立复审：581 项测试、类型与构建通过，159 项修复目标测试通过；先前实际文件桥接及桌面/侧栏 Electron 11 项通过。首次发送失败草稿与历史图片能力提示已修复。重载后撤销来源显示一致性作为 Minor 保留给最终审查，主进程继续拒绝未授权读取。原生选择器/Finder、完整模型与 .app 归 T13。
