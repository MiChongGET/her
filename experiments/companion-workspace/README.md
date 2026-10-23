# Companion workspace acceptance — 2026-10-23

This directory records A5 acceptance against real Electron, isolated Her-Pi-v1 SQLite/Pi files and loopback fixture providers. It does not contain real user history, model credentials or business messages. No live-provider or optional MarkItDown opt-in was enabled. No OS notification permission was requested or changed.

Final whole-A fix result: **source gate PASS; fresh packaged core UI PASS**. After the native-inbox navigation correction, final `npm run check` passed **1086 tests** (71 suites passed; 1 suite / 2 tests opt-in skipped), Renderer passed **168/168**, and the rebuilt package passed **16/16 (46.2s)** including attachments. Main/preload/native/renderer build artifacts match the final package byte-for-byte. See `logs/whole-a-fix1-*.log` and `.superpowers/sdd/2026-10-22-companion-workspace/whole-a-fix-1-report.md`. Actual native authorized/denied/revoked/banner/click acceptance remains open.

Prior A5 baseline evidence remains: check **1077 passed / 2 skipped**, source core **15/15 (55.2s)** and then-package **16/16 (46.6s)**. Source core was not repeated after the final narrow Renderer fix; the fresh packaged core run above exercises the final executable. A5's original RED/GREEN history is in `.superpowers/sdd/2026-10-22-companion-workspace/task-5-report.md`.

## Scope and evidence boundaries

| Layer | Evidence | What it proves |
| --- | --- | --- |
| Source/unit/build | `npm run check`; final counts in the A5 report | Strict types, local unit/integration regressions, final build including native compilation |
| Model boundary | `source-daily-requests.json`, `package-daily-requests.json` | Actual HTTP request bodies captured by `tests/pi-sdk/wire.ts`, three daily requests each: initial, after application restart, after deleting all SQLite display projections and reopening |
| Real Electron UI | `tests/e2e/companion-workspace.spec.ts`, core and affected e2e logs | Actual preload/IPC, Host, SQLite, Pi and selected-version event flow; local MCP receives no call before approval and one call after keyboard approval |
| Final packaged UI | Fresh cached exact-version `npm run package`, executable launched by Playwright | Workspace, request-isolation, restart, history, attachments and layout through the packaged main/preload/renderer |
| Actual macOS notification permission | A4 read-only packaged probe, reproduced below with provenance | `com.her.desktop`, arm64, Electron 44.7.0 actually reported `not-determined` in A4; A5 does not reinterpret fixture permission branches as native acceptance |
| Native notification delivery | Still open | Authorized, denied, post-revocation, actual banner and native click delivery are **not accepted**. Hidden-window generic UI tests are not OS notification click tests. |

Pi files remain the authoritative history. The boundary test seeds legacy (no TopicInfo) and work topics through the real store and Pi SessionManager, opens each through the UI, and verifies their original user messages survive restart and projection rebuilding. Both `工作秘密哨兵` and `旧历史秘密哨兵` are absent from every captured daily request, including system/tools/context. The daily conversation ID remains stable. The work topic keeps its own identity and `shareProgress=true`; legacy stays `topic=null`. No progress summary or memory injection is implemented or inferred.

The old daily test creates an old daily Pi history, trashes it, lets the store create the replacement daily and restores the old conversation through the real recycle-bin UI. Restoration preserves current daily selection/identity and makes the old conversation accessible as history.

The approval test creates work through the UI, receives a real local MCP approval and returns to daily. Daily contains only generic notice text: the title, body, approval target and summary are absent. A direct detail read for the unselected work is rejected. Keyboard activation of “查看” resolves and selects the owner, then keyboard approval authorizes exactly one controlled MCP call. Returning to daily does not cancel it. Restart preserves daily identity and does not replay the action.

After review fix 1, the hidden-window test explicitly gates the dynamic MCP response in `tests/helpers/mock-provider.ts`: after the actual request is captured, it verifies `BrowserWindow.hide()` has made `isVisible()` false and that pending notices are still empty, then releases the response. It verifies the approval appears while the window remains hidden and reads generic notices through `getPendingActions`, resolves the opaque id/version through `resolvePendingAction`, then uses the real “查看” control and `selectWorkspace` bridge to enter the owner. Deletion invalidates the notice and removes the UI entry. Restoring the stopped work shows a fresh generic paused notice without replaying the approval; the old notice remains invalid. This tests bridge ownership and lifecycle, not a synthetic/native notification click.

## Corrections exposed by acceptance

The real hidden-window test found that Host stop events preceded the final store deletion, leaving a stale generic notice after successful deletion. Restoration of stopped work had the opposite omission: the store restored it without a later Host event, so no generic paused notice reappeared. `registerIpc` now calls the existing `publishPending` callback after successful trash and restore. This refreshes both renderer generic notices and the existing Tray notifier from final state. No detail fields were added to notices. Permanent deletion accepts only already-trashed conversations (`beginPurge` checks `deleted_at`); those are already excluded from pending state, so no additional purge publication is needed.

Legacy e2e consumers were migrated only after failures were reproduced. They now select through UI once and read messages/tasks without incrementing selection versions; restart enters fixed daily; work/history must be explicitly opened. Model controls are opened through their disclosure. Existing protocol, capability, streaming, stop, restart, sandbox/preload, recycle-bin, unknown-outcome and audit assertions remain.

## Reproduction

```sh
npm run check
npm run test:e2e -- tests/e2e/companion-workspace.spec.ts tests/e2e/startup.spec.ts tests/e2e/conversation-runtime.spec.ts tests/e2e/desktop.spec.ts
npm run test:e2e -- tests/e2e/companion-workspace.spec.ts tests/e2e/mcp.spec.ts tests/e2e/pi-window-runtime.spec.ts tests/e2e/tool-resolution.spec.ts tests/e2e/message-files.spec.ts
HER_ELECTRON_ZIP_DIR=/Users/michong/Library/Caches/electron/953a0a4266b4fe4d83c379b33897281a9229323d55abb2772fdb535e9f65039e npm run package
HER_TEST_APP_EXECUTABLE=/Users/michong/work/her/release/Her-darwin-arm64/Her.app/Contents/MacOS/Her npx playwright test tests/e2e/companion-workspace.spec.ts tests/e2e/startup.spec.ts tests/e2e/conversation-runtime.spec.ts tests/e2e/desktop.spec.ts tests/e2e/message-files.spec.ts
```

Playwright uses one worker and isolated `HER_DATA_DIR` directories; `ELECTRON_RUN_AS_NODE` is stripped. All launches await a rendered UI before shutdown. The file-dialog/drop fixture supplies only local test files; actual preload provenance, grants and image bytes still pass through product code. The existing packaged login-item assertion substitutes only the OS login preference boundary inside its isolated process and does not claim actual login-at-startup acceptance. It never changes the user's login-item setting.

## Screenshots inspected

The `source-*` and `package-*` images in `screenshots/` are 850×620 logical-window screenshots at the local Retina device scale (1700×1240 pixels).

- `*-daily-private-notice-850x620.png`: only generic pending copy, daily composer visible, no private work title/body/approval detail. Keyboard Enter moves from daily navigation to the intended composer focus.
- `*-work-approval-850x620.png`: owner title and approval target/detail appear only after opening work. Allow/reject/stop remain readable and inside the viewport after normal chat scrolling. Keyboard approval succeeds.
- `*-attachments-850x620.png`: real PNG preserves its 3:1 aspect ratio; text/PDF/DOCX/XLSX source controls stack below it; the chat area scrolls while composer remains accessible. The upper message is partially scrolled naturally, not clipped by horizontal overflow.

## Review fix 1 verification

The hidden-arrival test now uses an explicit deferred response instead of a 300 ms delay. `mock-provider` gained an optional `beforeReply` hook, mirroring the existing hook in `tests/pi-sdk/wire.ts`; the hidden test uses **mock-provider** for its dynamic MCP tool name, while `wire.ts` remains the fixture for daily request-body capture. Release occurs only after request capture, actual hidden state and empty pending state have all been observed. Cleanup releases the promise as well.

Focused source command `npx playwright test tests/e2e/companion-workspace.spec.ts -g hidden_pending_open_resolves_owner` passed **1/1 (2.8s)**. The same command with `HER_TEST_APP_EXECUTABLE=/Users/michong/work/her/release/Her-darwin-arm64/Her.app/Contents/MacOS/Her` passed **1/1 (3.3s)** against the existing final package. `npm run typecheck` passed. Logs: `logs/fix1-hidden-source.log`, `logs/fix1-hidden-package.log`, `logs/fix1-typecheck.log`.

This was a test/helper-only change; no product rebuild or repackage was needed. The earlier full-suite counts remain their original run results, and these focused runs establish deterministic hidden-arrival ordering on that same product. Known SQLite ExperimentalWarning and NO_COLOR/FORCE_COLOR warnings are retained in the evidence; no warning filters or environment suppression were introduced.

## Whole-A final navigation fix verification

Whole review found that native-click processing captured navigation ownership only after an awaited inbox read. The final App captures it before that first await and keeps each queued wakeup's arrival generation. A newer user selection therefore keeps its page, draft and attachments; a superseded old click is consumed by exact id/version. If a queued wakeup exists, superseded ACK is deferred because the delayed read can already contain that newer identity; its own wakeup re-reads and handles it. Current native-owned selection increments preserve same-generation queued wakeups, while intervening user navigation supersedes them. Failed inbox/resolution/snapshot attempts remain unacknowledged and do not block already-queued newer wakeups.

Nine added Renderer regressions use deferred **stubbed bridges** and real App rendering. They cover late inbox + preserved daily draft/PDF attachment, queued arrivals before/after user navigation, unreadable inbox retained through reload, newer click after earlier failure, first native own selection success/failure, and an old inbox read already returning the newer notice. Earlier success/stale, resolve/snapshot failure+reload and supersession tests remain. This is source behavior evidence, not OS banner/native click acceptance.

RED/GREEN and artifact provenance:

- `whole-a-fix1-red.log`: initial **5 failures / 1 pass** reproducing the old inbox ownership and queued-flow problems; `whole-a-fix1-focused.log`: intermediate **12 passed**.
- `whole-a-fix1-queued-red.log`: **2 failures** exposed the first native selection incorrectly superseding a queued newer click. `whole-a-fix1-current-inbox-red.log`: **1 failure** exposed premature ACK when the delayed read already returned that newer identity.
- Final `whole-a-fix1-renderer.log`: **168 passed (21.46s)**; `whole-a-fix1-typecheck.log`: PASS.
- Final `whole-a-fix1-check.log`: **1086 passed / 2 skipped (27.01s Vitest)** plus typecheck, main/preload/renderer build and native compile PASS.
- Final `whole-a-fix1-package.log`: validated-cache package PASS. `whole-a-fix1-package-e2e.log`: **16 passed (46.2s)** via the packaged executable and the five core files shown under Reproduction.
- `whole-a-fix1-package-artifacts.log`: source/package byte equality PASS. Final Renderer **index-Cxtowvy4.js**, SHA256 **88d26b355461ee4bc8dd488d90848ab192add732196c60e4d7790d0d30411490**. Native module remains Mach-O arm64 with the A4 hash below.

The earlier same-dispatch 1085-test check, 167-test Renderer run, package/core **16/16 (45.9s)** and artifact comparisons are retained under `whole-a-fix1-intermediate-*.log`; they are not substituted for the final corrected artifact. That package test exited before the package directory was rebuilt. The final packaged run also exited normally. Package screenshots and daily request captures were refreshed by the final core run. Known warnings remain in raw logs. No OS permission request/change or explicit native permission probe was performed; the product's existing hidden-window read-only path may run, but no live notification delivery is claimed.

## A4 native permission evidence carried forward

Provenance: `.superpowers/sdd/2026-10-22-companion-workspace/task-4-report.md` and its independent review. The A4 package preceded the final renderer fix; A5 rebuilds and tests final packaged UI separately. Native implementation was unchanged by A5. A4 used:

```sh
HER_ELECTRON_ZIP_DIR=/Users/michong/Library/Caches/electron/953a0a4266b4fe4d83c379b33897281a9229323d55abb2772fdb535e9f65039e npm run package
node scripts/check-notification-permission.mjs
file out/native/notification-permission.node release/Her-darwin-arm64/Her.app/Contents/Resources/app/out/native/notification-permission.node
shasum -a 256 out/native/notification-permission.node release/Her-darwin-arm64/Her.app/Contents/Resources/app/out/native/notification-permission.node
```

A4 actual query exited 0 after renderer-ready and normal close:

```json
{"packaged":true,"bundleId":"com.her.desktop","arch":"arm64","electron":"44.7.0","permission":"not-determined","permissionChanged":false}
```

- Cached Electron `electron-v44.7.0-darwin-arm64.zip` SHA256: `e04e411b58a0a14375dd21b0ab4a378fd38930a702e4e20e322fee4849404c0b`. The package script validates the exact checksum against installed Electron checksums.
- Official Electron 44.7.0 header archive SHA256: `bb2b300b13850a976343a506c05aad5716bda0c43511add122ecd1959383ddd0`.
- A4 source/packaged `.node` SHA256: `9049883f0f1c38168e93253f8875c375bc5dd4c1d87978958550afef9623742b`, Mach-O arm64, stable Node-API 8. A5 fresh artifact comparisons are in `logs/package-artifacts.log`.
- A4 final renderer fix for native inbox ACK is source-tested and included in A5's fresh package. A5 does not claim a real banner/native click has been accepted.

## Known limits

The native permission matrix remains an independent Step 9 gate. At unavailable/non-authorized permission the product stays with generic Tray status. No timeout or lack of response implies approval. Actual OS authorized/denied/revoked states, banner display and native click remain unverified.

A4 observed an early-close baseline issue: a probe quitting before renderer-ready hung in `-[NSAlert runModal]`. Its owned PID 42537 stack sample showed a modal alert, not a blocked native callback. An early `loadURL` abort reaching the unchanged startup catch is an inference; precise JS stack was unavailable. That probe was cleaned up, and the renderer-ready probe plus packaged lifecycle tests exited normally. A5 preserves this unrelated startup code and does not claim to fix early-start/quit handling.

Live provider behavior, actual business effects, optional installed MarkItDown runtime, login-item OS behavior and real notification delivery are outside this local acceptance. No Git staging, commits, pushes, stashes, resets or subagents were used by A5. The pre-existing dirty tree and A1–A4 implementation were preserved except for the two proven IPC publication omissions and necessary e2e consumer migrations.
