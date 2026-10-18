# memory-experience Specification

## Purpose

Defines evidence-backed reusable experience as reviewable workflow cards. Her can propose cards from demonstrated or user-approved outcomes, retrieve approved versions for relevant tasks, and explain their use while preserving current user authority, source lifecycle rules and existing tool permissions.

## ADDED Requirements

### Requirement: Experience is a reviewable workflow card
The system SHALL represent reusable experience as a workflow card with its intended situation, actionable steps, relevant limits, version and supporting sources. First-phase cards SHALL be retrievable content rather than automatically installed or executed skills. A card SHALL NOT grant additional file, command, network or tool permissions.

#### Scenario: Consolidation identifies a repeatable procedure
- **WHEN** eligible evidence supports a reusable procedure
- **THEN** the system may propose a card describing when it applies, what to do and its known limits

#### Scenario: Card contains an operation requiring permission
- **WHEN** a retrieved card describes an operation beyond the current task's permitted capabilities
- **THEN** reading or approving the card does not authorize or execute that operation

### Requirement: Experience requires demonstrated or user-approved outcomes
The system SHALL require explicit user recognition of a useful procedure or verifiable successful execution evidence before proposing it as experience. Assistant statements that an operation succeeded SHALL NOT suffice. Required steps and outcomes SHALL retain complete evidence groups, and a result unrelated to a claimed outcome SHALL NOT prove that outcome.

#### Scenario: User approves a useful procedure
- **WHEN** the user explicitly confirms that a documented procedure worked or should be reused
- **THEN** the procedure may become an experience candidate with that statement retained as evidence

#### Scenario: Execution demonstrates success
- **WHEN** retained execution results verifiably establish the procedure's claimed successful outcome
- **THEN** those results may support an experience candidate even without an assistant's success claim

#### Scenario: Only the assistant claims success
- **WHEN** the assistant says the task succeeded but there is neither user recognition nor verifiable supporting execution evidence
- **THEN** the procedure does not become an eligible experience candidate on that claim alone

#### Scenario: Failed or cancelled attempt
- **WHEN** an operation fails or is cancelled before its claimed successful outcome is established
- **THEN** the attempt is not treated as successful experience merely because its conversation turn has ended

### Requirement: New cards and material changes require user review
The system SHALL require user approval before a new experience card or material change becomes active. Pending content SHALL be visible for review but excluded from automatic use. Rejecting a proposal SHALL preserve the current approved version. Approval SHALL revalidate sources and the target version; changed or invalidated proposals SHALL NOT silently replace newer approved content.

#### Scenario: New card awaits review
- **WHEN** consolidation creates a new experience proposal
- **THEN** the card is shown as pending and is not automatically supplied to future tasks

#### Scenario: Existing card receives new steps
- **WHEN** a proposed revision materially changes an approved workflow's steps, applicability or limits
- **THEN** the revision awaits review while the existing eligible approved version remains current

#### Scenario: Reject a revision
- **WHEN** the user rejects a proposed card revision
- **THEN** the previously approved version remains unchanged

#### Scenario: Source or target changes before approval
- **WHEN** a proposal's source becomes ineligible or its target has been revised before approval
- **THEN** approval does not activate stale content and the panel explains why the proposal must be refreshed or resolved

### Requirement: Approved relevant experience can be used automatically
The system SHALL allow approved, enabled and source-eligible cards to be retrieved for relevant tasks within the context budget. The interface SHALL identify only cards whose full approved content was supplied for the task as used. Current user instructions SHALL take precedence. Retrieval SHALL NOT activate pending, disabled or unsupported cards and SHALL NOT cause execution without the normal task and tool controls.

#### Scenario: Relevant approved card exists
- **WHEN** a current task matches an eligible approved card
- **THEN** Her may automatically reference its workflow and the interface shows that the card was supplied for the task

#### Scenario: Current instruction differs from a workflow
- **WHEN** the user explicitly requests a different approach from an approved card
- **THEN** the current instruction takes precedence and the card does not override it

#### Scenario: Card appears in search but is not supplied
- **WHEN** a card is only a retrieval candidate and is not selected for the model context
- **THEN** the interface does not present it as having been used

#### Scenario: Full card does not fit the context budget
- **WHEN** only a candidate excerpt fits and the full approved card is not supplied
- **THEN** the interface does not claim the card was used or its complete procedure was available to the model

### Requirement: Users can disable cards without forgetting their sources
The system SHALL let the user inspect sources and versions, approve or reject proposals, and disable an approved card in the unified memory panel. Disabled cards SHALL be excluded from automatic retrieval and context until explicitly re-enabled. Disabling SHALL NOT erase source history or override existing forgetting and source-eligibility rules.

#### Scenario: Disable a workflow card
- **WHEN** the user disables an approved card
- **THEN** it stops being supplied automatically while its content and source history remain inspectable in the panel

#### Scenario: Re-enable a card with invalid evidence
- **WHEN** the user attempts to re-enable a card whose sources no longer satisfy the evidence rules
- **THEN** it does not become eligible solely because its enabled setting changed

### Requirement: Experience follows source lifecycle and explicit forgetting
The system SHALL suspend cards lacking a complete eligible evidence group after sources enter trash, and MAY restore them when valid support returns. Permanent source deletion SHALL remove unsupported derived cards. Explicit forgetting of a known supporting source SHALL exclude the whole affected card even if another evidence group remains; restoring a conversation SHALL NOT undo that exclusion.

#### Scenario: Trash the only successful evidence
- **WHEN** the only complete source group for a card is moved to trash
- **THEN** the card stops being used while the source is unavailable

#### Scenario: Another independently demonstrated outcome remains
- **WHEN** one source group is trashed and another complete eligible group independently supports the same approved card
- **THEN** the card may remain usable unless a forgetting rule applies

#### Scenario: Explicitly forget part of a card's basis
- **WHEN** the user forgets information known to support part of a card
- **THEN** the whole affected card is excluded from model use and relearning rather than partially redacted and retained

#### Scenario: Restore or purge supporting chat
- **WHEN** source chat is restored or permanently deleted
- **THEN** source eligibility is recalculated, unsupported cards are handled accordingly, and explicit forgetting remains in force
