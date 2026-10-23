# Pane Lifecycle

## Purpose

Defines how the subagents extension opens, drives, observes, interrupts and closes subagent panes in the terminal host. The tmux-specific mechanics live in `tmux-backend`.

## Requirements

### Requirement: Subagent launch runs in the pane
For every pi and Claude Code subagent launch and resume, the extension SHALL write a launch spec file and run one command line in the new pane through tmux (`send-keys`): `node "<cli.ts>" run "<spec>"`. No shell script SHALL be written, and the command line SHALL NOT depend on which interactive shell the pane runs. The pane-side wrapper SHALL print `__SUBAGENT_DONE_<code>__` after the child exits. For pi-parent launches it SHALL NOT close the pane, because the parent closes the pane after it reads the result.

#### Scenario: Fish user shell
- **WHEN** the user's `SHELL` is fish and a subagent is spawned
- **THEN** the pi child starts, and a crash still prints the `__SUBAGENT_DONE_<code>__` sentinel with the child's exit code

#### Scenario: No script file
- **WHEN** a subagent is spawned or resumed
- **THEN** no `.sh` file is written, and the only text sent with `pane run` is the single `node ... run ...` command line

#### Scenario: Parent owns the close
- **WHEN** a pi-parent child exits after writing a `done` sidecar
- **THEN** the wrapper leaves the pane open, and the parent's completion detection reads the sidecar and closes the pane

### Requirement: Interrupt sends Escape

`pmux_interrupt` SHALL send Escape to the target subagent's pane through tmux. If the call fails, the tool MUST return an error that names the subagent and gives the tmux error.

#### Scenario: Interrupt a running subagent
- **WHEN** `pmux_interrupt` is called for a running subagent
- **THEN** its pane receives Escape, the child's current turn is aborted, and the subagent keeps running

#### Scenario: Pane already gone
- **WHEN** the tmux call fails because the pane no longer exists
- **THEN** the tool returns an error of the form `Failed to send Escape to subagent "<name>" via tmux: <message>`

### Requirement: Current pi packages
The extension SHALL import from `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` and load in the current pi release. No `@mariozechner/*` import SHALL remain.

#### Scenario: Load in current pi
- **WHEN** pi (the `@earendil-works` release) starts with the extension installed
- **THEN** it registers all subagent tools and commands without import or type errors

### Requirement: Subagent panes are named and titled

Spawning or resuming a subagent SHALL name the new pane after the subagent. If the split returns an error or no pane id can be found, the tool MUST return an error result that includes the tmux error message, and nothing SHALL run in a pane.

The extension SHALL also title the new pane: the run wrapper writes an OSC 2 title sequence to the pane's terminal after a delay, so that the emission lands after the child has initialized its terminal. The title text SHALL be `"<name> — <task>"`, where `<task>` is the first non-empty line of the task (or of the resume message), truncated to 48 characters. When no task text is available, the title SHALL be the name alone. Title text SHALL be sanitized: control characters, escape-sequence introducers and OSC terminators SHALL be removed from the derived title, so that untrusted task text cannot inject terminal control sequences. Title emission SHALL be best-effort: a failure to emit the title SHALL NOT fail the spawn, alter the tool result, or change the child's exit code. The caller's own pane SHALL NOT be titled by this extension.

#### Scenario: Successful spawn
- **WHEN** `pmux_spawn` is called with name "Scout" inside tmux
- **THEN** a new pane appears next to the caller's pane, focus stays on the caller's pane, and the new pane is named "Scout"

#### Scenario: Pane carries an OSC title
- **WHEN** `pmux_spawn` is spawned with name "Scout" and a task whose first line is "Fix the login bug"
- **THEN** the pane's run wrapper emits an OSC 2 sequence whose title text is `Scout — Fix the login bug`, sanitized of control characters

#### Scenario: Task text is hostile
- **WHEN** the task's first line contains escape sequences or control characters (for example an embedded `ESC [2J`)
- **THEN** the emitted title contains the printable characters only, with the control sequences stripped

#### Scenario: No task text
- **WHEN** `pmux_spawn` is called with an empty task
- **THEN** the pane's OSC title is the subagent name alone

#### Scenario: Resume
- **WHEN** `pmux_resume` opens a session with name "Resume"
- **THEN** the resumed pane's run wrapper emits an OSC 2 title derived from the name and, when provided, the follow-up message

#### Scenario: Title emission is best-effort
- **WHEN** writing the title sequence fails (for any reason)
- **THEN** the subagent still launches and the tool result is unchanged

#### Scenario: Split fails
- **WHEN** tmux answers the split with an error
- **THEN** the tool returns an error result containing the tmux error message, and nothing is run in a pane

### Requirement: Pane closes when the wait ends

When the wait for a pi subagent ends for any reason (done, ping, sentinel, error or abort), the extension SHALL close the subagent's pane through tmux. For Claude Code subagents without a sentinel summary, the extension SHALL read up to 200 lines of pane output as the summary before closing. A failure to close the pane MUST NOT change the result that the sidecar or sentinel produced.

#### Scenario: Normal completion
- **WHEN** the child calls `pmux_done` and the `.exit` file appears
- **THEN** the parent receives the result and the subagent's pane is closed

#### Scenario: Pane already closed
- **WHEN** the child writes a `done` `.exit` file and the pane is closed before the parent closes it
- **THEN** the parent reports the child's successful result with exit code 0, not a subagent error
