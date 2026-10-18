# Her Tools V1 兼容记录

更新：2026-10-15。此记录区分已验证的发布接口、本地自动化测试、开发 Electron 实测与安装包验收。

## 依赖与安装

依赖检查只读取版本、文件和非交互权限状态；不安装软件、不启动业务操作或扩展配对。GUI 不依赖终端 PATH。诊断子进程由 Her 单独持有，绑定应用生命周期；退出时立即终止，等候子进程退出并纳入统一五秒退出兜底，不会再启动后续探测。

| 预设 | 版本 / 检查 | 当前入口 |
| --- | --- | --- |
| Peekaboo | 原生 4.9.3，macOS arm64 发布二进制 SHA256 `ce0f4f9824c64092c03cac759fdd58e174e19f7770f170c9f59bf009410d7d26` | 已接入；原生行为验收见下文 |
| Chrome / Playwright MCP | 0.0.83；依赖 playwright/playwright-core `1.64.0-alpha-1790635538000` | 已接入；实际 MCP 发现通过，当前机器缺少官方扩展，页面业务验收待用户安装和批准 |
| MarkItDown | MCP 0.0.1a7 / MarkItDown 0.1.8 / CPython 3.13.13，74 包哈希锁 | 已接入授权文件 read_document；原始 URI 工具仅主进程私有 |
| open-webSearch | npm 包 2.2.0；服务自报版本 1.2.0 | 默认关闭；实际 Bing 请求搜索和公开网页提取通过；必须 MODE=stdio |

Peekaboo 独立安装步骤：下载 `@steipete/peekaboo@4.9.3` 的发布包，提取其原生 `peekaboo`，放到 `~/.local/share/her/dependencies/peekaboo-4.9.3/peekaboo` 并设置可执行权限；检查以上 SHA256。此路径是依赖的持久安装位置，运行不引用研究目录。应用不自动安装或升级。若架构或校验不同，会报告不兼容，不执行该文件。

Node/npm 使用独立安装；检查已知的 `~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin` 路径，不继承 shell 的查找结果。Python 同样单独安装；MarkItDown 应使用独立虚拟环境。Playwright 需要 Google Chrome 与官方扩展，由用户批准连接和标签范围。MarkItDown 仅通过授权文档入口执行；所有预设的依赖存在均不等于业务就绪。

## Peekaboo 固定运行绑定

运行命令是已校验的绝对原生路径，参数必须精确为：

```text
mcp --no-remote --transport stdio --allow-foreground
```

固定环境项：`PEEKABOO_ALLOW_TOOLS=app,window,see,click,type,press,scroll,menu`，`PEEKABOO_DISABLE_MCP_AUTOCONNECT=true`。主进程核验实际文件内容、版本、参数、环境、工作目录和权限后才创建可信适配器。用户修改 presetId、同名工具或 server annotations 均不能获得权限。自定义 MCP 仍默认 unknown。

npm 的 `peekaboo-mcp.js` wrapper 固定启动 `mcp serve`，不传递额外参数，因此不能用来提供前台能力。不启用 temporary clipboard，不选择外部 Bridge，不增加 CLI、脚本或远程回退。服务名 peekaboo-mcp 4.9.3，SDK 2.3.1 的 legacy 握手已协商 2025-11-25。

## 暴露范围与动作策略

只允许八个已验证名字，注册和实际派发均限制参数与子操作：

- app：list / launch / focus；普通应用名称或 bundle ID，禁止文件路径、openTargets、批量/强制操作。
- window：指定 PID 的 list，以及先发现该 PID 窗口后、经明确确认的 exact-window focus。聚焦不提供任何数据输入授权。
- see：指定 PID 与 window_id，强制新 AX 观察、元素列表和 web_focus=false；不接受截图路径、ROI、旧 snapshot 或分析端点。
- type：最新 snapshot、明确原生元素 ID 与字面文本；使用原生默认后台路由，不强制 foreground，也不自动添加 clear。系统 TextEdit 的可操作 AXTextArea 可按 interact 发起输入；clear 按 overwrite 确认。其他应用输入为 unknown，必须确认。追加输入的原生效果可能不可验证，须保持 unknown 并重新观察，不能直接重试。
- click / scroll：元素或图片像素坐标；坐标必须绑定实际 coordinate_reference，按实际图像大小和逻辑边界转换，不假定 Retina=2。scroll 必须指定元素或坐标。
- press：绑定观察和当前 focused_element；快捷键、点击均保守按 unknown 确认。menu 仅开放只读 list，仍要求 Host 持有新观察；menu.click 不暴露且派发入口拒绝。原生菜单只提供 app 作用域，不能保证文档窗口，因此首版不能通过菜单点击进行保存、关闭或其他操作；不通过隐藏聚焦或伪造 window 参数补偿。

已知 Terminal、脚本编辑器、开发工具、代理和浏览器执行表面禁止进入；网页操作应交给 T08。有限名字拒绝规则不是对所有应用语义的完备证明。未识别的普通原生应用不会自动获得 interact；必须确认具体目标与字面参数。普通文本中出现代码不等同于执行代码，不以字符串关键词阻断文本编辑。

## 观察、坐标与恢复

只解析发布包实测的 `_meta.snapshot_id`、`target_receipt`、`coordinate_context` 和 `ui_elements`。进程代际使用十进制字符串 `process_start_identity_decimal`，不转 JS number。snapshot 与 reference_id 分开保留，不能以样本中相等推断通用别名。

Host 内存凭据绑定服务运行版本、任务、会话、PID、代际和窗口。每次动作前再次读取同一窗口，核对进程、图像/逻辑尺寸及元素；按键额外核对焦点元素。变化要求模型重新观察，不悄悄改写已批准的 snapshot/元素/目标。每次派发消耗凭据，动作后必须重新观察。不杜撰时间 TTL；重连、任务切换和配置改变不复用凭据。

派发后超时/断开/取消或原生未确认效果，保留 unknown，不能自动重试输入/点击。可信观察经私有 `onObserved` 回调报告精确的 service/PID/window/generation 目标；TaskExecution 仅在成功、未取消且版本仍有效的 read 完成时解除当前运行的未知阻塞。同 PID 的新代际及无关读取不能解除。普通远端 meta 不具有该权限。应用启动自身若结果未知且尚无可核验进程收据，仍需人工处理，不能用无关窗口读取解除。

## 验收边界

本节以下为 T07 开发阶段历史记录。2026-10-16 最新包验收见 [完整验收记录](her-tools-v1-acceptance.md)：真实公司/claude-haiku-4-5 图片及扫描/混合 PDF、原生选择器/来源打开、中文与专用按钮独立读回、实体 Command+Option+Shift+S 停止已验证；最终包 open-webSearch 实网通过。原生输入/点击回执仍 unknown，默认停止键未生效，当前 TextEdit focus/click 仍有限制，不能把历史窗口成功推广到任意窗口；现有 Chrome 扩展由用户暂缓。

自动化覆盖：无终端 PATH、命令缺失、校验/版本/权限错误、伪造预设绑定、隐藏工具和危险参数、跨任务/服务版本 snapshot、几何变化、合成 Retina 像素映射、输入超时、不确认效果、停止、未知动作跨适配器重建后的恢复和进程代际隔离。

开发版宿主：`node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`，Electron 44.7.0；固定依赖从 Her 子进程启动。所有模型请求使用显式配置的本地测试 OpenAI 兼容端点及同一个测试模型，未自动切换模型或分析服务。此测试模型用于可重复地驱动真实 native 工具，不是外部模型能力验收。

首次实测：Screen Recording / Accessibility / Event Synthesizing 均报告 ready；原生连接、应用 warm launch 和准确 PID 窗口发现成功。同一个新建专用 TextEdit 文件的两次 fresh see 返回 `ACCESSIBILITY_INCOMPLETE`，未输入。权限状态 ready 不等于截图/AX/输入成功。后续尝试先发现再明确聚焦时，窗口列表已不包含专用文档；程序在聚焦前拒绝继续。没有实际输入成功证据。当时另一个用户授权的 UI 任务也在运行 Electron，前台/窗口变化存在并发干扰，失败根因未确定。

修复轮独立专用窗口实测：Her PID 93291 对 TextEdit PID 93319 / window 152717 成功取得 12 个 AX 元素和截图；下一次同一本地模型请求包含一张图片，未切换端点。实际回执为 native_scale=2、output_scale=1、673×439 logical1x。window.focus 因错误附加 foreground 参数被原生拒绝（该字段只用于 close），随后的输入被未知动作保护拦截。现已删除该额外字段，准确 PID/window 参数派发单测通过；未再进行原生重试。真实中文输入、输入后读回及修正后的 focus 仍待验收。focus 使用已开启的会话前台权限，不添加 close 专用参数。

后续验收更新：修正后的准确 window.focus 已得到 confirmed 回执。一次追加输入走 foreground/global_events，原生报告 unverifiable；独立观察仍为原文。修复 type 路由后，以保留原 unknown 的测试数据副本重新启动 Her，同代际 fresh see 恢复该目标后，明确批准一次包含原文和中文的全文替换（clear=true）。该次实际进入 background/accessibility_value，准确目标回执一致，但仍返回 effect=unverifiable、retry_safe=false。没有重试输入；随后保留两条 unknown 历史重启 Her，仅执行准确窗口发现和 fresh see，完整 AX 值与批准的替换文字一致。后台 AX 路由、中文替换结果及独立读回已有实证；原生派发即时确认仍未通过，历史 unknown 未删除或改成成功。读回仅确认当时内容，不证明追加输入能力、文件保存、全局键盘送达或原生未确认的原因。

开发版真实 native 服务的待确认动作已验证：全局停止快捷键已注册，调用实际注册回调以及点击聊天停止按钮均在派发前取消动作，迟到确认不能恢复动作。此项验证的是回调与按钮，未使用物理全局按键注入。

1x 实际回执与合成不同图像比例的转换单测，不替代跨显示器、Retina、缩放/ROI 真机点击验收。安装包 Her.app 的实际 TCC、签名身份、冷启动和真实中文输入复查属于 T13，不能用本次 Electron 开发验证替代。


## T08 网页预设：固定安装与运行

从仓库根目录复制 `resources/mcp-web-dependencies/package.json` 和同目录 `package-lock.json` 到持久目录，然后执行：

```sh
mkdir -p ~/.local/share/her/dependencies/web-tools-v1
cp resources/mcp-web-dependencies/package.json resources/mcp-web-dependencies/package-lock.json ~/.local/share/her/dependencies/web-tools-v1/
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --prefix ~/.local/share/her/dependencies/web-tools-v1 --ignore-scripts --omit=dev --no-audit --no-fund
```

该命令用于用户显式安装，不在 Her 依赖检查中执行。固定 lock 包含整个解析图；不下载浏览器、不运行安装脚本。实际入口使用已解析的绝对 Node 路径和上述目录中的 JS CLI，运行时不使用 npx、shell 或研究目录。Host 校验 @playwright/mcp、playwright、playwright-core、open-websearch 的发布包文件内容摘要及版本，检查实际参数、环境和无 cwd；editable presetId 或同名 custom 工具不会取得可信策略。摘要锚定本次 npm 发布 tarball，不是从运行时未验证的 metadata 动态生成。

Chrome 参数为 `<@playwright/mcp/cli.js> --extension --no-webmcp --snapshot-mode none --output-dir <持久目录>/browser-output`。`none` 禁用动作后自动文件快照；显式 browser_snapshot 的发布版实现使用 explicit 模式，仍返回内联 YAML。截图工具不接收 filename/target，只返回内联图片到既有会话 artifact；上游自身仍在固定 Host 输出目录生成截图文件。不会开放任意输出路径、cwd、_meta 格式覆盖、选择器、JS/evaluate/run_code、Cookie/storage、文件上传或页面 WebMCP。禁止模式不能通过隐蔽名称直接派发绕过。

允许 11 个真实发现的工具：browser_snapshot、browser_navigate、browser_navigate_back、browser_click、browser_hover、browser_type、browser_fill_form、browser_select_option、browser_tabs、browser_take_screenshot、browser_wait_for。全局按键和对话框批准未开放：公开接口无法绑定焦点元素，用户仍可在 Chrome 中处理连接/权限/安全提示。导航只允许无内嵌凭据的 HTTP(S) URL；等待最多 30 秒。截图之外的元素动作只接受最新 YAML 中的精确 `target` 引用（该版不是 ref 参数），表单每个字段同样限制。

`browser_snapshot({})` / `browser_tabs({action:"list"})` 返回 Host `observation_id`，绑定当前任务、会话和服务 revision。页面动作须附该 ID，标签变更须使用最新列表 ID 和明确 index。派发前再次读取对应页面/列表，完整比较当前 URL、标题、标签列表和 YAML，变化就拒绝；不替换已批准目标或参数。每次动作或错误均消耗观察，之后重新读取。输入替换为 overwrite、submit 为 send、关闭标签为 delete；其余浏览器调用（含读取）保守 unknown，由现有 T03 逐次确认。普通成功工具回执代表上游调用完成，不证明外部网站业务成功。

**公开身份限制：** 0.0.83 返回 Markdown URL/title、临时数组 index 和 YAML 元素引用，没有稳定 Chrome tab GUID、snapshot version 或扩展批准收据。后台可在 MCP 连接未变时重置，重复同 URL/标题页面和竞态无法由公开信息区分。Host ID 只标记本次观察，不能保证跨调用原子性或断线连续性。未知浏览器动作保持固定 service action target；观察使用独立 observation target，不会调用 onObserved 冒充恢复收据。重新观察、重连或创建新 Host ID 均不能清除持久 unknown；用户需在任务状态中核对原动作并显式选择已处理或放弃，详见下面的修复说明。

## T08 可选公开搜索

open-websearch 默认 disabled。固定环境为 MODE=stdio、SEARCH_MODE=request、DEFAULT_SEARCH_ENGINE=bing、ALLOWED_SEARCH_ENGINES=bing、USE_PROXY=false、OPEN_WEBSEARCH_QUIET_STARTUP=true、PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1。仅允许已验证 search 和 fetchWebContent：搜索引擎只暴露 Bing；提取必须明确 renderMode=request 和 maxChars=1000–10000，无 Cookie/header/profile 输入。即使依赖图含 Playwright，Host 参数和发布包分支仍禁止自动/浏览器提取。需要 JS 的页面交给获准 Chrome。

实际 wire npm 版本为 2.2.0，serverInfo 为 1.2.0，两者并不矛盾。搜索 JSON 在 text 内容中；Host 把 description 转为 snippet，完整保留 title/url/source/engine。partialFailures 非空加结果为空是失败，非空加有结果是部分成功，仅完整正常响应且 partialFailures 为空才可表示成功零结果。isError、网络异常、格式错误或 Host 截断均为失败；不冒充“未找到”。网页提取保留 finalUrl、retrievalMethod、contentType 和 truncated。

## T08 实际证据与待验收

2026-10-15，macOS arm64、Node 24.14.0，固定依赖持久安装完成。实际 Her McpConnectionManager（不是 mock）完成发布内容校验、stdio 握手和发现：Chrome 11 工具，OWS 2 工具。Bing 查询 `Playwright official documentation` 返回 3 条结果，包含官方 playwright.dev；请求模式读取 `https://modelcontextprotocol.io/llms.txt` 成功并保留截断标记。该次证明公开请求与来源解析，不证明所有引擎或真实配置模型的最终回答质量。两个自管 Node PID 在 close 后均不存在，未向用户 Chrome 发送退出信号。

实际 browser_snapshot 返回 `Playwright Extension not found`，指向标准 Chrome 配置。用户需要安装 [官方扩展](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm)，然后亲自批准连接和标签范围。没有自动安装、批准或切换 profile；元数据 ready 明确不等于 Chrome connected。真实登录态复用、获准标签范围、Chrome 搜索→阅读→来源回答、实际表单提交前确认以及断开再连仍待用户完成准备后验收。当前只确认本地合成页面/协议单测的确认与防陈旧行为。

固定依赖的真实 Electron 设置/IPC 验收单独通过 `HER_TEST_WEB_PRESETS=1 playwright test tests/e2e/web-presets.spec.ts` 运行；默认跳过以免普通开发机自动要求本地安装。安装包 Her.app 身份和 GUI 冷启动仍由 T13 验收，不能用 Node 或开发 Electron 结果代替。


## T08 评审修复：观察也确认、分阶段派发、人工处理

固定 Playwright 发布版的 browser_snapshot、browser_tabs list 和 browser_take_screenshot 内部都会执行 ensureTab，可能关闭崩溃标签并重建页面。browser_wait_for 上游本身不执行 ensureTab，但 Her 的等待前快照预检会。因此这些入口不能无条件按 read 放行。所有 Chrome 调用先显示明确确认，覆盖扩展获准范围、可能的崩溃标签重建及待执行动作。确认文字也说明：隐式重连后的完全相同页面无法由公开接口区分，当前内容核对不是原子标签身份保证。真实 Chrome 动作尚未实测，此残余边界保留给 T13，不作为已通过的稳定身份保证。

调用采用 Host 私有阶段标记：批准后计入一次逻辑调用预算；实际发送预检前持久化 preflight，成功响应后为 preflight-completed，发送最终动作前为 action。成功预检后发现页面变化只记 failed/cancelled，不误记已发送最终动作；预检自身失败/取消可能已经重建标签，保留 unknown，界面和模型结果明确“最终动作未派发”。真正动作派发后的失败仍为 unknown。拒绝批准不消耗调用预算；批准后失败的预检也计入 40 次上限。回调为 Host 私有，远端返回字段无权设置阶段。

SQLite 升至 **v8**：tool_executions 新增 dispatch_phase；独立 tool_resolutions 表保存用户 handled/abandoned 决定、原记录 revision 摘要和时间。原 unknown status/result/arguments 不被改成成功。任务状态包含本会话较早运行中的未处理记录；用户先停止活动任务，勾选已在目标应用核对/处理，再选“已处理，解除阻塞”或“放弃此动作，解除阻塞”。IPC 核验可信主框架、会话归属、确切 run/call、当前 revision，拒绝重复或过期决定。模型没有解除工具。重载和重启保留决定；解除本身不会继续或重放。下一次运行绑定新观察并再次确认，历史工具结果向模型附加独立 Host 人工决定说明而不改写原记录。原生工具的既有可信只读恢复与继续入口保留，Chrome 的潜在重建读取不能借该通道绕过 unknown 阻塞。

Node 门槛按安装锁实际依赖检查：Chrome ≥20.0.0，OWS ≥20.18.1，完整比较 major/minor/patch；同一门槛约束依赖状态、预设创建和可信策略验证。新文件迁移须从 v8 接续。当前 SQLite 实验性提示与 npm 依赖弃用提示仍在原验证日志中保留。

## T10 文档提取、缓存与真实运行时

2026-10-15：将产品目录 `resources/dependencies/markitdown/requirements-runtime.lock` 安装到实际持久目录 `/Users/michong/.local/share/her/dependencies/markitdown-0.1.8`，没有依赖 SDD 虚拟环境或指向研究环境的符号链接。基础解释器为 `/Users/michong/.local/share/uv/python/cpython-3.13.13-macos-aarch64-none`，必须保留。使用 `uv pip install --require-hashes`，74 个发行包版本完全匹配；`uv pip check` 与主要格式依赖导入通过。固定锁 SHA256 为 `1509b64c2c46e460c6f2ea04218e9b1213ec644698b8cb236a10548c4a5663df`，包含发布 MCP 所要求的 `markitdown[all]` 闭包。安装步骤见同目录 README/install.sh；插件环境固定 `MARKITDOWN_ENABLE_PLUGINS=false`。

主进程依赖探测核验持久路径、launcher shebang、解释器版本、全部 74 包版本和格式导入。通过现有预设 IPC 保存绝对路径配置，运行前再核验启动参数与环境。`McpConnectionManager.convertDocument` 只允许可信 Host 策略声明的文档转换；复用现有连接、发现、输入/输出 schema 和配置/信号检查，没有新增 renderer 调用接口。外层 `read_document` 统一授权、计数、120 秒超时；模型列表与普通 manager.call 均拒绝内置原始 `convert_to_markdown`。设置页显示空 MCP 工具列表为正常状态。

先用 T09 `readBytes` 获取受控文件句柄读出的最多 50 MiB 字节，再写入应用自管的随机 0700 目录与 0600 暂存文件；Python 只接收该副本的 file URI。提取结束、缓存 IO 后、暂存清理后均重新检查来源授权/版本、对话与任务/应用存活、解析器配置，迟到结果不发布。解析不能保证打断 Python 的同步工作，但取消立即停止等待、删除暂存，迟到返回被丢弃；连接退出仍归原 manager 所有权清理。

缓存全文保存在数据库同目录 `documents/<Host UUID>.json`，引用元数据由 schema 9 → 10 的 documents 表保存；schema 11 新增写入前持久化的 document_owners，已发布的 v10 缓存所有权会自动迁移。键包含 fileId/固定源版本/解析器版本/配置 revision；跨会话引用不共享。命中仍授权，丢失可从仍获授权的源重提取。删除对话只清除其自管缓存，保留原文件与其他对话引用；T08 动作 phase/human resolution 与 T09 grants/provenance 的迁移回归已覆盖。额外本地提取上限为 16 Mi UTF-16 字符，超过时明确拒绝，避免无界缓存；MCP wire 保留既有 64 MiB 上限。

`DocumentReference` 为 id/fileId/version/status/parserVersion；`DocumentChunk` 含 text/source/range/truncated/nextCursor/status/notice。offset/length 按 UTF-16 code units；query 在 offset 后查找首次字面匹配。片段先计算完整模型 JSON/source/标记预算，再确定 range 与 cursor，最多总计 30,000 字符，下一页不会跳过被裁掉的字符。实际存在的 Markdown 标题/工作表标题可作为起始位置；没有 pageNumber 推测。模型结果携带私有 `fileSources`，复用 T09 后续消息/工具参数来源校验。

实际 Her 私有 stdio → wrapper 转换（不是 Python 直接调用或 mock）验证：

| 样本 | 已观察结果 |
| --- | --- |
| tiny.docx | 标题、中文、Apples/7 表格；Markdown 下划线会转义 |
| tiny.pptx | slide/body/notes 标记保留 |
| tiny.xlsx | Revenue/Costs 两表、表格文字保留；公式无缓存值为 NaN，不重算；query 来源 sheet 正确 |
| text.pdf | 两页文字保留；仅提取状态 partial，不推断物理页序 |
| scanned.pdf | 成功但无文字，status=empty，并提示后续视觉识别 |
| mixed.pdf | 文字和 header 保留，扫描内容缺失，status=partial |
| corrupt.pdf | 发布解析器回退纯文本，保守 partial；不宣称文件结构正常 |
| encrypted.pdf | 转换失败，提示解密/重新导出/检查依赖，无成功缓存 |
| long.txt | 66,000 字符保留本地，模型按实际序列化预算分页 |

`HER_TEST_MARKITDOWN=1 npm test -- tests/documents.test.ts tests/documents-runtime.test.ts` 运行实际持久安装与上述 fixture；常规测试跳过真实依赖用例，仍运行私有协议 mock 和文件/缓存/分页/取消用例。真实用例核验原始工具不可直调、每次外层授权/计数/派发一次、撤销后拒绝，shutdown 后 owned process 列表为空。此验证为本机 Node 主进程逻辑与真实 Python MCP 联调；未启动 Electron/Chrome，也未验证打包应用、真实用户资料、模型视觉或 OCR。T11 负责 PDF 页面渲染/视觉链，T12 负责附件/授权文件 UI，T13 负责 GUI/安装包综合验收。


### T10 fix1：可恢复的资料清理

暂存目录改为 `documents/staging/<Host UUID>/source.<ext>`；写入任何暂存或缓存字节前，先把 UUID 与所属会话记录到 `document_owners`。引用发布和 published 标志在同一数据库事务提交。应用启动执行一次未发布/已删除会话所有权恢复，不扫描或删除未知路径；非 ENOENT 删除失败保留记录并输出不含路径的可操作诊断。旧 v10 已发布缓存通过现有 documents 行迁移；无法归属的旧版本中断文件不会被猜测归属或批量清理。

永久删除先清理指定会话全部已记录文件，再提交对话删除；清理失败时回滚数据库，保留回收站记录和清理责任，允许修复权限后重试。未发布所有权不会在 purge 中提前丢弃，避免已提交的异步暂存写入迟到后变成孤儿；完成清理或下一次启动恢复后再释放。磁盘删除不是数据库事务：SQL 删除失败可能已清除了可重建缓存，恢复对话后仍须重新检查源授权再提取，原文件和其他会话不变。

DocumentService 持有在途提取/清理 promise，shutdown 停止新请求并加入现有全局五秒退出 drain。截止后迟到任务只完成文件系统清理，不触碰已关闭数据库；未释放的持久所有权留待下次恢复。没有新增退出期限、后台清理框架或无限重试。回归覆盖实际暂存原文/未发布文本跨重启、真实非 ENOENT unlink 失败、purge 与迟到写入、已发布 v10 迁移、SQL 回滚后重提取及五秒前后延迟清理。测试输出仍有 Node SQLite ExperimentalWarning，区别于功能失败，不称为无警告日志。

## T13 本地应用包与无源码安装

打包使用 `@electron/packager@20.3.0`、Electron 44.7.0、macOS arm64；`npm run package` 输出 `release/Her-darwin-arm64/Her.app`，bundle ID `com.her.desktop`。不签名/公证/发布，ASAR 关闭，主入口 `Contents/Resources/app/out/main/index.js`。仅复制 out、生产 node_modules、package.json；固定依赖安装资源通过 extraResource 放到 Contents/Resources。

安装包用户将下文 `/path/to/Her.app` 替换为实际应用位置，无需 checkout：

```sh
mkdir -p "$HOME/.local/share/her/dependencies/web-tools-v1"
cp "/path/to/Her.app/Contents/Resources/mcp-web-dependencies/package.json" "/path/to/Her.app/Contents/Resources/mcp-web-dependencies/package-lock.json" "$HOME/.local/share/her/dependencies/web-tools-v1/"
cd "$HOME/.local/share/her/dependencies/web-tools-v1"
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --ignore-scripts
# 已另外安装 uv 时：
sh "/path/to/Her.app/Contents/Resources/dependencies/markitdown/install.sh"
```

包内两个资源目录的 README 保留完整说明；Node、uv、Python 和工具运行时仍分别安装。原有仓库根目录复制命令仅适用于源码用户。PDF.js 6.4.299 的实际 HTML/preload/worker、cmaps、standard_fonts、wasm、iccs 和许可证位于 app/out；不会从 checkout 绝对路径加载。工具版本兼容、GUI 冷启动、真实模型和系统权限各项结果见[独立验收矩阵](her-tools-v1-acceptance.md)，测试成功不自动等于外部服务验收。
