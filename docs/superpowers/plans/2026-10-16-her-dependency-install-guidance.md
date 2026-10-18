# Her dependency installation guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline task-by-task. User authorized direct implementation; preserve that method and do not ask again between tasks.

**Goal:** 缺少工具时有明确安装/授权操作，安装后能重新检查。

**Architecture:** Host 为现有 DependencyCheck 添加可选固定帮助，使用当前资源目录生成安装命令；renderer 复用一个带安装入口/复制命令的结果列表。原检查/连接/授权及分装打包保持。

**Tech Stack:** Existing Electron/React/TypeScript/Vitest/Playwright.

**Spec:** ../specs/2026-10-16-her-dependency-install-guidance.md

## Global Constraints

- 仅展示/复制固定安装流程和打开官方HTTPS；没有自动安装或任意执行IPC。
- 固定工具版本/锁/校验不变；用户模型/配置/凭据/已安装工具不变。
- No Git repository: use exact-file snapshots/diff instead of commits, retain SDD as recovery record. No worktree/init/push.
- Preserve newer MCP environmentDefaults/OPEN_WEBSEARCH_ENV and prerequisite diagnostics from other idle chat.

## Review Focus

- 含空格、单引号、$()的安装资源路径：命令不能误执行路径内容（Task1）。
- 迟到检查/页面切换：不能混入其他预设或覆盖草稿（Task2）。
- ready/permission_required：不能重复安装或把授权问题当缺软件（Task1/2）。
- 剪贴板/链接失败：有可操作错误，不能虚报安装完成（Task2）。
- 安装版与源码版路径：实际资源定位，重检依实际状态（Task3）。

### Task1: Host installation help

Files: src/shared/types.ts; new src/core/mcp/dependency-setup.ts; src/core/mcp/dependencies.ts; src/main/index.ts; new tests/dependency-setup.test.ts; tests/dependencies.test.ts.

Interfaces: DependencyCheck.setup?: DependencySetup {steps:string[];links:{label:string;url:string}[];command?:string}; dependencySetup(presetId:string,check:DependencyCheck,resourcesRoot?:string):DependencySetup|undefined. PresetDependencies options add resourcesRoot?:string; public check decorates original diagnostic results. Main passes packaged process.resourcesPath or app.getAppPath()/resources.

- [x] Write tests for ready/unknown no action, missing fixed links/versions, permission-only help, fixed scripts, shell quote roundtrip and no command substitution; run to see RED.
- [x] Implement helper/wrapper/options, preserving original diagnostic contents and validation. Run dependency-setup/dependencies/ipc-policy tests plus typecheck; expect PASS.
- [x] Snapshot/diff and ledger Task1 complete with actual verification.

### Task2: UI installation actions

Files: new src/renderer/src/DependencyChecks.tsx; McpSettingsPanel.tsx; FileAccessPanel.tsx; styles.css; tests/renderer.test.tsx (or dedicated component test).

Interfaces: DependencyChecks({checks:DependencyCheck[],label?:string}) presents original diagnostics, fixed links through window.her.openExternal, command through navigator.clipboard.writeText; failures local and visible, no installation status mutation. Saved-preset diagnostic state scoped to editor identity; failed connection probes dependencies. Existing PresetPicker keeps its generation fences.

- [x] Write RED tests: missing action/link/copy; ready no install; permission instructions; saved-preset connection failure; recheck clears missing; failed clipboard/link error; stale/unmount/draft preservation; parser reuse.
- [x] Implement minimal shared list, saved/new preset checks, document diagnostic reuse and styles. Run renderer and targeted core tests; expect PASS. Record Task2.

### Task3: Electron verification and docs

Files: tests/e2e/dependency-guidance.spec.ts; README.md; current task SDD report.

- [x] Add isolated Electron test for missing dependency through real preload IPC/Host guidance; stub only diagnostic boundary/external browser and clipboard at owned test boundary, not installation. Check actual resource command, copy feedback, recheck and existing draft.
- [x] Run complete check + relevant Electron tests; package with existing command and run new test against package. Keep user apps/permissions/clipboard and external tool installs untouched.
- [x] Update README installation workflow, retain prior acceptance limitations; capture source/package proof separately.
- [x] Fresh whole-change review per executing-plans; adjudicate findings, one TDD fix pass for Critical/Important; no additional implementation agents. Final report links code, tests and limits.
