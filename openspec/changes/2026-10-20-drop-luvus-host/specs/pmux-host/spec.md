# Spec Delta

## Purpose

Defines the single terminal host of the package: tmux. The extension runs
subagent panes in tmux, reports their state through a status file, and ends a
subagent through the `.exit` sidecar.

## ADDED Requirements

### Requirement: tmux is the only host

The extension SHALL run subagent panes in tmux and SHALL refuse to spawn
when tmux is not available. tmux is available when `TMUX` and `TMUX_PANE` are
both set and non-empty. The caller's own pane id SHALL be `TMUX_PANE`.

#### Scenario: Spawn inside a tmux pane
- **WHEN** `TMUX` and `TMUX_PANE` are set
- **THEN** the extension accepts the host and the caller's pane id is `TMUX_PANE`

#### Scenario: No tmux pane
- **WHEN** `TMUX_PANE` is unset
- **THEN** the extension spawns nothing and returns an error naming tmux as the required host

### Requirement: One surface API

Every pane operation SHALL go through one surface API, with no host dispatch
in between: create, name, run a command, read the pane, send Escape, close
the pane, deliver a prompt, and poll for the exit.

#### Scenario: A split anchors on the caller
- **WHEN** a subagent is spawned from pane `%3`
- **THEN** the new pane is created by splitting `%3` without selecting it, and the caller's pane keeps the focus

### Requirement: Status file

A running child SHALL write its status next to its session file, so an
observer can tell whether it is working, idle, done or blocked. The status
SHALL be `working` while the child generates, `idle` when it waits, `done`
when it finishes cleanly and `blocked` when it stops to ask a question.

#### Scenario: A working child
- **WHEN** a child starts a turn
- **THEN** the status file next to its session file holds `working`

#### Scenario: A blocked child
- **WHEN** a child calls the ping tool with a question
- **THEN** the status file holds `blocked` and the question text

#### Scenario: A finished child
- **WHEN** a child calls the done tool
- **THEN** the status file holds `done`

### Requirement: Wait for a status

The CLI SHALL provide a `wait` command that takes a session file, the wanted
statuses and a timeout, and that returns the final status. It SHALL end
early when the wanted status appears, and SHALL fail with a timeout error
when the timeout passes first.

#### Scenario: The child finishes
- **WHEN** the orchestrator waits for `done,blocked` and the child writes `done`
- **THEN** the command returns the `done` status

#### Scenario: The child never finishes
- **WHEN** the timeout passes before the wanted status appears
- **THEN** the command fails with a timeout error naming the last status it saw
