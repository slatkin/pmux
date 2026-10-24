# subagent-supervision Specification

## Purpose

Defines how a pi parent supervises its subagents: what it records when it spawns a child, how it resumes a child with the same role configuration for both backends, how it delivers results, and how a session end or a reload stops its watchers.

## Requirements

### Requirement: Launch record at spawn
When `pmux_spawn` starts a pi or Claude Code child, the extension SHALL write a launch record to `<session>.launch.json`, where `<session>` is the child session file. The record SHALL hold the backend, display name, agent name, working directory, model, tool allowlist, role prompt, denied tools, auto-exit and interactive values that the spawn resolved. When the role has a valid `surface:`, the record SHALL also hold that value.

#### Scenario: Pi child spawned with an agent
- **WHEN** `pmux_spawn` starts agent `scout` with `cwd` `/repo` and the agent frontmatter sets `spawning: false`
- **THEN** `<session>.launch.json` exists and records backend `pi`, agent `scout`, cwd `/repo`, and the spawning tools in its denied tools

#### Scenario: Claude Code child spawned
- **WHEN** `pmux_spawn` starts an agent whose frontmatter sets `cli: claude`
- **THEN** `<session>.launch.json` exists and records backend `claude`

#### Scenario: Role surface recorded
- **WHEN** `pmux_spawn` starts an agent whose frontmatter sets `surface: float`
- **THEN** the launch record holds the surface `float`

#### Scenario: Per-call surface not recorded
- **WHEN** `pmux_spawn` starts an agent whose frontmatter sets no `surface:` (a call carries no surface value)
- **THEN** the launch record holds no surface

### Requirement: Launch record holds no per-run values
The launch record SHALL NOT hold the task prompt, skill prompts, the subagent id, the pane, the activity file, the parent roster file or the Claude Code sentinel file. The extension SHALL create these values again for each run.

#### Scenario: Record after spawn
- **WHEN** `pmux_spawn` starts a child with task "Fix the login bug"
- **THEN** the launch record does not contain the task text or the child's subagent id

### Requirement: Resume restores the role configuration
When `pmux_resume` is called with a session file that has a launch record, the extension SHALL start the child with the record's backend, agent name, working directory, model, tool allowlist, role prompt and denied tools. The resumed child SHALL show the record's display name. The surface SHALL be the record's surface when the record holds one, else the configured default.

#### Scenario: Resumed scout keeps its deny list
- **WHEN** `pmux_resume` resumes a session whose record denies `pmux_spawn`
- **THEN** the resumed child does not have the `pmux_spawn` tool

#### Scenario: Resumed child keeps its working directory
- **WHEN** `pmux_resume` resumes a session whose record has cwd `/repo`, from a parent whose cwd is `/other`
- **THEN** the resumed child runs in `/repo`

#### Scenario: Resumed child keeps its name and agent
- **WHEN** `pmux_resume` resumes a session whose record has name `Worker` and agent `worker`
- **THEN** the pane is named `Worker` and the child runs as agent `worker`

#### Scenario: Resumed child keeps its role surface
- **WHEN** `pmux_resume` resumes a session whose record holds the surface `float`
- **THEN** the resumed child opens as a float

#### Scenario: Record without a surface
- **WHEN** `pmux_resume` resumes a session whose record holds no surface
- **THEN** the configured default applies

### Requirement: Resume parameters
`pmux_resume` SHALL accept exactly `sessionPath` (required), `message` and `autoExit`. When `autoExit` is absent, the record's auto-exit value SHALL apply, and the record's interactive value SHALL apply. When `autoExit` is present, it SHALL override the record, and the run SHALL be interactive exactly when `autoExit` is false.

#### Scenario: Auto-exit from the record
- **WHEN** `pmux_resume` resumes a session whose record has auto-exit on, and `autoExit` is not given
- **THEN** the resumed child runs with auto-exit on

#### Scenario: Caller turns auto-exit off
- **WHEN** `pmux_resume` is called with `autoExit: false`
- **THEN** the resumed child runs without auto-exit, and its stalled and recovered transitions do not wake the parent

### Requirement: Resume without a launch record
When the session file has no launch record, or the record cannot be read, `pmux_resume` SHALL resume a pi child with no agent, no denied tools, the parent's working directory and the display name `Resume`, and auto-exit on unless `autoExit` is false. The tool result SHALL say that no launch record was found and that the role configuration was not restored. When the session file does not exist and there is no readable launch record, `pmux_resume` SHALL return an error result and start nothing.

#### Scenario: Session from before the launch record
- **WHEN** `pmux_resume` is called with a session file that has no `<session>.launch.json`
- **THEN** the child resumes as a plain pi session named `Resume`, and the tool result says that the role configuration was not restored

#### Scenario: No session file and no record
- **WHEN** `pmux_resume` is called with a session path that has neither a session file nor a launch record
- **THEN** the tool returns an error that names the missing session file, and no pane is created

### Requirement: Resume of a Claude Code child
When a Claude Code child run ends, the extension SHALL store the Claude Code session id in the child's launch record. `pmux_resume` on that session file SHALL start Claude Code with that session id resumed and `message` as the prompt. When the record has backend `claude`, the extension SHALL NOT require the pi-style session file to exist. When the record has backend `claude` but no session id, `pmux_resume` MUST return an error result and start nothing.

#### Scenario: Claude child resumed by session file
- **WHEN** a Claude Code child has ended and `pmux_resume` is called with its session file and a message
- **THEN** Claude Code starts in a new pane with the stored session id resumed and the message as the prompt

#### Scenario: Claude record exists but no session file
- **WHEN** `pmux_resume` is called with a session path whose launch record has backend `claude` and a session id, and no session file exists at that path
- **THEN** Claude Code starts in a new pane with the stored session id resumed

#### Scenario: Claude session id was never stored
- **WHEN** `pmux_resume` is called for a Claude Code record that has no session id
- **THEN** the tool returns an error and no pane is created

### Requirement: Spawn has no resume parameter
`pmux_spawn` SHALL NOT accept a `resumeSessionId` parameter. Resuming any child SHALL use `pmux_resume`.

#### Scenario: Spawn schema
- **WHEN** the parent lists the `pmux_spawn` parameters
- **THEN** there is no `resumeSessionId` parameter

### Requirement: Resumed child is told about messaging
When `pmux_resume` resumes a pi child with a `message`, the prompt the child receives SHALL name the targets it can reach at resume time (`parent` and the names of the parent's running children), in the same wording as the spawn prompt, followed by the message.

#### Scenario: Resume while a sibling runs
- **WHEN** the parent has a running child `Reviewer` and resumes `Worker` with a message
- **THEN** Worker's prompt names `parent` and `Reviewer` as reachable, then holds the message

### Requirement: Results name the session file for both backends
The result message and the ping message for a child SHALL include the child's session file and tell the parent to use `pmux_resume` with that file to continue the child. They SHALL NOT show a `pi --session` command. This SHALL apply to pi and Claude Code children. The handoff message keeps its instruction to start a new child and not to resume, and SHALL NOT include a `pmux_resume` line.

#### Scenario: Pi child finishes
- **WHEN** a pi child finishes with a result
- **THEN** the parent's result message holds the session file and names `pmux_resume`, and holds no `pi --session` text

#### Scenario: Claude Code child finishes
- **WHEN** a Claude Code child finishes with a result
- **THEN** the parent's result message holds the child's session file

### Requirement: Same delivery for spawned and resumed children
Spawned and resumed children SHALL be delivered to the parent the same way: one result, ping, handoff or error message that triggers a turn. Each of the four kinds SHALL carry the child's name, task and agent in its details. For a resumed child, the summary SHALL come from the session entries written after the resume started.

#### Scenario: Resumed child pings
- **WHEN** a resumed child calls `caller_ping`
- **THEN** the parent gets one ping message with the child's agent in its details, as for a spawned child

#### Scenario: Resumed child summary
- **WHEN** a resumed child ends after writing a new assistant message
- **THEN** the result summary is that new message, not an assistant message from before the resume

#### Scenario: Resumed child hands off
- **WHEN** a resumed child reaches the context alert and hands off
- **THEN** the parent's handoff message carries the child's name, task and agent in its details

### Requirement: Session end and reload stop the supervision
When the parent session shuts down, the extension SHALL stop watching every running child, stop its widget and status refresh. When the extension module loads again in the same process, it SHALL do the same for the previous load before it starts its own.

#### Scenario: Reload with a running child
- **WHEN** the extension reloads while a child is running
- **THEN** the previous load stops its watcher and refresh timers, and the parent does not get status messages from both loads

### Requirement: Spawn requires a known role
`pmux_spawn` SHALL require an `agent` value. When the value is missing, or no role definition of that name resolves, the call SHALL fail with an error that names `agent` or the role and the searched paths, and SHALL create no pane, write no launch record and start no child. Only the role's existence SHALL be checked: a role with no `model:` SHALL still launch, on pi's default model.

#### Scenario: Missing role
- **WHEN** `pmux_spawn` is called without an `agent` value
- **THEN** the call fails with an error that names `agent`, and no pane is created

#### Scenario: Misspelled role
- **WHEN** `pmux_spawn` is called with agent `wroker` and no role file named `wroker` exists
- **THEN** the tool result is an error that names `wroker` and the searched paths, no pane is created, and no launch record is written

#### Scenario: Role without a model
- **WHEN** `pmux_spawn` is called with an agent whose definition sets no `model:`
- **THEN** the child launches, and pi chooses its default model

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
