# Spec Delta

## MODIFIED Requirements

### Requirement: Child extension lookup
The skill launcher SHALL find the package root, meaning a directory that holds `pi-extension/pmux/cli.ts`, `pmux-done.ts` and `hang-guard.ts`, in this order: the `PI_PMUX_DIR` directory, then the checkout containing the launcher's resolved real path, then pi's git install of this package under the pi agent directory (`PI_CODING_AGENT_DIR`, or `~/.pi/agent`, followed by `git/github.com/slatkin/pmux`). Paths SHALL be built with the platform's path rules. The child SHALL be launched with `-e` on that root's `pmux-done.ts` and `hang-guard.ts`. When no candidate holds the files, the launcher MUST exit non-zero, print an error naming the `pi install` command and the candidates searched, and create no pane.

#### Scenario: Dev override
- **WHEN** `PI_PMUX_DIR` points at a checkout containing `pi-extension/pmux/pmux-done.ts` and `hang-guard.ts`
- **THEN** the child is launched with `-e` on both files

#### Scenario: Extension not installed
- **WHEN** no candidate location holds the extension files
- **THEN** the launcher exits non-zero with an error naming `pi install`, and no pane is split

### Requirement: Launch contract
`start` SHALL create a new pane by the tmux-backend placement rule, with the caller's pane as the anchor, without taking focus, and name it after the child. It SHALL write a launch spec that starts pi with `--session`, the env vars `pmux-done.ts` reads (with `PI_PMUX_SESSION` equal to `--session`), and the brief as the prompt. The spec's env SHALL carry `PI_PMUX_GUARD_MODE` resolved by the mode rule in the command-hang-guard spec — `yolo` for an external-orchestrator child — and the spec's pi argv SHALL carry `--no-guard` exactly when the child's pi config lists an installed `pi-hang-guard` package. It SHALL remove `<session>.status` before it runs that spec, and then run the spec in the pane. On success it SHALL print exactly one JSON document on stdout, giving the pane id, the session file and the launch-spec path. Everything else SHALL go to stderr. Because every `start` is an external-orchestrator launch, it SHALL set `PI_PMUX_EXTERNAL_PARENT=1` in the launch spec env; a pi-parent launch does not set that key. A `resume` rebuilds the launch spec from the launch record with the same external parent, so the resumed child carries the marker too. A `send`-mode spec SHALL also carry `PI_PMUX_REPORT_PROTOCOL` with the value `file-ack-v1`, which selects the file, pointer and acknowledgement protocol in `send` and in the run wrapper; a `last`-mode spec and a pi-parent launch SHALL NOT set it.

#### Scenario: Successful launch
- **WHEN** `start` is given a child name, a role, a working directory, a brief file and the parent's name
- **THEN** a new named pane runs pi in that directory with that session, and stdout is JSON with `pane`, `session` and `launch`

#### Scenario: Second launch from the same orchestrator
- **WHEN** the orchestrator in pane `%3` ran `start` once, its child pane `%5` is still alive, and it runs `start` again
- **THEN** the new pane is created by splitting `%5`, not `%3`

#### Scenario: Hostile names and paths
- **WHEN** the child name contains `;`, `$(...)` and a single quote, and the scratch directory contains a space
- **THEN** the launch succeeds, pi receives the prompt path as one argument, and no injected command runs

#### Scenario: The launch spec carries the external-parent marker
- **WHEN** `start` succeeds and the orchestrator reads the launch spec it wrote
- **THEN** the spec env holds `PI_PMUX_EXTERNAL_PARENT` with the value `1`

#### Scenario: The launch spec carries the guard mode
- **WHEN** `start` succeeds and the orchestrator reads the launch spec it wrote
- **THEN** the spec env holds `PI_PMUX_GUARD_MODE` with the value `yolo`

#### Scenario: The launch spec carries the report protocol marker
- **WHEN** `start` runs with `--report send` and the orchestrator reads the launch spec it wrote
- **THEN** the spec env holds `PI_PMUX_REPORT_PROTOCOL` with the value `file-ack-v1`

#### Scenario: A last-mode spec carries no protocol marker
- **WHEN** `start` runs without `--report`
- **THEN** the spec env has no `PI_PMUX_REPORT_PROTOCOL`

#### Scenario: A resume keeps the marker
- **WHEN** a child started with `start` is resumed with `resume --launch <spec>`
- **THEN** the resumed child's environment also carries `PI_PMUX_EXTERNAL_PARENT=1`

#### Scenario: A pi-parent child does not carry the marker
- **WHEN** a pi parent spawns a child with `pmux_spawn`
- **THEN** the child's env has no `PI_PMUX_EXTERNAL_PARENT`
- **THEN** no pane is addressed by title and no text is typed into any pane but the child's own
