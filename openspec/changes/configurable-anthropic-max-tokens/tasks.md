# Tasks

## 1. 类型与存储迁移

- [x] 1.1 在 `src/shared/types.ts` 的 `ProviderProfile`、`RuntimeProvider` 增加可选 `maxOutputTokens?: number`，在 `SaveProfileInput` 增加 `maxOutputTokens?: number | null`；运行 `npm run typecheck` 确认通过
- [x] 1.2 修改 `src/core/storage/store.ts`：新库建表包含 `max_output_tokens INTEGER`；`user_version` 为 1 的旧库在同一事务内先查 `PRAGMA table_info` 再 `ALTER TABLE ... ADD COLUMN`，成功后设为 2；去掉每次启动无条件写 `user_version = 1` 的语句；拒绝打开的阈值改为 `> 2`；`saveProfile` 改为带列名的 `INSERT`，读写该列。在 `tests/storage.test.ts` 增加用例：旧版（版本 1、无该列）数据库升级后服务和历史保留、值为未配置；重复打开已升级的库不报错；版本 3 的库被拒绝；写入后重开能读回数值和 `NULL`。运行 `npx vitest run tests/storage.test.ts` 通过

## 2. 校验与保存语义

- [x] 2.1 修改 `src/core/storage/profiles.ts`：`validate` 校验 `maxOutputTokens` 为 1 到 200000 的整数或 `null`，失败抛中文错误；协议为 `openai` 时落库为 `NULL`；`undefined` 保留原值、`null` 清除；`publicProfile` 与 `resolve` 带出该字段；不把它计入 `connectionChanged`。在 `tests/profiles.test.ts` 增加用例：拒绝 0、负数、小数、`NaN`、200001 且原配置不变；接受 1 与 200000；省略时保留、`null` 时清除；改为 `openai` 协议后被丢弃；仅修改该值时连接测试结果与 `revision` 不变。运行 `npx vitest run tests/profiles.test.ts` 通过

## 3. 请求构造

- [x] 3.1 修改 `src/core/providers/stream.ts` 的 Anthropic 分支为 `body.max_tokens = provider.maxOutputTokens ?? 4096`，OpenAI 分支不动。在 `tests/providers.test.ts` 把现有 `toBeGreaterThan(0)` 断言收紧，并增加用例：未配置时为 4096、配置 8192 时为 8192、OpenAI 请求体不含 `max_tokens`。运行 `npx vitest run tests/providers.test.ts` 通过
- [x] 3.2 在 `tests/chat.test.ts` 或 `tests/profiles.test.ts` 增加用例，验证 `testConnection` 发出的请求使用已保存的值（通过传入的 `stream` 桩检查 `provider.maxOutputTokens`）。运行对应测试通过

## 4. 设置面板

- [x] 4.1 修改 `src/renderer/src/SettingsPanel.tsx`：增加 `maxOutputTokens` 状态；仅在协议为 Anthropic 时渲染 `type="number"` 输入框，占位提示"留空使用默认 4096"；编辑已有服务时预填；保存时空值传 `null`、有值传数字；切换协议、新建服务、选择其他服务时重置，沿用现有重置逻辑。在 `tests/renderer.test.tsx` 增加用例：Anthropic 下显示且预填、切到 OpenAI 后消失、保存时 `window.her.saveProfile` 收到正确的值（空为 `null`）。运行 `npx vitest run tests/renderer.test.tsx` 通过

## 5. 文档与整体验证

- [x] 5.1 更新 `docs/implementation/stage-a.md` 的"服务配置契约"：说明新字段、默认 4096、仅 Anthropic 生效，以及 `user_version` 升到 2 后无法回退旧版本，升级前可手动备份 `her.sqlite`。核对文档中的路径和命令与代码一致
- [x] 5.2 运行 `npm run check`（类型检查、全部 Vitest、构建）全部通过
- [x] 5.3 运行 `npm run test:e2e` 通过；若 Electron 二进制无法下载则如实记录未能运行

## Workflow follow-up

- 手动验收：用一个真实 Anthropic 端点保存较大的最大输出 token 数，确认长回答不再在 4096 处被截断。自动化测试用的是本地模拟服务，不能替代这一项。
- 评审通过后归档该 change。
