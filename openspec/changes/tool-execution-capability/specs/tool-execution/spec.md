# Spec Delta

## Purpose

Defines the lifecycle of tool execution in Her — from receiving a tool call event from the LLM stream, executing the tool in the main process, returning the result back to the model, and continuing the conversation. Covers tool discovery, execution, result reporting, error handling, and the regeneration flow after tool completion.

## ADDED Requirements

### Requirement: Tool execution lifecycle

The system SHALL execute tool calls received during streaming responses by running the tool in the main process, then returning the result to the model for continued generation.

#### Scenario: Single tool call succeeds
- **WHEN** the LLM stream returns a `tool` event with a valid tool name and arguments
- **THEN** the system executes the tool with the provided arguments
- **AND** the tool result is sent back to the model as part of the conversation
- **AND** the model generates a continuation response containing the tool result

#### Scenario: Multiple tool calls in sequence
- **WHEN** the LLM returns multiple `tool` events sequentially
- **THEN** each tool is executed in order
- **AND** each result is appended to the conversation before the next tool call
- **AND** the final result includes all tool outputs

#### Scenario: Tool execution fails
- **WHEN** a tool call encounters an execution error
- **THEN** the error message is returned to the model as the tool result
- **AND** the model generates a response explaining the failure
- **AND** the conversation continues without aborting

### Requirement: Tool result visibility

The system SHALL record tool call arguments and results on the assistant message as a structured `toolCalls` field, separate from the answer text in `content`, so users can see what was executed and what was returned without the trace being mixed into the answer.

#### Scenario: Tool call visible in conversation
- **WHEN** a tool call is executed and the model generates a response
- **THEN** the assistant message carries the tool name, arguments and result in `toolCalls`
- **AND** the answer text in `content` contains only the model's reply
- **AND** the UI renders the tool calls in a block separate from the answer

### Requirement: Built-in tool registry

The system SHALL provide a registry of built-in tools with stable names, JSON schema parameter definitions, and execution handlers. The initial set covers file reading, file writing, time query, HTTP request, and weather query.

#### Scenario: Tool list available for injection
- **WHEN** a chat request is sent to a provider that supports function calling
- **THEN** the system injects the tools from the registry into the API request
- **AND** the tools are available for the LLM to call during generation

#### Scenario: File reading tool
- **WHEN** the model calls a file reading tool with a file path
- **THEN** the system reads the file from disk
- **AND** returns the file content to the model

#### Scenario: File writing tool
- **WHEN** the model calls a file writing tool with a path and content
- **THEN** the system writes the content to the specified path
- **AND** returns a confirmation message to the model

#### Scenario: Time query tool
- **WHEN** the model calls a time query tool
- **THEN** the system returns the current date and time
- **AND** the model can use this information in its response

#### Scenario: HTTP request tool
- **WHEN** the model calls an HTTP request tool with a URL and method
- **THEN** the system executes the HTTP request
- **AND** returns the response status and body to the model

#### Scenario: Weather query tool
- **WHEN** the model calls a weather query tool with a city name
- **THEN** the system fetches current weather data
- **AND** returns the weather summary to the model

### Requirement: Tool execution isolation

The system SHALL execute all tool calls in the Electron main process, never in the renderer process. Tool execution must not expose raw filesystem access, network calls, or system commands to the renderer.

#### Scenario: Tool runs in main process
- **WHEN** any tool call is executed
- **THEN** the execution happens in the Electron main process
- **AND** the renderer only receives the tool result for display

### Requirement: Cancellation during tool execution

The system SHALL allow users to cancel a tool call while it is executing, and the cancellation shall propagate back to the model generation loop.

#### Scenario: User cancels during tool execution
- **WHEN** a user clicks the stop button while a tool is executing
- **THEN** the tool execution is cancelled
- **AND** the generation loop is aborted
- **AND** the partial tool result (if any) is not sent to the model

### Requirement: Tool availability gating

The system SHALL gate tool availability based on the provider's protocol support. Tools are only injected into requests when the provider supports function calling, and are never sent to providers that do not.

#### Scenario: Provider without function calling
- **WHEN** a chat request is sent to a provider that does not support function calling
- **THEN** no tools are included in the request
- **AND** the model generates a text-only response
