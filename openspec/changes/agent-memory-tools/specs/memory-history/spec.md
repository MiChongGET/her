# memory-history Specification

## Purpose

Defines on-demand retrieval of original conversation evidence for Her's three-layer memory system. Chinese and mixed-language searches retain readable originals, expose source and validity, and consistently exclude forgotten or unavailable material without treating lexical matches as established facts.

## ADDED Requirements

### Requirement: Historical search returns bounded original evidence
The system SHALL provide on-demand search of eligible original user and assistant messages across conversations and model services. Results SHALL contain readable original excerpts, source identity, time, role, completion status and applicable validity markers. Results SHALL be bounded and traceable to source chat. Search SHALL retrieve candidates rather than declare a remembered fact or guarantee an answer.

#### Scenario: Search an earlier conversation
- **WHEN** the user or a permitted model tool searches for a topic discussed in another eligible conversation
- **THEN** relevant matching messages can be returned with their source identities and readable original excerpts

#### Scenario: No suitable evidence is found
- **WHEN** no eligible message matches sufficiently
- **THEN** search returns no evidence rather than inventing a fact or manufacturing a match

#### Scenario: Assistant message matches
- **WHEN** an assistant statement appears in historical results
- **THEN** its role remains visible and the match alone does not establish a user fact or successful experience

#### Scenario: Incomplete output matches
- **WHEN** an eligible failed or cancelled assistant output appears in search
- **THEN** it is marked as an incomplete fragment and is not treated as a verified successful outcome

#### Scenario: Open a source from search
- **WHEN** the user follows a historical result to its source
- **THEN** the corresponding conversation and message can be located if the source still exists

### Requirement: Chinese search uses consistent segmentation and full-text matching
The system SHALL use Intl.Segmenter preprocessing with SQLite FTS5 for core memory, historical messages and experience cards. Indexed text and queries SHALL use the same normalization and segmentation rules while originals remain unchanged. Query punctuation SHALL NOT inject search syntax. Search SHALL NOT promise arbitrary substring, synonym or semantic matching that the lexical index does not provide.

#### Scenario: Search Chinese words in continuous text
- **WHEN** a Chinese query contains terms produced by the same segmentation rules as an indexed message
- **THEN** the matching terms can retrieve that message without requiring spaces in the original text

#### Scenario: Search Chinese and a technical identifier
- **WHEN** a query mixes Chinese words with a supported English term or technical identifier
- **THEN** indexing and query processing apply the same rules and preserve the original source text for display

#### Scenario: Query contains operators or punctuation
- **WHEN** a query contains quotes, operator-like words or punctuation
- **THEN** it is treated as a safely constructed user query rather than executable search syntax or a malformed request

#### Scenario: Runtime segmentation behavior changes
- **WHEN** an application update changes the active normalization or segmentation version
- **THEN** indexes are rebuilt from retained originals before being used with the changed query rules

### Requirement: Source exclusions apply at every historical read
The system SHALL exclude trashed, permanently deleted and explicitly forgotten source messages and their known derived content from machine search, context and consolidation. Superseded but otherwise eligible statements MAY remain searchable as clearly outdated history. Eligibility SHALL be checked again when results are used, so stale results cannot bypass later lifecycle changes.

#### Scenario: Source is trashed after retrieval
- **WHEN** a retrieved source enters the trash before its excerpt is supplied to a model
- **THEN** the excerpt is excluded from that request

#### Scenario: Forgotten content is present in current conversation
- **WHEN** an identified forgotten source or its known derived content is in the current conversation window
- **THEN** it is excluded from the model request even though the user can still manually read original chat

#### Scenario: Search a corrected preference
- **WHEN** a historical message states a fact replaced by a later confirmed correction
- **THEN** it may be returned as outdated evidence with the correction relationship visible, never as the current fact

#### Scenario: Empty the trash
- **WHEN** the user permanently deletes all trashed conversations
- **THEN** their original messages are no longer retrievable and stale result references cannot recover them

### Requirement: Historical availability is independent from consolidation eligibility
The system SHALL make eligible existing history searchable without automatically consolidating it. Default consolidation SHALL consider only eligible messages first created after the activation boundary. Retry, restoration or index initialization SHALL NOT newly enroll earlier messages. Earlier messages SHALL require a user-selected historical range, preserving all evidence and exclusion rules.

#### Scenario: Search history that predates activation
- **WHEN** the user searches an eligible conversation created before memory consolidation was configured
- **THEN** historical matching remains available without implicitly scheduling that conversation for consolidation

#### Scenario: Older history changes after activation
- **WHEN** a message first created before activation is retried, restored or indexed afterward
- **THEN** it remains outside default consolidation unless the user explicitly selects it within a historical range

#### Scenario: Select a historical backfill range
- **WHEN** the user explicitly selects a historical time or conversation range for consolidation
- **THEN** only eligible messages within that selected range become candidates for that backfill request

#### Scenario: Historical range includes forgotten material
- **WHEN** a selected range includes a forgotten or otherwise excluded source
- **THEN** that source remains excluded and selecting the range does not authorize relearning it
