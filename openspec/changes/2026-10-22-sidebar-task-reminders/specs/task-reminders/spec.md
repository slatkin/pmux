# Spec Delta

## ADDED Requirements

### Requirement: the extension delivers the sidebar's task reminders

The extension SHALL inject the two task reminders of the
tmux-agent-sidebar's agent-tasks spec into the pi session at the turn
boundaries, each one exactly when its condition holds. The wording SHALL
be the two reminder constants `RECORD_FIRST_REMINDER` and
`UPDATE_BEFORE_FINISH_REMINDER`, copied byte-for-byte from
`src/task_reminders.rs` in the tmux-agent-sidebar repository.

#### Scenario: an empty store at turn start
- **WHEN** a user prompt starts a turn and the pane's sidebar task store holds no items
- **THEN** the record-first reminder is injected into that turn

#### Scenario: a fresh store at turn start
- **WHEN** a user prompt starts a turn and the pane's sidebar task store already holds items
- **THEN** no reminder is injected

#### Scenario: a steer turn is not a user turn
- **WHEN** a run starts from an injected steer rather than a user prompt
- **THEN** no reminder is injected at its start, so a delivered reminder cannot re-fire the condition that delivered it

#### Scenario: a failed turn gets no steer
- **WHEN** a turn ends in `error`, or the user aborted it
- **THEN** no update-before-finish reminder is injected for that turn

#### Scenario: open items at turn end
- **WHEN** the turn ends and the pane's store still holds pending or in-progress items
- **THEN** the update-before-finish reminder is injected

#### Scenario: nothing open at turn end
- **WHEN** the turn ends and no item is open
- **THEN** no reminder is injected and the next turn start starts clean

#### Scenario: a child stays quiet
- **WHEN** the pi session is a pmux subagent child
- **THEN** no reminder is injected, whatever the store holds

#### Scenario: the wording matches the source
- **WHEN** the two injected texts are compared with `RECORD_FIRST_REMINDER` and `UPDATE_BEFORE_FINISH_REMINDER` in `src/task_reminders.rs` of the tmux-agent-sidebar repository
- **THEN** both match byte for byte

### Requirement: delivery never disturbs the session

The extension SHALL deliver through one steer message and SHALL NOT spawn
a turn of its own to deliver a reminder, SHALL NOT await the store read or
the injection, and SHALL swallow every failure of either. A missing
`TMUX_PANE`, a missing or unreadable store and a broken injection SHALL
leave the turn exactly as it would run without the module, and SHALL write
nothing to the session's output.

#### Scenario: no store at all
- **WHEN** the pane has no `TMUX_PANE` in its environment, or its store file is missing or unreadable
- **THEN** the turn runs as if the module were absent and nothing is written anywhere but the store's absence

#### Scenario: a failing injection
- **WHEN** the steer injection fails
- **THEN** the failure is swallowed, the turn continues, and no extension error is raised

#### Scenario: no turn spawned for a reminder
- **WHEN** a reminder's condition holds while the pi session is idle
- **THEN** the reminder is queued to the turn the agent next runs, and no run is started for it
