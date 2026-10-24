# Spec Delta

## MODIFIED Requirements

### Requirement: the extension publishes the session's activity

The extension SHALL publish the activity of the pi session it runs in to the
tmux sidebar, by calling `pmux-explorer hook pi <event>` with the
payload on stdin, for every event of the protocol that pi can answer.

#### Scenario: A user prompt
- **WHEN** pi receives a user prompt
- **THEN** the extension publishes `user-prompt-submit` with that prompt text

#### Scenario: A tool starts
- **WHEN** pi starts a tool
- **THEN** the extension publishes `activity-log` with the tool name and its arguments

#### Scenario: A tool ends
- **WHEN** a tool ends
- **THEN** the extension publishes `activity-log` with the tool name, its arguments and its result

#### Scenario: The turn ends
- **WHEN** a run settles with the outcome `completed` or `aborted`
- **THEN** the extension publishes `stop` with the text of the run's last assistant message

#### Scenario: The turn fails
- **WHEN** a run settles with the outcome `error`
- **THEN** the extension publishes `stop-failure` with the error text

#### Scenario: The session waits for a human
- **WHEN** pi starts waiting on a blocking user-facing extension prompt
- **THEN** the extension publishes `notification` with a wait reason

#### Scenario: The wait is over
- **WHEN** pi stops waiting on that prompt
- **THEN** the extension publishes `user-prompt-submit` with an empty prompt, and no prompt text of its own

#### Scenario: The session starts
- **WHEN** the pi session starts
- **THEN** the extension publishes `session-start` with the working directory, the session id and the source

#### Scenario: The session ends
- **WHEN** the pi session shuts down
- **THEN** the extension publishes `session-end`
