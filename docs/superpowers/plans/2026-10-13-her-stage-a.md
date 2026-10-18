# Her Stage A Implementation Plan

> **For agentic workers:** Use the shared contracts in src/shared/types.ts. Steps use checkbox syntax for tracking; implement scoped modules with meaningful RED → GREEN tests, then review the integrated application.

**Goal:** 交付可运行的 Mac 桌面框架、自定义 OpenAI / Claude 兼容服务配置、流式文字聊天和重启后的历史恢复。

**Architecture:** Electron 主进程持有 SQLite、受系统保护的凭据和网络请求。React 通过受限 preload 接口操作配置与聊天。两种协议转成统一流式事件，聊天状态以本地数据库为准。

**Tech Stack:** Electron、electron-vite、React、TypeScript、SQLite、Vitest、Playwright Electron。

**Spec:** ../specs/2026-10-13-her-design.md

## Global Constraints

- 云端模型推理，本地保存历史与配置。
- 自定义服务地址、模型和密钥，支持 OpenAI Chat Completions 与 Claude Messages。
- 不设置预算上限或自动预算熔断。
- 持久密钥不返回渲染进程，不明文写入数据库、日志或仓库。
- 失败明确显示，切换由用户选择，不自动改发其他端点。
- 第一阶段只交付文字与服务接入；完整第一版的其他阶段仍以设计为准。
- 当前目录不是 Git 仓库，在当前项目内实施，不自行初始化仓库、提交或推送。

## Review Focus

- 带自定义路径前缀的 Base URL：追加资源路径正确，不重复 v1，不跟随携带密钥的重定向。
- 流被截断、UTF-8 被拆包、错误出现在流内：不把不完整结果标记为完成或执行半段工具参数。
- 用户取消、切换会话、退出后重启：正确归属消息，恢复部分内容并标记中断，迟到响应不能复活。
- 修改密钥或模型后：验证状态失效，空密钥输入的“保持”和“清除”语义明确。
- IPC 来源与参数非法：不能获取凭据、触发任意网络/文件能力或污染状态。

## Task 1: 构建与共享契约

**Files:** package.json、electron.vite.config.ts、tsconfig.json、vitest.config.ts、playwright.config.ts、src/shared/types.ts。

**Interfaces:** HerApi 是渲染进程唯一业务入口；ProviderEvent 是适配器输出；ChatMessage.status 区分完成、流式、失败和取消。

- [x] 创建最小工程配置与共享类型。
- [x] 安装明确版本依赖，确认 Electron 中 SQLite 可用。
- [x] 验证：npm run typecheck 与 npm run build；Expected: 无类型错误、生成 main/preload/renderer 三个入口。

## Task 2: 两种服务协议与能力检测

**Files:** src/core/providers/stream.ts、src/core/providers/sse.ts、tests/providers.test.ts。

**Interfaces:** streamChat(input: StreamChatInput): AsyncGenerator<ProviderEvent>；ProviderError.code 标记可显示的失败类型。

- [x] 先写分包文字、工具、前缀 URL、鉴权、错误、重定向、取消和截断用例，运行并观察失败。
- [x] 实现真实 HTTP 流解析；工具只在完整参数与结束条件满足时输出。
- [x] 验证：npm test -- tests/providers.test.ts；Expected: 两种协议及失败路径通过。

## Task 3: 本地持久化与配置

**Files:** src/core/storage/store.ts、src/core/storage/profiles.ts、tests/storage.test.ts、tests/profiles.test.ts。

**Interfaces:** HerStore 管理 profile、settings、conversation、message；ProfileService 保存、删除、解析运行配置并记录验证状态。SecretCodec 只在主进程使用。

- [x] 先验证重开数据库恢复、启动时中断标记、加密保存、清除/保持密钥、变更后验证失效，观察失败。
- [x] 实现 SQLite 和原子配置更新，不存密钥明文。
- [x] 验证：npm test -- tests/storage.test.ts tests/profiles.test.ts；Expected: 历史和配置恢复准确，凭据不可从公共 DTO 获取。

## Task 4: 聊天协调

**Files:** src/core/conversation/chat.ts、tests/chat.test.ts。

**Interfaces:** ChatService.send(SendMessageInput): SendMessageResult；cancel(requestId): void；通过 ChatEvent 回调更新界面。

- [x] 先验证流式保存、连续上下文、取消、失败重试不重复用户消息、模型切换和会话隔离，观察失败。
- [x] 实现统一文字会话，保留已生成部分，结束状态与实际请求一致。
- [x] 验证：npm test -- tests/chat.test.ts；Expected: 上下文与消息归属正确，异常不伪称完成。

## Task 5: 桌面框架、preload 与界面

**Files:** src/main/index.ts、src/main/ipc.ts、src/main/credentials.ts、src/preload/index.ts、src/renderer/**。

**Interfaces:** 全部使用 Task 1 的 HerApi。主进程校验调用来源，renderer 不获得任意 IPC 或 Node 能力。

- [x] 菜单栏、关闭窗口后台运行、显式退出、快捷键和可选开机自启。
- [x] 模型设置页：服务列表、协议、路径前缀、模型、密钥、额外请求头；文字/工具各自测试。
- [x] 聊天界面：会话列表、流式文字、停止、失败提示与重试、模型切换和 Markdown 展示。
- [x] 关键界面行为先写交互测试，观察失败后实现。
- [x] 验证：npm run typecheck、npm test、npm run build；Expected: 通过。

## Task 6: 桌面验收、审阅和说明

**Files:** tests/e2e/desktop.spec.ts、tests/helpers/mock-provider.ts、README.md、docs/implementation/stage-a.md。

- [x] Playwright 启动实际 Electron，连接独立本地 HTTP 协议服务，完成两种协议配置、文字与工具测试、发送、流式、取消、错误、模型切换、重启恢复。
- [x] 检查预加载隔离、公共配置不含密钥、关闭窗口后能重新唤出。
- [x] 验证：npm run check、npm run test:e2e；Expected: 构建与确定性测试通过。
- [x] 独立审阅整个实现，修复关键发现并运行覆盖测试。
- [x] README 给出 npm install / npm run dev / npm run build / npm start，以及第三方服务配置方法。
- [x] 记录证据边界：本地 HTTP 服务证明应用链路，不证明用户真实第三方账号与端点已连通。

## 完成记录

2026-10-13：上述实现与确定性验证已完成；最终 `npm run check && npm run test:e2e` 成功，83 个核心/界面测试和 2 个实际 Electron E2E 通过。独立审阅的关键发现已修复并回归验证。开发模式真实窗口也已验证加载与 reload。

当前交付源码运行版；登录自启明确要求后续安装版。真实第三方端点、系统钥匙串实测及设计中的中文 ASR 可行性小样仍待相应验收，因此这些勾选不表示完整第一版或真实服务验收已经完成。
