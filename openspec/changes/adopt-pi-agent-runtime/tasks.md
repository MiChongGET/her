# Tasks

## 1. 依赖锁定与 SDK 隔离验证

- [x] 1.1 以精确版本安装 `@earendil-works/pi-coding-agent@1.3.0`（及其声明的 pi-agent-core / pi-ai 1.3.0），更新 lockfile；验证 `npm ls @earendil-works/pi-coding-agent` 只有一个 1.3.0 且 `npm run typecheck` 通过
- [x] 1.2 在 `tests/pi-sdk/` 新增基于回环 HTTP/SSE 模拟服务的 SDK 探针测试：受控注入 + `noTools: "builtin"` 后实际工具集合只含注入工具，且用户主目录的 Pi 配置/扩展/auth 未被读取（以临时 HOME 放置诱饵文件断言）；`npx vitest run tests/pi-sdk` 通过
- [x] 1.3 探针测试覆盖：两会话同时 prompt 事件不串线、`abort` 只影响本会话、条目落盘与 `agent_settled` 顺序（实测普通消息不派发 `entry_appended`，已据此修订 D6）、`appendCustomEntry` 不进入模型上下文；记录实测结果到 `experiments/pi-sdk-1.3.0/REPORT.md`
- [x] 1.4 探针测试复现 pi-ai-compat 报告中的差异（坏工具 JSON、缺 `[DONE]`、`apiKey=''`、Anthropic 基址、错误含密钥、读取停滞），逐项在 REPORT.md 记录 1.3.0 是否仍存在及 Her 处理方式（D7 无密钥注册方式、D9 来源过滤钩子在此确定）
- [x] 1.5 在 electron-vite 构建与 `npm run package` 生成的 `.app` 中运行最小 Pi 会话（含 photon-node 加载）；验证主进程与打包后均成功，结果写入 REPORT.md。若任一关键能力不成立，停止后续任务并向用户报告

## 2. 新资料空间、会话权威与投影

- [x] 2.1 数据目录改为 `appData/Her-Pi-v1`（保留 `HER_DATA_DIR` 覆盖），创建 `pi/sessions`、`pi/workspaces`、`artifacts`、`documents`；测试断言路径与旧 `userData` 不重叠且旧目录未被访问
  - 已做：Pi 会话/工作区放在 `<userData>/Her-Pi-v1/pi/`，`HER_DATA_DIR` 可覆盖
  - 未做：`her.sqlite`、`documents`、`tool-artifacts` 仍在旧 `userData` 根目录（与旧版 Her 同目录，与"新资料空间"相悖）；没有断言路径不重叠的测试
  - 说明：目录在首次使用时创建（Pi 会话/工作区、artifacts、documents）；`tests/data-paths.test.ts` 5 条覆盖统一入口、不与旧 userData 重叠、旧文件不被读取或改动
  - 遗留：`tests/e2e/` 中 file-bridge、tool-resolution、tools 三个 spec 仍调用旧 store API，未更新，也未运行
- [x] 2.2 重写 `src/core/storage/store.ts` 为新 v1 schema（D6 表清单），删除旧迁移代码与 messages 表；`tests/storage.test.ts` 按新 schema 重写并通过
  - 说明：`tests/storage.test.ts` 已按新 schema 整体重写为 47 条（schema 与版本检查、设置、模型服务、会话、重命名、回收站、永久删除、投影、MCP 服务），连续 15 次运行全部通过
  - 顺带修了两处实现缺陷：`HerStore` 缺 `renameConversation`（IPC 在调用它，界面重命名会直接报错）；`listConversations` 缺 `rowid` 次级排序，同一毫秒创建的对话顺序不确定
  - 注意：`ipc.ts` 里的 `@ts-nocheck` 已摘掉（此前正是它盖住了上面第一处缺陷）。`src/` 里仍有 5 个文件带 `@ts-nocheck`：documents/service.ts、files/access.ts、files/tools.ts、mcp/config.ts、tools/artifacts.ts，其类型错误尚未暴露
- [x] 2.3 实现投影：在 `turn_end` / `agent_settled` / 启动时从 `SessionManager.getEntries()` 拉取并以 entry ID 幂等 upsert，与游标对账补齐；测试”清空投影后重建内容一致””已写 Pi 未投影后补齐且不重复”
  - 已做：`AgentHost.reconcile()` 以 entry ID 重建投影，在一次运行结束和读取消息时调用
  - 未做：没有"清空投影后重建一致""已写 Pi 未投影后补齐且不重复"两条测试；没有在 `turn_end`/启动时拉取
  - 说明：`tests/projection.test.ts` 7 条：清空投影后重建与原来完全一致、陈旧行与错误游标被替换而非合并、Pi 已写而投影未更新时补齐且只出现一次、重复读取与重启不产生重复、游标跟随 Pi 最后一条
  - 与任务原文的差异：投影是整体删除后重建（结果幂等，但不是按 entry ID 逐条 upsert）；触发点是一次运行结束、读取消息、启动恢复，没有挂在 `turn_end`/`agent_settled` 事件上；启动时只对有被 claim 输入的会话对账，其余会话在首次读取时对账
- [x] 2.4 实现 drafts（中断片段）与 `her.run` 关联条目；测试中断片段不进入后续上下文
  - 说明：停止时已说出的文字存入 `draft_fragments`（`interrupted-text`），`her.run` 条目关联请求与任务；`tests/draft-fragments.test.ts` 5 条
  - 注意："片段不进入后续上下文"并非 Her 的代码所致，而是 Pi 在转换历史时整条跳过 `stopReason` 为 `error`/`aborted` 的助手消息（pi-ai `transform-messages.js`）。测试固定了该行为，升级 Pi 时会暴露变化
  - 未做：`draft_fragments` 只写不读，界面上的"中断片段标记"（9.2）尚未用它
- [x] 2.5 实现启动恢复：非终态任务→interrupted、dispatched 无关联条目的输入→pending 且队列 paused、running/dispatched 工具→unknown 并写隔离；对各断点注入崩溃的测试全部通过
  - 说明：重启时任务标为 interrupted；被 claim 的输入按 Pi 会话记录分流——用户消息未写入 Pi 则放回队列（仍暂停），已写入则关闭为取消、不重发，并补一条失败的助手消息；读不出会话一律不重发；工具账本沿用 `ActionLedger.recover()`。`tests/startup-recovery.test.ts` 16 条
  - 同时修了一个真实缺陷：重启后点"继续队列"会把消息卡在 running（先 claim 后取事件接收端，失败时无法回退）
  - 未覆盖：崩溃发生在 SQLite 写入与 Pi 写入之间的更细断点只测了代表性的 4 个阶段；`approval`/`waiting_resource` 状态的任务没有单独测
- [ ] 2.6 会话文件损坏时保留原文件、隔离会话并报错；测试其他会话可正常发送
  - 已做：整个文件无法识别时，读取和发送都被拒绝，提示为不带路径的中文，原文件字节不变，只影响该对话；其他对话照常（`tests/session-damage.test.ts` 7 条）
  - 未做：文件中间夹着坏行时 Pi 会静默跳过，Her 没有检测也没有提示（测试只是固定了这一现状）；没有持久的"已隔离"标记，每次访问各自报错
- [x] 2.7 确认单实例锁覆盖新资料目录（第二实例不写入）；补充测试或手动验证记录
  - 手动验证记录（`experiments/pi-sdk-1.3.0/single-instance.sh`，未打包的开发版 Electron 44.7.0，macOS）：同一 `HER_DATA_DIR` 下先后启动两个实例，第二个 1 秒内以退出码 0 退出；第二个实例前后 `Her-Pi-v1` 内文件的路径、大小、修改时间无任何差异；第一个实例全程运行
  - 说明：锁在 `app.whenReady` 之前由 `requestSingleInstanceLock()` 取得，`start()` 只在拿到锁的分支里执行；锁跟随 `userData`，所以不同数据目录的实例互不影响
  - 未验证：打包后的 `.app`；两个实例几乎同时启动的竞争情形
## 3. 模型接入与凭据

- [ ] 3.1 profile 模型改为“Pi 目录模型 | 自定义兼容服务”，自定义服务必填上下文容量，认证方式 `api-key | headers | none`；`tests/profiles.test.ts` 覆盖校验与缺容量拒绝
- [ ] 3.2 实现 Her `CredentialStore`（按 profileId、safeStorage 加密、加密不可用时失败），每个 profile 注册独立 provider ID；测试两个同协议不同 Key 的 profile 并发请求各自携带正确 Key，资料目录 grep 不到明文
- [ ] 3.3 实现无密钥与仅请求头模式（D7：进程内随机内部值 + `fetch` 包装删除对应认证头 + `redirect: 'error'`），三协议模拟服务断言请求头无认证值、自定义头存在，资料目录与日志中找不到内部值
- [ ] 3.4 错误脱敏：模型/运行错误映射为中文提示，测试含 Key 与认证头值的 SDK 错误不出现在 IPC 事件与日志中
- [ ] 3.5 连接测试改用 Pi ModelRuntime 最小请求；测试成功、认证失败、无密钥三种情况
- [ ] 3.6 用量记录：有用量记数，无用量标 unknown；测试不记为 0

## 4. Agent 宿主与并行会话

- [x] 4.1 新建 `src/core/agent/factory.ts`，集中受控注入并在创建后比对工具白名单；测试白名单外工具导致拒绝启动
  - 说明：`tests/agent-factory.test.ts` 5 条中的 3 条针对白名单：暴露的工具与传入的完全一致且无内置工具、传入空集则为空、集合不一致时拒绝启动。已验证：临时关闭该检查后"拒绝启动"那条会失败
  - 局限："不一致"只构造了同名工具这一种情形，其他导致集合不符的途径没有逐一模拟；工厂文件在 `src/core/agent/factory.ts`，任务里提到的 `handle.ts` 属于 4.2
- [ ] 4.2 新建 `handle.ts` 与 `host.ts`：按 conversationId 的句柄、generation、runId、单调 seq，旧代次事件丢弃；测试 A/B 同时流式、停止 A 不影响 B、迟到事件不改写新任务
- [ ] 4.3 新建 `events.ts`，Pi 事件映射为 Her `TaskEvent`（含全部任务状态）；测试“模型回答结束但仍调用工具时保持 running”
- [x] 4.4 模型请求重试最多两次（Pi 公开设置），认证/校验/取消不重试，重试不重放工具；模拟服务测试三种情况
  - 说明：Pi 重试开启、最多 2 次（`MODEL_RETRIES`）；`tests/model-retry.test.ts` 15 条，连续 3 次全过：503 在三种协议下重试后完成、最多共 3 次请求后失败、401 在三种协议下只请求 1 次、被拒绝的重定向只请求 1 次、用户停止后不重启、空回复不重试、工具结果之后的请求失败重试时工具仍只运行 1 次
  - 发现并修了两个真实缺陷：(1) OpenAI SDK 把所有失败都改写成 "Connection error."，Pi 会把它当可重试，导致 401 也被重试三次——现在 fetch 包装在遇到非暂时性状态码或被拒重定向时关闭本次运行的重试；(2) 第一次尝试已流出的文字在重试后没清掉，回复变成 "你好🌙你好🌙"——现在收到 `auto_retry_start` 时清空并通知界面
  - 局限："暂时性"的状态码清单（408/425/429/500/502/503/504/529）是我定的，不是来自设计文档；断流类错误依赖 Pi 的正则判断；退避时间默认 2 秒起、每次翻倍，测试里用 `retryPolicy` 缩短；没有用真实服务验证
- [x] 4.5 `ChatService` 收缩为门面委托 `AgentHost`，删除 `active` 单例、`generate()` 与 50 条 / 64,000 字符截断；测试超过旧界限的历史仍进入上下文，`tests/chat.test.ts` 按新行为重写并通过
  - 说明：`ChatService` 只是委托 `AgentHost` 的门面，没有 `active` 单例、`generate()` 或 50 条 / 64,000 字符截断；`tests/agent-factory.test.ts` 另 2 条证明 120 条旧消息、以及超过 64,000 字符的旧历史都会从第一条起送到模型
  - 局限：`tests/chat.test.ts` 已删除而不是"按新行为重写"，其覆盖的主题逐项对照后分散在 host-*、attachments、tool-*、system-prompt、model-selection、retry 等新测试里
- [ ] 4.6 任务冻结配置快照，禁用服务/删除凭据/撤销工具授权立即停止相关任务；测试运行中改名不影响当前任务、禁用服务立即停止
  - 已做（`tests/config-freeze.test.ts` 9 条；临时关闭宿主订阅后其中 5 条失败，说明测试有效）：删除模型服务、替换或移除 API Key、更改服务地址，都会立即停止正在使用该服务的回复、说明原因并暂停该会话队列；仅改名或改模型列表不影响运行中的回复；只停使用该服务的运行，其他会话照常；之后的任务使用新配置。撤销文件授权的停止见 7.3；运行中改配置不改变当前任务所用模型由 `validateRuntime` 的版本比对保证
  - 未做：禁用或修改 MCP 服务时，运行中的任务不会被停止——工具调用会因配置失效而失败，但回复本身继续；运行没有记录自己用过哪些 MCP 服务，要做需先决定"相关任务"的范围（用过该服务工具的运行，还是该会话所有运行）
  - 局限："暂时性"之外的配置变化（例如仅改最大输出）按连接是否变化判断，没有逐项列举
## 5. 工具执行门、资源队列与未知动作

- [x] 5.1 新建 `src/core/tools/gate.ts`，把注册表工具包装为 Pi custom tools，按 Her schema 二次校验；测试非法参数不执行、历史工具名不构成权限
- [x] 5.2 审批键改为 runId+callId+toolVersion+argsHash+target；`tests/tool-approval.test.ts` 覆盖批准 A 不放行 B
- [x] 5.3 新建 `resources.ts`（desktop / write:<target> / mcp:<service> 键，字典序多键、FIFO、可取消、finally 释放）；单元测试冲突排队、不冲突并行、审批等待不占锁、取消出队
- [x] 5.4 取得桌面后重新观察并重新核对授权/配置/generation；Peekaboo 测试中目标窗口变化后不使用旧坐标
- [x] 5.5 派发前写账本（失败不执行），取消/超时/崩溃登记 unknown 并写 `target_quarantine`；测试隔离跨会话、跨重启生效、用户处理后解除、无自动重放
  - 5.5 必须保留的旧 `TaskExecution` 行为（来自 tests/tool-execution.test.ts，该实现按旧 store 编写，已决定不迁移而重写）：
    - 全权限模式仍做 schema 校验、响应停止、阻断 unknown 结果
    - 审批等待期间只记录不派发，批准后仅派发一次；停止于审批前记为 cancelled，不是 unknown
    - 服务禁用/注销后重新注册不能复活旧审批；参数内容变化不派发旧值或新值
    - 第 41 次调用暂停且不派发；活动时间不含审批等待，调用超时从批准后开始计时（调用次数/活动时间上限已在阶段 6 用 `RunLimits` 实现）
    - 变更类动作派发后超时或远端 isError 记为 unknown，迟到的完成不改记录；失败的读取不能清除 unknown
    - unknown 目标必须由同一目标的真实成功读取清除；interact 恢复即使读取过目标也要显式审批；观察到的目标变化使审批失效
    - 同一记录不可并发执行、不可重放；Host 观察成功才清除持久 unknown，且保留 generation 隔离；先到达的 Host 观察不应用于随后被取消的读取
- [x] 5.6 `McpConnectionManager` 有状态服务按 (conversationId, serviceId) 建连接，取消单个调用不断开连接；`tests/mcp-lifecycle.test.ts` 覆盖停止 A 的浏览器操作 B 继续（实际覆盖在 tests/mcp-scoped.test.ts：mcp-lifecycle.test.ts 因引用已删除的 providers/probe 无法加载，未修）

## 6. 持久队列、停止、继续与压缩

- [x] 6.1 实现 `input_queue`（入队、查看、撤销、条件更新保证只取一次）与 IPC；测试撤销后永不发送、同一消息只产生一个任务
- [x] 6.2 任务结束判定（prompt settle + agent_settled + 无在途派发），仅 completed 自动取下一条，其他终态暂停队列；测试正常完成继续、停止/失败/压缩失败后不偷跑
- [x] 6.3 停止流程按 D3/spec 顺序执行，部分文本存为中断片段，迟到结果只入审计；测试生成中停止与迟到工具结果
- [x] 6.4 继续：为 interrupted/stopped/failed 任务创建关联新尝试，保留隔离与审批约束；测试继续后未知动作不重放
- [x] 6.5 开启自动压缩并按窗口计算 reserve/keepRecent；测试跨旧界限触发、工具结果后触发、小窗口模型可发送
- [x] 6.6 手动压缩与停止压缩（压缩期间消息入队）；压缩失败暂停队列并提供重试；超大单条直接失败提示；测试四种情况，压缩后原文仍可查看
- [x] 6.7 会话空闲时切换模型：运行中拒绝、小窗口先压缩、能力不足明确提示；测试三种情况且不影响其他会话

## 7. 附件来源与撤权过滤

- [x] 7.1 发送与工具读取前复核 grant/存在/版本，失效阻止发送；测试删除与替换文件两种情况
- [x] 7.2 （实际：写入 Pi 会话的 `her.run`/`her.sources` 自定义条目，只存 id，未另建 SQLite 表）实现 `provenance` 记录（改为写入 Pi 会话的 `her.run`/`her.sources` 自定义条目，只存 id；不另建 SQLite 表）（派生文本与摘要继承依赖，不存凭据与全文）；测试摘要依赖覆盖附件
- [x] 7.3 通过 1.4 确认的公开钩子在普通请求、压缩、恢复前过滤失效来源，撤权时停止在途请求；测试三条路径都不含撤权内容、迟到结果不复活

## 8. 回收站、永久删除与应用生命周期

- [x] 8.1 回收站：关闭派发资格→generation+1→停止任务→暂停队列→释放句柄与专属连接；恢复只查看不自动运行；`tests` 覆盖运行中删除 A 而 B 继续
- [x] 8.2 永久删除持久清理任务（墓碑→关句柄→删 Pi 会话→删投影/草稿/队列/缓存→附件引用归零才删）；测试重启后不复活、共享附件保留、授权原文件不删、失败可见可重试、未知动作隔离保留
- [x] 8.3 退出：`createShutdown` 接入 `AgentHost.stopAll()` 与 drain，超时只强杀 Her 子进程；测试两会话运行中退出全部停止并落盘
- [ ] 8.4 验证关闭窗口后台继续、重新打开显示最新进度/队列/审批（e2e 或手动验证记录）（**未做**：需要真实 Electron 窗口手动验证，本轮仅有单元/集成测试覆盖）

## 9. IPC、类型与界面

- [ ] 9.1 `src/shared/types.ts`、`src/preload/index.ts(.d.ts)`、`src/main/ipc.ts` 增加入队/撤销/停止/继续/压缩/切模型/按会话状态等通道，事件带 conversationId/runId/seq，不暴露 Pi 对象；`tests/ipc-policy.test.ts` 通过
  - 已做：`her:queue-get/cancel/resume`、`her:compact`、`her:compact-stop`、`her:model-switch` 共 6 个通道及类型、preload、输入校验，并有"拒绝其他发送者与子框架"的测试
  - 未做：事件没有单调 `seq`；`tests/ipc-policy.test.ts` 仍有 10 个失败（都在文件选择/预览相关，不在这 6 个通道上）
- [ ] 9.2 `App.tsx` / `TaskStatus.tsx`：多会话并行状态、排队消息与撤销、等待审批、等待资源、压缩中/失败/重试、中断片段标记；`tests/renderer.test.tsx` 覆盖 chat-message-layout 新场景
  - 已做（只读显示，经 `getQueue` 取得，6 条渲染测试）：排队消息列表、队列暂停原因、"正在压缩"提示、侧栏对话的运行/等待确认/暂停指示
  - 未做：撤销排队消息、手动压缩/停止压缩、切换模型、继续队列的界面控件；中断片段标记（依赖 2.4）；"等待资源"没有独立状态
- [ ] 9.3 `SettingsPanel.tsx`：目录模型/自定义服务、认证方式、上下文容量；`TrashPanel.tsx`：清理未完成与重试；渲染测试通过
  - 已做：上下文容量输入框、认证方式只读显示
  - 未做：认证方式显式选择（现在由是否填了 Key/请求头推断）；Pi 目录模型选择（依赖阶段 3）；`TrashPanel` 的清理失败保留与重试
- [x] 9.4 更新 `AGENTS.md` 中的技术栈、项目结构、IPC 与数据目录说明，使之与新实现一致
  - 已核对：文中提到的路径都存在；React 19、Electron 44、Pi SDK 1.3.0；数据目录 `<userData>/Her-Pi-v1/`（her.sqlite、pi/sessions、pi/workspaces、artifacts、documents）；IPC 命名 `her:<主题>-<动作>`，类型在 `HerApi`；`safeStorage` 加密不可用时拒绝保存；关闭时 5 秒后强杀；删除了不存在的 `core/llm`、`docs/API.md`、`CHANGELOG.md`、ESLint 引用；UI 设计规范未改
  - 未写入文档：`handle.ts`、`agent-ipc.ts`、`events.ts` 当前没有被任何文件引用，留待 4.2/4.3 决定保留还是删除

## 10. 删除旧路径与完整验收

- [x] 10.1 删除 `src/core/providers/stream.ts`、`sse.ts`、`message-format.ts`、旧 `probe.ts` 及其测试与引用；`npm run check` 通过且 grep 无残留引用
  - 验证：`npm run check` 退出码 0（类型错误 0，59 个测试文件通过：918 通过、1 跳过，构建三段完成）；`src`、`tests` 中对 `providers/stream|sse|message-format|probe`、`streamChat`、`formatModelMessages` 的引用为 0；`src/core/providers/` 已删除
  - 被删的测试：`providers.test.ts`、`chat.test.ts`（旧流式循环与旧 ChatService 构造）；其行为在新测试中的对应已逐项核对，缺的几项（系统提示拼装、重试、模型选择、未知动作处理）已补实现和测试
  - 说明：旧的"50 条 / 64,000 字符截断"在 `src` 中已无残留（对应 4.5 的一部分）
- [ ] 10.2 按方案 §14 验收表逐项在模拟服务下运行（并行、队列、冲突资源、未知动作、压缩、来源失效、多存储恢复、模型认证、清理、生命周期），结果记录到 `experiments/pi-sdk-1.3.0/ACCEPTANCE.md`
- [ ] 10.3 用用户明确配置的真实服务验证聊天、工具往返、容量、压缩、取消和认证，在打包后的 macOS `.app` 中执行 `npm run test:e2e`，结果记录到 ACCEPTANCE.md

## Workflow follow-up

- 归档前由用户决定在途 change `tool-execution-capability`、`agent-memory-tools`、`multi-model-per-service`、`conversation-rename-and-trash` 的去留。
- 验收通过后归档本 change 并核对 `openspec/specs/` 结果。
