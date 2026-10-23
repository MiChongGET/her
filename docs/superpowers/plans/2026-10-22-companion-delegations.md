# Companion Delegations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现有明确范围、可跨运行续接、可即时修正和撤回的委托授权，覆盖 Q2、Q3、Q5、Q6、Q8、Q9、Q10、Q12。

**Architecture:** 在 Her 的工具门前建立主进程维护的委托、用户意图和真实动作描述；Pi 继续管理会话历史，任务仍表示一次运行。所有动作在批准后及真正派发前核对委托版本，可信适配器负责目标与效果证据，任意代码保持精确单次批准。

**Tech Stack:** Electron 44、React 19、TypeScript strict、Pi SDK 1.3.0、node:sqlite、Vitest、Playwright Electron。

**Spec:** [私人伙伴交互与授权设计](../specs/2026-10-22-private-companion-interaction-design.md)

## Global Constraints

- 主路线为 A 空间 → B 委托 → C 记忆共享；本计划是 B，先完成 [A 空间计划](2026-10-22-companion-workspace.md) 的话题与路由契约。
- 消费 `TopicInfo { conversationId: string; kind: 'daily' | 'work'; shareProgress: boolean; shareRevision: number }`；legacy 内容不进入日常模型上下文。
- “委托的持续有效不表示旧工具调用批准可以跨运行重用。”应用重启后等待用户要求继续。
- “预订、付款和提交个人资料继续单独确认。”删除、覆盖仍沿用已有确认要求。
- “不得换工具或换种说法重新尝试同一个被拒绝的动作。”结果未知时先观察，不能自动重放。
- “取消‘所有对话允许此工具的所有操作’入口。”旧配置、新鲜观察及会话级浏览器放行均不得绕过委托范围。
- SQLite `user_version` 保持 `1`，不读取或迁移旧版资料；本计划提出 v1 内增量表结构，未声称已实施或批准新增 schema 版本。
- 保留当前资源互斥、配置版本、来源撤回、动作账本及 Pi 历史权威；本工作区有大量在途变更，执行前重新核对实际文件。
- 不自动提交或推送；不为验证擅自向真实联系人发消息、提交资料、预订或付款。

## Review Focus

- 取得批准后、资源等待期间收到停止或范围变化，实际派发必须为零：任务 2、5。
- 页面按钮看似导航但事件处理器会提交，或输入框自动保存：任务 3 不按控件外观授予免确认权限。
- 跨工具改写参数再次尝试被拒绝的资料提交：任务 4 按业务动作身份阻断。
- 用户引用“先别发”讨论措辞，与直接停止指令不同；不确定时先保护候选效果并澄清：任务 5。
- 已批准正文未变但收件人、窗口、账号或适配器版本改变：任务 6 不能复用发送能力。

---

## 文件职责与交付契约

- 新增 `src/core/delegations/types.ts`：内部委托范围、可信意图、动作描述；这些对象不接受模型直接构造。
- 新增 `src/core/delegations/service.ts`：委托生命周期、范围版本、动作决策、拒绝记录；存储方法归入现有 `src/core/storage/store.ts`。
- 新增 `src/core/delegations/control.ts`：优先接纳停止/修正、候选屏障和语义消歧；不承载模型运行器。
- 新增 `src/core/tools/delegation.ts`：绑定当前真实用户输入的托付接纳工具；向日常仅返回接纳状态，工作详情留在所属话题。
- 新增 `src/core/tools/browser-actions.ts`、`message-actions.ts`：受控浏览操作与消息渠道契约；现有 `ego-browser.ts` 继续承载任意脚本的精确审批。
- 修改 `tools/registry.ts`、`approval.ts`、`types.ts`、`agent/host.ts`、`conversation/chat.ts`：贯通委托校验、派发和任务关联，不重写 Pi 会话逻辑。
- 修改 `shared/types.ts`、`main/ipc.ts`、`preload/index.ts`、`renderer/src/TaskStatus.tsx`、`McpSettingsPanel.tsx`：真实动作卡、分开的控制按钮及旧放行退出。
- 对外状态：`DelegationStatus = 'active' | 'paused' | 'completed' | 'cancelled'`；等待批准是待处理动作状态，不冒充整件委托完成。
- 内部范围：`DelegationScope { purpose: string; objects: string[]; completion: string; allowedCapabilities: string[]; origins: string[]; constraints: Record<string, string | number> }`；objects/capabilities 由 Host 解析为稳定身份，描述文字本身不是授权证据。
- 内部记录：`Delegation { id: string; conversationId: string; scope: DelegationScope; revision: number; status: DelegationStatus; resumeRequired: boolean }`。
- 内部意图：`UserIntent { id: string; messageId: string; conversationId: string; text: string; source: 'user'; kind: 'unclassified' | 'ordinary' | 'delegate' | 'control' | 'send-exact'; spans: [number, number][] }`；Host 先保存 unclassified 原始输入，确认普通聊天后为 ordinary，不能预先全部标成 control；网页/工具结果无此入口。
- 托付候选：`DelegationProposal { id: string; topicId?: string; scope: DelegationScope; evidenceSpans: [number, number][]; revision: number }`；模型提取结果只是候选，未通过 Host 校验不能成为授权。
- 内部动作：`ActionDescriptor { id: string; delegationId: string; scopeRevision: number; adapterId: string; adapterRevision: string; effect: ActionAssessment['effect']; targetId: string; payloadHash: string; observationId?: string; dataClasses: string[]; providerId?: string; capability: string; confirmation: 'scope' | 'always'; opaque: boolean }`。
- 真实预览：`ActionPreview { fields: { label: string; value: string }[]; finalText?: string; recipient?: string; transferDestination?: string }`；从冻结的实际参数及经核验对象生成，渲染结果与 payloadHash 绑定，不以模型 summary 代替事实。
- 消费 A 提供的 `PendingActionNotice { id: string; status: 'waiting_approval' | 'paused' | 'unknown'; version: number }`；id 是不可读 token，不编码话题、目标或标题；日常模型不接收此 DTO，B 仅提供 Host 状态来源。

### Task 1: 持久化委托并关联一次次运行

**Files:** Create `src/core/delegations/types.ts`, `src/core/delegations/service.ts`, `src/core/tools/delegation.ts`; modify `src/core/storage/store.ts`, `src/shared/types.ts`, `src/core/agent/host.ts`, `src/core/conversation/chat.ts`; test `tests/delegation-store.test.ts`, `tests/delegation-admission.test.ts`, `tests/startup-recovery.test.ts`。

**Interfaces:**
- 消费 A 的 `TopicInfo`；`DelegationService.create(topic: TopicInfo, intent: UserIntent, scope: DelegationScope): Delegation` 只为工作话题创建委托。
- 产出 `get(id: string): Delegation`、`pause(id: string, revision: number): Delegation`、`cancel(id: string, revision: number): Delegation`、`revise(id: string, revision: number, scope: DelegationScope): Delegation`。
- 产出 `resume(id: string, revision: number): Delegation`、`complete(id: string, revision: number): Delegation`、`attachRun(id: string, runId: string): void`；终态不能恢复，完成须核验结束条件。
- 产出 `admitIntent(intent: UserIntent, proposal: DelegationProposal): { conversationId: string; status: 'ready' | 'needs-confirmation'; delegationId?: string }`、`approveScope(proposalId: string, revision: number): Delegation`；待确认候选存入控制记录，不构成可运行委托。
- 产出 `registerDelegationTool(registry: SimpleToolRegistry, service: DelegationService, intent: UserIntent): void`：注册 `delegate_work` 候选入口，可信 intent 由当前 run 闭包提供，模型不能指定别的 messageId 伪造用户依据。

- [x] **Step 1:** 写 `delegation_survives_restart_without_dispatch`：持久目标、版本及运行关联；重新打开 store 后 `resumeRequired === true`，自动派发计数为 `0`。
- [x] **Step 2:** 运行 `npm test -- tests/delegation-store.test.ts tests/startup-recovery.test.ts`，确认新增用例因缺少接口而失败，既有恢复测试仍有明确基线。
- [x] **Step 3:** 实现 v1 内 `delegations`、`delegation_runs`、`delegation_controls`、`delegation_denials` 表及读取/比较版本写入；全部位于 Her-Pi-v1，保留旧数据目录边界。
- [x] **Step 4:** 在 Host 的 `admit` 创建任务后关联委托；恢复时设置待续，`continueTask` 创建新 run 并重新核验当前对象、范围和能力，旧批准不能复制。
- [x] **Step 4a:** 在 `ChatService.send` 保存真实用户依据，日常 `AgentHost.generate` 绑定本次 intent 注册 `delegate_work`；Pi 提出托付候选后由 Host 接纳。明确指向已有工作才选择该话题，否则调用 A 的 `HerStore.createWorkConversation(id, piSessionId, title)`；不要求预填表，不自动转换历史话题。
- [x] **Step 4b:** Host 核对候选的原文依据、唯一对象、目标及结束条件；充分明确的范围调用 `create`，缺项或扩大范围时先询问/确认。模型从“看看酒店”抽取出的“提交手机号”不得自行授权。
- [x] **Step 4c:** ready 才把原始委托输入交给所属工作话题的 `AgentHost.send`，随后 `attachRun`；未批准不启动业务动作。用户可停留日常，日常发送仍返回自己的 `SendMessageResult`；delegate_work 只返回通用接纳状态，工作事件经 A 路由隔离，不能返回工作 `SendMessageResult` 给日常。
- [x] **Step 4c.1:** 接纳以可信 intentId 做持久幂等键；重复 delegate_work 或重复范围批准不能多建话题/运行。范围卡批准后走同一 ready 接纳分支，拒绝候选只结束候选，不产生委托权限。
- [x] **Step 4d:** 写 `daily_request_admits_work_without_switching_daily`、`proposal_cannot_expand_user_authority`、`ambiguous_scope_waits_before_run`；断言工作只有一个运行、日常选择未变、私密详情无泄漏、待确认时 `dispatchCount === 0`。
- [x] **Step 5:** 补 `cancel_invalidates_authority_but_preserves_history`、`pause_retains_scope`、`completion_requires_end_condition`；`expect(cancelled.status).toBe('cancelled')`，历史与账本仍可读。
- [x] **Step 6:** 运行 `npm test -- tests/delegation-store.test.ts tests/delegation-admission.test.ts tests/startup-recovery.test.ts` 全部 PASS；用旧 v1 fixture 验证 `PRAGMA user_version === 1` 且已有表内容未被重建。
- [x] **Step 7:** 记录任务结果；提交仅在用户要求时。

### Task 2: 统一动作描述与委托授权门

**Files:** Modify `src/core/delegations/service.ts`, `src/core/storage/store.ts`, `src/core/tools/{types,registry,approval}.ts`, `src/core/mcp/{registry-adapter,manager,config}.ts`, `src/core/agent/host.ts`, `src/shared/types.ts`, `src/renderer/src/McpSettingsPanel.tsx`; test `tests/delegation-policy.test.ts`, `tests/tool-approval.test.ts`, `tests/config-freeze.test.ts`，并按实际消费变更适配设置测试。

**Interfaces:**
- 产出 `DelegationService.decide(action: ActionDescriptor, intent?: UserIntent): 'allow' | 'confirm' | 'deny'`、`assertCurrent(action: ActionDescriptor): void`；缺少可信描述默认 `confirm`，暂停/取消/拒绝默认 `deny`。
- `ToolExecutionContext` 增加主进程专用 `delegationId?: string`、`describeAction?: (assessment: ActionAssessment, args: Record<string, unknown>) => Promise<ActionDescriptor>`；保留现有 `authorize` 签名。
- 扩展 `ApprovalRequest` 的真实卡片字段为 `purpose`, `target`, `summary`, `preview: ActionPreview`, `dataClasses`, `providerName?`, `scopeSummary`, `actionLabel`，字段由 Host 与可信适配器生成；原始技术参数默认折叠。
- 增加仅主进程可装配的 `ToolRegistrationOptions.describeAction` 及可信 `McpServicePolicy` 描述来源；注册表以实际注册身份、版本和冻结参数绑定其结果，Host 提供可信 intent/委托版本，MCP annotations、用户 JSON 或模型字段不能装配描述器。缺少可信来源的动作保持 opaque/confirm。内置时钟及本次日常 run 的托付候选入口只能凭实际注册/闭包身份通过共同策略，不能按名称或 read 标签放行。
- 当前有效委托的越界动作可以对准确展示内容单次确认，批准不扩大持久范围；过期、暂停、取消及已记录拒绝仍 deny，普通调用批准不能解除。`assertCurrent` 不是批准凭证，confirm 路径仍须取得精确调用批准。

- [x] **Step 1:** 写 `all_paths_reenter_delegation_gate`；对旧 `allowAllOperations=true`、conversation grant、新鲜 observation、`effect='read'` 分别断言 `outOfScopeDispatches === 0`，只读也须核对委托对象和范围。
- [x] **Step 2:** 运行 `npm test -- tests/delegation-policy.test.ts tests/tool-approval.test.ts tests/config-freeze.test.ts`，确认新增断言 RED。
- [x] **Step 3:** 删除 `registry.ts` 的 trusted-interaction 授权旁路及 `approval.ts` 的两个放行早退；read 早退移到委托范围检查之后。配置读取忽略旧允许值，新配置写入拒绝 `allowAllOperations`；同步删除设置复选框、状态和提交字段，保留其他设置可保存，不将消费者留到 Task 7。
- [x] **Step 4:** revision 覆盖用户意图、委托版本、动作描述、工具版本、原样参数；批准后、资源等待结束、`markDispatched` 前调用 `assertCurrent`。同步校验和真正派发之间不引入 await。
- [x] **Step 5:** 补 `scope_changed_while_waiting_resource`：批准后锁住资源、修改范围、再放锁，`expect(dispatchCount).toBe(0)`；特殊动作即使范围匹配也 `confirm`。
- [x] **Step 5a:** 补 `preview_matches_exact_payload`：资料提交卡显示实际姓名/邮箱及接收网站，消息卡显示实际正文/收件方；任一值在展示后变化即 `expect(dispatchCount).toBe(0)`，只给出“个人资料”类别不能通过此验收。
- [x] **Step 6:** 重跑上述命令全部 PASS；`npm run typecheck` PASS。模型生成的 effect/目的文案和 MCP annotations 不能授予权限。
- [x] **Step 7:** 记录任务结果；提交仅在用户要求时。

### Task 3: 先交付 HTTP 比较闭环，再验证浏览器增量能力

状态：源码及真实 HTTP 路径通过独立审阅，最终检查 1142 项通过、4 项跳过；测试夹具窄修后 8/8 通过并独立复核。真实浏览器诊断发现自主后台请求，observe/navigate 保持 unavailable；Steps 4–8 自动能力仍未验收，不以禁用门的零派发冒充通过。唯一自建测试空间已确认关闭，详见 `experiments/companion-browser/ACCEPTANCE.md`。

**Files:** Create `src/core/tools/browser-actions.ts`, `src/core/delegations/http-comparison.ts`, `resources/mcp-web-dependencies/apply-her-patch.mjs` 与精确 hash/replacement manifest, `tests/delegation-http.test.ts`, `tests/delegation-http-live.test.ts`, `tests/browser-actions.test.ts`, `tests/browser-actions-live.test.ts`, `experiments/companion-browser/ACCEPTANCE.md`; modify `src/core/tools/ego-browser.ts`, `src/core/mcp/{web-search,dependencies,dependency-setup}.ts`, `src/core/delegations/types.ts`, `src/core/storage/store.ts`, `src/core/agent/host.ts`, `src/main/index.ts`, `resources/mcp-web-dependencies/README.md`；复用 `tests/web-search.test.ts`，按实际消费调整依赖校验、安装命令及资源打包测试。

**Interfaces:**
- 首个闭环复用现有 `createWebSearchAdapter` 的 `search` / `fetchWebContent`，保留 `renderMode: 'request'`，增加委托对象、查询内容和 URL 范围的 ActionDescriptor 校验，不新建 HTTP 抓取器或浏览器依赖。对已锁定上游分发包应用 repo-owned 确定性补丁：校验完整原始 treehash，透传 `redirectPolicy: 'error'` 并使 HEAD/GET 的 `maxRedirects=0`；Bing 固定 `https://cn.bing.com`，既有请求链禁止 regional redirect 和搜索结果自动访问。原始包与 Her patched revision 分别校验，只有核验后者才具备有界自动能力；旧包或校验失败保持精确审批，不修改现用安装或全局缓存。
- 首期可信自然输入仅接受明确列出的三家酒店公开 URL 与来源对照表目标，搜索仅接受明确的字面查询；其它表达待确认。实际读取收据绑定原始意图、委托/范围版本、run、URL/finalURL、内容 hash、请求模式与适配器版本，保存必要的有限事实；不保存完整 HTML、headers 或 credentials。由三份当前收据生成确定性来源对照表，Host 在 Pi 实际最终消息持久化后记录交付；只有真实最终消息包含该表且全部来源关联仍有效才证明完成，三次读取或 run 结束本身不证明完成。
- 浏览器增量产出 `BrowserAction { kind: 'observe' | 'navigate'; delegationId: string; workspaceId: string; pageId: string; url?: string; observationId?: string }`；schema 禁止 `code`, `evaluate`, `cdp` 和任意参数透传。
- `BrowserActions.describe(input: BrowserAction, context: ToolExecutionContext): Promise<ActionDescriptor>`、`execute(input: BrowserAction, context: ToolExecutionContext): Promise<ToolResult>`；Host 保存委托→自己创建的 TaskSpace/page 身份映射。
- 不将 `click`, `fill`, `press`, `scroll` 加入首批自动允许能力；它们可能触发提交、自动保存、导航或加载行为。

- [x] **Step 0:** 写 `http_hotel_comparison_stays_in_delegation`：连续搜索/读取三家酒店已获准页面且不逐步弹卡，未批准资料提交为零；范围外 URL 在派发前阻断，返回 finalUrl 重新核对，越界结果不供模型使用。运行 `npm test -- tests/delegation-http.test.ts tests/web-search.test.ts` 先 RED，再接入 Task 2 校验至 PASS；个人资料查询另行确认，禁止浏览器回退。
- [x] **Step 0a:** 运行 `HER_TEST_COMPANION_HTTP_LIVE=1 npm test -- tests/delegation-http-live.test.ts`，经实际搜索 MCP 的 HTTP 请求模式读取已选定公开酒店页，记录结果、来源及无浏览器启动证据；本地 fixture 仅证明范围/拒绝契约，真实读取通过后该酒店比较路径独立验收，不等待浏览器自动导航。
- [x] **Step 1:** 仅在工作需要页面 UI 时执行下列浏览器增量探针；先写 `owned_workspace_and_exact_operation_only`：模型伪造 workspace、page、origin、协议、code 均被拒绝；已有用户标签不能被认领或清理。
- [x] **Step 2:** 运行 `npm test -- tests/browser-actions.test.ts` 确认 RED；记录当前 `ego_browser_run` 仍是 `unknown` 的完整脚本，禁止按模型标签改成 read。
- [x] **Step 3:** 用官方 CLI 探针验证 Host 固定模板仅接受结构化值：读取完整指南、创建己方 TaskSpace、观察已有页、结束己方 TaskSpace；注入字符串不会产生额外 Node/API 调用。
- [ ] **Step 4:** 浏览器 observe 只读当前所属页，不允许自动重建崩溃页；导航仅允许可信适配器已验证的公开只读路由，不能仅凭 GET、同源或按钮名称推定安全。此增量探针不改变上述现成 HTTP 读取路径的独立交付。
- [ ] **Step 5:** origin 用 `new URL().origin` 精确匹配委托范围，不允许后缀/wildcard；路由和查询键按适配器协议校验，禁止凭据、未知跨域重定向、下载、自定义协议和触发提交的端点。
- [ ] **Step 6:** 若从链接获得目标，Host 读取真实 href 并重新校验后直接受控导航，不执行页面 click handler；旧页 unload、后台请求、跳转均须由探针证实可在动作发生前约束，否则该导航保持精确审批。
- [ ] **Step 7:** 在本地攻击页面测试 click handler 外发、onchange 自动保存、重定向逃逸、窗口串线及停止竞态；`expect(unapprovedRequests).toHaveLength(0)`、`expect(userTabsTouched).toBe(0)`。
- [ ] **Step 8:** 运行 `HER_TEST_COMPANION_BROWSER_LIVE=1 npm test -- tests/browser-actions-live.test.ts`，必须通过已安装官方 CLI＋真实浏览器＋本地服务器计数，不能用 fake CLI 声称该探针 PASS。受控面每次只派发一个动作；延迟序列取消后不得出现后续效果，不能把“本地 CLI 已退出”当作远端脚本已停止。
- [x] **Step 9:** PASS 才启用对应浏览器能力；任意一项无法约束则 `available=false` 并保留精确审批，记录失败能力与证据。已派发 opaque 脚本不可证明停止时记为未知，仅保证阻断后续工具调用；浏览器自动操作未就绪不能标已完成，但不阻断已通过验收的 HTTP 酒店比较闭环。
- [x] **Step 10:** 运行 `npm test -- tests/browser-actions.test.ts tests/ego-browser.test.ts tests/ego-browser-skill.test.ts` 全部 PASS；记录任务结果；提交仅在用户要求时。

### Task 4: 拒绝一步后继续其它工作

状态：实现与独立审阅通过，最终检查 1159 项通过、4 项跳过。真实 Host/Pi 本地链验证拒绝后阻断跨工具重试、无关查询继续。显式撤回机制默认 fail closed；B5/B7 仍须接入绑定真实用户选择的生产者，测试 callback 不代表自然修订已支持。

**Files:** Modify `src/core/delegations/{types,service}.ts`, `src/core/tools/{types,approval,gate,registry}.ts`, `src/core/agent/host.ts`, `src/core/storage/store.ts`; create `tests/delegation-denial.test.ts`。

**Interfaces:**
- 产出 `DelegationService.reject(action: ActionDescriptor): void`、`isDenied(action: ActionDescriptor): boolean`；拒绝键至少包含委托、稳定真实对象、效果及数据类别，payloadHash 保留审计但不能因改写正文改变拒绝身份，不以工具名或 callId 代替业务身份。
- 编译适配器可提供 `businessEffect?: string` 作为可信业务效果，registry 冻结后用于拒绝身份；模型参数与 annotations 无此权威。现有公开 HTTP read 不强制增加字段。变更/opaque/unknown 缺少事实不能证明无关时直接拒绝；同一对象/业务效果不能靠增减 dataClasses 绕过，已证明无关的读取继续。
- `reviseDeniedStep(id, expectedRevision, denialId, evidenceIntentId, evidenceSpans)` 为 main-only 显式修订入口：CAS、消费唯一原始用户依据、记录撤回证据、增加委托版本并设 `resumeRequired` 同一事务提交。非空 spans 或 `kind=control` 不是撤回证明；额外可信生产者必须绑定实际用户对当前具体拒绝的明确修订。默认 fail closed，B5/B7 接入真实控制/确认卡前不得宣称自然修订已支持；普通 revise/pause/resume 不清除拒绝。
- 产出 `DeniedStepError`，附只供 Host 使用的动作 ID；传给模型的结果明确“此步被拒绝，继续不依赖该步的工作”，不宣称整件已取消。

- [x] **Step 1:** 写 `refuse_personal_data_keep_comparing`：拒绝资料提交后 `submissions === 0`，另一个已获准酒店查询 `queries === 1`，委托仍 active。
- [x] **Step 2:** 运行 `npm test -- tests/delegation-denial.test.ts`，确认 RED。
- [x] **Step 3:** 先保存拒绝再结束等待；同一动作换适配器或改写参数仍拒绝。opaque 替代脚本无法排除同一被拒动作时直接 deny，不能反复弹卡绕过；只有用户明确修订原安排才可更新拒绝记录。
- [x] **Step 4:** 补 `denied_action_cannot_change_tools`、`essential_step_waits_for_user`；`expect(replays).toBe(0)`，必要步骤无法继续时等待用户调整；模型重复调用不隐式撤销拒绝。
- [x] **Step 5:** 重跑上述命令以及 `npm test -- tests/tool-approval.test.ts tests/action-ledger.test.ts`，全部 PASS；拒绝、暂缓、取消具有不同持久状态。
- [x] **Step 6:** 记录任务结果；提交仅在用户要求时。

### Task 5: 控制指令在普通消息队列之前生效

状态：实现、独立审阅及续跑原意图漏项修复的定向复核通过；最终检查 1203 项通过、4 项跳过。实际 Host/Pi 本地链覆盖发送屏障、无关读取、排队/准备/续跑/晚建话题、重启及串行历史。解释器仅支持已测试结构；B7 真实卡片与受检 IPC、B6 真实发送关联及 C 来源清理仍按契约接入，不把本地模拟算作渠道验收。

**Files:** Create `src/core/delegations/control.ts`, `tests/delegation-control.test.ts`; 按实际消费 modify `src/core/delegations/{types,service}.ts`, `src/core/agent/host.ts`, `src/core/conversation/chat.ts`, `src/core/storage/store.ts`, `src/core/tools/{types,registry}.ts`, `src/main/index.ts`；必要的显示关联复用/扩展 `src/shared/types.ts` 与 Pi 展示投影；test `tests/host-queue.test.ts`, `tests/host-stop-continue.test.ts`。

**Interfaces:**
- 产出 `ControlService.intercept(intent: UserIntent, topic: TopicInfo): { controlId?: string; heldDelegationIds: string[]; ordinary: boolean }`；先同步建立候选效果屏障，再异步消歧。
- 产出 `ControlService.resolve(controlId: string, choice: { delegationIds: string[]; kind: 'pause' | 'cancel' | 'revise' | 'ordinary'; scope?: DelegationScope }): Promise<void>`；只能依据原始用户输入缩小候选范围，不接受工具内容创建控制。
- `AgentHost.send` 保持签名，在入普通队列前调用 intercept；控制本身持久记录并进入所属 Pi 历史，不与正在写会话的 Pi 实例并发追加。
- 生产解释器为保守的 main-local 结构解释，只读取本条持久真实用户原文，不另起模型 runtime，不发送私密候选给分类模型。入任何 await 前先持久化可能相关效果屏障；明确引用/否定按普通消息释放，支持的直接句仅对唯一可信候选处理，不确定等 B7 选择。独立 `priority_controls` 保存原意图引用、冻结候选/版本、效果过滤、解析及 history pending/written，不能混用范围接纳的 `delegation_controls`。
- “先别发”保留效果级屏障，使同一委托的可信无关读取继续；整件暂停/取消才改变委托生命周期。收件方只能用主进程可信编译/真实观察事实缩小；缺少身份就等待选择。预算仅修订既有可信 numeric budget 约束，不凭空替 HTTP 比较建立预算授权。
- registry 将实际 `context.conversationId` 强制绑定到内部 ActionDescriptor，覆盖模型或参数自述；控制屏障在无 delegationId 的早退之前也按候选真实所属话题核验，不因此授予范围。B6 自动消息启用前必须关联真实可拦截安排/所属话题，不能用 daily 空关联绕过。
- 同步冻结控制前仍在 prepare/queue/running/waiting-scope 的真实 `candidateIntentIds`，registry 强制绑定实际 `context.intent.id`；通过原意图及范围接纳关联覆盖晚建 work/delegation，不能因 ID 创建较晚逃逸，也不把控制后的新独立输入或终态历史混作旧候选。仅现有 Host 私有 random-closure 验证的精确 local candidate admission 可穿过效果屏障，使派生真实动作再次核验；不新增通用许可标志或跳过其它门禁。取消闭锁针对旧安排及其派生，不能永久封禁话题。
- B4 撤回拒绝经 main-only prepare/confirm 原工作话题 challenge，绑定实际控制/拒绝/版本及明确新选择；prepare、原文字样、kind=control 或模型声明均不授予撤回权。Host 闭包生产者只在实际 confirm 后出 proof，B7 受检原话题卡点击接入，生产者测试与真实交互证据分开。
- 控制原文以公开 appendMessage 在 Pi writer 真正空闲后恰好一次串行写入，白名单 `her.control` 只保存本地状态/显示关联；即时显示与待写状态先持久保存。按当前公开 SDK，实际用户 appendMessage 可持久化；每次读回确认后才标 written。忙时保持 pending，不造 assistant/user 消息强迫 custom-only 刷盘，不另建聊天权威。C 的来源及遗忘需覆盖该类 entry 与 pending 原文。

- [x] **Step 1:** 写 `stop_candidates_before_disambiguation`：两项待发送、一项酒店查询；输入“先别发”，消歧 promise 未完成时 `sends === 0` 且查询继续。
- [x] **Step 2:** 运行 `npm test -- tests/delegation-control.test.ts tests/host-queue.test.ts`，确认控制用例 RED，普通消息仍保持顺序队列。
- [x] **Step 3:** `intercept` 在任何 await/异步语义开始前同步设置候选屏障并写入控制记录；忙时输入未分类期间阻挡可能相关的后续变更。结构化语义识别覆盖同义表达和引用/否定，无法排除发送效果的 opaque 后续调用纳入候选；明确无关读取继续，不能等原任务结束才识别控制。
- [x] **Step 4:** “预算改成五百”先阻止依赖预算的动作，核实新范围后加版本恢复；指代不唯一时询问，不能让日常模型看到未共享话题的标题或正文。
- [x] **Step 5:** 补 `quoted_stop_is_not_silent_cancel`、`budget_revision_invalidates_approval`、`stop_after_dispatch_is_truthful`；已有动作只报告已完成/未知，不声称已撤回。
- [x] **Step 6:** 对语义输入集测试“这句‘先别发’怎么改写”“不用停，继续”“先别发给小王”等；已明确无关委托继续，误判可澄清恢复，不能静默永久取消。
- [x] **Step 7:** 重跑上述命令及 `npm test -- tests/host-stop-continue.test.ts tests/startup-recovery.test.ts` 全部 PASS；屏障在停止、重启、范围变化下不丢失。
- [x] **Step 8:** 记录任务结果；提交仅在用户要求时。

### Task 6: 原样消息指令形成一次可信发送批准

**Files:** Create `src/core/tools/message-actions.ts`, `tests/message-intent.test.ts`; 按实际消费 modify `src/core/delegations/{types,service}.ts`, `src/core/tools/{types,approval,registry,ledger}.ts`, `src/core/storage/store.ts`。

**Interfaces:**
- 产出 `MessageTarget { accountId: string; recipientId: string; displayName: string; observationId: string; adapterRevision: string }`。
- 产出 `MessageAdapter.resolveRecipient(name: string): Promise<MessageTarget[]>`、`describeSend(target: MessageTarget, text: string): Promise<ActionDescriptor>`、`send(target: MessageTarget, text: string, context: ToolExecutionContext): Promise<ToolResult>`。
- 编译渠道注册具备实际 channel identity 和同步 `validateTarget(target): boolean`，在最后派发前核验账号/收件方/观察/适配器版本；不能用 model/config 的 ready 标志代替。私有 provenance 绑定实际注册及冻结 descriptor，普通描述字段拼成相同形状不授自动权。目前没有真实渠道注册，测试 adapter 只证明框架。
- 本轮自动路径要求真实 current work delegation 与 canonical 原始用户意图关联；无关联保持精确审批，不伪造委托或声称自然入口已免重复点击。真实渠道未来启用须在实际接纳流程把原样指令建立为可拦截安排，保留 B5 跨准备/续跑/晚建话题绑定。
- 产出 `authorizeExactMessage(intent: UserIntent, target: MessageTarget, finalText: string, action: ActionDescriptor): boolean`；只比较 Host 保存的用户原文、唯一收件方、账号、原样正文和当前观察，不使用模型“已获授权”标签。
- 产出 `consumeExactMessage(intentId: string, action: ActionDescriptor, call: { runId: string; callId: string; toolName: string; args: Record<string, unknown> }): void`；boolean 决策不消费批准，此方法在真正派发前消费。
- registry 仅对私有来源核验的 exact-send allowance，在共同门禁与资源等待后以一次 Store 事务消费唯一 intent 并准备现有 tool_calls 行，替代该次普通 ledger.begin，不另建账本；普通批准走原路。同步最终核验和真实派发之间不加 await；如有异步 preflight，须在现有 deferred markDispatched 的真实边界完成同样事务和校验，不能提前消费后再修改参数。

- [x] **Step 1:** 写 `exact_message_authorizes_once`：真实用户原文“在微信里给张三发：我晚十分钟到”，唯一目标且核验一致时 `decision === 'allow'`；重复发送不复用该能力。
- [x] **Step 2:** 运行 `npm test -- tests/message-intent.test.ts` 确认 RED。
- [x] **Step 3:** 实现可信意图与动作描述决策，批准绑定精确正文/收件方/账号/适配器版本；普通发送规则不覆盖付款、预约、资料提交、删除或覆盖。
- [x] **Step 3a:** 在同一 SQLite 事务中插入具有唯一 intentId 的消费记录并写动作账本待派发行；版本失效或重复消费全部失败。派发前崩溃也不能自动复用批准，派发后未知按现有隔离规则处理。
- [x] **Step 3b:** 补 `parallel_send_consumes_intent_once`、`crash_after_consume_never_replays`；并发调用只有一次消费成功且派发至多一次。此断言证明本地批准恰好消费一次，不宣称外部消息服务提供 exactly-once 送达。
- [x] **Step 4:** 补 `draft_requires_preview`、`same_name_is_ambiguous`、`changed_account_rejects_old_intent`、`webpage_cannot_forge_user_intent`；对应 `expect(decision).not.toBe('allow')`。
- [x] **Step 5:** 具体渠道只有提供真实稳定接收方、最终文本、派发前核对和可读回结果后才启用此路径；opaque/任意脚本降级精确审批，不能拿 fake adapter 宣称微信已支持。
- [x] **Step 6:** 重跑上述命令和 `npm test -- tests/tool-approval.test.ts` 全部 PASS；真实发送验收仅在用户另行指定收件方和正文时执行，否则该渠道验收明确保持未完成。
- [x] **Step 7:** 记录任务结果；提交仅在用户要求时。

Status: Task6 framework source/local validation and independent review accepted; final check 1238 passed / 4 skipped, typecheck/build passed. Production channel, natural messaging ingress, actual recipient/account and external delivery remain unaccepted. No WeChat or other channel readiness claim.

### Task 7: 动作卡、委托控制与私密待处理入口

**Files:** Modify `src/shared/types.ts`, `src/main/ipc.ts`, `src/preload/index.ts`, `src/core/conversation/chat.ts`, `src/renderer/src/{TaskStatus,McpSettingsPanel,App}.tsx`, `src/renderer/src/styles.css`; test `tests/renderer.test.tsx`, `tests/ipc-policy.test.ts`, `tests/delegation-ui.test.tsx`。

**Integration files:** Actual owned control/resume consumers may narrowly modify `src/core/delegations/{control,types,service}.ts`, `src/core/agent/host.ts`, `src/core/storage/store.ts` and selected workspace detail service; reuse existing contracts, no unrelated refactor.

**Interfaces:**
- 新增 `HerApi.pauseDelegation(id: string, revision: number): Promise<void>`、`cancelDelegation(id: string, revision: number): Promise<void>`、`resumeDelegation(id: string, revision: number): Promise<void>`；映射 `her:delegation-pause/cancel/resume`。
- 新增 `HerApi.approveDelegationScope(proposalId: string, revision: number): Promise<void>`、`rejectDelegationScope(proposalId: string, revision: number): Promise<void>`，映射 `her:delegation-scope-approve/reject`；只消费用户看过的原工作话题范围卡，不接受模型或普通工具结果替代点击。
- 消费 A 的待处理列表及 `resolvePendingAction(input: { id: string; version: number }): Promise<{ conversationId: string } | null>`，不重复创建 overview 服务；过期、已处理或无权查看时返回 null，原话题可读才跳转并读取 `ApprovalRequest`。
- 保留 `decideToolApproval` 的调用绑定，decision 收窄为 `approve | reject`；目的、对象、资料、当前模型服务、范围及撤回方式由任务 2 的 DTO 展示。

- B5 actual producer consumption: wire resolveControl, prepareDenialRevision and confirmDenialRevision through selected-original-owner cards only. IPC must synchronously validate current card revision/owner/frozen candidate immediately before the main call; preparation is inert until informed explicit confirmation. No renderer-supplied authority proof or private daily candidate bootstrap.

- Multi-owner control resolution uses main-only `resolveForOwner` and optional `PriorityControl.ownerResolutions` in existing JSON. Atomically persist owner choice/revision and only owned delegation changes; preserve every other-owner/unknown/unmaterialized hold. Denial confirmation clears only chosen owner holds. Repeated choices reject except explicit ordinary correction of owned mutation-pause. Daily notices never expose other owner details or counts.
- Explicit resume reuses existing bound latest run and persisted profile/model through Host continuation, preserving no-Task admission recovery. Check owner/current delegation revision before async work and again before admission; unresolved unknown actions remain in existing observe/resolve flow.

- One-click lifecycle resume optionally carries viewed relevant control revisions. Existing Store transaction atomically activates the exact current delegation and releases only its canonical intent holds from resolved whole-pause controls; all other barriers remain. Missing/stale relevant set rejects, no compensating resume rollback or extra mandatory release click.

- Owned input-only control recovery may expose `hasOwnedInputs` boolean only for held original WORK inputs with actual persisted input ownership and no intent-control. Explicit owner-wide ordinary release describes these barriers; daily/future-work unknowns stay held, and per-delegation resume never clears unbound sibling inputs.

- Current delegation card and existing opaque continuation notice remain usable after a later completed unbound ordinary turn in the same topic. Existing private card hook captures/rechecks latest delegation run plus current latest ordinary run across awaits/admission; current Pi leaf is retained. Legacy stale task continuation stays strict; no renderer bypass flag or new authority source.

- [x] **Step 1:** 写 `private_pending_contains_only_opaque_id_status_version`：`expect(Object.keys(notice).sort()).toEqual(['id', 'status', 'version'])`；日常 DOM、通知和模型请求没有标题/内容/目标，点击后原话题卡片才出现；旧版本点击 `expect(resolved).toBeNull()`。
- [x] **Step 2:** 运行 `npm test -- tests/delegation-ui.test.tsx tests/renderer.test.tsx tests/ipc-policy.test.ts`，确认新交互 RED。
- [x] **Step 3:** 卡片按钮用真实动作名；拒绝步骤、暂缓委托、取消委托分别调用对应接口。核对 Task 2 已同步移除的全局 MCP 允许入口不复活，删除剩余会话浏览器自动允许 UI。
- [x] **Step 4:** 主进程验证发送方、id、revision、归属和允许状态；重复点击只消费一次。模型服务未涉及传输时不得虚构传输，涉及资料时明确实际 provider。
- [x] **Step 5:** 补 `grant_is_not_os_permission`：未满足系统权限时状态显示待就绪，打开系统设置不能把委托标成完成；重启后仍需显式继续。
- [x] **Step 6:** 重跑上述命令全部 PASS，`npm run typecheck` PASS；测试模拟桥接只证明 UI 契约。
- [x] **Step 7:** 记录任务结果；提交仅在用户要求时。

Status: Task7 source/local authority and UI-contract validation accepted after independent review I1 fix and fresh scoped PASS. Final check 1270 passed / 4 skipped, typecheck/build passed. Actual Electron/package/readiness acceptance follows in Task8; no production sender or natural messaging ingress claim.

### Task 8: 全链路验收与交给 C 的有效状态

**Files:** Create `tests/e2e/delegations.spec.ts`; modify `experiments/companion-browser/ACCEPTANCE.md`; test existing `tests/e2e/{tools,tool-resolution,mcp-settings}.spec.ts`。

**Integration files:** Implement the required progress evidence producer in `src/core/delegations/{service,types}.ts` and narrowly required Store/producer consumers; add meaningful `tests/delegation-progress.test.ts` behavior coverage. No renderer/test authority grant or production readiness backdoor.

**Interfaces:** 产出 `DelegationService.getProgressEvidence(conversationId: string): DelegationProgressEvidence[]`，供 C 消费；不能将内部 ActionDescriptor、UserIntent 或私密待处理详情直接放进日常上下文。

- `DelegationProgressEvidence { delegationId: string; conversationId: string; revision: number; status: DelegationStatus; pendingReason: 'approval' | 'capability' | 'unknown' | null; completedActionCount: number; observedAt: string; evidenceRefs: { kind: 'user-request' | 'ledger'; id: string }[] }`。
- 只输出真实持久状态与源定位，不含文档、工具返回或消息正文；completedActionCount 只计具备真实后置条件证据的业务动作，不把 CLI 零退出码或普通工具 succeeded 当作业务完成。

- [x] **Step 1:** 在真实 Electron 中写完整场景：范围内查询→越界资料卡→拒绝→继续比较→暂停→重启→显式继续；断言本地服务请求记录及数据库状态，不只检查文案。
- [x] **Step 2:** Run `npm run test:e2e -- tests/e2e/delegations.spec.ts` against the current implementation and record the actual initial result. Existing implemented flows may already pass; never manufacture RED. New progress-evidence behavior needs its own meaningful RED before source implementation. Fix observed in-scope gaps only.
- [x] **Step 3:** 运行 `npm run check`，再运行 `npm run test:e2e -- tests/e2e/delegations.spec.ts tests/e2e/tools.spec.ts tests/e2e/tool-resolution.spec.ts tests/e2e/mcp-settings.spec.ts`；全部 PASS。
- [x] **Step 4:** 先运行 `HER_TEST_COMPANION_HTTP_LIVE=1 npm test -- tests/delegation-http-live.test.ts` 验收独立 HTTP 路径；若启用浏览器增量，再运行 `HER_TEST_COMPANION_BROWSER_LIVE=1 npm test -- tests/browser-actions-live.test.ts` 并记录 CLI/浏览器版本。未启用的浏览器能力单列未验收，不阻断 HTTP 闭环；现有 ego live 测试不能替代受控能力验收。
- [ ] **Step 5:** 运行 `npm run package`，用本次构建出的绝对路径设置 `HER_TEST_APP_EXECUTABLE` 后重复委托 e2e；未跑打包应用、真实模型或真实业务渠道须分别标未验收。
- [x] **Step 6:** 收尾记录覆盖 Q2/3/5/6/8/9/10/12 的证据矩阵；本地模拟、真实浏览器、本地服务及真实外发四种证据分别列出，未支持渠道不能标完成。
- [x] **Step 7:** 记录任务结果；提交仅在用户要求时。

Status: Task8 source/progress gate accepted after initial independent I1/I2 findings, narrow fix and fresh scoped Spec/Quality PASS. Final check 1278 passed / 4 skipped, typecheck/build passed. Named Electron regression set before the fix: 12 passed / 1 existing opt-in skip. Post-fix copy/scope cases passed; the first public-flow run failed its first-receipt postcondition, then an unchanged targeted full-flow run passed 1/1 in 17.8s; these are separate outcomes, not a stitched green aggregate. Public HTTP independently passed 1/1. Current package build and complete path/byte audit passed for 247 files including both preloads. Step5 trusted packaged full-flow remains unaccepted: the preceding packaged attempt passed scope rejection but timed out on isolated-HOME safeStorage keychain; no OS grant/fallback and no repeat of the known blocked attempt. That earlier package runtime diagnostic is historical after rebuild. Browser automatic capabilities, real model semantics, production message channels and native permission matrix remain separately unaccepted. See experiments/companion-browser/ACCEPTANCE.md and task-8 reports. Whole-B final review follows before C implementation.

Whole-B final gate: independent architecture/security/integration review found one Important terminal control response/pending refresh mismatch. The single scoped final fix and fresh independent Spec/Quality review passed with no new findings. Final check 1287 passed / 4 skipped, focused 288 passed, typecheck/build passed; current package complete path/byte audit 247 files. Current package was not launched; earlier keychain-blocked full-flow, unsupported real channels/browser/native/model and mixed public-flow outcomes remain explicitly unaccepted or limited as above. C may now consume the real minimal progress API.
