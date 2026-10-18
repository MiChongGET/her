# Her Tools V1 验收记录

日期：2026-10-16。交付状态：**软件及本机包验证通过；本轮实机验收已完成并保留限制。权限、中文读回、专用按钮点击读回、原生选择器/来源打开、公司/Haiku 图片与 PDF 理解、最终包实网搜索及独立实体停止键已验证。默认停止键未生效，TextEdit 窗口聚焦/点击仍有兼容限制；Chrome 扩展由用户暂缓。** 下表不把模拟服务或开发版证据当作真实服务兼容证明，T13 全部真实场景仍未勾为完成。

## 版本和应用包

| 项目 | 实际版本/位置 |
| --- | --- |
| 应用 | Her 0.1.0，bundle ID `com.her.desktop`，macOS arm64 |
| 框架 | Electron 44.7.0；打包器 `@electron/packager@20.3.0`；构建宿主 Node 24.14.0 |
| 应用包 | `release/Her-darwin-arm64/Her.app`，本机包，未执行签名、公证、上传或发布 |
| MCP 客户端 | `@modelcontextprotocol/client@2.3.1` |
| PDF | `pdfjs-dist@6.4.299`，真实专用 worker，随包 standard_fonts/cmaps/wasm/iccs |
| 文档 | 持久安装 MarkItDown 0.1.8、markitdown-mcp 0.0.1a7、CPython 3.13.13，74 包哈希锁 |
| Mac/网页预设 | Peekaboo 4.9.3；Playwright MCP 0.0.83；open-webSearch 2.2.0 |

应用包只包含 `Contents/Resources/app/{package.json,out,node_modules}` 和必要的 Electron 资源；node_modules 已裁剪开发依赖。`Contents/Resources/dependencies/markitdown` 与 `Contents/Resources/mcp-web-dependencies` 包含固定清单和独立安装说明，不依赖源码 checkout。不包含 SDD、experiments、用户数据库、测试资料、开发缓存或外部 Node/Python 运行时。

首次直接访问 GitHub 下载 Electron 超时；随后通过 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 复用固定 44.7.0 缓存。缓存 ZIP 的 SHA256 与已安装 `electron@44.7.0/checksums.json` 一致，记录在 `T13-electron-integrity.json`。I1 修复后的 final-fix1 包清单及原 T13 收据保留。更正：旧 T13 清单实际包含 `node_modules/.vitest-cache` 和 `.vite`，原“无开发缓存”的描述不准确；后续打包已精确排除这两处缓存，生产依赖与 PDF 资源保留。

当前为 fix2 诊断修复重建包，3,603 项、399,493,274 字节；清单 SHA256：`acf9f3202b1f3b805f778d4f6e4cae57a5c9848f6831a7b7537c846a52010e4b`。`T13-real-20261016-VGYLJH/fix2-package-manifest.json`、`fix2-final-verification.json` 核对全部包路径与 SHA，212 个 out 文件匹配。对照 fix1，生产代码仅多两行错误分类；原生适配器、模型图片和 PDF 路径未改变。原生动作与真实模型证据来自此次 final-fix1 实机阶段；fix2 重建后另重跑全部回归、权限诊断及实网搜索，不冒充再次执行了旧原生动作。

以下证据路径相对于工作区 `.superpowers/sdd/2026-10-15-her-tools-v1/`。只保留合成验收数据和必要断言，不记录真实密钥、私人文档或模型请求的认证信息。

## 验收矩阵

| 范围 | 操作与预期 | 实际结果 | 状态与证据 |
| --- | --- | --- | --- |
| 类型/单元/构建 | `HER_TEST_MARKITDOWN=1 npm run check`；完整套件及真实解析器条件项通过 | 类型通过；27 套件、594 测试通过；生产构建通过 | **通过**：`T13-real-20261016-VGYLJH/fix2-check.log` |
| 源码 Electron 综合回归 | 构建后 `HER_TEST_MARKITDOWN=1 npx playwright test`；原聊天/草稿/图片桥/回收站/窗口行为和新工具流程 | 23 通过；1 既有 opt-in web preset 测试未启用，未改动其断言 | **通过（1 明示跳过）**：`T13-real-20261016-VGYLJH/fix2-e2e-source.log` |
| 最终 .app 综合回归 | 用 `HER_TEST_APP_EXECUTABLE` 指向重建包运行 tools/desktop/sidebar/window-lifecycle | 20 通过（其中 tools 8 项）：三协议可实际解码的工具图片、连续两次工具确认、停止/重启、扫描/混合 PDF、HTTP 静态鉴权/未知结果、四格式文档、自管退出 | **通过**：`T13-real-20261016-VGYLJH/fix2-package-e2e.log` |
| GUI 冷启动/路径 | LaunchServices `open -n`，显式隔离 HER_DATA_DIR、PATH 仅系统路径；不得转到开发实例 | PID 92809 来自修复前 T13 包，加载 `her://app/index.html`；preload/bootstrap/SQLite 可用，返回数据目录与测试目录相等；开发 PID 15577/15585 保留 | **历史通过，有边界（修前包；新包未重做此项）**：`T13-cold-launch/receipt.json`、`window.png`、`cleanup.json`。非字面 Finder 双击默认数据目录验收；带测试 CDP 端口 |
| 包内容/依赖安装资源 | 原生包入口、生产 MCP SDK、PDF资源、固定依赖说明可用；排除开发/私人内容 | 明确白名单，逐文件 SHA256 清单；212输出文件匹配；固定依赖无需 checkout | **通过**：`T13-real-20261016-VGYLJH/fix2-package-inspection.json`、`fix2-package-manifest.json`、`fix2-final-verification.json` |
| PDF 真正渲染 | mixed.pdf 按物理页 `[2,3,1]`；scanned.pdf `[1]`，进入工具图片请求，来源/撤销有效 | 最终包创建 `pdf.worker.mjs` 专用 worker，混合文档实际请求本地 standard_fonts；真实页图进入本地合成模型 HTTP，消息库只保存引用；撤销后来源打开拒绝 | **通过**：`T13-real-20261016-VGYLJH/fix2-package-e2e.log` （`T13-package-worker-lifecycle-evidence.json` 仅为修前历史收据）。不代表 OCR/真实模型理解，不证明所有特殊编码/字体 |
| 真实 MarkItDown 四格式 | 从最终包发现持久运行时，授权选入 DOCX/PPTX/XLSX/文字PDF；提取标记到模型、来源可见 | 四格式实际转换并保留 source fileId/name，来源按钮可见；测试选择器返回替换仅在测试进程，文件/IPC/解析器是真实代码 | **通过，有边界**：`T13-real-20261016-VGYLJH/fix2-package-e2e.log`。不代表原生选择手势、复杂版式保真或公式重算 |
| HTTP MCP 静态鉴权 | 错误/缺失合成凭据返回401；保存正确合成头后可发现/调用；错误不泄露凭据 | 最终包真实 HTTP、safeStorage 配置及 MCP SDK 完整链路通过；执行后断线记 unknown；重启不重放 | **通过（本地受控 HTTP 服务）**：`T13-real-20261016-VGYLJH/fix2-package-e2e.log`。未宣称第三方服务或 OAuth 兼容 |
| 自管进程退出 | 创建自管 stdio fixture，忽略 SIGTERM，退出后限时清理 | 核实精确父子 PID，真正退出后子进程消失，耗时小于8秒；没有终止 Chrome 或其他应用 | **通过**：`T13-real-20261016-VGYLJH/fix2-package-e2e.log` （`T13-package-worker-lifecycle-evidence.json` 仅为修前历史收据）；产品清理预算为5秒，测量包含 Playwright 进程退出开销 |
| 原生应用启动/激活 | 真实模型提出 launch TextEdit，用户本地确认后执行 | 工具 succeeded、效果 confirmed、任务 completed；TextEdit 原本已在运行 | **已运行应用激活通过，冷启动未证明**：`T13-real-20261016-VGYLJH/app-launch-proposed.json`、`app-launch-result.json` |
| Mac 权限/中文输入 | 用户人工授权后，以 Her 包和真实模型操作专用合成 TextEdit 文档 | 中文 AX 写入已派发，工具保留 unknown；独立 CUA 与随后 Her 新只读观察均精确读回三行内容。fix2 重建后 Peekaboo 三项权限再次 ready | **状态读回通过，原调用仍 unknown**：`T13-real-20261016-VGYLJH/native-type-result.json`、`native-chinese-readback.json`、`fix2-final-permissions.json`。没有重复输入或把 unknown 改成成功 |
| 原生窗口/点击 | 精确 PID/窗口观察、聚焦和单次按钮点击 | TextEdit focus 被 Peekaboo 拒绝；普通窗口的标题栏/标题 AX 元数据变化被校验拦截。另用全新无标题栏专用按钮B，真实 AX action 派发一次，计数0→1，CUA与 Her 新只读观察均确认1；原点击仍 unknown，任务 paused | **专用按钮效果读回通过，TextEdit focus/click 限制保留**：`T13-real-20261016-VGYLJH/native-focus-failure.json`、`native-background-click-diff.json`、`native-button-b-result.json`、`native-button-b-readback.json`。没有放宽校验或重放未知动作；不是第三方应用任意控件兼容证明 |
| 实体全局停止键 | 在确认前、0工具调用时按实体键 | 默认 Command+Shift+Escape 未生效，显式 API 取消后 stopped。隔离实例改用 Command+Option+Shift+S；用户实体按键后同一请求 awaiting_confirmation→stopped，active=null，调用0 | **独立键通过，默认键失败且原因未定**：`T13-real-20261016-VGYLJH/hardware-stop-after.json`、`hardware-stop-api-cleanup.json`、`alternate-stop-before.json`、`alternate-stop-after.json`。API 取消不冒充实体键成功；未修改用户实际 Her 偏好 |
| 原生文件选择/来源打开 | 实际系统选择器选入合成 TXT/PDF，点击文件来源打开 | 真正系统选择器选入文本和两份 PDF；真实模型 read_text 成功；来源按钮确实在 TextEdit 打开同一文件，界面内容与文件路径吻合 | **选择器/支持文件打开通过，拖拽/Finder 定位未验证**：`T13-real-20261016-VGYLJH/native-picker-read.json`、`native-fixture-identity.json`、`real-scanned-pdf.json`、`real-mixed-pdf.json`；没有替换 dialog 返回 |
| Chrome 现有登录态/标签范围 | 官方扩展审批后完成搜索→阅读→来源、表单和重连 | 用户明确暂缓安装扩展，本次未操作现有 Chrome、未新建替代浏览器/profile | **用户暂缓/未验证**。T08 元数据与缺扩展证据仍仅为先前开发版证明 |
| 可选搜索 | 默认关闭，在隔离最终包显式启用后实网检索/提取 | fix2 包 + Node24.14.0 + open-webSearch2.2.0；真实 Bing 返回3条官方结果，无 partialFailures；公开 llms.txt 以 retrievalMethod=request 提取，两工具 succeeded。未启动独立浏览器 | **最终包实网通过**：`T13-real-20261016-VGYLJH/fix2-live-web-result.json`、`fix2-live-web-cleanup.json`。驱动模型为本地确定性夹具，MCP/搜索引擎/网页是真实服务；不证明 Chrome 登录态或真实模型搜索判断 |
| 历史撤销状态呈现 | 重启仍准确显示已撤销来源不可读 | 主进程授权拒绝始终有效；App remount 后历史来源的可用性标签可能遗忘 | **M1 非阻塞，明确延期**：final-review.md；没有宣称已修复 |

## 模型图片兼容矩阵

| 协议/模型 | 最终包工具图片→HTTP 格式 | 真实外部端点的图片/PDF理解 |
| --- | --- | --- |
| OpenAI Chat Completions / `fixture-vision` | **通过**，本地确定性服务收到 image_url；真正 MCP PNG 及 PDF 页图经产品图片路径发送 | **未验证**：没有确认可用的真实 OpenAI 端点 |
| Anthropic Messages / `fixture-vision`；真实“公司 / claude-haiku-4-5” | **通过**，本地确定性服务收到合法 image/source/media_type | **真实工具图片与 PDF 通过**：当前 UI/用户确认同一服务模型；真实外部端点正确识别工具图片、纯扫描 PDF 第1页、混合 PDF 物理第2页中各自随机短码。证据见下文 |
| OpenAI Responses / `fixture-vision` | **通过**，本地确定性服务收到 input_image | **未验证**：没有确认可用的真实 Responses 端点 |

此前 `fixture-vision`、T07 的 `native-fixture-model` 是确定性本地服务。2026-10-16 用户明确当前“公司 / claude-haiku-4-5”并授权视觉实测；现场 UI 与配置均已启用视觉，未再次修改用户配置。仅在实际 Her 主进程解密单个配置并重新加密保存到隔离验收目录，没有复制真实用户历史。三次图像理解只发送新生成的合成资料，随机短码不在提示、文件名或工具文本中。

`T13-real-20261016-VGYLJH/real-tool-image.json` 证明当前外部端点两轮工具图片协议与识别；`real-scanned-pdf.json`、`real-mixed-pdf.json` 则经过完整 Her ChatService/inspect_pdf/read_pdf_pages/真实 PDF worker/图片发送链路。两份 PDF 均任务 completed、两工具 succeeded，混合 PDF pageCount=2 且只渲染物理第2页，答案与内存中的随机期望一致。没有将这些证据推广为其他服务、协议、特殊字体或任意扫描文档保证。

冻结前发现新 MCP PNG 夹具的 IDAT CRC 错误，最初 wire 测试不能证明图像可解码。增加真实 Electron `nativeImage` 解码断言后观察 RED（空图像），改为已校验的 16×16 PNG 后，最终 `.app` 八项重新通过（19.2 秒）。该次 PNG 修正结论以 `T13-png-red.log` → `T13-package-e2e-final.log` 为准。应用代码未因 PNG 夹具更改；当前包另包含 final-fix1 生命周期修复并已重新测试。

冷启动实例 PID 92809 最后通过 CDP `Browser.close` 清理并确认消失；SIGTERM 单独发送时仍存活。普通应用退出与自管进程清理由独立生命周期测试证明，不能把强制关闭收据当普通退出证据。原开发 PID 15577/15585 保留。

## 后续验收入口

1. 本机可在实际 Her 桌面设置中选择已验证的 `CommandOrControl+Alt+Shift+S`；本次只修改隔离实例，未替用户实际偏好保存。默认键失效原因未确定，TextEdit focus/click 兼容限制仍保留；不能放宽观察校验或自动重复 unknown 动作。
2. 用户愿意安装 Chrome 扩展时，按预设提示在现有 Chrome 内批准目标标签范围，再验证登录态、搜索/来源、表单与断线恢复。
3. 当前公司/Haiku 的真实工具图像和 PDF 视觉已通过；没有可用外部端点的其他协议保持未验证。
4. 原生 picker/支持文件来源打开已通过；实际拖拽与 Finder 定位仍未验证。源码与 `.app` 保持独立 userData，所有动作只指向合成资料。

## final-fix1 图片归属修复与边界

schema 12 新增独立于会话级联删除的 artifact_owners：任何 mkdir/write 前登记 Host UUID/会话；已发布的 schema11 图片引用无损迁移。图片发布与 published 标志同事务提交，永久删除先清理指定 owner 文件，失败保留回收站与归属供重试。未发布 owner 在 purge 时保留，以承接已开始的迟到写入；启动只对明确 owner 执行一次恢复，失败保留记录并提示检查权限后重试/重启。不扫描匿名历史残留、不删除原文件或其他会话图片。

磁盘删除不能由 SQL 回滚恢复：多选删除途中失败或随后 SQL 删除失败，已经清除的图片可能缺失；恢复会话后明确提示缺失，不假装成功读取。文档 owner/schema11 语义保留。图片 drain 加入既有全局五秒预算，截止后的迟到完成只清理文件系统并保留 durable owner，下次打开恢复，不访问已关闭数据库。

10 项新回归覆盖写前归属、EACCES、多选部分清理、写入/清理双失败、重开恢复、迟到写入、五秒前后退出、schema11 图片迁移、路径限制及 SQL 回滚。实际旧包同一 EACCES 测试 RED 为回收站空，重建包 GREEN 为保留→重启→成功重试；详见 final-fix1-red-verified.log、final-fix1-package-red-verified.log、final-fix1-check-final.log、final-fix1-package-e2e-final.log。

包桌面回归首次为 19 pass / 1 测试适配失败：源码专属“登录启动不支持”断言在实际包启用了登录项。本次 exact 测试包通过 Electron API 已恢复为 not-registered/openAtLogin=false（final-fix1-login-cleanup.json）；未采集操作前 OS 原始状态，不能声称已证明 false→true。随后测试仅替换测试进程的 OS 登录项边界，实际偏好保存 true→false 仍验证；20 项最终通过不代表真实 OS 登录启动验收。清理临时 PID7773 的正常关闭和 SIGTERM 未完成，核对身份后仅强制结束此 owned 进程，finally 清理测试目录；它不是正常 quit 证据，正常退出由独立 owned-child 测试证明。

M1 历史撤销来源状态 remount 后遗忘、M2 SQLite ExperimentalWarning / NO_COLOR 与 FORCE_COLOR 日志冲突均明确延期，无全局抑制或运行时升级。原 T13 冷启动收据是历史包证据；fix2 的 worker/退出/文档/图片/HTTP 已在新包综合回归，权限另做只读复核。LaunchServices/Finder 冷启动未重做；默认停止键、TextEdit focus/click、Chrome 及其他未列通过场景仍是未关闭 gates。本机包未签名、公证或发布。

最终 I1 scoped 复核已通过，见 final-fix1-review.md。实机发现的错误分类另作两行修复与两项回归：先见 RED（实收“工具名称重复或冲突”），再见 GREEN；完整 check 为27套件/594测试、类型与构建通过。fix2 独立复核无 Critical/Important/Minor，重打包、源码23项/1明示跳过和包20项全部通过。见 `T13-real-20261016-VGYLJH/fix2-{red,green,check}.log`、`fix2-review.md`、`fix2-e2e-source.log`、`fix2-package-e2e.log`。

## 本轮清理

原生验收包 PID5365 正常关闭，其 Peekaboo 子进程及专用控件窗口消失；只关闭本次合成 TextEdit 文档，保留原有 TextEdit 进程。已移除含单个加密克隆配置的隔离 data 目录，真实服务凭据未留在测试数据中。实网搜索包与最终权限探测包也正常退出，各自数据目录及本地模型夹具已清理。用户 Her 开发进程3241/父3227和 TextEdit93319仍保留，没有退出它们抢快捷键；隔离测试键随进程退出释放。见 `cleanup-final.json`、`fix2-live-web-cleanup.json`、`fix2-final-permissions.json`、`fix2-final-verification.json`（均位于本轮证据目录）。

实网首轮本地模型夹具发出无效工具名，产品在零工具派发时拒绝；修正夹具共享状态并检查公布名称后再验收真实 MCP，两轮证据分别保留在 `fix2-live-web-fixture-first-failure.json` / `fix2-live-web-result.json`，没有把夹具修正算作产品修复。
