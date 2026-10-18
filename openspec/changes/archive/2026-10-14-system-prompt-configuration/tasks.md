# Tasks

## 1. 类型定义与存储

- [x] 1.1 在 `src/shared/types.ts` 中为 `DesktopSettings` 接口添加 `systemPrompt?: string` 字段，验证 TypeScript 编译通过
- [x] 1.2 在 `src/core/storage/store.ts` 的 `getSettings()` 中返回 `systemPrompt` 字段（若缺失则 undefined），验证测试覆盖读取逻辑
- [x] 1.3 在 `src/core/storage/store.ts` 的 `setSettings()` 中保存 `systemPrompt` 字段，验证测试覆盖写入逻辑

## 2. ChatService 读取提示词

- [x] 2.1 在 `src/core/conversation/chat.ts` 中为 `ChatService` 构造函数添加 `getSystemPrompt: () => string` 参数，验证类型检查通过
- [x] 2.2 修改 `ChatService.send()` 中的 `system` 参数，从 `SYSTEM` 常量改为调用 `getSystemPrompt()`，验证单元测试覆盖自定义提示词逻辑
- [x] 2.3 在 `src/main/index.ts` 中实例化 `ChatService` 时传入 `() => store.getSettings().systemPrompt ?? SYSTEM`，验证集成测试使用自定义提示词
- [x] 2.4 保留 `chat.ts` 中的 `SYSTEM` 常量作为默认值导出，验证 fallback 逻辑测试通过

## 3. 设置面板 UI

- [x] 3.1 在 `src/renderer/src/SettingsPanel.tsx` 的 tab 状态类型中添加 `'system-prompt'`，验证 TypeScript 编译通过
- [x] 3.2 在设置面板 tabs 区域添加"系统提示词" tab 按钮，验证点击切换到该 tab
- [x] 3.3 添加 `systemPrompt` 和 `defaultSystemPrompt` state 以及对应的输入框和保存逻辑，验证输入字符数限制 16384
- [x] 3.4 实现保存系统提示词的 `saveSystemPrompt` 函数，调用 `window.her.setSystemPrompt(text)` 并刷新配置，验证保存成功提示
- [x] 3.5 实现"恢复默认"按钮，将提示词重置为 `defaultSystemPrompt`，验证点击后文本框内容更新

## 4. IPC 桥接

- [x] 4.1 在 `src/shared/types.ts` 中为 `HerApi` 接口添加 `getSystemPrompt(): Promise<string>` 和 `setSystemPrompt(prompt: string): Promise<void>` 方法签名，验证类型检查通过
- [x] 4.2 在 `src/preload/index.ts` 中暴露这两个 IPC 方法，验证 preload 脚本编译通过
- [x] 4.3 在 `src/main/index.ts` 中注册 `getSystemPrompt` handler，返回 `store.getSettings().systemPrompt ?? SYSTEM`，验证返回正确值
- [x] 4.4 在 `src/main/index.ts` 中注册 `setSystemPrompt` handler，验证输入长度不超过 16384 并保存到 settings，验证超长输入被拒绝

## 5. 样式与文案

- [x] 5.1 在 `src/renderer/src/styles.css` 中为系统提示词 tab 添加样式（textarea 高度、字数提示等），验证视觉效果符合设计
- [x] 5.2 为系统提示词 tab 添加说明文案（"定义 Her 的性格和行为方式"），验证文案清晰易懂
- [x] 5.3 添加字符计数显示（如"已输入 234 / 16384 字符"），验证实时更新

## 6. 测试

- [x] 6.1 在 `tests/renderer.test.tsx` 中添加系统提示词 tab 的渲染测试，验证 tab 切换和输入框存在
- [x] 6.2 添加保存和恢复默认功能的测试，验证 IPC 调用被正确触发
- [x] 6.3 在 `tests/chat.test.ts`（或新建）中测试 `ChatService` 使用自定义提示词，验证 `system` 参数传递正确
- [x] 6.4 运行 `npm run check` 验证所有单元测试通过、类型检查无错误、构建成功

## 7. 端到端验证

- [x] 7.1 在 `tests/e2e/desktop.spec.ts` 中添加场景：打开设置 → 系统提示词 tab → 编辑提示词 → 保存 → 发起对话，验证对话使用自定义提示词
- [x] 7.2 添加场景：恢复默认提示词后发起对话，验证使用默认提示词
- [x] 7.3 运行 `npm run test:e2e` 验证所有 e2e 测试通过
