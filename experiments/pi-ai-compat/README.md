# Her / pi-ai 小范围兼容验证

这是独立实验，不被 Her 正式入口引用。固定 `@earendil-works/pi-ai@1.2.0`，正式依赖和 `src` 不变。

在 Her 根目录重跑：

```sh
npm --prefix experiments/pi-ai-compat ci --ignore-scripts
npm --prefix experiments/pi-ai-compat run verify
```

前提：Her 根目录已安装其开发依赖；完整 Electron 打包验证使用本机 macOS Electron。运行只访问本地模拟服务，不需要模型密钥。测试会生成独立临时用户数据和未签名 `.app`，不会使用真实聊天库。测试的绿色结果包含“成功复现不兼容行为”，不能理解为所有场景兼容。

- [结论与证据](REPORT.md)
- `adapter.ts`：薄适配，仅做消息/事件转换、完整结果后的工具白名单与对象检查；故意不加 SSE 重解析、URL 修补或认证占位值，方便观察真实差异。
- `protocol.test.ts`：现有 Her 与真实 Pi SDK 接收同一组 HTTP/SSE 样本。
- `chat-integration.test.ts`：真实 ChatService、ProfileService、SQLite 和工具执行器的接入验证。
- [Electron 打包方法](packaging/README.md)
- `results/protocol.json`：逐项兼容差异、用量能力和流停滞观察。
- `results/test-results.json`：全部实验测试结果。
- `results/verification.log`：统一验证日志。
- `results/packaging-results.json`：构建、包大小、源码哈希和运行结果位置。
- `results/production-integrity.json`：本轮正式源码与依赖文件保持不变的检查。

`production-before.json` 是本次实验开始时的快照。将来正式源码有意修改后，完整 `verify` 的最后一步会提示差异；那不是 Pi 协议回归。可分别运行 `typecheck`、`test`、`test:electron`，并人工确认新的验证基线。

生成目录 `node_modules/`、`packaging/work/` 不进入版本管理。保留脚本和结果用于复现；最终选型完成后可整体删除本实验目录及其日志中明确记录的临时应用目录。
