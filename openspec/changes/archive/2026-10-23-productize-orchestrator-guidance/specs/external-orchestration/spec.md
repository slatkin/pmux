# Spec Delta

## MODIFIED Requirements

### Requirement: Skill documents the handoff sidecar
`SKILL.md` SHALL tell the orchestrator that a child can end with `{"type":"handoff","message":...}` in `<session>.exit`, which `wait --signal sidecar` reports with the reason `handoff` and the handoff message. It SHALL say that the task is not complete, that the handoff text is in the sidecar, that the pane closes itself after the close grace as for `done`, and that the orchestrator continues the task with a new child through `start`, with the handoff text in the brief.

#### Scenario: Orchestrator reads a handoff
- **WHEN** an orchestrator follows `SKILL.md` and finds a `handoff` sidecar
- **THEN** the skill tells it to start a new child with the handoff text in its brief, not to resume the old session

#### Scenario: Pane gone after the grace
- **WHEN** the wait on a child's status ends and no pane is left after the close grace
- **THEN** the skill tells the orchestrator to run `wait --session <file> --signal sidecar`, where `done` means finished and `handoff` means continue with a new child

### Requirement: The skill waits through the CLI
`SKILL.md` SHALL tell the orchestrator to wait for a child with the CLI `wait` command, run through the launcher. For the `last` mode it SHALL use `node <skill-dir>/launch.ts wait --session <file> --status done,blocked --timeout <seconds>`, then `node <skill-dir>/launch.ts wait --session <file> --signal sidecar` to read the exit, and tell the orchestrator to read the report with `last-message --session <file>`. For the `send` mode it SHALL use `node <skill-dir>/launch.ts wait --session <file> --signal sidecar [--timeout <seconds>]` and tell the orchestrator to act on the printed reason. In both modes the orchestrator SHALL read the exit only through `wait --signal sidecar`: `SKILL.md` SHALL NOT tell it to read `<session>.exit` directly, or to delete, move or write that file. It SHALL NOT document a multiplexer command for the wait or for reading a report.

#### Scenario: The orchestrator waits for a child
- **WHEN** the orchestrator follows `SKILL.md` and waits for a last-mode child
- **THEN** it runs the CLI `wait` command with the child's session file and the `done,blocked` statuses, and then runs `wait --signal sidecar` to read the exit

#### Scenario: The orchestrator reads the report
- **WHEN** the wait returns `done` for a last-mode child
- **THEN** the skill tells the orchestrator to run `last-message --session <file>` for the report

#### Scenario: The orchestrator waits on the sidecar
- **WHEN** the orchestrator follows the send-mode section and is woken by a report
- **THEN** it runs `wait --session <file> --signal sidecar`, reads the printed reason, and leaves the sidecar in place

#### Scenario: No recipe touches the sidecar file
- **WHEN** a reader reads every recipe in `SKILL.md` that handles a child's exit
- **THEN** no recipe reads `<session>.exit` directly, and none tells the orchestrator to `rm` it
