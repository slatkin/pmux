# pmux-host Specification

## Purpose
Defines the single terminal host of the package: tmux. The pane mechanics live in
`tmux-backend`. This capability adds the host rule, the status file that
replaces the leased status, the `wait` command that reads it, and the rule that
a new run starts clean.

## Requirements

### Requirement: tmux is the required host

The extension SHALL run subagent panes in tmux only. `pmux_spawn`,
`pmux_resume`, `start` and `resume` MUST NOT spawn anything when tmux is not
available as `tmux-backend` defines it. Each MUST return an error that names tmux
as the required host. No other terminal backend and no headless fallback SHALL
exist.

#### Scenario: Spawn outside tmux
- **WHEN** `pmux_spawn` is called with `TMUX_PANE` unset
- **THEN** the tool returns an error result that names tmux, and no pane or process is created

### Requirement: Pane operations call tmux directly

Every pane operation (create, name, run a command, read the pane, send Escape,
close the pane, deliver a prompt, check focus, notify and poll for the exit) SHALL
call the tmux backend directly, with no host dispatch in between.

#### Scenario: A spawn drives tmux
- **WHEN** `TMUX` and `TMUX_PANE` are set and a subagent is spawned
- **THEN** the pane is created and driven through tmux commands only

### Requirement: Status file

A pi process that runs the extension as a subagent child (a session with
`PI_PMUX_SESSION` set) SHALL write its status to `<session file>.status`, as one
JSON object with `status`, `at` (ISO time) and an optional `message`. The
`status` SHALL be `working` while a turn runs, `idle` while the session waits for
input, `done` when the child ends with `pmux_done` (with or without a handoff) or
with auto-exit, and `blocked` when the child pings with a question (`message` is
the question) or ends on a provider error (`message` is the error text). Each
write SHALL replace the whole file, so a reader never sees a partial object. A
`done` or `blocked` write SHALL come before the `.exit` sidecar write. After a
`done` or `blocked` write, later writes SHALL be skipped, and shutdown SHALL NOT
remove the file. A failed write SHALL NOT delay a turn, the sidecar write or
shutdown. A session without `PI_PMUX_SESSION` SHALL write no status.

#### Scenario: A working child
- **WHEN** a child starts a turn
- **THEN** `<session file>.status` holds `working`

#### Scenario: An idle child
- **WHEN** a child ends a turn and the session stays open
- **THEN** `<session file>.status` holds `idle`

#### Scenario: A blocked child
- **WHEN** a child calls `caller_ping` with a question
- **THEN** the status file holds `blocked` with the question as `message`, and the `ping` sidecar is written after it

#### Scenario: A provider error
- **WHEN** a child's turn ends with `stopReason: "error"`
- **THEN** the status file holds `blocked` with the error text as `message`, and the `error` sidecar is written after it

#### Scenario: A finished child
- **WHEN** a child calls `pmux_done`
- **THEN** the status file holds `done` before the `done` sidecar is written

#### Scenario: A handoff
- **WHEN** a child calls `pmux_done` with a `handoff`
- **THEN** the status file holds `done`, and the sidecar holds the `handoff` object

#### Scenario: Terminal status stays
- **WHEN** a child has written `done` and a later turn event or the shutdown runs
- **THEN** the status file still holds `done`

#### Scenario: The write fails
- **WHEN** the status file cannot be written
- **THEN** the turn, the sidecar write and the shutdown still happen

#### Scenario: Not a subagent
- **WHEN** a pi session without `PI_PMUX_SESSION` runs a turn
- **THEN** no status file is written

### Requirement: A new run starts with no status

`pmux_spawn`, `pmux_resume`, `start` and `resume` SHALL remove
`<session file>.status` before the child starts, so that the status of an earlier
run is never read as the status of the new run. They SHALL also remove
`<session file>.exit`, so that the exit of an earlier run is never read as the
exit of the new one.

#### Scenario: Resume after done
- **WHEN** a session whose status file holds `done` is resumed
- **THEN** the status file is removed before the child starts, and a `wait` for `done` returns only after the new run writes `done`

#### Scenario: A stale sidecar does not end the new run
- **WHEN** a session with a leftover `<session file>.exit` is resumed
- **THEN** the sidecar is removed before the child starts, so the new run is not reported as the exit of the earlier one

### Requirement: A child that exits without completing is blocked

When the run wrapper sees the child exit, and `<session file>.exit` does not
exist, and the status file does not hold `done` or `blocked`, the wrapper SHALL
write the status `blocked` with a `message` that gives the exit code. It SHALL
also write an `error` `.exit` sidecar that names the exit code and marks its
source as the wrapper, so that a parent polling the sidecar ends the run at
once. A clean completion or a ping SHALL NOT be changed by the wrapper.

#### Scenario: The child crashes
- **WHEN** pi exits with code 137 and wrote neither a sidecar nor a terminal status
- **THEN** the status file holds `blocked` and its `message` names exit code 137, and the `.exit` sidecar holds an `error` that names exit code 137 and marks its source as the wrapper

#### Scenario: The child completed
- **WHEN** pi exits after the child wrote `done` and the `done` sidecar
- **THEN** the wrapper leaves the status file as it is

#### Scenario: The child exits cleanly without reporting
- **WHEN** pi exits with code 0 and wrote neither a sidecar nor a terminal status
- **THEN** the wrapper writes the `error` sidecar and the `blocked` status, and the sidecar's message says the child did not call `pmux_done`

### Requirement: Wait for a status

The CLI SHALL provide `wait --session <file> [--status <list>] [--timeout <seconds>]`.
`--status` is a comma-separated list of `working`, `idle`, `done` and `blocked`,
and defaults to `done,blocked`. `--timeout` is a positive number of seconds and
defaults to 600. The command SHALL poll `<file>.status` at a fixed interval, and a
missing file SHALL count as no status yet. When the status is in the list, the
command SHALL print the file content as one JSON line on stdout and exit 0. When
the timeout passes first, it SHALL print the last content it saw (or
`{"status":null}` when there was none) on stdout, print an error that names that
status on stderr, and exit 2. A missing `--session`, an unknown status name or an
invalid timeout SHALL exit 1 with a usage error and print nothing on stdout.

#### Scenario: The child finishes
- **WHEN** the orchestrator waits for `done,blocked` and the child writes `done`
- **THEN** the command prints the status line and exits 0

#### Scenario: The child never finishes
- **WHEN** the timeout passes while the status file holds `working`
- **THEN** the command prints the last status line, reports a timeout that names `working`, and exits 2

#### Scenario: No status file yet
- **WHEN** the status file does not exist and the timeout passes
- **THEN** the command prints `{"status":null}`, reports a timeout, and exits 2

#### Scenario: Unknown status name
- **WHEN** the command runs with `--status finished`
- **THEN** it exits 1 with a usage error that lists the accepted names, and prints nothing on stdout
