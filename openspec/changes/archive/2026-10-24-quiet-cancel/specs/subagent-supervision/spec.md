# Spec Delta

## MODIFIED Requirements

### Requirement: A user cancel notifies the parent without ending the run
When the exit poll reads a child's `.exit` sidecar with `type` `cancelled`, the poll SHALL NOT complete. The poll consumes the sidecar it reports, so each cancel notifies exactly once. The parent SHALL receive one cancel message per cancel that carries the child's session file and carries the child's name, task and agent in its details. Unless quiet cancel mode is configured (see "Cancel wake is configurable"), the message SHALL trigger a turn; in quiet mode the message SHALL be appended to the parent's session without triggering a turn. The child SHALL remain registered.

A reported cancel SHALL mark the run user-cancelled. While the mark stands, the idle watchdog SHALL NOT nudge the child or finish the run, and its gone detection SHALL still apply. (The watchdog's nudge/finish and gone arms already act only on non-interactive children, so the mark changes nothing for an interactive run.) The mark SHALL clear when a fresh activity read reports an active phase.

#### Scenario: Cancel notifies and keeps watching
- **WHEN** a running child's `.exit` sidecar gains `{"type":"cancelled"}` and quiet cancel mode is off
- **THEN** the parent gets one cancel message that triggers a turn, the message says the child was cancelled in its pane and that the session is still open, tells the parent to ask the user how to proceed before resuming with `pmux_resume` or spawning a replacement, the child stays registered, and the exit poll continues

#### Scenario: Quiet cancel records without waking
- **WHEN** a running child's `.exit` sidecar gains `{"type":"cancelled"}` and quiet cancel mode is on
- **THEN** the parent session gains the same cancel message with no turn triggered, the child stays registered, and the exit poll continues

#### Scenario: Each cancel notifies once
- **WHEN** the poll has reported a `cancelled` sidecar
- **THEN** that file is consumed and produces no further message, and a later abort writes a new sidecar that notifies again

#### Scenario: A cancelled child is not nudged or finished
- **WHEN** a non-interactive run is marked user-cancelled and the child keeps reporting a `waiting` phase
- **THEN** the idle watchdog sends no reminder to the child's pane and writes no `done` sidecar, no matter how long the wait lasts

#### Scenario: New activity ends the suppression
- **WHEN** a user-cancelled child's activity reports an `active` phase, for example after the user types in its pane
- **THEN** the mark clears and the idle watchdog treats the run like any other afterwards

#### Scenario: A dead cancelled pane is still reported
- **WHEN** a non-interactive run is marked user-cancelled and the child's activity file stops reporting
- **THEN** the gone detection still finishes the run with an `error` sidecar

#### Scenario: Completion after a cancel
- **WHEN** a child whose cancel was reported later writes a `done`, `error`, `handoff` or `ping` sidecar
- **THEN** the run completes exactly as if no cancel had happened

## ADDED Requirements

### Requirement: Cancel wake is configurable
The extension `config.json` SHALL accept an optional `quietCancel` boolean inside the `notify` object, defaulting to `false`. A non-boolean `quietCancel` value, and any other unknown key in `notify`, MUST be a config error.

#### Scenario: Default wakes the parent
- **WHEN** `config.json` has no `quietCancel` key and a child's `.exit` sidecar gains `{"type":"cancelled"}`
- **THEN** the cancel message triggers a parent turn

#### Scenario: Quiet mode records the cancel
- **WHEN** `config.json` sets `"quietCancel": true` and a child's `.exit` sidecar gains `{"type":"cancelled"}`
- **THEN** the cancel message is appended to the session without a turn

#### Scenario: Invalid value is a config error
- **WHEN** `config.json` sets `quietCancel` to a non-boolean value
- **THEN** loading the config fails with an error that names the key
