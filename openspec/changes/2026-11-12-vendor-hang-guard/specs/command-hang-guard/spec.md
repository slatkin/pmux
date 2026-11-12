# Spec Delta

## Purpose

Defines the vendored command watchdog that runs inside a pi session — including every pmux child: it classifies tool executions, measures output silence and runtime against per-class thresholds, escalates inside the child process, and publishes liveness and hang state to the activity file for the parent.

## ADDED Requirements

### Requirement: Vendored engine

The extension SHALL ship a command watchdog derived from pi-hang-guard (MIT), carrying its copyright notice. The watchdog SHALL read `tool_execution_start`, `tool_execution_update` and `tool_execution_end` events only: it SHALL NOT override a built-in tool, SHALL NOT rewrite a command and SHALL NOT touch a tool event's input. A watchdog failure SHALL NOT surface as an unhandled exception.

#### Scenario: Read-only by construction
- **WHEN** the watchdog observes a `bash` tool execution
- **THEN** the tool's command and arguments reach the tool unchanged

#### Scenario: Watchdog throws
- **WHEN** the watchdog's tick or event handler fails
- **THEN** the failure is contained and the session continues

### Requirement: Command classification

Every tool execution SHALL be classified before it is watched: `interactive`, `watcher` or `one-shot`. Interactive commands SHALL NOT be watched. A command carrying its own bound (`timeout N`, `--timeout N`) SHALL be flagged self-timed. A command on the known-slow list (build, install, fetch and archive commands) SHALL be flagged idle-tolerant. A leading `cd ... &&` chain, env assignments and `sudo` SHALL NOT affect the classification.

#### Scenario: Self-timed command
- **WHEN** a `bash` execution runs `timeout 600 cargo bench -- --test`
- **THEN** it is classified one-shot and flagged self-timed

#### Scenario: Idle-tolerant command
- **WHEN** a `bash` execution runs `cargo build --release`
- **THEN** it is classified one-shot and flagged idle-tolerant

#### Scenario: Interactive command
- **WHEN** a `bash` execution runs `git add -p`
- **THEN** it is not watched

### Requirement: Silence and runtime measurement

A streaming tool (such as `bash`) that is not self-timed SHALL be measured by output silence: the time since its last `tool_execution_update`. A self-timed or non-streaming tool SHALL be measured by wall-clock runtime. Each measurement SHALL be compared against a warning threshold and a critical threshold for its class, and the thresholds for an idle-tolerant command SHALL be longer than the defaults.

#### Scenario: Quiet streaming command
- **WHEN** a `bash` execution produced no output for longer than the warning threshold
- **THEN** the execution is at warning level

#### Scenario: Self-timed command measured by runtime
- **WHEN** a `timeout 600` command has run 300 seconds with no output
- **THEN** the measurement is 300 seconds of runtime, not silence

#### Scenario: Output resets the silence clock
- **WHEN** a quiet `bash` execution produces output
- **THEN** its silence measurement restarts

### Requirement: Escalation modes

The watchdog SHALL run in one of three modes: `observe` only reports, `guard` aborts the turn at the critical threshold and delivers a structured report to the agent (bounded automatic resumes), and `yolo` first tries to kill the session's tracked tool child processes so the turn survives with a non-zero exit, falling back to the `guard` abort when the soft kill is unavailable or the grace period elapses.

#### Scenario: Observe never interrupts
- **WHEN** an execution crosses the critical threshold in `observe` mode
- **THEN** a warning is reported and the turn continues

#### Scenario: Guard aborts
- **WHEN** an execution crosses the critical threshold in `guard` mode
- **THEN** the turn is aborted and a structured report naming the command and the measurement is delivered to the agent

#### Scenario: Yolo soft kill
- **WHEN** an execution crosses the critical threshold in `yolo` mode and the tracked-children kill succeeds
- **THEN** the tool call ends with a non-zero exit, the turn is not aborted, and the agent continues

#### Scenario: Yolo falls back to abort
- **WHEN** the tracked-children kill is unavailable or the command still runs after the grace period
- **THEN** the turn is aborted as in `guard` mode

### Requirement: Mode resolution

The watchdog mode SHALL resolve per session: a non-interactive pmux child (auto-exit, no user driving the pane) SHALL default to `yolo`; every other session SHALL default to `observe`. `PI_PMUX_GUARD_MODE` SHALL override the default with `observe`, `guard` or `yolo`; `PI_PMUX_GUARD_DISABLED=1` SHALL switch the watchdog off for that session.

#### Scenario: Non-interactive child
- **WHEN** a subagent launches non-interactively with no override
- **THEN** its watchdog runs `yolo`

#### Scenario: Interactive child or parent session
- **WHEN** an interactive subagent or a parent session starts with no override
- **THEN** its watchdog runs `observe`

#### Scenario: Env override
- **WHEN** a child launches with `PI_PMUX_GUARD_MODE=guard`
- **THEN** its watchdog runs `guard`

### Requirement: Activity heartbeat

While the session lives, the child extension SHALL refresh a liveness timestamp `aliveAt` in its activity file on an interval well under the parent's gone bound, independent of session events. Event writes SHALL also refresh `aliveAt`. A stale `aliveAt` therefore means the process is dead or its event loop is wedged, never merely quiet.

#### Scenario: Quiet tool call stays live
- **WHEN** a child sits inside a `bash` execution that produces no events for five minutes
- **THEN** `aliveAt` in its activity file is never older than the heartbeat interval

#### Scenario: Session end stops the heartbeat
- **WHEN** the child's session shuts down
- **THEN** no further `aliveAt` refresh is written

### Requirement: Hang state in the activity file

At `tool_execution_start` the activity file SHALL carry `toolCommand`, truncated to the activity string limit. While a watched execution is at warning or critical level the file SHALL carry a `hang` block with the tool call id, the measurement, the command class and the level, removed when the execution ends or produces output. Both fields SHALL be optional: older files and readers tolerate their absence.

#### Scenario: Command recorded
- **WHEN** a `bash` execution starts
- **THEN** the activity file holds `toolCommand` with the command text, truncated to 200 characters

#### Scenario: Warning published
- **WHEN** an execution reaches warning level
- **THEN** the activity file's `hang` block names the tool call, the measurement and the class

#### Scenario: Hang clears
- **WHEN** the flagged execution produces output or ends
- **THEN** the `hang` block is gone from the next write

### Requirement: Orchestrator notification

Warnings SHALL be reported in the pane in every session. In a pmux child with a pi parent, an execution at critical level SHALL additionally append one message per level to the child's parent message file — naming the child, the command, the measurement and the class — delivered to the parent as a steering message. For an external orchestrator the hang SHALL be visible through the activity `hang` block and the status file instead.

#### Scenario: Standalone session
- **WHEN** an execution crosses the critical threshold in a session with no pmux parent
- **THEN** a warning is reported in the pane and nothing else is sent

#### Scenario: Pi-parent child at critical
- **WHEN** a pmux child with a pi parent crosses the critical threshold on a `bash` execution
- **THEN** one message lands in the parent message file naming the child, the command, the silent duration and the class

#### Scenario: No repeat messages
- **WHEN** the same tool call stays at critical level across later ticks
- **THEN** no further parent message is appended for that level

### Requirement: Single watchdog per session

A pmux child SHALL run exactly one command watchdog. When the pi configuration that the child will load lists an installed `pi-hang-guard` package, the launch SHALL pass `--no-guard` to the child so the installed copy stands down; when no such package is configured the flag SHALL NOT be passed.

#### Scenario: Installed package present
- **WHEN** the child's pi config lists `pi-hang-guard` among its packages
- **THEN** the child launches with `--no-guard`

#### Scenario: No installed package
- **WHEN** the child's pi config lists no `pi-hang-guard` package
- **THEN** the child launches without `--no-guard`
