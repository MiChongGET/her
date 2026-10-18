# memory-consolidation Specification

## Purpose

Defines bounded memory consolidation while Her is running, using an independently configured model and user-visible durable progress. Covers idle and manual scheduling, incremental and selected historical work, foreground priority, quotas, cancellation, recovery and evidence-valid publication without interrupting ordinary chat.

## ADDED Requirements

### Requirement: Consolidation uses an independently selected model
The system SHALL provide a separate consolidation model selection in settings, reusing saved service configuration and credentials without following the active chat model. Missing, removed, invalid or failing configuration SHALL preserve pending work and expose the reason. The system SHALL NOT silently switch providers, models or credentials as a fallback.

#### Scenario: User changes the chat model
- **WHEN** the current conversation switches to a different model service
- **THEN** consolidation continues to use its independently selected model configuration

#### Scenario: No consolidation model is configured
- **WHEN** automatic or manual consolidation has pending work but no usable model is selected
- **THEN** the work is retained and the interface explains that model configuration is required without sending a fallback request

#### Scenario: Selected service is removed or fails
- **WHEN** the selected service is deleted, credentials become invalid or a request fails
- **THEN** pending work is retained with an actionable reason and another service is not tried automatically

### Requirement: Automatic consolidation is opt-in and requires Her to be idle
The system SHALL keep automatic consolidation disabled by default. When enabled, it SHALL run only while Her is running, after five continuous minutes without interaction in Her and while no foreground generation or tool is running. Foreground activity SHALL take priority and pause background work. Disabling automatic consolidation SHALL prevent new automatic requests without resetting pending work or the incremental boundary.

#### Scenario: Default settings
- **WHEN** a user has not enabled automatic consolidation
- **THEN** no automatic consolidation request is sent even if a model is configured and messages are pending

#### Scenario: Idle threshold is reached
- **WHEN** automatic consolidation is enabled, eligible work exists and Her has remained inactive for five minutes with no foreground generation or tool
- **THEN** an automatic batch may start subject to available quota, budget and the single-worker rule

#### Scenario: User interacts before the threshold
- **WHEN** the user interacts with Her before five continuous idle minutes have elapsed
- **THEN** the idle interval restarts and automatic consolidation does not start based on the earlier interval

#### Scenario: Foreground generation starts
- **WHEN** a user starts foreground generation or a tool runs while consolidation is active
- **THEN** consolidation yields, an in-flight background request is cancelled when applicable, and unfinished work remains resumable

#### Scenario: User disables automatic consolidation
- **WHEN** the user turns automatic consolidation off
- **THEN** it stops starting automatic requests, retains unfinished work and does not reset its incremental boundary

#### Scenario: Toggle automatic mode during manual work
- **WHEN** the user changes only the automatic consolidation switch while a manual batch is running
- **THEN** the manual batch keeps its model configuration and continues without a configuration-change pause

### Requirement: Manual consolidation starts one bounded batch
The system SHALL let the user request one manual consolidation batch even when automatic consolidation is disabled. It SHALL not require the idle interval or consume automatic daily quota, but SHALL obey the same per-batch budgets, source rules and foreground priority. Only one consolidation batch SHALL execute at a time; manual work SHALL run before waiting automatic work when the worker becomes available.

#### Scenario: Manual request with automatic consolidation disabled
- **WHEN** the user chooses consolidate now and no foreground work or other consolidation batch is active
- **THEN** one manual batch starts without waiting five minutes

#### Scenario: Manual request during foreground work
- **WHEN** the user requests manual consolidation while chat generation or a tool is running
- **THEN** the panel shows the waiting state and starts the batch after foreground work and the active worker release allow it

#### Scenario: Several batches are queued
- **WHEN** a consolidation worker becomes available with manual and automatic batches waiting
- **THEN** a waiting manual batch takes precedence without running two batches concurrently

#### Scenario: User repeatedly starts the same manual work
- **WHEN** the user repeats the start action for an already queued or running manual batch
- **THEN** the interface reuses that batch instead of stacking duplicate work

### Requirement: Incremental work has a stable activation boundary
The system SHALL record the incremental boundary on the first successful save of consolidation model configuration. Default eligibility SHALL depend on a message's original creation identity being after that boundary, not its latest change. Retry, restoration, index initialization, model changes or restarts SHALL NOT enroll older messages. Version tracking SHALL apply within already eligible or explicitly selected input, and historical backfill SHALL remain scoped and independently tracked.

#### Scenario: Configure consolidation for the first time
- **WHEN** the user first successfully saves a usable consolidation model selection
- **THEN** the activation boundary is established and older messages remain outside default incremental consolidation

#### Scenario: Re-enable automatic work later
- **WHEN** the user disables and later re-enables automatic consolidation
- **THEN** eligible unprocessed messages after the original boundary remain pending without rescanning all older history

#### Scenario: Select historical backfill
- **WHEN** the user selects a historical time or conversation range for manual consolidation
- **THEN** only eligible messages in that range are considered and unrelated history is not enrolled

#### Scenario: Retry changes an existing source message
- **WHEN** an already eligible or explicitly selected message is regenerated or its eligible evidence version changes
- **THEN** processing tracks the relevant version rather than assuming an unchanged message identity has already been handled

#### Scenario: Older message is retried or restored
- **WHEN** a message first created before activation is retried, restored or assigned an index after activation
- **THEN** its later change does not make it eligible for default incremental consolidation
- **AND** only an explicit historical selection can enroll it

### Requirement: Automatic quota counts logical batches once
The system SHALL allow at most three automatic batches to begin model work per local calendar day. An automatic batch SHALL consume quota when its first model request is dispatched, not merely when queued. A logical batch SHALL retain that quota identity across pauses, retries, restarts and midnight. Manual batches SHALL use no automatic quota.

#### Scenario: Daily automatic quota is exhausted
- **WHEN** three automatic batches have already begun model requests on the current local day
- **THEN** another automatic batch waits while the user can still request a manual batch

#### Scenario: Cancel before a model request
- **WHEN** an automatic batch is cancelled before its first model request is dispatched
- **THEN** it does not consume an automatic daily slot

#### Scenario: Failure after dispatch
- **WHEN** an automatic batch's first model request was dispatched but the request fails
- **THEN** that batch retains its consumed quota slot even if no memory was created

#### Scenario: Resume after midnight or restart
- **WHEN** the same logical automatic batch resumes on another day or after restarting Her
- **THEN** it is not counted as a new automatic batch and its prior quota record is preserved

### Requirement: Every batch has a shared input and output budget
The system SHALL apply equal per-batch input/output accounting budgets to manual and automatic work. All attempts SHALL share the budget across retries and restarts. Missing usage SHALL NOT count as zero; estimates SHALL be labelled. Exhaustion SHALL persist terminal budget_exhausted status, release the worker and leave remaining messages pending. Continuing SHALL require a new batch, not a budget reset, without promising an exact provider billing limit.

#### Scenario: Input does not fit the remaining budget
- **WHEN** additional source material cannot fit within the batch's remaining input budget
- **THEN** that material remains pending rather than being sent outside the budget or silently marked processed

#### Scenario: Retry follows a failed or cancelled request
- **WHEN** the same batch makes another model attempt
- **THEN** the attempt uses the remaining cumulative budget rather than receiving a fresh per-attempt allowance

#### Scenario: Output budget is exhausted
- **WHEN** the batch has no remaining output allowance
- **THEN** it becomes terminal budget_exhausted, sends no further model request and releases the consolidation worker
- **AND** the panel explains the budget stop and remaining work

#### Scenario: Continue after budget exhaustion
- **WHEN** the user or scheduler continues work left by a budget_exhausted batch
- **THEN** a new batch with its own applicable quota and budget is required
- **AND** the exhausted batch cannot resume or retry with a refreshed allowance

#### Scenario: Actual usage exceeds the estimate
- **WHEN** a provider reports more usage than the reserved estimate
- **THEN** the actual usage is recorded and further requests stop if the batch budget is exhausted

#### Scenario: Interrupted request has no usage report
- **WHEN** a request is cancelled or its outcome is unknown without reliable usage information
- **THEN** reserved consumption is retained conservatively and shown as estimated rather than reported usage

### Requirement: Batches persist and distinguish pause from cancellation
The system SHALL persist batch identity, progress, remaining work, attempts, quota and budget. Foreground preemption or application suspension SHALL pause resumable work; restart SHALL recover unfinished work without duplicate effects. User cancellation SHALL terminate the current batch, stop requests and reject late results while retaining unprocessed messages. Failed requests SHALL await explicit retry rather than loop indefinitely.

#### Scenario: Application exits during a batch
- **WHEN** Her exits with unfinished consolidation work
- **THEN** no work continues outside the application and the next launch recovers the unfinished batch subject to scheduling and configuration rules

#### Scenario: Operating system sleeps
- **WHEN** the operating system suspends Her
- **THEN** background work is paused and cannot be treated as successfully completed solely because the app resumes

#### Scenario: User cancels a running batch
- **WHEN** the user cancels consolidation
- **THEN** the current batch becomes cancelled, sends no further requests and discards late results
- **AND** eligible unprocessed messages remain available for a future explicitly or automatically scheduled batch

#### Scenario: Foreground preemption is not user cancellation
- **WHEN** foreground activity interrupts a background batch
- **THEN** the batch is resumable with its existing progress and budget rather than being permanently cancelled

#### Scenario: User retries a failed batch
- **WHEN** the user explicitly retries a failed batch whose configuration is usable and budget remains
- **THEN** it retries as the same logical batch with prior attempts, quota and budget preserved

### Requirement: Consolidation publishes only validated current evidence
The system SHALL bind each extraction unit to a frozen source-version set, target versions and model configuration. It SHALL atomically publish all valid candidates, including pending approvals, or an explicit no-op with completion markers for every source in that unit. Any invalid or stale candidate SHALL prevent the unit from advancing. Earlier committed units SHALL remain intact. Core evidence and experience approval rules SHALL apply.

#### Scenario: Valid extraction includes facts and experience
- **WHEN** all candidates in an extraction unit are valid and supported
- **THEN** clear non-conflicting user facts may become active while inferred or conflicting facts and new or materially revised experience cards await their required review
- **AND** all candidates and completion markers for every source in that unit are committed atomically

#### Scenario: One source produces several candidates
- **WHEN** the same source message contributes several candidates to an extraction unit
- **THEN** that source is not marked complete after only its first candidate is published
- **AND** the unit advances only when all its candidates and source completion markers commit together

#### Scenario: Valid extraction finds nothing to retain
- **WHEN** a validated extraction unit has an explicit no-op result with no memory candidate
- **THEN** the no-op and completion markers for all sources in that unit commit atomically

#### Scenario: User forgets evidence during model work
- **WHEN** a user forgets, trashes or permanently deletes a source before the batch publishes
- **THEN** the stale attempt cannot recreate its memory or experience or mark that stale extraction as successfully applied

#### Scenario: Model configuration changes during a request
- **WHEN** the selected model, credentials or request configuration is changed or invalidated while a batch request is in flight
- **THEN** results bound to the obsolete configuration cannot silently publish as the current attempt
- **AND** the batch pauses until the new configuration is usable and its work can resume with the existing budget
- **AND** changing only the automatic consolidation switch does not count as a manual batch model-configuration change

#### Scenario: User corrects the target during model work
- **WHEN** the user updates a target memory or card after the batch reads it
- **THEN** a late proposal cannot overwrite the newer version

#### Scenario: Crash while publishing a batch result
- **WHEN** the application stops while publishing validated changes and progress
- **THEN** recovery observes complete committed extraction units with matching source progress and retains uncommitted units for retry without duplicate memory effects

#### Scenario: Malformed output
- **WHEN** any candidate in an extraction unit violates the required format, evidence or current source rules
- **THEN** that unit publishes no candidates and advances none of its source completion markers
- **AND** earlier committed units remain intact while the failed unit displays its reason

### Requirement: Progress and results are visible without chat notifications
The system SHALL display queued, running, paused, completed, failed, cancelled and budget_exhausted progress as applicable in the memory panel, including completed and remaining work, outcomes and actionable stop reasons. Manual work SHALL show progress in place. Automatic success SHALL update the panel quietly; pending review SHALL show a badge and failures SHALL show their reason without inserting notification messages into chat.

#### Scenario: Automatic batch completes
- **WHEN** automatic consolidation finishes
- **THEN** its progress and outcome are available in the panel without adding a chat message

#### Scenario: Review is needed
- **WHEN** consolidation produces facts or cards requiring approval
- **THEN** the memory entry point shows a pending-review badge and the panel opens the corresponding proposals

#### Scenario: Manual batch is running
- **WHEN** the user starts a manual batch
- **THEN** its current stage, progress and cancellation control are visible in the initiating interface

#### Scenario: Background work cannot proceed
- **WHEN** work is waiting for foreground activity, model configuration, quota or explicit retry
- **THEN** the panel distinguishes that reason from active processing or an empty queue
