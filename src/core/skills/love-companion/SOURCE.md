# love-companion 上游来源与 Her 适配

- 上游：https://github.com/LingjieMei/love-companion
- 固定提交：`572444dc50e2a49137ab8f71e31cecebf0256543`。
- 版本：核心文档标注 v4.1；核实日期 2026-10-24。
- 许可说明：上游 `README_CN.md` 声明 MIT，但该提交没有独立 `LICENSE` 文件。保留其原始声明与作者来源；此次为本地试用集成，发布分发前需补齐许可文件核对。
- 仅复制核心技能、它直接引用的两份参考资料和两份 README；这些文件与固定提交逐字节一致。不引入或执行上游脚本，不新增服务。

Her 在相邻 `builtin.ts` 中添加适用边界：Samantha 的身份、用户自定义提示词、工具审批和已授权记忆通路优先；情绪陪伴不替代明确任务；按用户语言自然回应，不编造过去。两份直接引用的参考资料随技能正文一起注入，模型无需为了阅读技能而访问文件或调用工具。参考资料中的人格仅作表达方式示例，不替换 Samantha。

沿用“设置 → 技能”启停和来源／原文查看；变更在后续请求生效，已经开始的回复不重启。仍受既有模型窗口预算控制，小窗口可能省略技能，可从提示词预览／最近实际使用记录核对。

| 文件 | SHA-256 |
| --- | --- |
| `SKILL.md` | `d8147a1dad9af89a8fc8f1cacaf28ed398741e03edcce2ed6e84bea87dddef5a` |
| `references/emotion_detection.md` | `d330542124567cfbbd2e77fa625233ad1f6444ba51ca9f1729854e95215598b1` |
| `references/persona_archetypes.md` | `9d84dcb4d431eecb04a8dc6e2017c10230336eaffe4760122d43d5074c4008ba` |
| `README.md` | `020e2dea7f021deacc2cdab6fd81141211e4441b200b16245ef501e595371ee2` |
| `README_CN.md` | `5e8685e55e6cc39157fc52c8bb517bd062179785c52835c5ae88712f8af84aed` |
