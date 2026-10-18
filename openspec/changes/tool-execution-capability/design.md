# Design

## Context

Her's `streamChat()` generator in `src/core/providers/stream.ts` already parses tool calls from all three supported protocols (OpenAI, Anthropic, Responses). The `ChatService.generate()` method in `src/core/conversation/chat.ts` currently throws when a `tool` event arrives. The infrastructure for parsing is complete; only the execution and loop-back layer is missing.

The current request model is single-shot: one HTTP fetch, one SSE stream, one response. Tool execution requires a multi-round loop — fetch, execute tools, fetch again with results, repeat until the model produces a text response.

## Goals / Non-Goals

**Goals:**

- Run tool execution in the Electron main process, keeping renderer isolated
- Support sequential tool calls (model may call multiple tools before responding)
- Support iterative tool loops (model may call a tool, get result, call another tool)
- Make tool results visible in conversation history
- Cancel tool execution when user stops generation

**Non-Goals:**

- No MCP server integration (future work)
- No parallel tool execution (all tools run sequentially)
- No custom user-defined tools (built-in registry only for this change)
- No streaming tool result display in real-time (tool results appear in the final message)
- No sandboxing beyond what Node.js already provides

## Decisions

### 1. Tool execution loop lives in `ChatService`, not in `streamChat`

`streamChat` is a protocol-level concern — it knows how to parse SSE and emit events. The tool loop is a conversation-level concern — it knows about messages, tool results, and model continuation. Mixing them would couple protocol parsing to conversation state.

The `generate()` method becomes a loop:

```
while (not done):
  result = streamChat(current_messages)
  for event in result:
    if event.type == "tool": collect tool call
    if event.type == "text": accumulate text
    if event.type == "done": break
  if collected tools:
    execute each tool in order
    build tool result messages
    append to message history
    continue loop
  else:
    done = true
```

### 2. Tool results are protocol-specific message formats

Each protocol expects tool results in a different shape:

- OpenAI: `{ role: "tool", tool_call_id, content }`
- Anthropic: `{ role: "user", content: [{ type: "tool_result", tool_use_id, content }] }`
- Responses: `{ role: "tool", tool_call_id, content }` (similar to OpenAI)

The tool execution layer builds protocol-appropriate result messages. A `buildToolResultMessages(toolEvents, protocol)` function converts collected tool events into the correct message format for the next API request.

### 3. ToolRegistry is a simple interface, not a framework

```ts
interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>  // JSON Schema
}

interface ToolExecutor {
  (args: Record<string, unknown>, signal: AbortSignal): Promise<string>
}

interface ToolRegistry {
  getDefinitions(): ModelTool[]
  execute(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string>
}
```

No plugin system, no hot-reloading. A simple map of name → { definition, executor }. The first five tools are hardcoded.

### 4. Tool result text is returned to the model as a plain string

Tool execution results are always stringified before being sent back to the model. If a tool returns structured data, the executor serializes it. The model sees tool results as text — this matches how OpenAI and Anthropic both handle tool result content.

### 5. Cancellation works at the AbortSignal level

The existing `AbortController` in `ChatService` already supports cancellation. Tool executors receive the same signal. When the user clicks stop, the signal aborts, the tool executor returns early, and the generation loop terminates cleanly.

### 6. Tool availability is controlled by provider protocol

Tools are only injected when `input.provider.protocol` supports function calling. All three current protocols (`openai`, `anthropic`, `openai-responses`) support tools. If a new protocol is added that doesn't support tools, the tool list is simply omitted from the request.

### 7. Built-in tools for the first iteration

| Tool | Name | Parameters | Safety |
|------|------|------------|--------|
| File read | `read_file` | `path` (string) | Blocks outside userData dir; 5MB max |
| File write | `write_file` | `path` (string), `content` (string) | Blocks outside userData dir; 10MB max |
| Time query | `get_current_time` | `timezone` (string, optional) | Stateless, safe |
| HTTP request | `http_request` | `url` (string), `method` (string), `headers` (object, optional) | Only HTTPS; 10s timeout; 1MB response max |
| Weather query | `get_weather` | `city` (string), `unit` (string, optional) | Calls public weather API; caches 15 min |

File tools are restricted to `app.getPath('userData')` directory to prevent arbitrary file access.

## Risks / Trade-offs

**[Tool execution can hang]** → Each tool executor must respect the AbortSignal and implement its own timeout. HTTP requests have a 10-second timeout. File operations are synchronous and fast.

**[Tool result too large]** → File read caps at 5MB. HTTP response caps at 1MB. Oversized results are truncated with a note. This prevents context window exhaustion.

**[Protocol-specific message formats are fragile]** → If a new protocol is added, the `buildToolResultMessages` function needs a new branch. The function is small and isolated, making it easy to update. Test coverage ensures correctness for all three current protocols.

**[Tool execution in main process = no sandbox]** → Node.js process-level isolation only. No OS-level sandboxing. The file path restriction and network restrictions (HTTPS only) are the primary mitigation. Users configure their own LLM providers, so they already trust the API endpoints.

**[Weather API dependency]** → Uses a free public API (wttr.in) with no key required. If the API changes or becomes unavailable, the weather tool returns an error message to the model, which then communicates this to the user. The failure is graceful.

**[No tool approval flow]** → Tools execute without user confirmation. This matches Hermes' design but increases risk. Future work could add an approval mechanism (like Hermes' `allow_once` / `allow_always` pattern) before enabling write tools by default.

## Migration Plan

1. Deploy with tools disabled by default (current behavior unchanged)
2. Add a settings toggle "Enable tool execution" 
3. When enabled, tools are injected into API requests
4. No data migration needed — tool results are stored as message content
5. Rollback: disable the toggle, old behavior returns immediately

## Open Questions

- Should tool results appear as separate message bubbles in the UI, or inline in the assistant's response? (Proposal: inline — the model's response already references the tool result, so a separate bubble would be redundant.)
- Should there be a per-conversation tool toggle, or a global one? (Proposal: global, managed in settings. The system prompt can mention tool availability.)
- Should tool execution be limited to specific model capabilities? (Proposal: all models that support function calling can use tools. The `ServiceModel.multimodal` flag doesn't indicate tool support — adding a `supportsTools` flag would require a data migration.)
