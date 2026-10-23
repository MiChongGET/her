# Her 生活陪伴界面：正式实现验收

本记录对应 [界面与交互方案](../../docs/superpowers/specs/2026-10-23-life-companion-ui-design.md) 和 [实施计划](../../docs/superpowers/plans/2026-10-23-life-companion-ui-implementation.md)。基线为 [可交互原型](../life-companion-prototype/README.md)。验收环境：macOS 26.6.2 (25G83)、arm64、Her 0.1.0 / Electron 44.7.0。截图来自真实 Electron 窗口，窗口尺寸为 1034×749 或 850×620，Retina 截图为两倍像素；测试资料均位于隔离的 `HER_DATA_DIR`。

## 实现范围

- 三个固定入口：日常、一起在做的事、她记得的事。具体话题以真实标题进入，记忆明确显示尚未开放。原型的演示外框、场景切换器、虚构人物及静态回复没有进入应用。
- 日常和话题共用交流布局，颜色按用户后续要求回到 Her 原有的暖白与浅灰绿；话题列表、首句标题、重命名、回收站、设置和对话详情使用真实服务。生活陪伴文案优先，办理与授权仅在确有事项时出现。
- 草稿、附件引用和阅读位置按会话保留在当前应用会话内。切页后重新核验附件；历史、队列、待处理读取失败时不展示假空状态，也不放行发送或审批。
- 输入框左下角以“文字与附件”打开向上展开的文件菜单，左边缘与输入框对齐；菜单接入真实文件选择、当前话题及长期目录授权，并可展开查看当前资料授权。保持暖白与浅灰绿配色。
- 输入框右侧的用量入口在发送按钮左边；生成中的停止按钮也在发送按钮左边，发送始终位于最右端。
- 设置弹窗按原型改为顶部标题与说明、左侧六项纵向菜单、右侧内容；模型与 MCP 的服务选择移到内容区顶部，保留真实配置表单和浅色配色。
- 草稿附件显示为与输入框左边缘对齐的横向卡片，包含图片预览、文件名、使用范围和移除操作。当前资料授权从附件菜单打开浮层，默认不占输入区高度；浮层内仍可查看及撤销真实授权。
- “单独聊这件事”先选择少量日常原话并预览，再明确确认。保存到 Pi 历史和 SQLite 操作记录，重启可再次读回；同次操作核实与并发点击不重复创建，不自动调用模型。背景来源和接收模型服务变化时停止提交；不可验证的上下文按失败关闭。
- 当前委托、审批、未知动作与排队卡片按对象展示；设置和回收站保留原有操作。未开放的记忆与共享能力只显示边界，不提供伪功能开关。

## 验证结果

| 层级 | 结果 | 证据范围 |
| --- | --- | --- |
| 浅色版 `npm run check` | 类型检查、1329 项单测通过、4 项跳过、构建通过 | 源码与本地模拟；[完整日志](../../.superpowers/sdd/2026-10-23-life-companion-ui-implementation/light-palette-check.log) |
| 浅色版源码 Electron | 三入口、背景衔接、委托/审批等 6 项全通过 | 真实 Electron / IPC / 隔离数据目录 / 本地假服务；[测试日志](../../.superpowers/sdd/2026-10-23-life-companion-ui-implementation/light-palette-source-electron.log) |
| 浅色版打包应用 | `npm run package` 成功；关键 Electron 套件 8 项全通过 | 实际 `Her.app`；[打包日志](../../.superpowers/sdd/2026-10-23-life-companion-ui-implementation/light-palette-package.log) · [测试日志](../../.superpowers/sdd/2026-10-23-life-companion-ui-implementation/light-palette-package-electron.log) |
| 文件菜单对齐 | `npm run check`：1330 项通过、4 项跳过；源码和打包 Electron 各 11 项通过、1 项按条件跳过 | [检查](../../.superpowers/sdd/2026-10-23-life-companion-ui-implementation/attachment-menu-check.log) · [源码 Electron](../../.superpowers/sdd/2026-10-23-life-companion-ui-implementation/attachment-menu-source-electron.log) · [打包](../../.superpowers/sdd/2026-10-23-life-companion-ui-implementation/attachment-menu-package.log) · [打包 Electron](../../.superpowers/sdd/2026-10-23-life-companion-ui-implementation/attachment-menu-package-electron.log) |
| 发送按钮位置 | `npm run check`：1330 项通过、4 项跳过；源码和打包 Electron 各 2 项通过，850×620 下检查发送按钮位于用量入口右侧、距输入框右边缘小于 20px | [检查](../../.superpowers/sdd/2026-10-23-life-companion-ui-implementation/send-right-check.log) · [源码 Electron](../../.superpowers/sdd/2026-10-23-life-companion-ui-implementation/send-right-source-electron.log) · [打包](../../.superpowers/sdd/2026-10-23-life-companion-ui-implementation/send-right-package.log) · [打包 Electron](../../.superpowers/sdd/2026-10-23-life-companion-ui-implementation/send-right-package-electron.log) |
| 设置菜单布局 | `npm run check`：1330 项通过、4 项跳过；源码与打包 Electron 各 2 项通过，检查六项菜单逐一切换及 850×620 可见性 | [检查](../../.superpowers/sdd/2026-10-23-life-companion-ui-implementation/settings-sidebar-check.log) · [源码 Electron](../../.superpowers/sdd/2026-10-23-life-companion-ui-implementation/settings-sidebar-source-electron.log) · [打包](../../.superpowers/sdd/2026-10-23-life-companion-ui-implementation/settings-sidebar-package.log) · [打包 Electron](../../.superpowers/sdd/2026-10-23-life-companion-ui-implementation/settings-sidebar-package-electron.log) |
| 资料授权与附件卡片 | `npm run check`：1330 项通过、4 项跳过；源码和打包 Electron 各 4 项通过，核对文件预览、授权浮层不推移输入框、文件/图片发送和桥接 | [检查](../../.superpowers/sdd/2026-10-23-life-companion-ui-implementation/attachment-card-check.log) · [源码 Electron](../../.superpowers/sdd/2026-10-23-life-companion-ui-implementation/attachment-card-source-electron.log) · [打包](../../.superpowers/sdd/2026-10-23-life-companion-ui-implementation/attachment-card-package.log) · [打包 Electron](../../.superpowers/sdd/2026-10-23-life-companion-ui-implementation/attachment-card-package-electron.log) |

深绿实现时的源码 Electron 全量套件曾 49 项通过、5 项按条件跳过（[历史日志](../../.superpowers/sdd/2026-10-23-life-companion-ui-implementation/final-source-electron.log)）。后续颜色回退只改样式，已对浅色版重新执行完整 `npm run check`、相关源码 Electron 和打包 Electron 验收；全量桌面套件未在颜色回退后重跑。

## 页面截图

| 场景 | 源码 Electron |
| --- | --- |
| 日常无模型空状态 | [1034×749](screenshots/source-daily-empty.png) · [850×620](screenshots/source-daily-empty-850x620.png) |
| 话题空列表、真实话题卡 | [空列表](screenshots/source-topics-empty.png) · [话题卡](screenshots/source-topic-list.png) |
| 记忆未开放 | [记忆页](screenshots/source-memory-unavailable.png) |
| 日常背景预览、确认后重启 | [预览](screenshots/source-handoff-preview.png) · [重开话题](screenshots/source-handoff-reopened.png) |
| 设置、回收站 | [设置](screenshots/package-settings.png) · [设置 850×620](screenshots/package-settings-850x620.png) · [有话题的回收站](screenshots/source-trash-with-topic.png) · [空回收站](screenshots/source-trash-empty.png) |
| 待确认动作卡 | [850×620](screenshots/source-work-approval-850x620.png) |
| 文件菜单 | [打包应用 850×620](screenshots/package-attachment-menu-850x620.png) |
| 草稿附件与授权 | [附件卡片 850×620](screenshots/package-attachment-draft-850x620.png) · [授权浮层 850×620](screenshots/package-grants-flyout-850x620.png) |

对照原型的内容区域：标题栏、约 200px 侧栏、三个入口、宋体标题、右侧用户气泡与底部输入区的层次相符；颜色按后续要求恢复为原有暖白、浅灰绿和浅色气泡。正式应用在未配置模型时显示真实的服务配置入口，因此日常空状态与原型的虚构示例聊天内容不同；新话题和衔接页由真实服务结果驱动。850×620 下输入区与关键操作可见；较长审批内容在卡片内部滚动。日常、设置、背景预览和审批卡均已人工核对浅色版截图。

本验收使用本地假模型服务和隔离测试资料，证明了 Electron 主进程、预加载、渲染层及打包产物的相应路径；未连接真实外部模型服务，也未验证用户机器上的实际系统权限或外部动作执行。未迁移或清理旧测试对话；未提交、推送或发布。

## 打包应用最终验收

最终产物：`release/Her-darwin-arm64/Her.app`，测试入口为其 `Contents/MacOS/Her`。命令：

```bash
HER_TEST_APP_EXECUTABLE=/Users/michong/work/her/release/Her-darwin-arm64/Her.app/Contents/MacOS/Her \
  npx playwright test tests/e2e/life-companion-ui.spec.ts tests/e2e/window-lifecycle.spec.ts tests/e2e/companion-workspace.spec.ts --reporter=line
```

8 项全部通过，覆盖三入口、话题管理、记忆未开放、设置/回收站、日常背景预览与重启读回、真实待确认动作，以及隐藏/恢复/退出窗口。最终包截图：[日常 1034×749](screenshots/package-daily-empty.png)、[日常 850×620](screenshots/package-daily-empty-850x620.png)、[话题列表](screenshots/package-topic-list.png)、[背景预览](screenshots/package-handoff-preview.png)、[重启读回](screenshots/package-handoff-reopened.png)、[记忆未开放](screenshots/package-memory-unavailable.png)、[待确认动作 850×620](screenshots/package-work-approval-850x620.png)、[设置](screenshots/package-settings.png)。
