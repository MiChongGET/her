# Tasks

## 1. 类型与存储迁移

- [x] 1.1 修改 `src/shared/types.ts`：新增 `ServiceModel { id; longOutput; tests }`；`ProviderProfile` 增加 `models: ServiceModel[]` 并去掉顶层 `tests`（`model` 保留为默认模型 ID）；`SaveProfileInput` 增加可选 `models?: { id: string; longOutput?: boolean }[]`；`SendMessageInput` 增加可选 `model?: string`；`HerApi.testProfile` 增加可选第三个参数 `model?: string`。运行 `npm run typecheck`，记录由此暴露的全部调用点作为后续任务的清单
- [x] 1.2 修改 `src/core/storage/store.ts`：`StoredProfile` 用 `models` 取代 `tests`；新库建表带 `models TEXT`；旧库在现有迁移事务内补列，并只对 `models IS NULL` 的行写入 `[{ id: model, longOutput: false, tests: 原 tests }]`；`user_version` 设为 4，拒绝阈值改为 `> 4`；`saveProfile` / `profileFromRow` 读写 `models`，旧 `tests` 列固定写 `'{}'`。在 `tests/storage.test.ts` 增加用例：版本 3 的旧库升级后服务、历史、测试结果保留并归入唯一模型；重复打开已升级的库不报错；中途只补了列但未回填的库再次打开能补完；写入多模型后重开能读回；版本 5 被拒绝（把现有"版本 4 被拒绝"用例改为 5）。运行 `npx vitest run tests/storage.test.ts` 通过

## 2. 服务保存、校验与解析

- [x] 2.1 修改 `src/core/storage/profiles.ts` 的 `validate` 与 `save`：校验模型列表（1 到 20 个、ID 去空白后非空且 ≤2048、不重复、`model` 在列表中，失败抛中文错误且不写库）；`models` 省略时等价于 `[{ id: model }]`；`longOutput` 对所有协议原样保存，服务级覆盖值仍只对 Anthropic 保存；按 ID 与旧列表匹配，保留同 ID 模型的 `tests`，新 ID 为"未验证"；`connectionChanged` 去掉 `model`，变化时所有模型的 `tests` 重置且 `revision` 加 1；`publicProfile` 带出 `models`。在 `tests/profiles.test.ts` 增加用例：每条校验规则的拒绝场景且原配置不变；新增模型时其余模型测试状态保留；改地址时全部重置；改默认模型、改 1M、改服务级覆盖值时测试结果与 `revision` 不变；协议改为 openai 后 `longOutput` 保留、服务级覆盖值被丢弃。运行 `npx vitest run tests/profiles.test.ts` 通过
- [x] 2.2 修改 `recordTest(id, kind, result, expectedRevision?, model?)` 与 `resolve(id, model?)`：`model` 省略时用默认模型；`recordTest` 对不存在的模型返回 `false`；`resolve` 对不在列表中的模型抛中文错误；任意协议下 `longOutput` 为真时 `maxOutputTokens = 1_000_000`；否则 Anthropic 用服务级覆盖值、没有则不带该字段，其余协议不带该字段。校验上限常量与错误文案改为 1 到 1000000。在 `tests/profiles.test.ts` 增加用例：1M 优先于覆盖值、关闭时回落到覆盖值、同服务其他模型不受影响、OpenAI 兼容与 Responses 开启 1M 时带出 1000000 而关闭时不带该字段、未知模型被拒绝、接受 1 与 1000000 并拒绝 1000001、旧的 8192 保持不变；并把现有读取顶层 `.tests` 的断言改为读取默认模型的 `tests`。运行 `npx vitest run tests/profiles.test.ts` 通过

## 3. 请求构造、测试与发送

- [x] 3.1 修改 `src/core/providers/stream.ts` 为 `provider.maxOutputTokens ?? 262144`，OpenAI 兼容分支在 `provider.maxOutputTokens` 有值时写 `max_tokens`，Responses 分支在有值时写 `max_output_tokens`，没有值时两者请求体不变。在 `tests/providers.test.ts` 把现有 4096 的断言改为 262144，保留"配置 8192 时为 8192"，并保留未设置输出上限时"OpenAI 请求体不含 `max_tokens`"；另加用例：OpenAI 兼容带 1000000 时 `max_tokens` 为 1000000，Responses 带 1000000 时 `max_output_tokens` 为 1000000 且不含 `max_tokens`。运行 `npx vitest run tests/providers.test.ts` 通过
- [x] 3.2 修改 `src/core/providers/probe.ts`：`testConnection(profiles, id, kind, stream?, model?)`，用 `resolve(id, model)` 并把结果记到该模型。在 `tests/profiles.test.ts` 增加用例：测试第二个模型时请求使用它的 ID 和有效输出上限，只有它的状态改变；未指定模型时测试默认模型。运行 `npx vitest run tests/profiles.test.ts` 通过
- [x] 3.3 修改 `src/core/conversation/chat.ts`：用 `resolve(input.profileId, input.model)` 取运行时配置，`model` 非字符串或超过 2048 字符时按"消息不正确"拒绝；未知模型在创建任何消息之前失败。在 `tests/chat.test.ts` 增加用例：未指定模型用默认模型；指定模型时请求与助手消息的 `model` 都是它；不属于该服务的模型被拒绝且对话中没有新增消息；重试使用当前传入的模型。运行 `npx vitest run tests/chat.test.ts` 通过
- [x] 3.4 修改 `src/main/ipc.ts` 与 `src/preload/index.ts`：`her:profile-test` 与 `her:message-send` 透传可选 `model`，主进程把 `her:profile-test` 的 `model` 校验为 ≤2048 字符的字符串或缺省。运行 `npx vitest run tests/ipc-policy.test.ts` 与 `npm run typecheck` 通过

## 4. 设置面板

- [x] 4.1 修改 `src/renderer/src/SettingsPanel.tsx` 的模型列表：用行列表取代单个 Model ID 输入框，每行有"设为默认"单选、Model ID 输入框（`aria-label` 保持含"Model ID"）、所有协议都显示的"1M"复选框、删除按钮（仅剩一行时禁用），列表下方有"添加模型"按钮（20 个时禁用）；保存时传 `model`（默认行的 ID）与 `models`；表单 identity 纳入 `models`；新建服务、切换服务时重置（切换协议不重置模型列表和 1M 勾选）；服务列表副标题显示默认模型。在 `tests/renderer.test.tsx` 增加用例：添加、删除、更换默认模型后保存的入参正确；1M 复选框在三种协议下都出现并随保存提交，切换协议后勾选状态保留（服务级最大输出 token 数输入框仍只在 Anthropic 下出现）；仅剩一行时不能删除。运行 `npx vitest run tests/renderer.test.tsx` 通过
- [x] 4.2 修改 `SettingsPanel.tsx` 的最大输出 token 数输入框与连接测试区：输入框 `max` 改为 1000000、占位改为"留空使用默认 262144"；模型多于 1 个时在连接测试区显示"测试模型"下拉（选项来自已保存的模型，切换服务时回到默认模型），按所选模型显示结果并调用 `window.her.testProfile(id, kind, model)`，只有一个模型时仍按现有方式调用。在 `tests/renderer.test.tsx` 更新 `profile` 夹具、`commitProfile` 与 `commitTest` 为 `models` 结构，并增加用例：占位文案、测试第二个模型时调用参数与显示的结果；同时更新依赖旧入参形状的现有用例（如 `saveProfile` 的断言）。运行 `npx vitest run tests/renderer.test.tsx` 通过

## 5. 聊天窗口模型切换

- [x] 5.1 修改 `src/renderer/src/App.tsx` 与 `src/renderer/src/styles.css`：在 `.model-picker` 旁增加 `aria-label="当前模型"` 的下拉，列出当前服务的 `models`；所选模型为 `useState<string | null>`，有效模型 = 所选值仍在列表中则用它，否则回退默认模型；新建对话和 `activeProfileId` 变化时置回 `null`；`send` 把有效模型放进 `SendMessageInput.model`；输入框下方的提示显示有效模型；窄屏样式一并处理。在 `tests/renderer.test.tsx` 增加用例：列出当前服务的模型；切换后发送的入参带所选模型；新建对话后回到默认模型；切换服务后列出新服务的模型并选中其默认模型；所选模型被删除后回退默认模型。运行 `npx vitest run tests/renderer.test.tsx` 通过

## 6. 文档与整体验证

- [x] 6.1 更新 `docs/implementation/stage-a.md` 的"服务配置契约"：多模型与默认模型、聊天窗口按模型切换且不持久化、按模型记录的连接测试与失效范围、默认输出上限 262144 与校验上限 1000000、模型级 1M 开关（三种协议均可用及各自的请求字段）与优先级、`user_version` 升到 4 且升级前可手动备份 `her.sqlite`，以及默认值变大后上游可能拒绝、此时需填写服务级覆盖值；同时修正文档中"4096""200000""版本为 3"的旧描述，以及 Responses 协议"不发送 `max_output_tokens`"的描述（仅在开启 1M 时发送）。核对文档中的路径、字段名和命令与代码一致
- [x] 6.2 运行 `npm run check`（类型检查、全部 Vitest、构建）全部通过
- [x] 6.3 运行 `npm run test:e2e` 通过；若 Electron 二进制无法下载则如实记录未能运行；若 e2e 用例依赖旧的单模型表单或顶层 `tests`，一并更新

## Workflow follow-up

- 手动验收：用真实 Anthropic 端点配置两个模型，在聊天窗口切换并确认助手消息标注的模型正确；对某个模型开启 1M，确认上游接受请求（若被拒绝，记录是否需要额外请求头）；确认未填覆盖值的现有服务在 262144 下仍可聊天。自动化测试用本地模拟服务，不能替代这一项。
- 归档顺序：先归档 `configurable-anthropic-max-tokens`（使 `openspec/specs/provider-profiles` 存在），再归档本变更，否则 `provider-profiles` 的 MODIFIED 找不到对应需求。
- 实现时留意 `chat-ui-redesign` 对 `App.tsx` / `styles.css` 的并行改动，后合入的一方负责合并。
