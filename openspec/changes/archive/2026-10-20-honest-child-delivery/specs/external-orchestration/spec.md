# Spec Delta

## MODIFIED Requirements

### Requirement: Launch contract
`start` SHALL split a new pane next to the caller's pane without taking focus and name it after the child. It SHALL write a launch spec that starts pi with `--session`, the env vars `pmux-done.ts` reads (with `PI_PMUX_SESSION` equal to `--session`), and the brief as the prompt. It SHALL remove `<session>.status` before it runs that spec, and then run the spec in the pane. On success it SHALL print exactly one JSON document on stdout, giving the pane id, the session file and the launch-spec path. Everything else SHALL go to stderr. Because every `start` is an external-orchestrator launch, it SHALL set `PI_PMUX_EXTERNAL_PARENT=1` in the launch spec env; a pi-parent launch does not set that key. A `resume` reuses the launch spec unchanged, so the resumed child carries the marker too.

#### Scenario: Successful launch
- **WHEN** `start` is given a child name, a role, a working directory, a brief file and the parent's name
- **THEN** a new named pane runs pi in that directory with that session, and stdout is JSON with `pane`, `session` and `launch`

#### Scenario: Hostile names and paths
- **WHEN** the child name contains `;`, `$(...)` and a single quote, and the scratch directory contains a space
- **THEN** the launch succeeds, pi receives the prompt path as one argument, and no injected command runs

#### Scenario: The launch spec carries the external-parent marker
- **WHEN** `start` succeeds and the orchestrator reads the launch spec it wrote
- **THEN** the spec env holds `PI_PMUX_EXTERNAL_PARENT` with the value `1`

#### Scenario: A resume keeps the marker
- **WHEN** a child started with `start` is resumed with `resume --launch <spec>`
- **THEN** the resumed child's environment also carries `PI_PMUX_EXTERNAL_PARENT=1`

#### Scenario: A pi-parent child does not carry the marker
- **WHEN** a pi parent spawns a child with `pmux_spawn`
- **THEN** the child's env has no `PI_PMUX_EXTERNAL_PARENT`

### Requirement: Close on done
After the child exits, the skill-path run wrapper SHALL print `__SUBAGENT_DONE_<exit code>__`. It SHALL then close its own pane through tmux only when `<session>.exit` parses as JSON with `type` equal to `done` or `handoff`, and only after a grace period. The grace period SHALL default to 5000 ms, SHALL be set per launch with `start --close-grace-ms <n>`, and SHALL be stored in the launch spec so that a resume reuses it. A value of `0` closes at once. For any other `.exit` content, unparseable content, or no `.exit`, the pane MUST stay open with the sentinel visible. The wrapper MUST NOT delete the `.exit` file. The wrapper SHALL NOT contact the parent: it SHALL NOT address any pane by title and SHALL NOT type text into any other pane. The orchestrator's wake is the `wait` command, which polls the status file; the report is the child's last assistant message, read with `last-message`.

#### Scenario: Clean completion
- **WHEN** the child calls `pmux_done` and pi exits
- **THEN** after the grace period the child's pane closes, and `<session>.exit` still holds `{"type":"done"}`

#### Scenario: Handoff completion
- **WHEN** the child calls `pmux_done` with a `handoff` and pi exits
- **THEN** after the grace period the child's pane closes, and `<session>.exit` still holds the `handoff` sidecar

#### Scenario: External wait observes done before close
- **WHEN** an orchestrator is blocked in `wait --session <file> --status done,blocked` and the child completes with `pmux_done` under the default grace period
- **THEN** the wait exits 0 before the pane closes

#### Scenario: Immediate close
- **WHEN** the child was started with `--close-grace-ms 0` and completes with `done`
- **THEN** the wrapper closes the pane immediately after printing the sentinel

#### Scenario: Provider error
- **WHEN** pi exits after writing an `error` `.exit`
- **THEN** the pane stays open showing `__SUBAGENT_DONE_<code>__`

#### Scenario: Crash
- **WHEN** pi exits without writing an `.exit` file
- **THEN** the wrapper writes an `error` `.exit` sidecar that marks its source as the wrapper, and the pane stays open showing `__SUBAGENT_DONE_<code>__`

#### Scenario: Malformed sidecar
- **WHEN** `<session>.exit` holds text that is not JSON, or JSON whose `type` is not `done` or `handoff`
- **THEN** the pane stays open

#### Scenario: The wrapper contacts nobody
- **WHEN** a skill-launched child exits and the wrapper prints `__SUBAGENT_DONE_<code>__`
- **THEN** no pane is addressed by title and no text is typed into any pane but the child's own
