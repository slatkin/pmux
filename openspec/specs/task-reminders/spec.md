# task-reminders Specification

## Purpose

Delivers the tmux-agent-sidebar's update-before-finish reminder to a pi pane: at a settled turn end whose sidebar task store holds open items, the reminder is injected with the sidebar's own wording, an empty store stays silent, and the delivery never disturbs the session.

## Requirements

### Requirement: the extension delivers the sidebar's update-before-finish reminder

The extension SHALL inject the update-before-finish reminder at the
settlement boundary, exactly when its condition holds. The wording SHALL be
the reminder constant `UPDATE_BEFORE_FINISH_REMINDER`, copied byte-for-byte
from `src/task_reminders.rs` in the tmux-agent-sidebar repository.

#### Scenario: open items at turn end
- **WHEN** the turn ends and the pane's store holds pending or in-progress items
- **THEN** the update-before-finish reminder is injected

#### Scenario: nothing open at turn end
- **WHEN** the turn ends and no item is open
- **THEN** no reminder is injected and the next turn start starts clean

#### Scenario: a failed turn gets no steer
- **WHEN** a turn ends in `error`, or the user aborted it
- **THEN** no update-before-finish reminder is injected for that turn

#### Scenario: a child stays quiet
- **WHEN** the pi session is a pmux subagent child
- **THEN** no reminder is injected, whatever the store holds

#### Scenario: the wording matches the source
- **WHEN** the injected text is compared with `UPDATE_BEFORE_FINISH_REMINDER` in `src/task_reminders.rs` of the tmux-agent-sidebar repository
- **THEN** it matches byte for byte

### Requirement: an empty store is never nudged

The extension SHALL NOT deliver the record-first reminder, and SHALL NOT
inject anything at a turn start. Recording tasks is a human-prompted action,
not a default tag.

#### Scenario: an empty store stays silent
- **WHEN** the pane's store holds no tasks, at any turn boundary
- **THEN** no reminder is injected, so the agent is never told to record a list it was not asked to keep

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
