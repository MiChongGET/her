# Her - AI 助手开发指南

## 项目简介

Her 是一个优雅的桌面 AI 助手应用，采用 Electron + React + TypeScript 构建。模型调用、对话历史、上下文压缩由 Pi SDK 承担；Her 负责请求接纳、排队、任务身份、工具权限与审批、资源冲突、动作账本、附件来源和界面。

## 技术栈

- **框架**: Electron 44 + React 19
- **语言**: TypeScript（`strict`）
- **Agent 底座**: `@earendil-works/pi-coding-agent` 1.3.0（含 `pi-ai`），版本精确锁定，经 `src/core/agent/factory.ts` 受控注入，不读取用户主目录里的 Pi 配置
- **本地存储**: SQLite（`node:sqlite`）+ Pi 会话文件（JSONL）
- **状态管理**: React Hooks
- **样式**: 原生 CSS（无预处理器）
- **构建**: electron-vite（Vite）
- **测试**: Vitest（单元/集成）、Playwright（Electron e2e）

## 项目结构

```
her/
├── src/
│   ├── main/               # Electron 主进程
│   │   ├── index.ts        # 入口：数据目录、单实例锁、装配各服务
│   │   ├── ipc.ts          # IPC 处理（仅接受主窗口主框架）
│   │   ├── ipc-policy.ts   # 发送者与链接校验
│   │   ├── credentials.ts  # 用 safeStorage 加密 API Key 与请求头
│   │   ├── shutdown.ts     # 退出：停止全部任务、5 秒后只强杀 Her 自己的子进程
│   │   └── test-connection.ts
│   ├── preload/            # contextBridge 暴露的 window.her
│   ├── renderer/src/       # React 界面（App.tsx、TaskStatus.tsx、设置/回收站面板、styles.css）
│   ├── core/
│   │   ├── agent/          # AgentHost（会话级运行、队列、停止/继续、压缩、切换模型、启动恢复）
│   │   │                   # factory.ts 创建 Pi 会话；sources.ts/source-guard.ts 过滤失效来源；budget.ts 按窗口算压缩余量
│   │   ├── conversation/   # ChatService：AgentHost 的门面
│   │   ├── tools/          # 工具门(gate)、审批、资源队列、动作账本、注册表
│   │   ├── mcp/            # MCP 连接管理（有状态服务按会话各开一条）与 Peekaboo/浏览器/搜索适配
│   │   ├── files/          # 文件授权与版本核对
│   │   ├── documents/      # 文档提取与缓存
│   │   ├── skills/         # 随应用内置的技能文档
│   │   └── storage/        # store.ts(SQLite)、profiles.ts(模型服务)、paths.ts(数据目录唯一入口)
│   └── shared/types.ts     # 主进程、预加载、渲染进程共享的类型（含 HerApi）
├── tests/                  # Vitest 测试；tests/e2e 为 Playwright；tests/pi-sdk 为 SDK 探针
├── docs/                   # DESIGN_SYSTEM.md、adr/（架构决策）、superpowers/specs/（Pi 适配设计）
├── openspec/changes/adopt-pi-agent-runtime/   # 适配的任务清单与规格，进度以 tasks.md 为准
├── experiments/pi-sdk-1.3.0/                  # SDK 验证记录与脚本
├── CONTEXT.md              # 领域用语表
└── resources/              # 应用资源
```

## 数据与存储

所有 Her-Pi 数据都在 `<userData>/Her-Pi-v1/` 下，路径只由 `src/core/storage/paths.ts` 决定。`<userData>` 在 macOS 上是 `~/Library/Application Support/Her`，可用环境变量 `HER_DATA_DIR` 覆盖。旧版 Her 直接把文件放在 `<userData>` 根目录；新版不读取、不迁移、不改动它们。

```
Her-Pi-v1/
├── her.sqlite     # 模型服务、设置、队列、任务、动作账本、权限、展示投影
├── pi/sessions/   # Pi 管理的会话文件（对话历史的唯一权威）
├── pi/workspaces/ # 交给 Pi 的受控工作目录
├── artifacts/     # 工具返回的图片
└── documents/     # 文档提取缓存
```

- 对话消息的权威在 Pi 会话文件里；SQLite 里的 `projection_entries` 只是展示用投影，可以随时删除并重建。
- SQLite 版本号固定为 1。遇到其他版本直接拒绝打开，不做旧版资料迁移。用户于 2026-10-20 允许当前 Her-Pi-v1 增加 `purge_jobs` 清理任务表，以持久保存永久删除的墓碑与失败状态。
- API Key 与自定义请求头用 `safeStorage` 加密后存入 SQLite，不进入渲染进程，也不写入日志。
- Her 打开会话前用 Pi 导出的解析函数做只读完整性校验；发现坏行或无法识别的文件时拒绝读取并留下隔离标记，保持原文件不变。恢复有效文件并通过校验后解除隔离。

## 核心功能模块

### 1. 会话与任务
- **入口**: `src/core/conversation/chat.ts` → `src/core/agent/host.ts`
- 同一会话同一时间只运行一个任务，之后发送的消息进入持久队列，可查看、撤销；只有正常完成才自动取下一条，停止、失败、压缩出问题、未知动作、重启后队列都会暂停，等用户处理。
- 停止、继续、手动压缩、空闲时切换模型、回收站与永久删除都在 `AgentHost`。

### 2. 工具与权限
- 模型只能调用工具门（`tools/gate.ts`）导出的工具；非只读动作需要审批，审批绑定到具体的一次调用。
- 冲突资源（桌面、同一写入目标、同一 MCP 服务）排队；动作派发前先写账本，结果未知的目标会被隔离，直到重新观察或用户处理。

### 3. 附件与来源
- 文件通过文件选择器授权后以引用发送；发送前和工具读取前都会重新核对授权、文件是否存在、版本是否变化。
- 撤权或文件变化后，依赖它的内容在普通请求、压缩和恢复三条路径上都会被替换为占位文字，原文仍可在界面查看。

### 4. 模型服务
- **协议**: OpenAI 兼容、Anthropic、OpenAI Responses
- **位置**: `src/core/storage/profiles.ts`（配置）、`src/core/agent/factory.ts`（接入 Pi）
- 暂时性失败（超载、限流、5xx、断流）最多重试 2 次；认证失败、校验失败、被拒绝的重定向和用户停止不重试。

## IPC 通道

渲染进程通过 `window.her` 调用，类型定义在 `src/shared/types.ts` 的 `HerApi`，实现在 `src/preload/index.ts` 与 `src/main/ipc.ts`。通道名为 `her:<主题>-<动作>`，按主题分组：`her:conversation-*`（会话与回收站）、`her:message*`（发送与取消）、`her:queue-*`（排队消息）、`her:task-*`（审批、继续、未知动作）、`her:compact*`、`her:context-usage`（上下文估算）与 `her:model-switch`、`her:profile-*`、`her:files-*`、`her:mcp-*`、`her:artifact-*`、`her:system-*`。事件（聊天、请求）由主进程推送。

## UI 设计风格

### 设计语言
- **美学**: 东方美学 + 现代极简主义
- **色调**: 柔和的绿色系，自然、温暖
- **字体**: 宋体标题 + 系统无衬线字体
- **特点**: 充足留白、细腻阴影、流畅过渡

### 关键设计元素

**色彩**:
- 品牌色: `#8fa375` (自然绿)
- 用户消息: `#d8e5c9` (清新绿)
- 助手消息: `#f4f3ed` (纯净暖白)
- 文字: `#2a3226` (深绿灰)

**圆角**:
- 消息气泡: 16px
- 输入框/卡片: 12px
- 按钮: 7px
- 小元素: 4px

**间距**:
- 消息间距: 28px
- 气泡内边距: 12px 16px
- 容器边距: 40px

**详细设计规范**: 参见 `docs/DESIGN_SYSTEM.md`

## 开发规范

### CSS 规范
- **组织**: 单一 `styles.css` 文件，按模块分组
- **命名**: 使用语义化类名（`.message`, `.composer`, `.sidebar`）
- **变量**: 使用 CSS 自定义属性定义颜色、间距
- **过渡**: 统一使用 0.15s-0.2s 过渡时长

### React 规范
- **组件**: 函数式组件 + Hooks
- **状态**: 使用 `useState`, `useEffect`
- **类型**: 所有组件都需要 TypeScript 类型定义
- **事件**: 使用箭头函数定义内联处理器

### TypeScript 规范
- **类型定义**: 共享类型放在 `src/shared/types.ts`
- **接口优先**: 使用 `interface` 而非 `type`
- **严格模式**: 启用 `strict: true`

### IPC 通信规范
- **命名**: `her:<主题>-<动作>`（如 `her:queue-cancel`）
- **类型安全**: 在 `src/shared/types.ts` 的 `HerApi` 中定义，并同步 `src/preload/index.ts`
- **校验**: 主进程在 `ipc.ts` 里校验每个参数，并只接受主窗口主框架的调用
- **错误处理**: 所有 IPC 调用都需要 try-catch，错误信息不得带本机路径或密钥

## 常见任务

### 添加新的 UI 组件
1. 在 `App.tsx` 或新建组件文件中定义组件
2. 在 `styles.css` 中添加样式（参考设计系统）
3. 确保响应式适配和键盘导航
4. 添加必要的 TypeScript 类型

### 添加新的设置项
1. 在 `src/shared/types.ts` 中定义类型
2. 在 `src/core/storage/store.ts` 中添加默认值
3. 在设置面板中添加 UI 控件
4. 更新相关的业务逻辑

### 接入新的模型协议
1. 在 `src/core/agent/factory.ts` 里选择对应的 Pi 适配器并映射 `api` 与基址
2. 更新 `ProviderProtocol` 类型与 `profiles.ts` 的校验
3. 在设置面板中添加协议选项
4. 用 `tests/pi-sdk/wire.ts` 的假服务器补该协议的流式、工具调用、失败与重试测试

### 修改消息样式
1. 参考 `docs/DESIGN_SYSTEM.md` 设计规范
2. 修改 `.message`, `.bubble` 相关样式
3. 确保用户消息和助手消息的视觉区分
4. 测试长文本、代码块、列表等场景

## 测试

### 运行测试
```bash
npm run check               # 类型检查 + 全部单元测试 + 构建（提交前必须通过）
npm test                    # 只跑 Vitest
npm run test:watch          # 监听模式
npm run test:e2e            # 构建后跑 Playwright（真实 Electron）
```

### 测试覆盖
- 单元/集成: 宿主、队列、工具门、账本、存储、来源过滤；模型一侧用 `tests/pi-sdk/wire.ts` 的本地假服务器，不访问真实服务
- UI: `tests/renderer.test.tsx` 渲染组件（桥接是模拟的，不证明主进程一侧可用）
- e2e: `tests/e2e/`，需要已构建的应用

## 构建与发布

```bash
npm run dev                 # 开发模式
npm run build              # 构建应用
npm run package            # 打包应用
```

## 调试技巧

### 主进程调试
```bash
# 启动时添加调试标志
npm run dev -- --inspect
```

### 渲染进程调试
- 使用 Chrome DevTools（Cmd+Option+I）
- React DevTools 已集成

### 查看日志
- 主进程日志: 终端输出
- 渲染进程日志: DevTools Console
- 存储数据: `~/Library/Application Support/Her/Her-Pi-v1/`（见上文「数据与存储」）

## 注意事项

### 性能优化
- 避免在渲染循环中进行昂贵操作
- 使用 `React.memo` 优化组件重渲染
- 大列表使用虚拟滚动
- 流式响应及时更新 UI，避免累积后一次渲染

### 安全考虑
- API 密钥用 `safeStorage` 加密后存入 SQLite，不暴露到渲染进程；加密不可用时拒绝保存
- 使用 contextBridge 安全暴露 API
- 验证所有用户输入
- 防止 XSS 攻击（渲染 Markdown 时使用安全库）

### 用户体验
- 所有异步操作提供加载状态
- 错误信息清晰、可操作
- 支持键盘快捷键
- 响应式设计，适配不同窗口尺寸

## 相关文档

- **设计规范**: `docs/DESIGN_SYSTEM.md` - 详细的 UI 设计系统
- **领域用语**: `CONTEXT.md`
- **架构决策**: `docs/adr/`
- **Pi 适配设计**: `docs/superpowers/specs/2026-10-19-her-pi-adapter-design.md`
- **任务清单（进度以此为准）**: `openspec/changes/adopt-pi-agent-runtime/tasks.md`

## 贡献指南

### 提交代码前检查
- [ ] 代码符合 TypeScript 严格模式
- [ ] 样式遵循设计系统规范
- [ ] 添加必要的错误处理
- [ ] 测试通过
- [ ] `npm run check` 通过

### Git 提交信息格式
```
<type>: <subject>

<body>
```

类型:
- `feat`: 新功能
- `fix`: 修复 bug
- `style`: 样式调整
- `refactor`: 重构
- `docs`: 文档更新
- `test`: 测试相关
- `chore`: 构建/工具相关

## 获取帮助

- 设计相关问题: 参考 `docs/DESIGN_SYSTEM.md`
- 技术实现问题: 查看源码注释
- Electron 相关: https://www.electronjs.org/docs
- React 相关: https://react.dev

---

**版本**: 2.0.0  
**最后更新**: 2026-10-20
