# Spec Delta

## MODIFIED Requirements

### Requirement: the extension delivers the sidebar's update-before-finish reminder

The extension SHALL inject the update-before-finish reminder at the
settlement boundary, exactly when its condition holds. The wording SHALL be
the reminder constant `UPDATE_BEFORE_FINISH_REMINDER`, copied byte-for-byte
from `src/task_reminders.rs` in the tmux-agent-sidebar repository.

The extension SHALL NOT inject the reminder while the pane's task store has
been written within a quiet period of five minutes, or when fewer than
three turn ends have passed since the store's last write. An injection
resets the turn count and the quiet period from that point. The open-set
guard remains: an identical open set to the last injection does not
re-fire.

#### Scenario: open items at turn end
- **WHEN** the turn ends and the pane's store holds pending or in-progress items, the store was last written more than five minutes ago, and at least three turn ends have passed since that write
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

#### Scenario: a recently written store stays silent
- **WHEN** the turn ends and the pane's store holds open items, but the store was written within the last five minutes
- **THEN** no reminder is injected

#### Scenario: fewer than three turns since the last write
- **WHEN** the turn ends and the pane's store holds open items, the store was last written more than five minutes ago, but fewer than three turn ends have passed since that write
- **THEN** no reminder is injected

#### Scenario: an injection restarts the buffer
- **WHEN** a reminder has just been injected
- **THEN** the turn count and the five-minute clock restart from that point, and a later turn end with the same open set does not re-fire until the buffer expires again
