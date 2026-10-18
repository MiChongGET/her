# agent-memory Specification

## Purpose

Defines Her's local, single-user core memory across conversations and model services. Covers evidence-backed facts, controlled context selection, user correction and forgetting, source lifecycle changes, and the unified memory management interface.

## ADDED Requirements

### Requirement: Core memory is local and globally shared
The system SHALL persist short core memories locally and share them across the user's conversations and model services. Each entry SHALL record its content, kind, lifecycle state, timestamps and supporting sources. Project names SHALL be searchable content rather than separate memory spaces.

#### Scenario: Switch conversation or model service
- **WHEN** the user starts another conversation or selects another model service
- **THEN** the same eligible core memories are available under the same retrieval and context rules

#### Scenario: Record a project fact
- **WHEN** an eligible fact concerns a named project
- **THEN** the project name is retained as context without creating a separate memory space

#### Scenario: Invalid memory submission
- **WHEN** a submission has missing sources, an unsupported kind or content outside the accepted bounds
- **THEN** the submission fails without creating a partial entry

### Requirement: Core memories require explicit user evidence
The system SHALL automatically accept an unambiguous fact, preference or agreement explicitly stated by the user when it does not conflict with current memory. Exact duplicates SHALL reuse the existing entry. Inferences and conflicting candidates SHALL await user confirmation and SHALL NOT become active automatically. Assistant claims, quoted external content and retrieval matches alone SHALL NOT establish user facts.

#### Scenario: Clear user preference
- **WHEN** the user clearly states a stable preference and no current entry conflicts with it
- **THEN** the system may create an active memory linked to that user statement without another confirmation

#### Scenario: Exact duplicate with another source
- **WHEN** the same fact is explicitly stated again with content identical to an eligible active entry
- **THEN** the existing entry is reused without creating a duplicate
- **AND** the additional supporting source can be retained independently

#### Scenario: Inferred or conflicting candidate
- **WHEN** a candidate is inferred or conflicts with an existing current fact without an explicit user correction
- **THEN** it is shown as awaiting confirmation and does not replace or join active memory

#### Scenario: Unsupported assistant assertion
- **WHEN** only an assistant message or a quoted document says that the user has a preference
- **THEN** that assertion is not automatically accepted as a user fact

#### Scenario: Plans remain plans
- **WHEN** the user describes a future plan
- **THEN** any saved entry preserves that it is planned rather than completed and preserves an unambiguous time when known

### Requirement: Supporting evidence preserves complete source groups
The system SHALL retain source identity and version for message, tool-result and explicit user-action evidence. A source group supports an item only while all required members are eligible; separate complete groups provide alternative support. Correction lineage and a derived restatement SHALL NOT count as independent evidence for a new fact. Writes SHALL recheck source eligibility and target state before taking effect.

#### Scenario: One of several required sources disappears
- **WHEN** an item needs two messages together and one becomes ineligible
- **THEN** that evidence group no longer supports the item

#### Scenario: Independent complete support remains
- **WHEN** one evidence group becomes ineligible but another complete independent group still supports the same item
- **THEN** the item may remain eligible unless an explicit forgetting rule applies

#### Scenario: Correction history is not new evidence
- **WHEN** a new fact replaces an old fact
- **THEN** the new fact is supported by the correcting user statement rather than only by the old fact's lineage

#### Scenario: Source changes before a write
- **WHEN** a proposed write refers to a source version that has changed or become ineligible
- **THEN** the write does not activate memory using that stale evidence

### Requirement: Explicit user corrections take effect immediately
The system SHALL apply an unambiguous user correction to the identified memory without a second approval. It SHALL retain the earlier version as superseded, link the correction history, and make only the corrected version current. Original messages SHALL remain available as historical evidence with outdated information identified as such. An ambiguous correction SHALL be resolved before changing memory.

#### Scenario: Correct a current preference
- **WHEN** the user explicitly replaces an identified current preference
- **THEN** the new preference becomes current and the earlier version stops being injected or returned as a current fact

#### Scenario: Retrieve old evidence after correction
- **WHEN** historical search returns an eligible message containing the replaced fact
- **THEN** the result identifies it as outdated and points to the current correction when available

#### Scenario: Concurrent stale correction
- **WHEN** a correction targets a version that another action has already replaced
- **THEN** it does not overwrite the newer fact and reports that the target has changed

### Requirement: Explicit forgetting removes known memory and blocks reuse
The system SHALL immediately forget an identified item and its entire correction chain on explicit user request. It SHALL exclude known source messages and known derived content from model context, retrieval and relearning, and forget whole affected experience cards. Raw source chat MAY remain manually viewable. This guarantee covers recorded lineage, not unidentified semantic restatements.

#### Scenario: Forget a corrected memory
- **WHEN** the user explicitly forgets a memory with earlier corrected versions
- **THEN** the whole correction chain is removed from usable memory
- **AND** known supporting source messages and their known derived content cannot be supplied to a model or used to recreate it

#### Scenario: Source message contains several facts
- **WHEN** an identified source message supports a forgotten fact alongside other content
- **THEN** the whole source message is excluded from machine retrieval and context rather than only a matching substring

#### Scenario: Existing context contains a known restatement
- **WHEN** a current conversation, cached retrieval result or known derived reply contains the forgotten information
- **THEN** that known derived content is excluded from subsequent model requests

#### Scenario: Affected experience has another source
- **WHEN** an experience card is known to derive from explicitly forgotten information even if it also has another source
- **THEN** the entire card is excluded rather than retained through its other sources

#### Scenario: User manually opens source chat
- **WHEN** the user opens an original chat containing a forgotten source message
- **THEN** the original message can still be read by the user without making it eligible for model use

#### Scenario: Ambiguous forgetting request
- **WHEN** the request cannot unambiguously identify what to forget
- **THEN** the system asks the user to resolve the target before deleting or blocking unrelated items

#### Scenario: User explicitly remembers again
- **WHEN** the user explicitly asks Her to remember the fact again with a fresh supporting statement
- **THEN** a new memory may be created from that authorization
- **AND** old source exclusions are not automatically lifted

### Requirement: Conversation lifecycle changes propagate to memory
The system SHALL exclude trashed conversations and suspend derived items lacking another complete eligible evidence group. Restoring sources MAY restore supported items but SHALL NOT override forgetting. Permanently deleting sources SHALL remove derived items that no longer have a complete supporting group. These rules SHALL apply to individual and bulk operations and to pending candidates as well as active items.

#### Scenario: Trash the only supporting conversation
- **WHEN** a conversation containing the only complete support for a memory is moved to trash
- **THEN** its messages and the unsupported memory stop being retrieved, injected or used for consolidation

#### Scenario: Trash one of two independent sources
- **WHEN** another complete eligible evidence group supports the same memory
- **THEN** the memory remains eligible while the trashed messages remain excluded

#### Scenario: Restore a conversation
- **WHEN** a trashed conversation is restored
- **THEN** items with restored complete evidence may become eligible again
- **AND** previously forgotten sources and items remain excluded

#### Scenario: Permanently delete sources in bulk
- **WHEN** multiple conversations are permanently deleted
- **THEN** pending and active derived items with no remaining complete support are removed from usable memory
- **AND** no retained search result or cached context restores the deleted evidence

### Requirement: Memory context is bounded and respects current instructions
The system SHALL prioritize eligible stable personal preferences, personal facts and long-term agreements within a bounded core context. Project facts, events and experience cards SHALL be selected by relevance. Each request SHALL recheck eligibility. Memory SHALL be labelled as data, remain subordinate to current user instructions, and be appended without replacing a saved custom system prompt.

#### Scenario: More core memories than the context budget permits
- **WHEN** all eligible stable personal memories cannot fit
- **THEN** a prioritized subset fits within the budget and other eligible items remain searchable

#### Scenario: Unrelated project information
- **WHEN** a request is unrelated to a stored project fact or event
- **THEN** that item is not included solely because it was recently created

#### Scenario: Custom system prompt is configured
- **WHEN** the user has saved a custom system prompt
- **THEN** it is preserved and the memory rules and selected memory data are appended

#### Scenario: Memory changes between tool rounds
- **WHEN** a memory is corrected, forgotten or loses eligible support before another model request
- **THEN** the next request uses the updated eligibility and current fact state

#### Scenario: No eligible memories exist
- **WHEN** there are no eligible memories for a request
- **THEN** no empty or misleading memory-data block is added

### Requirement: Memory operations use the existing controlled tool lifecycle
The system SHALL expose memory operations through the existing tool lifecycle with conversation, user-message and tool-call identity. It SHALL preserve whole-response validation and cancellation behavior. Only failures after a valid tool batch enters memory business execution SHALL become tool error results. Calls SHALL obey memory rules, repeated attempts SHALL NOT duplicate committed effects, and answer regeneration alone SHALL NOT undo valid user-backed memory.

#### Scenario: Memory tool fails
- **WHEN** a protocol-valid and fully validated tool batch enters memory business execution and an operation fails
- **THEN** it returns an error result through the existing tool loop without corrupting memory or unconditionally ending the conversation

#### Scenario: Tool batch has invalid protocol content
- **WHEN** a response contains malformed tool-argument JSON or an unknown tool name
- **THEN** existing whole-response validation rejects the batch before executing any of its tools
- **AND** the invalid protocol is not converted into a recoverable memory business error

#### Scenario: Foreground turn is cancelled
- **WHEN** the user cancels a turn containing memory tool work
- **THEN** the existing cancellation behavior remains in force instead of turning cancellation into an error result that continues model or tool execution

#### Scenario: Answer is regenerated
- **WHEN** a user regenerates an answer after a valid user-backed memory operation was committed
- **THEN** the committed memory is not automatically rolled back and an equivalent repeated write does not create a duplicate

#### Scenario: Model attempts an unsupported correction
- **WHEN** the model proposes changing an established fact without an explicit user correction
- **THEN** the proposal follows the pending-confirmation rule instead of receiving authority from the tool call itself

### Requirement: Unified memory panel supports inspection and control
The system SHALL provide a unified memory panel for core content and sources, correction and forgetting, pending confirmations, experience review and disabling, and consolidation progress and results. Lifecycle and loading failures SHALL be distinguishable from an empty list. The panel SHALL provide accessible keyboard interaction. Model selection and batch budgets SHALL be configured in settings.

#### Scenario: Inspect and correct a memory
- **WHEN** the user opens an entry in the memory panel
- **THEN** its content, state and source evidence are visible and the user can explicitly correct or forget it

#### Scenario: Review a pending fact
- **WHEN** the user approves or rejects an inferred or conflicting candidate
- **THEN** approval establishes the user's confirmation as evidence before activation, while rejection leaves current memory unchanged

#### Scenario: List cannot be loaded
- **WHEN** loading the memory panel fails
- **THEN** an actionable error is shown instead of presenting the failure as an empty memory collection

#### Scenario: Operate the panel with a keyboard
- **WHEN** the user opens and navigates the memory panel using the keyboard
- **THEN** focus remains usable within the panel and closing it returns focus to its entry point
