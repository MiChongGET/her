# Her Independent Peekaboo Skill Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for this small change. Implementation is authorized in this chat. This is a non-Git workspace; scoped before-files and verification logs are retained.

**Goal:** Her automatically receives the original Peekaboo skill and uses the conversation to decide when to reference it. Skills and MCP services remain independent.

**Architecture:** Bundle the original Markdown with Vite `?raw` in a separate built-in skills module. Compose it with the system prompt in ChatService, regardless of MCP discovery or connection state. A short generic wrapper distinguishes skill reference material from actual available tools. The original file is not rewritten; MCP configuration, registration, schemas and execution remain unchanged.

**Tech Stack:** Existing TypeScript, Electron/Vite, Vitest.

**Spec:** The user's latest explicit correction: keep skills and MCP independent, and keep the linked original SKILL.md content. This supersedes the earlier MCP-adapted document and registration-coupled loading design.

## Global Constraints

- Keep the original file from https://raw.githubusercontent.com/zhaolinnan12/openclaw-cn/main/skills/peekaboo/SKILL.md byte-for-byte. Record source/hash outside the skill.
- Keep all existing MCP and tool-registry implementation unchanged, including approvals, target validation, unknown-result handling, cancellation and budgets.
- The model chooses how to reference the skill from conversation semantics. No keyword router, manual selection, new execution tool, service auto-install or permission expansion.
- Tool names, parameters and available actions come from actual tool definitions and Host validation. The CLI-oriented skill does not add a CLI executor.
- Bundle the Markdown into production output without a runtime source-file path or network dependency.

## Review Focus

- Skill availability remains independent of missing, custom, connected or disconnected MCP services.
- The wrapper must not rewrite or imply execution of the original CLI examples.
- Custom system prompts and subsequent/continued rounds retain the original skill.
- No skill metadata appears in provider function schemas.
- The production main bundle includes the skill without requiring its source file at runtime.

## Task 1: Independently bundle and load the original skill

**Files:**
- Create: `src/core/skills/peekaboo/SKILL.md`, `src/core/skills/builtin.ts`
- Modify: `src/core/conversation/chat.ts`
- Test: `tests/chat.test.ts`

**Interfaces:**
- `BUILTIN_SKILLS_PROMPT: string` contains the original Markdown and a separate generic reference/capability wrapper.
- `ChatService.buildSystemPrompt(toolNames)` preserves the configured prompt, then appends built-in skills independently of the tool list.

- [x] Revert the superseded MCP/registry coupling and its tests. Verify those files match their before-copies exactly.
- [x] Write failing model-input tests for independent skill delivery without MCP, through tool rounds, continuation and disconnect. Capture RED before implementation.
- [x] Preserve the downloaded original skill and add the minimal independent built-in module and prompt composition.
- [x] Run focused tests: 58 chat tests passed after 5 expected failures before implementation.
- [x] Run `npm run check`; typecheck, all 31 test files (664 passed, 1 existing skip), and production build passed.
- [x] Obtain independent code review; no material findings.
- [x] Inspect the production bundle; the decoded inlined skill exactly matches the original file, and no runtime Markdown import remains. Hash/equality evidence is in `verification.json`. Real-model/native execution and repackaging were not performed.
