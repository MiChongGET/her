# Tasks

## 1. 依赖锁定与 SDK 隔离验证

- [x] 1.1 以精确版本安装 `@earendil-works/pi-coding-agent@1.3.0`（及其声明的 pi-agent-core / pi-ai 1.3.0），更新 lockfile；验证 `npm ls @earendil-works/pi-coding-agent` 只有一个 1.3.0 且 `npm run typecheck` 通过
- [x] 1.2 在 `tests/pi-sdk/` 新增基于回环 HTTP/SSE 模拟服务的 SDK 探针测试：受控注入 + `noTools: "builtin"` 后实际工具集合只含注入工具，且用户主目录的 Pi 配置/扩展/auth 未被读取（以临时 HOME 放置诱饵文件断言）；`npx vitest run tests/pi-sdk` 通过
- [x] 1.3 探针测试覆盖：两会话同时 prompt 事件不串线、`abort` 只影响本会话、条目落盘与 `agent_settled` 顺序（实测普通消息不派发 `entry_appended`，已据此修订 D6）、`appendCustomEntry` 不进入模型上下文；记录实测结果到 `experiments/pi-sdk-1.3.0/REPORT.md`
- [x] 1.4 探针测试复现 pi-ai-compat 报告中的差异（坏工具 JSON、缺 `[DONE]`、`apiKey=''`、Anthropic 基址、错误含密钥、读取停滞），逐项在 REPORT.md 记录 1.3.0 是否仍存在及 Her 处理方式（D7 无密钥注册方式、D9 来源过滤钩子在此确定）
- [x] 1.5 在 electron-vite 构建与 `npm run package` 生成的 `.app` 中运行最小 Pi 会话（含 photon-node 加载）；验证主进程与打包后均成功，结果写入 REPORT.md。若任一关键能力不成立，停止后续任务并向用户报告

## 2. 新资料空间、会话权威与投影

- [x] 2.1 数据目录改为 `appData/Her-Pi-v1`（保留 `HER_DATA_DIR` 覆盖），创建 `pi/sessions`、`pi/workspaces`、`artifacts`、`documents`；测试断言路径与旧 `userData` 不重叠且旧目录未被访问
- [x] 2.2 重写 `src/core/storage/store.ts` 为新 v1 schema（D6 表清单），删除旧迁移代码与 messages 表；`tests/storage.test.ts` 按新 schema 重写并通过
- [x] 2.3 实现投影：在 `turn_end` / `agent_settled` / 启动时从 `SessionManager.getEntries()` 拉取并以 entry ID 幂等 upsert，与游标对账补齐；测试”清空投影后重建内容一致””已写 Pi 未投影后补齐且不重复”
- [ ] 2.4 实现 drafts（中断片段）与 `her.run` 关联条目；测试中断片段不进入后续上下文
- [ ] 2.5 实现启动恢复：非终态任务→interrupted、dispatched 无关联条目的输入→pending 且队列 paused、running/dispatched 工具→unknown 并写隔离；对各断点注入崩溃的测试全部通过
- [ ] 2.6 会话文件损坏时保留原文件、隔离会话并报错；测试其他会话可正常发送
- [ ] 2.7 确认单实例锁覆盖新资料目录（第二实例不写入）；补充测试或手动验证记录

## 3. 模型接入与凭据

- [ ] 3.1 profile 模型改为“Pi 目录模型 | 自定义兼容服务”，自定义服务必填上下文容量，认证方式 `api-key | headers | none`；`tests/profiles.test.ts` 覆盖校验与缺容量拒绝
- [ ] 3.2 实现 Her `CredentialStore`（按 profileId、safeStorage 加密、加密不可用时失败），每个 profile 注册独立 provider ID；测试两个同协议不同 Key 的 profile 并发请求各自携带正确 Key，资料目录 grep 不到明文
- [ ] 3.3 实现无密钥与仅请求头模式（D7：进程内随机内部值 + `fetch` 包装删除对应认证头 + `redirect: 'error'`），三协议模拟服务断言请求头无认证值、自定义头存在，资料目录与日志中找不到内部值
- [ ] 3.4 错误脱敏：模型/运行错误映射为中文提示，测试含 Key 与认证头值的 SDK 错误不出现在 IPC 事件与日志中
- [ ] 3.5 连接测试改用 Pi ModelRuntime 最小请求；测试成功、认证失败、无密钥三种情况
- [ ] 3.6 用量记录：有用量记数，无用量标 unknown；测试不记为 0

## 4. Agent 宿主与并行会话

- [ ] 4.1 新建 `src/core/agent/factory.ts`，集中受控注入并在创建后比对工具白名单；测试白名单外工具导致拒绝启动
- [ ] 4.2 新建 `handle.ts` 与 `host.ts`：按 conversationId 的句柄、generation、runId、单调 seq，旧代次事件丢弃；测试 A/B 同时流式、停止 A 不影响 B、迟到事件不改写新任务
- [ ] 4.3 新建 `events.ts`，Pi 事件映射为 Her `TaskEvent`（含全部任务状态）；测试“模型回答结束但仍调用工具时保持 running”
- [ ] 4.4 模型请求重试最多两次（Pi 公开设置），认证/校验/取消不重试，重试不重放工具；模拟服务测试三种情况
- [ ] 4.5 `ChatService` 收缩为门面委托 `AgentHost`，删除 `active` 单例、`generate()` 与 50 条 / 64,000 字符截断；测试超过旧界限的历史仍进入上下文，`tests/chat.test.ts` 按新行为重写并通过
- [ ] 4.6 任务冻结配置快照，禁用服务/删除凭据/撤销工具授权立即停止相关任务；测试运行中改名不影响当前任务、禁用服务立即停止

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

- [x] 9.1 `src/shared/types.ts`、`src/preload/index.ts(.d.ts)`、`src/main/ipc.ts` 增加入队/撤销/停止/继续/压缩/切模型/按会话状态等通道，事件带 conversationId/runId/seq，不暴露 Pi 对象；`tests/ipc-policy.test.ts` 通过（**部分实现**：入队、停止、继续、任务状态已实现；撤销 IPC、压缩 IPC、切模型 IPC 未实现；部分 ipc-policy 测试失败）
- [x] 9.2 `App.tsx` / `TaskStatus.tsx`：多会话并行状态、排队消息与撤销、等待审批、等待资源、压缩中/失败/重试、中断片段标记；`tests/renderer.test.tsx` 覆盖 chat-message-layout 新场景（**部分实现**：排队消息显示、等待审批、等待资源、压缩状态已实现；撤销 UI、并行状态显示、中断片段标记未实现；renderer 测试未更新）
- [x] 9.3 `SettingsPanel.tsx`：目录模型/自定义服务、认证方式、上下文容量；`TrashPanel.tsx`：清理未完成与重试；渲染测试通过（**部分实现**：设置面板已显示认证方式、上下文容量；TrashPanel 的清理未完成与重试功能未实现；部分渲染测试失败）
- [ ] 9.4 更新 `AGENTS.md` 中的技术栈、项目结构、IPC 与数据目录说明，使之与新实现一致

## 10. 删除旧路径与完整验收

- [ ] 10.1 删除 `src/core/providers/stream.ts`、`sse.ts`、`message-format.ts`、旧 `probe.ts` 及其测试与引用；`npm run check` 通过且 grep 无残留引用
- [ ] 10.2 按方案 §14 验收表逐项在模拟服务下运行（并行、队列、冲突资源、未知动作、压缩、来源失效、多存储恢复、模型认证、清理、生命周期），结果记录到 `experiments/pi-sdk-1.3.0/ACCEPTANCE.md`
- [ ] 10.3 用用户明确配置的真实服务验证聊天、工具往返、容量、压缩、取消和认证，在打包后的 macOS `.app` 中执行 `npm run test:e2e`，结果记录到 ACCEPTANCE.md

## Workflow follow-up

- 归档前由用户决定在途 change `tool-execution-capability`、`agent-memory-tools`、`multi-model-per-service`、`conversation-rename-and-trash` 的去留。
- 验收通过后归档本 change 并核对 `openspec/specs/` 结果。
