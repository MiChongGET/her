# Her / Pi 1.3.0 接入验收

候选版本：`0eefa41` 之后本次工作区；2026-10-20，macOS arm64，Electron 44.7.0，Pi SDK 精确锁定 1.3.0。验收使用隔离的 `HER_DATA_DIR`，不迁移旧对话。

## 模拟服务与断点验收（方案 §14）

`npm run check`：65 个文件通过，981 条通过、1 条跳过，类型检查和主进程/预加载/渲染构建通过。完整日志：`/tmp/her-pi-check-final.log`。

| 项目 | 当前代码的验证入口 | 已验证行为 |
| --- | --- | --- |
| 完整 SDK | `agent-factory`、`tool-wiring`、`projection`、`host-compaction` | 运行、工具往返、压缩与会话恢复走 AgentSession；删除投影后从 Pi 重建文字、结构化结果和工具状态 |
| 并行会话 | `host-events`、`host-stop-continue`、`host-compaction`、`config-freeze`、`model-credentials` | A/B 同时运行；停止、审批、压缩、模型与配置变化不串会话；事件有运行身份、代次、递增 seq；凭据隔离 |
| 持久队列 | `host-queue`、`startup-recovery`、`renderer` | 每条请求独立身份，可撤销且只接纳一次；完成自动继续，失败/停止/重启暂停；界面可查看与继续 |
| 冲突资源 | `tool-resources`、`tool-approval`、`peekaboo`、`host-events` | 同资源 FIFO、无冲突并行、审批不占锁、取消出队、动作前重新观察，资源等待可见 |
| 未知动作 | `action-ledger`、`tool-resolution`、`host-stop-continue`、`startup-recovery` | 派发各阶段取消/超时/恢复，目标隔离跨会话与重启，迟到结果只入审计，禁止自动重放 |
| 压缩 | `agent-factory`、`host-compaction`、`model-selection` | 超过旧条数/字符界限仍保留上下文；工具后压缩；小窗口预算、超大单条拒绝；失败/停止保留原文且暂停队列 |
| 来源失效 | `source-filter`、`attachments`、`host-compaction` | 普通请求、压缩、恢复过滤撤权/变化来源及依赖摘要，停止相关在途任务，迟到结果不复活来源 |
| 多存储恢复 | `projection`、`startup-recovery`、`session-damage`、`purge` | Pi 已写/投影未写可重建；接纳未入 Pi 不重发有副作用请求；动作及删除断点恢复；坏行隔离、不改原文件 |
| 模型认证 | `profiles`、`model-credentials`、`model-connection`、`model-usage`、`credentials` | 离线目录、自定义窗口、显式认证、请求头/无密钥、模型切换；凭据不串线或明文落盘；缺失用量显示未知 |
| 清理 | `purge`、`storage`、`host-trash`、`renderer` | 墓碑持久化、Pi 文件删除、共享附件引用计数、原文件保留、失败可见/可重试、未知目标隔离保留 |
| 生命周期 | `host-shutdown`、`host-trash`、`pi-window-runtime.spec.ts`、`window-lifecycle.spec.ts` | 关闭窗口继续，重新显示队列/审批/进度；退出全部停止，重启不自动运行，只清理自管进程 |
| 真实桌面包 | 下方打包 e2e | Electron 主进程、正式 preload/UI、nativeImage 与真实 PDF worker；模型与 MCP 由本地模拟服务提供 |

测试名对应 `tests/*.test.ts`。额外回归：`projection.test.ts` 证明结构化正文送给模型而非动作上下文的私有 `meta` 不送；`session-damage` 证明隔离文件丢失时不能悄悄新建历史。`modelToolResultText` 保留已有截断、来源与动作上下文规则。

## macOS 包

包：`release/Her-darwin-arm64/Her.app`。常规 `npm run package` 的网络下载等待被终止后，使用同一 `scripts/package.mjs` 配置与本机 Electron 44.7.0 缓存 ZIP（packager 的 `electronZipDir`）生成；未修改打包配置或应用源码以绕过验收。命令记录：`/tmp/her-package-cached.mjs`；日志：`/tmp/her-pi-package-final.log`。

包中 `Contents/Resources/app/out/main/index.js` 与当前 `out/main/index.js` SHA-256 相同：`7f463c735f07d7db75b9ac86acf4f44333def8124b5e72e29102e324bfb7b6d1`。

完整包内 e2e：`HER_TEST_APP_EXECUTABLE="$PWD/release/Her-darwin-arm64/Her.app/Contents/MacOS/Her" npm run test:e2e`，退出码 0，**39 条通过、3 条跳过**（1.3 分钟）。日志：`/tmp/her-pi-packaged-e2e-final.log`。跳过项为单独启用的真实服务、本机 MarkItDown、外部 Web 预设；真实服务另见下节。所有 launch 都尊重包路径，未把源码运行混充为包验收。

边界：文件选择器在测试进程返回合成文件；登录启动 API 在测试进程替换，未实际添加登录项。源码模式测试注册的停止快捷键回调；包模式核对原生注册并经真实 IPC 停止隐藏窗口任务，不宣称模拟了系统键盘输入。MarkItDown/外部浏览器真实安装验收需显式启用，不属于本次模拟通过证明。

## 用户授权的真实服务

用户明确要求“从数据库找个”。只读查询 `<userData>/her.sqlite` 已存 `services`，仅复制一个服务的加密连接记录到临时新版库；不读取旧会话、不修改源库、不把密钥送入渲染进程或日志。生产代码继续只打开 `Her-Pi-v1`。

已观察：开发 Electron 与 Her 包的凭据身份有差异；真实服务使用正式 Her 包验收。首轮真实工具读取暴露旧工具门遗漏 `structuredContent`，已修复并加入失败复现/通过回归。

最终完整验收服务：**中转站 / `claude-haiku-4-5` / Anthropic**，Her macOS 包内 **1 条通过（40 秒）**。命令：

```bash
HER_TEST_LIVE=1 HER_TEST_LIVE_SERVICE='中转站' \
HER_TEST_APP_EXECUTABLE="$PWD/release/Her-darwin-arm64/Her.app/Contents/MacOS/Her" \
npx playwright test tests/e2e/pi-live-service.spec.ts --output=/tmp/her-pi-live-accepted-results
```

日志：`/tmp/her-pi-live-accepted.log`。脱敏结果：`/tmp/her-pi-live-accepted-results/pi-live-service-explicitly-ef0ce-compaction-and-cancellation/live-service.json`；同目录 `pi-entry-diagnostics.json` 仅含条目类型、终态、用量和内容种类。

| 真实验证 | 结果 |
| --- | --- |
| 已存凭据与文字/工具探针 | 均通过，API Key 不出主进程 |
| 聊天与实际工具往返 | 完成聊天，`read_text` 成功读取合成文件并回答仅存在于文件中的标记 |
| 实际用量 | 工具往返累计输入 6325、输出 42 tokens（服务报告） |
| 配置容量 | 设为 4096，超大单条在接纳时拒绝 |
| 压缩与后续上下文 | Pi 写入 3 个自动压缩检查点；原消息仍全部可查看，压缩后继续成功；最近内容已经压缩时不强求再手动压缩 |
| 取消 | 收到部分文本后停止，结果保存为 cancelled |
| 错误凭据 | 单独合成错误 Key 的连接测试失败，错误不回显凭据 |

源库的两个旧记录均同时存在 `auth_method=none` 与 `has_api_key=1`。隔离副本明确选择已有 API Key 认证，随后编辑容量仍保留密钥；源库未更改。另一个已存服务“公司 / spark-x2.6-preview / Responses”通过文字探针、工具探针、聊天和实际文件读取，但在 4096 窗口演练中出现未完成生成，**不计为该服务完整验收通过**。三协议模拟测试通过不代表所有真实模型在所有窗口配置都已通过。

容量验收针对 Her 明确配置的窗口及其预算/压缩行为，不能据此推断供应商未声明的最大窗口。模拟模型测试也不能替代真实模型结果。
