# Her - AI 助手开发指南

## 项目简介

Her 是一个优雅的桌面 AI 助手应用，采用 Electron + React + TypeScript 构建。

## 技术栈

- **框架**: Electron + React 18
- **语言**: TypeScript
- **状态管理**: React Context + Hooks
- **样式**: 原生 CSS（无预处理器）
- **构建**: Vite

## 项目结构

```
her/
├── src/
│   ├── main/              # Electron 主进程
│   │   ├── index.ts       # 主进程入口
│   │   └── ipc.ts         # IPC 通信处理
│   ├── preload/           # 预加载脚本
│   ├── renderer/          # 渲染进程（React 应用）
│   │   ├── src/
│   │   │   ├── App.tsx    # 根组件
│   │   │   ├── styles.css # 全局样式
│   │   │   └── components/
│   │   └── index.html
│   ├── core/              # 核心业务逻辑
│   │   ├── storage/       # 数据持久化
│   │   └── llm/           # LLM 集成
│   └── shared/            # 共享类型定义
├── tests/                 # 测试文件
├── docs/                  # 文档
│   └── DESIGN_SYSTEM.md   # 详细的前端设计规范
└── resources/             # 应用资源
```

## 核心功能模块

### 1. 对话管理
- **位置**: `src/renderer/src/App.tsx`
- **状态**: `conversations`, `currentConversationId`
- **存储**: `src/core/storage/store.ts`

### 2. 消息处理
- **流式响应**: 使用 SSE 接收 AI 回复
- **消息类型**: `user` | `assistant`
- **状态**: `pending`, `streaming`, `completed`, `error`

### 3. 服务提供商管理
- **支持**: OpenAI、Anthropic、Ollama 等
- **配置**: 动态加载，支持多模型切换
- **位置**: `src/core/llm/`

### 4. 数据持久化
- **技术**: Electron Store
- **位置**: `src/core/storage/store.ts`
- **数据**: 对话历史、用户设置、服务配置

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
- **命名**: 使用 `namespace:action` 格式（如 `conversation:create`）
- **类型安全**: 在 `src/preload/index.d.ts` 中定义类型
- **错误处理**: 所有 IPC 调用都需要 try-catch

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

### 集成新的 LLM 提供商
1. 在 `src/core/llm/` 中实现适配器
2. 更新 `ProviderProtocol` 类型定义
3. 在设置面板中添加配置 UI
4. 测试流式响应和错误处理

### 修改消息样式
1. 参考 `docs/DESIGN_SYSTEM.md` 设计规范
2. 修改 `.message`, `.bubble` 相关样式
3. 确保用户消息和助手消息的视觉区分
4. 测试长文本、代码块、列表等场景

## 测试

### 运行测试
```bash
npm test                    # 运行所有测试
npm run test:watch          # 监听模式
```

### 测试覆盖
- 单元测试: 核心业务逻辑
- 集成测试: IPC 通信、存储
- UI 测试: React 组件渲染

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
- 存储数据: `~/Library/Application Support/her/`

## 注意事项

### 性能优化
- 避免在渲染循环中进行昂贵操作
- 使用 `React.memo` 优化组件重渲染
- 大列表使用虚拟滚动
- 流式响应及时更新 UI，避免累积后一次渲染

### 安全考虑
- API 密钥存储在 Electron Store，不暴露到渲染进程
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
- **API 文档**: `docs/API.md` - IPC 接口文档（待完善）
- **更新日志**: `CHANGELOG.md` - 版本更新记录（待创建）

## 贡献指南

### 提交代码前检查
- [ ] 代码符合 TypeScript 严格模式
- [ ] 样式遵循设计系统规范
- [ ] 添加必要的错误处理
- [ ] 测试通过
- [ ] 无 ESLint 警告

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

**版本**: 1.0.0  
**最后更新**: 2024-10-14
