# Tasks

## 1. Tool Registry & Types

- [x] 1.1 Create `src/core/tools/types.ts` with `ToolDefinition`, `ToolExecutor`, and `ToolRegistry` interfaces — verify TypeScript compiles with `npm run typecheck`
- [x] 1.2 Create `src/core/tools/registry.ts` with the `ToolRegistry` class and a built-in tool registry — verify unit tests pass for registry listing and lookup
- [x] 1.3 Add `ModelTool` extension in `src/shared/types.ts` to support tool result messages (`role: 'tool'`) — verify existing type checks pass

## 2. Built-in Tool Implementations (MVP: get_current_time only, defer others)

- [ ] 2.1 Implement `read_file` tool: reads a file from disk, caps at 5MB, blocks paths outside userData directory — verify unit test covers successful read and path restriction
- [ ] 2.2 Implement `write_file` tool: writes content to disk, caps at 10MB, blocks paths outside userData directory — verify unit test covers successful write and path restriction
- [x] 2.3 Implement `get_current_time` tool: returns current date/time in specified timezone — verify unit test returns correct format
- [ ] 2.4 Implement `http_request` tool: sends HTTP request, only allows HTTPS, 10s timeout, 1MB response cap — verify unit test covers success and rejection of non-HTTPS
- [ ] 2.5 Implement `get_weather` tool: fetches weather from public API (wttr.in), caches 15 minutes — verify unit test covers success and API failure gracefully
- [x] 2.6 Register `get_current_time` in the registry with JSON Schema parameter definitions — verify `getDefinitions()` returns 1 tool with valid schemas

## 3. Tool Result Message Formatting

- [x] 3.1 Create `src/core/tools/result-format.ts` with `buildToolResultMessages()` building internal OpenAI-style tool messages; `src/core/providers/stream.ts` converts them to the anthropic / openai-responses wire shapes — verified by the per-protocol test in `tests/providers.test.ts`
- [x] 3.2 Create `src/core/tools/result-format.ts` with `buildToolCallMessages()` function that appends tool call info to assistant message content — verify unit test verifies content appending

## 4. Tool Execution Loop in ChatService

- [x] 4.1 Modify `ChatService.generate()` in `src/core/conversation/chat.ts` to replace the `throw ProviderError('tools_unavailable')` branch with tool execution — verify integration test: tool call triggers execution, result is sent back, model generates continuation
- [x] 4.2 Implement the tool loop: collect tool events from stream, execute sequentially, build result messages, append to message history, re-fetch from model — verify integration test: multiple sequential tool calls work
- [x] 4.3 Add tool result visibility in conversation: tool call arguments and results are stored in `ChatMessage.toolCalls` (persisted in the `tool_calls` column, not mixed into `content`) and rendered in a collapsed block above the answer — verified by tests in `chat.test.ts`, `storage.test.ts` and `renderer.test.tsx`
- [x] 4.4 Add cancellation support: `AbortSignal` propagates to tool executors, tool execution is interrupted on stop — verify integration test: cancel during tool execution aborts cleanly
- [x] 4.5 Add error handling: tool execution failures return error message to model, conversation continues without aborting — verify integration test: tool error is returned as string, model responds gracefully

## 5. Tool Injection & Settings (MVP: deferred, tools always enabled)

- [ ] 5.1 Add `supportsTools` field to `DesktopSettings` in `src/shared/types.ts` and wire it through the store — verify typecheck passes
- [ ] 5.2 Add tool availability gate in `ChatService.send()`: only inject tools when settings.supportsTools is true — verify integration test: tools not injected when disabled
- [ ] 5.3 Add "Enable tool execution" toggle to `SettingsPanel.tsx` — verify UI renders toggle and save persists to store
- [ ] 5.4 Modify `streamChat` request body building in `src/core/providers/stream.ts` to include tools from registry when enabled — verify integration test: tools appear in API request body when enabled

## 6. Integration Tests & Verification

- [x] 6.1 Write integration test: single tool call (get_current_time) → execute → result → model continuation — verify test passes end-to-end with mock provider
- [x] 6.2 Write integration test: multiple tool calls in one round → all execute in order → combined result → model continuation (`http_request` is not implemented, so the test uses `get_current_time` twice) — verify test passes
- [x] 6.3 Write integration test: tool error (unknown tool, since `read_file` is not implemented yet) → error returned → model responds with error message — verify test passes
- [x] 6.4 Write integration test: cancel during tool execution → loop aborts → partial result not sent — verify test passes
- [ ] 6.5 Write integration test: tools disabled in settings → no tools in API request (blocked on 5.1-5.2; no such test exists yet) — verify test passes
- [x] 6.6 Run full test suite `npm test` and verify all tests pass
- [x] 6.7 Run typecheck `npm run typecheck` and verify no errors
- [x] 6.8 Run build `npm run build` and verify app compiles

## Workflow follow-up

- Archive the change after the project's review requirements are satisfied.
- Verify the archived result.
