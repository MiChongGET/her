# settings/system-prompt Specification

## Purpose
Allows users to customize the system prompt that defines Her's personality, tone, and behavior during conversations.

## Requirements

### Requirement: User can view system prompt
The system SHALL display the current system prompt in the settings interface.

#### Scenario: View default prompt
- **WHEN** user opens system prompt settings for the first time
- **THEN** system displays the default system prompt text

#### Scenario: View saved custom prompt
- **WHEN** user opens system prompt settings after saving a custom prompt
- **THEN** system displays their saved custom prompt

### Requirement: User can edit system prompt
The system SHALL allow users to edit the system prompt text.

#### Scenario: Edit prompt text
- **WHEN** user types in the system prompt text area
- **THEN** system accepts input up to 16384 characters

#### Scenario: Reject oversized prompt
- **WHEN** user attempts to save a prompt exceeding 16384 characters
- **THEN** system displays an error and does not save

### Requirement: User can save system prompt
The system SHALL persist the edited system prompt to the database.

#### Scenario: Save custom prompt
- **WHEN** user clicks save after editing the prompt
- **THEN** system stores the prompt and displays success confirmation

#### Scenario: Apply saved prompt to new conversations
- **WHEN** user starts a new conversation after saving a custom prompt
- **THEN** system uses the custom prompt instead of the default

### Requirement: User can restore default prompt
The system SHALL allow users to restore the original default system prompt.

#### Scenario: Restore default
- **WHEN** user clicks restore default button
- **THEN** system replaces current prompt with the default and displays confirmation

#### Scenario: Restore after custom edits
- **WHEN** user has edited the prompt and clicks restore default
- **THEN** system discards custom edits and restores the original default

### Requirement: System uses configured prompt
The system SHALL use the stored system prompt when making chat requests.

#### Scenario: Use default on first run
- **WHEN** user sends first message before configuring prompt
- **THEN** system uses the hardcoded default prompt

#### Scenario: Use custom prompt
- **WHEN** user sends a message after saving custom prompt
- **THEN** system includes the custom prompt in the model request
