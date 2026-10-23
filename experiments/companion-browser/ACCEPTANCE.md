# B3：有界 HTTP 来源对照与浏览器能力验收

日期：2026-10-23。HTTP 真实读取已验收；最终消息交付另有真实 Pi SDK + 本地模型 wire 证据。浏览器诊断完成，自动 `observe` / `navigate` **均 unavailable**，不得据此标记浏览器自动化已验收。没有 Git 提交、外部发布或更新现用搜索 runtime。

## 支持的有限任务

```text
请比较下面三家酒店的公开页面，整理来源对照表：
甲酒店 https://hotel-a.example/
乙酒店 https://hotel-b.example/
丙酒店 https://hotel-c.example/
搜索词：“可选的字面查询”
```

仅识别“请/帮我”这一窄中文格式、三个不同名称及明确 HTTPS URL，可选一个带中文引号的字面查询。不推断目的地、推荐、价格、日期、预订或其它比较语义；不支持的自然请求仍需确认。模型候选不是授权。HTTP scope 从持久原始意图产生，包含 exact URLs/query、origin、`renderMode=request`、`redirectPolicy=error`。搜索固定请求 `https://cn.bing.com`，不自动打开结果链接；结果只保留当前范围中的 URL。

`HttpComparison` 实装 `resolveScope/revalidate/recordDelivery/validateCompletion`，由 main 注入 Host。三份实际 request 结果写收据并生成确定性 Markdown 来源表（用户名称、观察标题、有界真实摘录、URL；缺失标题明确标记）。第三次读取可返回表给模型。Host 在正常最终 Pi assistant entry 持久化后验证文本包含整张表（仅 CRLF 与每行边缘空白归一化），绑定真实 run/message 引用，再验证当前范围与来源才 complete。三个 reads、模型 done、tool succeeded 或 run completed 本身都不构成完成证明。该证明不验证模型价格建议、优劣结论或通用比较语义。

## 上游与 Her 补丁来源

复用现有 `open-websearch@2.2.0`，原 lock 下载地址 `https://registry.npmmirror.com/open-websearch/-/open-websearch-2.2.0.tgz`，npm integrity 保持：

```text
sha512-Wv2iZqknbNGNMqD9YQ7+gfgc0FFIFg303HfbysRDDbbob9vamCp/99ltP3EIMO/kskWERU9cFpDV3tO1sdnPTw==
```

Her revision `her-request-confinement-v1` 与官方字节明确区分：

| 分发目录 tree SHA-256 | 值 |
| --- | --- |
| 官方原始 | `e4f65c6b7244abe3257142a7b473ba0d6e50d65f56520397826cc6d56d049b03` |
| Her patched | `b8d9e106bc30e4877acbdea464cc333f3fac49e6794e4c0b2cff190493796598` |

`resources/mcp-web-dependencies/her-request-patch.json` 保存四文件精确 before/after SHA-256 与 replacement；`apply-her-patch.mjs` 验证完整原始 tree → 所有文件原 hash/唯一上下文 → 预期新 hash → 写入 → 完整 patched tree。重复执行识别同一 revision；未知、部分补丁、伪造声明或篡改字节拒绝。tree digest 算法沿用依赖校验：相对文件名 NUL 文件 SHA-256 LF，排序后再 SHA-256；不含 `node_modules`，拒绝 symlink。不制作或发布新 tarball，因此没有冒称官方下载 hash 的自定义包。

具体调用链与控制：

- `build/tools/setupTools.js` schema/handler 接收、透传仅 `redirectPolicy:error`。
- `build/core/fetch/fetchServices.js` 透传给现有 fetcher。
- `build/engines/web/fetchWebContent.js` 在 request 分支将现有 HEAD/GET 的 `maxRedirects=0`，仍沿用原抓取、SSRF 与解析代码。
- `build/engines/bing/bing.js` 原 axios `maxRedirects=0`，将地域二次跳转上限从 1 改 0，固定 cn.bing.com 查询。
- Her 编译适配器注入 redirect policy；模型 schema 不暴露该字段。响应 original URL 必须等于冻结请求 URL，final URL 再核对，越界内容不供模型使用。事后过滤本身不被当作零越界网络证据。

`PresetDependencies.webRequestConfinement()` 校验真实已安装 package tree；main 只为已校验且仍 enabled/current revision 的 preset 注册自动能力。未打补丁的官方 runtime 可继续精确单次审批，不获得自动 scope。README 与界面生成的安装命令一致：固定 lock `npm ci --ignore-scripts` 后运行随资源附带的 patch；用户须先停现有服务。本次仅在临时副本执行，未改全局缓存/用户 runtime。`scripts/package.mjs` 已将整个 `mcp-web-dependencies` 目录列为 extraResource；B3 不重复整体 app package 验收（由 B8 负责）。

## 四层证据

| 层级 | 实际结果与边界 |
| --- | --- |
| 源码与本地单元 | 冻结 args、当前 scope、返回原 URL/final URL、范围外 URL/个人资料提交拒绝、搜索结果过滤；浏览器 code/evaluate/CDP/伪造所有权拒绝；固定模板字符串注入只是数据。 |
| 真实 Pi SDK + 本地模型 wire | `tests/delegation-http.test.ts`：daily delegate → work，三 reads → assistant 实际交付整张表 → complete；缺表/来源删除/服务 revision 改变不完成。模型服务是本地 fixture，并非在线模型。 |
| 真实 MCP HTTP | `HER_TEST_COMPANION_HTTP_LIVE=1 npm test -- tests/delegation-http-live.test.ts`：隔离 HOME + 已锁定 runtime 副本 + 补丁校验 + 实际 stdio MCP；三官方酒店直达页均 request、original=final、0 prompts、3 receipts + table。没有伪造 delivery，也没有声称在线模型最终交付。 |
| 真实官方 CLI + 浏览器 | `HER_TEST_COMPANION_BROWSER_LIVE=1 npm test -- tests/browser-actions-live.test.ts`：一份自建 TaskSpace、真实观察、本地攻击服务器计数；诊断成功而自动能力不可用。详见下节。 |

HTTP 实际成功页面：

- 新加坡莱佛士：https://www.raffles.com/singapore/
- 伦敦莱佛士：https://www.raffles.com/london/
- 巴黎莱佛士：https://www.raffles.com/paris/

每页返回真实标题及 2033 字符结果（请求 maxChars=2000，上游附截断说明），领域持久层仅保存 title≤200、excerpt≤400 和完整返回文本 hash。`http-live-result.json` 记录来源及 receipt/table refs/hash。请求模式分支无浏览器 fallback、实际 retrievalMethod=request，探针未调用浏览器 API；没有做全 OS 进程级零浏览器行为监测，不夸大该证据。

`http-redirect-result.json` 由真实安装包现有请求实现 + 注入 HTTP 302 transport 边界生成：fetch 仅原 URL 的 HEAD/GET，Bing 仅一次固定 cn.bing.com，forbiddenRedirectDispatches=0。这是实际实现的本地边界测试，**不是现场网络计数**。实际 Peninsula 读取遇到 `Too many redirects (max 0)` 被拒绝，证明实际 MCP 链带入该限制。没有实际在线 Bing 成功结果探针；Bing 仅有该边界测试与本地 scope/search fixture。

失败与成功日志均保留于 `.superpowers/sdd/2026-10-22-companion-delegations/evidence/`：首次 Wikipedia 读取失败（规范化失败，未取得足够上游细节，不推定根因）`task-3-http-live.log`；第二轮 Peninsula redirect 拒绝 `task-3-http-live-official.log`；新明确输入 Raffles 三页成功 `task-3-http-live-raffles.log`；补全 patch 幂等/字节篡改/transport 边界后的成功 `task-3-http-live-final.log`。未通过放宽 redirect 策略制造 PASS。

## 浏览器诊断与清理

已完整阅读实际安装 guide v2.1.0（550 行），副本 `ego-task3-current-guide.md`。实际官方 CLI 创建且只使用 `Her bounded browser 2d95452d-156c-4b7b-99c7-85d968b05ae2`，space=1、p1、agent ownership；不检查/切换用户 profile，不认领既有用户或 unmanaged tabs。固定观察返回真实新标签页快照。精确授权 fixture setup 在该唯一 page 导航本地 `/attack`；服务器收到 `/attack`、`/favicon.ico`、`/unapproved-background`，证明页面具有自主后台请求。

随后 typed observe/navigate 由于 unavailable 未派发，伪造 click/fill/code/workspace/page、HTTP redirect URL、已取消 context 均拒绝；typed 阶段 `unapprovedRequests=[]`。这只证明禁用门阻断，没有证明启用后可以防 unload/重定向/后台请求/远端停止竞态；observe 崩溃自动重建也未证明可控。因此两能力继续 false，任意 `ego_browser_run` 仍 unknown/精确审批，CLI 进程退出不冒称远端脚本已停止。

此探针正常成功结束，无 CLI error/timeout/unknown/takeover。控制者澄清成功诊断应清理后，**仅一次**对同一 owned space 执行 `finish({keep:[]})`，真实回执：

```json
{"spaceId":1,"closedSpace":true,"keptManagedLabels":[],"closedManagedLabels":["p1"],"preservedUnmanagedCount":0}
```

回执在 `task-3-browser-finish.log`，合并记录在 `browser-live-result.json`。无第二空间、无 fixture 重放、finish 后无浏览器操作。原 live wrapper 在完成诊断时保留空间；后续已修正为成功诊断收尾一次、error/unknown/stop 不收尾，并改为记录实际派发 target 统计。没有为了测试 wrapper 修正再建空间；实际“probe + 独立一次 finish”证据与 wrapper 本地检查明确分开。实际 userTabsTouched=0 依据全部命令只指定 agent-owned 1/p1；初版 JSON 的该字段本身不是独立全浏览器审计。

## C 的来源与遗忘接点

SQLite v1 新表 `delegation_http_evidence`，`id` 主键、`delegation_id` FK cascade、`scope_revision`、JSON data；不存完整 HTML/headers/credentials。`HerStore.saveHttpEvidence/listHttpEvidence/deleteHttpEvidence` 是内部接口，无模型任意写入口。

- 所有记录：`id, delegationId, scopeRevision, intentId, kind, runId, createdAt, refs, contentHash`。
- receipt：`url, finalUrl, title, excerpt, retrievalMethod=request, adapterId, adapterRevision`（实际 MCP 服务 config revision）、`providerId, callId, payloadHash`。
- table：`markdown` + 三个 receipt IDs，hash 为确定性表文本 hash。
- delivery：`messageId`（Pi 实际 assistant entry id）、`runId`、table ref、最终消息文本 hash。

查验始终回到持久 intent/current scope、run 绑定、当前 enabled 已验证 provider revision、有效 receipt refs 及重建表。删除 receipt 后其 table/delivery 无法再证明完成；C 应遍历 refs 清理派生产物，且把 Pi 权威历史作为独立来源过滤/忘记路径处理，不能仅删 SQLite 当成抹除聊天历史。此任务提供 refs 与失效接口，不实现 C 的完整遗忘 UX/清理工作流。现有 completed 状态的历史撤回策略由 C 接续，不冒称删除自动回滚所有已完成状态。

## 检查记录

TDD RED 日志覆盖 original/final URL、producer/receipt/gate/Host delivery、未知补丁/运行字节、typed browser、精确批准结果回传、显式 redirect scope 与安装命令缺失。focused HTTP 48/48；browser 24/24；最终修复前串行原失败 suites + HTTP 163/163；安装链 26/26。完整检查第一次 1139 pass/4 skip/3 个 5s timeout（attachments/config-freeze/model-connection 首次 Pi 加载用例），无新增默认 live 派发或残留 test/MCP 子进程证据。串行复验通过，第二次原配置完整检查 1142 pass/4 skip + typecheck/build；没有调高 timeout 或删除断言。首次超时根因未被严格定位，不把资源竞争作为已证明结论。

最终安装链修改后的 `npm run check`：77 test files passed / 3 skipped，1142 tests passed / 4 skipped，TypeScript、electron-vite 与 native notification helper 构建通过，exit 0（`task-3-final-check-complete.log`）。实际 HTTP 和浏览器探针没有因这些文档/安装命令小修重复运行；整体 Electron/package 留待 B8。

## B8：真实主进程与当前打包应用验收（2026-10-23）

B8 使用正常生产 main/preload/IPC/React/Host/Pi，不新增测试入口、renderer 授权或 SSRF 例外。模型服务为本地协议 fixture；待提交资料为虚构 `example.test` 地址，仅展示并拒绝，实际 tools/call 次数为 0。HTTP 使用临时自管 HOME 中复制的固定依赖，现有安装包只读，补丁仅作用于副本，生产 preset 就绪检查验证真实字节与当前配置。Fix 1 后复制保留相对链接，并在启动前逐个 realpath 校验依赖链接不逃逸自有 modules；独立 Node 可执行链接在该树之外。此前复制留下六个指向安装目录的 .bin 链接，因此历史运行只证明直接 owned CLI 的业务断言与已记录 package hash，不证明完整依赖图隔离；未观察到源 runtime 被修改。子进程 HOME、CLI 解析路径和前后 tree hash 均断言；不复制凭据，不修改用户现有 runtime。

`tests/e2e/delegations.spec.ts` 已实际跑通：范围内读取 → 越界资料确认卡 → 拒绝 → 改参数重试仍被阻断 → 独立公开读取继续 → 暂缓 → 应用重启且无自动重放 → 重新检查能力 → 用户明确继续 → 三页来源表由 Pi 最终消息真实交付 → 数据库完成。保留 revision 1 的两次历史读取；恢复的 revision 3 有三条收据与表/交付链；终态 revision 4 的 proof.scopeRevision=3。另一个场景验证伪装名称/只读注解的自定义 MCP 无自动授权、原话题卡隔离与范围拒绝。

### Q2/3/5/6/8/9/10/12 证据矩阵

| 决定 | 本地模拟与源代码集成 | 真实 Electron / 本地服务 | 真实浏览器 | 真实外发 / 业务渠道 |
| --- | --- | --- | --- | --- |
| Q2 有界委托 | 实际服务/注册表范围、版本、对象与原始 intent 检查；进度只计真实后置条件 | 正常 main + 已校验 Herpatched MCP；实际 Raffles HTTPS；范围内读取连续执行；伪装 MCP 不自动授权 | 自动观察/导航仍 unavailable，未重探 | 仅公开只读 HTTP；无预订/付款/资料提交 |
| Q3 准确授权内容 | B7 renderer/IPC 测试覆盖冻结预览、目标/内容/选中 owner/revision | 虚构资料的原始实际参数在真实卡显示；过期版本/错误 owner 批准拒绝；daily 不显示该卡 | 未验收 | 本地虚构资料提交仅被拒绝；不等价已验证真实业务渠道内容 |
| Q5 原样消息指令 | B6 编译适配器、唯一联系人、逐次消费/readback/竞态单元集成通过 | **生产无已注册消息渠道/自然消息入口，未验收** | 未验收 | 微信等真实消息发送未验收，不能标完成 |
| Q6 跨运行续接 | B7 严格 canonical input、暂停控制、凭据/owner 竞态集成 | 真正关闭重启；本地 provider 请求数不增；显式继续后 lineage 与新范围版本；最终 Pi 交付+DB proof | 不据此启用浏览器 | 只证明公开 HTTP；未知真实业务不自动重放 |
| Q8 明确修正优先 | B5/B7 实际 Host/Store/control/gate 集成；新进度测试保留需澄清控制的 approval 状态 | 生命周期暂缓是真实 UI/IPC；自然修正语义未由在线模型验证 | 未验收 | 无真实消息/预算业务变更 |
| Q9 拒绝步骤继续 | 语义拒绝换工具/内容/数据类别不能规避；无依据撤回失败 | 真实卡拒绝虚构提交，变更 email 重试仍 0 tools/call；独立 HTTP 读取继续，重启后 denial 保留 | 未启用浏览器，不声称跨浏览器外发证明 | 无实际资料外发；拒绝边界已验收 |
| Q10 模糊停止候选屏障 | B5/B7 同步候选屏障、多个 owner/晚 materialization/原始输入关联测试 | 无在线多委托指代语义证明；本地 Host 行为证据单列 | 未验收 | 无真实发送渠道验证 |
| Q12 撤销全局永久放行 | 旧配置/旧 conversation decision/可信观察不能绕过的回归 | 自定义 MCP 仍逐次确认；真实设置回归与未知动作恢复回归；不恢复全局开关 | ego opaque 仍逐次精确审批；自动能力未启用 | 无全局外发授权 |

### C 进度接口的限定

`DelegationService.getProgressEvidence(conversationId)` 仅给可读 work owner 返回最小 DTO；不返回原文、scope、标题、目标、provider、ActionDescriptor、UserIntent 或收据内容。`user-request` 定位原始 `user_intents.id`；`ledger` 只引用真实未处理 unknown 调用的 `tool_calls.id`，不伪造 read ledger。

`completedActionCount` 是**当前可核验授权版本**的实际读取数；已完成委托使用 completion proof 中的旧 scope revision。暂停/改版后 0 不代表从未发生动作；`active` 仅表示委托仍有效，不证明 Task 正在运行；pendingReason=null 也不证明后台在执行。C 不得据此生成“没有做过任何事”“尚未开始”或“正在后台执行”。历史 receipt/ledger 不删除、不回滚；来源删除使派生完成证据失效，历史状态不自动改写。

真实在线模型语义质量、在线 Bing、真实消息/预订/付款/资料提交、自动浏览器能力、原生通知权限与投递继续单独标未验收。B8 未请求或改变 macOS 权限；A 的 not-determined/Tray fallback 证据仍只代表其原范围。

### B8 最终结果与打包边界

- 源码检查：`task-8-check-final.log`，typecheck/build 通过，1276 pass / 4 skip。
- 正常生产 main 的 Electron 回归：`task-8-e2e-regressions-final.log`，12 pass / 1 原有 MarkItDown opt-in skip；真实 HTTP 完整流程结果在 `task-8-source-e2e.json`。
- 独立公开 HTTP：`task-8-http-live.log`，1 pass；本次实际三页请求与注入重定向边界分别记在 `http-live-result.json` / `http-redirect-result.json`，未重探浏览器。
- 本次 package 构建通过；`task-8-package-assets.json` 记录其列出的 245 个文件与源码构建/资源逐字节一致；旧清单漏列两个 `.cjs` preload 文件，Fix 1 的完整构建文件清单会补齐，旧结果不回溯升级。`task-8-package-runtime.json` 验证真实打包 Resources 解析、IPC 生成的锁定安装命令、打包 patch 脚本在自有上游副本上的实际执行与源 hash 不变。未实际运行完整联网 npm ci 安装。
- **打包 Electron：1 pass / 1 fail**（`task-8-package-e2e.log`）。范围拒绝/卡隔离场景通过；可信 HTTP 完整流程在保存 preset 配置时被临时 HOME 下 safeStorage 的 macOS 钥匙串 UI 阻塞，180 秒超时，业务尚未派发。进程 sample 与 Playwright trace 保留。未授予 OS 权限、未接触个人 Keychains、未换回真实 HOME、未新增绕过。所属进程已退出；测试 finally 已清理临时 fixture，因此未保留 DB 副本。**打包可信完整链路仍未验收**；源码流程与资源相等不替代此项。

既定最小 DTO 不含 `resumeRequired`；重启后的 active/null 可能仍需明确继续，C 必须保持“委托有效”与“正在执行”的区别。以上日志位于 `.superpowers/sdd/2026-10-22-companion-delegations/evidence/`。

### B8 审查修复 1：owner 进度与复制链接

I1 已按实际 `ownerResolutions[conversationId]` 排除该 owner 已解决的澄清；A 的暂停保留不再继承 B 的等待状态。真实 ControlService 双 owner 回归覆盖全部动作暂停与仅修改动作暂停、B 后续选择不改变 A、保留屏障、真实工具审批与 unknown 优先级。未改变生命周期或动作权限。

I2 已保留内部相对符号链接并在应用启动前逐个检查 realpath 位于自有 modules，越界即失败。新增纯本地复制检查；旧业务 PASS 不回溯升级为新的隔离证明。新的源 Electron 证据单列在下文。打包钥匙串完整链路的已知阻塞不会因本次资源检查变为 PASS，也不重复触发。

Fix 1 验证：`task-8-fix-1-check.log`：1278 pass / 4 skip，typecheck/build 通过；进度专项 8 pass，纯复制专项 1 pass。新的源 E2E 首轮为 2 pass / 1 fail：复制与范围拒绝通过，完整场景第一条 HTTP 收据为 0，具体工具结果未保留，原因未证实。失败日志与 trace 保留；未放宽断言或超时。一次原样定点重试 `task-8-fix-1-source-e2e-retry.log` 完整场景 1/1 pass（17.8 秒），同一次运行完成全部业务链，新的 `task-8-source-e2e.json` 记录六条自有依赖链接及实际收据/交付/proof。不得将首轮与重试合并称为整批全绿。

Fix 1 已重建当前 package（`task-8-fix-1-package.log`）。更新的 `task-8-package-assets.json` / `task-8-fix-1-package-assets.log` 对完整构建目录与资源目录的路径集合和字节验证通过，共 **247 文件**，含两个 `.cjs` preload；main SHA256 为 `d1c96db5c15de6d5667f941c25ff0ace60773556151e9eabc6c8f47b5bf725f6`，tests/已知缓存未入包。本轮未启动打包应用；此前的打包拒绝/资源运行证据仅属旧构建的历史证据，可信打包完整链路仍未验收，未重复已知钥匙串阻塞尝试。
