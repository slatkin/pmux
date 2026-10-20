# Spec Delta

## Purpose

The external orchestration contract moves from Luvus panes to tmux panes: the
skill launches into tmux, waits on the status file and the sidecar, and reads
the report from the session file.

## MODIFIED Requirements

### Requirement: Packaged orchestration skill

The package SHALL ship the skill in `skills/pmux/`, and the skill SHALL
document the tmux protocol: the launch commands, the wait command, the
completion signal, the close-on-done behaviour and the report lookup.

#### Scenario: The orchestrator installs the skill
- **WHEN** an orchestrator installs the skill from this package
- **THEN** the skill describes launching into a tmux pane, waiting for the child's status, and reading the report from the session file

### Requirement: Child extension lookup

The launcher SHALL find the package's CLI and the child extension in
`pi-extension/pmux/`, and SHALL report both paths when it cannot find them.

#### Scenario: The package is installed from GitHub
- **WHEN** the launcher resolves the package under the agent config directory
- **THEN** it uses `pi-extension/pmux/cli.ts` and `pi-extension/pmux/pmux-done.ts`

### Requirement: tmux is required for launch

`start` and `resume` SHALL refuse to run unless `TMUX` and `TMUX_PANE` are
both set. They SHALL call tmux only through the `tmux` binary, with the
caller's pane id taken from `TMUX_PANE`.

#### Scenario: Run outside tmux
- **WHEN** `start` runs with `TMUX_PANE` unset
- **THEN** it exits non-zero with an error saying it must run inside a tmux pane, and creates nothing

### Requirement: Launch contract

`start` SHALL split a new pane next to the caller's pane without taking
focus and name it after the child. It SHALL write a launch spec that starts
pi with `--session`, the env vars the done extension reads (with
`PI_PMUX_SESSION` equal to `--session`), and the brief as the prompt. It
SHALL then run that spec in the pane. On success it SHALL print exactly one
JSON document on stdout, giving the pane id, the session file and the
launch-spec path. Everything else SHALL go to stderr.

#### Scenario: Successful launch
- **WHEN** `start` is given a child name, a role, a working directory, a brief file and the parent's name
- **THEN** a new named pane runs pi in that directory with that session, and stdout is JSON with `pane`, `session` and `launch`

#### Scenario: Hostile names and paths
- **WHEN** the child name contains `;`, `$(...)` and a single quote, and the scratch directory contains a space
- **THEN** the launch succeeds, pi receives the prompt path as one argument, and no injected command runs

### Requirement: Parent-contact footer

`start` SHALL append a footer to the brief that gives the parent's name and
pane. The footer SHALL tell the child that its last assistant message is the
report the parent reads, and that it SHALL then call `pmux_done`. It SHALL
tell the child not to use `caller_ping` or `pmux_message` to reach the parent.

#### Scenario: Footer names the parent
- **WHEN** `start` runs with parent name `orch` from pane `%12`
- **THEN** the prompt the child receives ends with a footer naming the parent `orch` and pane `%12`, and states that the last assistant message is the report

### Requirement: Close on done

After the child exits, the skill-path run wrapper SHALL print
`__SUBAGENT_DONE_<exit code>__`. It SHALL then close its own pane through
tmux only when `<session>.exit` parses as JSON with `type` equal to `done` or
`handoff`, and only after a grace period. The grace period SHALL default to
5000 ms, SHALL be set per launch with `start --close-grace-ms <n>`, and
SHALL be stored in the launch spec so that a resume reuses it. A value of `0`
closes at once. For any other `.exit` content, unparseable content, or no
`.exit`, the pane MUST stay open with the sentinel visible. The wrapper MUST
NOT delete the `.exit` file.

#### Scenario: Clean completion
- **WHEN** the child calls `pmux_done` and pi exits
- **THEN** after the grace period the child's pane closes, and `<session>.exit` still holds `{"type":"done"}`

### Requirement: Skill documents the handoff sidecar

`SKILL.md` SHALL tell the orchestrator that a child can end with
`{"type":"handoff","message":...}` in `<session>.exit`. It SHALL say that the
task is not complete, that the handoff text is in the sidecar, that the pane
closes itself after the close grace as for `done`, and that the orchestrator
continues the task with a new child through `start`, with the handoff text in
the brief.

#### Scenario: Orchestrator reads a handoff
- **WHEN** an orchestrator follows `SKILL.md` and finds a `handoff` sidecar
- **THEN** the skill tells it to start a new child with the handoff text in its brief, not to resume the old session

#### Scenario: Pane gone after the grace
- **WHEN** the wait on a child's status ends with no pane left after the close grace
- **THEN** the skill tells the orchestrator to read `<session>.exit`, where `done` means finished and `handoff` means continue with a new child

## ADDED Requirements

### Requirement: The skill waits through the CLI

`SKILL.md` SHALL tell the orchestrator to wait for a child with the CLI's
`wait` command, naming the session file, the wanted statuses and the
timeout, and SHALL tell it to read `<session>.exit` when the wait ends
without a wanted status. It SHALL NOT document a multiplexer command for the
wait or for reading a report.

#### Scenario: The orchestrator waits for a child
- **WHEN** the orchestrator follows `SKILL.md` and waits for a child
- **THEN** it runs the CLI `wait` command with the child's session file and the `done,blocked` statuses, and reads the sidecar when the wait ends otherwise
