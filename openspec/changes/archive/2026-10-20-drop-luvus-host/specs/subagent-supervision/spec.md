# Spec Delta

## Purpose

The identifiers are renamed, and the supervisor has no event stream to stop.

## MODIFIED Requirements

### Requirement: Launch record at spawn
When `pmux_spawn` starts a pi or Claude Code child, the extension SHALL write a launch record to `<session>.launch.json`, where `<session>` is the child session file. The record SHALL hold the backend, display name, agent name, working directory, model, tool allowlist, role prompt, denied tools, auto-exit and interactive values that the spawn resolved.

#### Scenario: Pi child spawned with an agent
- **WHEN** `pmux_spawn` starts agent `scout` with `cwd` `/repo` and the agent frontmatter sets `spawning: false`
- **THEN** `<session>.launch.json` exists and records backend `pi`, agent `scout`, cwd `/repo`, and the spawning tools in its denied tools

#### Scenario: Claude Code child spawned
- **WHEN** `pmux_spawn` starts an agent whose frontmatter sets `cli: claude`
- **THEN** `<session>.launch.json` exists and records backend `claude`

### Requirement: Resume restores the role configuration
When `pmux_resume` is called with a session file that has a launch record, the extension SHALL start the child with the record's backend, agent name, working directory, model, tool allowlist, role prompt and denied tools. The resumed child SHALL show the record's display name.

#### Scenario: Resumed scout keeps its deny list
- **WHEN** `pmux_resume` resumes a session whose record denies `pmux_spawn`
- **THEN** the resumed child does not have the `pmux_spawn` tool

#### Scenario: Resumed child keeps its working directory
- **WHEN** `pmux_resume` resumes a session whose record has cwd `/repo`, from a parent whose cwd is `/other`
- **THEN** the resumed child runs in `/repo`

#### Scenario: Resumed child keeps its name and agent
- **WHEN** `pmux_resume` resumes a session whose record has name `Worker` and agent `worker`
- **THEN** the pane is named `Worker` and the child runs as agent `worker`

### Requirement: Resume parameters
`pmux_resume` SHALL accept exactly `sessionPath` (required), `message`, `surface` and `autoExit`. When `autoExit` is absent, the record's auto-exit value SHALL apply, and the record's interactive value SHALL apply. When `autoExit` is present, it SHALL override the record, and the run SHALL be interactive exactly when `autoExit` is false.

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

### Requirement: Session end and reload stop the supervision
When the parent session shuts down, the extension SHALL stop watching every running child, stop its widget and status refresh. When the extension module loads again in the same process, it SHALL do the same for the previous load before it starts its own.

#### Scenario: Reload with a running child
- **WHEN** the extension reloads while a child is running
- **THEN** the previous load stops its watcher and refresh timers, and the parent does not get status messages from both loads
