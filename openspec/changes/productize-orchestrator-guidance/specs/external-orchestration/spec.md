# Spec Delta

## ADDED Requirements

### Requirement: Orchestrator pane titled once
`start` SHALL title the caller's pane (`TMUX_PANE`) `<window-name>-orchestrator`, unless the pane already carries the titled marker. `start` SHALL set that marker on the pane when it sets the title, so later launches and a user's own retitle are left alone.

#### Scenario: First start titles the caller pane
- **WHEN** an orchestrator in a window named `mychange` runs its first `start`
- **THEN** the caller's pane is titled `mychange-orchestrator` and carries the titled marker

#### Scenario: Marked pane keeps its title
- **WHEN** `start` runs from a pane that already carries the titled marker
- **THEN** the pane's title is not changed

### Requirement: Sidecar wait names the next action
The JSON a `wait --signal sidecar` prints SHALL carry a `hint` field: one sentence naming the next action for the reported reason. A `ping` hint SHALL name `resume`, a `handoff` hint SHALL name `start` of a new child, a `done` hint SHALL name the report, and an `error` hint SHALL name `last-message`.

#### Scenario: Ping hint
- **WHEN** the sidecar is a `ping`
- **THEN** the printed JSON's `hint` tells the caller to answer with `resume --launch <spec> --prompt <file>`

#### Scenario: Handoff hint
- **WHEN** the sidecar is a `handoff`
- **THEN** the printed JSON's `hint` tells the caller to start a new child with the handoff text in its brief

#### Scenario: Done hint
- **WHEN** the sidecar is a `done`
- **THEN** the printed JSON's `hint` tells the caller the report is the last assistant message or was typed into its pane

#### Scenario: Error hint
- **WHEN** the sidecar is an `error`
- **THEN** the printed JSON's `hint` names `last-message --session <session>`

### Requirement: Nudge command
The CLI SHALL provide `nudge --pane <pane> --text <text>`, which types the text into the pane through the pane-input primitive the `send` command uses — one line plus one Enter keypress, encoded the same way — and prints one JSON line on stdout. A missing `--pane` or `--text` MUST be a usage error: a message on stderr, nothing on stdout, exit 1, and nothing typed.

#### Scenario: Nudge delivered
- **WHEN** `nudge --pane %5 --text 'status?'` runs
- **THEN** tmux receives the encoded text as literal input followed by one Enter keypress, and stdout holds one JSON line naming the pane

#### Scenario: Missing flag
- **WHEN** `nudge` runs without `--text`
- **THEN** it exits 1 with an error naming `--text` on stderr, stdout is empty, and tmux receives no call

### Requirement: Close command
The CLI SHALL provide `close --pane <pane>`. Every pane `start` or `resume` creates SHALL carry a pmux ownership marker option. `close` SHALL kill the named pane only when it carries that marker, SHALL print one confirmation line on stdout, and MUST refuse a pane without the marker: a message on stderr, a non-zero exit, and the pane left alone.

#### Scenario: Close an owned pane
- **WHEN** `close --pane <pane>` names a pane `start` created
- **THEN** the pane is killed and stdout holds one confirmation line

#### Scenario: Refuse a foreign pane
- **WHEN** `close --pane <pane>` names a pane without the ownership marker
- **THEN** the command exits non-zero with a refusal on stderr, and the pane stays open

### Requirement: Skill recipes use the CLI
`SKILL.md` SHALL use the `nudge` command for the idle-child recipe and the `close` command for pane cleanup, and SHALL NOT give the orchestrator a `tmux send-keys` or `tmux kill-pane` recipe. It SHALL describe the `hint` field of the sidecar-wait JSON as the next action to follow.

#### Scenario: The nudge recipe uses the CLI
- **WHEN** an orchestrator follows the idle-child recipe
- **THEN** the skill tells it to run `nudge --pane <pane> --text <text>`, with no `send-keys` command

#### Scenario: The cleanup recipe uses the CLI
- **WHEN** an orchestrator follows the pane-cleanup recipe
- **THEN** the skill tells it to run `close --pane <pane>`, with no `kill-pane` command

## MODIFIED Requirements

### Requirement: Sidecar wait failures
When the timeout of a sidecar wait passes before the sidecar exists, `wait` SHALL print `{"sidecar":null,"hint":<hint>}` on stdout, where `<hint>` tells the caller the child may still be working and names waiting again or the `nudge` command, plus a timeout message on stderr, and exit 2. A missing `--session`, a bad `--timeout`, an unknown `--signal` value, or a `--status` flag given together with `--signal sidecar` SHALL be a usage error: a message on stderr, nothing on stdout, exit 1. The `--status` check SHALL test flag presence, not its resolved value.

#### Scenario: Timeout
- **WHEN** no sidecar appears before the timeout
- **THEN** stdout is `{"sidecar":null,"hint":...}`, stderr holds a timeout message, and the exit code is 2

#### Scenario: Usage error
- **WHEN** `wait --signal sidecar` runs without `--session`, or with `--signal fast`, or with an explicit `--status done`
- **THEN** the exit code is 1 and stdout is empty

#### Scenario: The default status does not count as given
- **WHEN** `wait --session <file> --signal sidecar` runs without `--status`
- **THEN** it is not a usage error, and it waits on the sidecar

### Requirement: Every command answers on success
Every CLI command SHALL print at least one line on stdout when it succeeds, so an agent that ran it can read the result. A command that succeeds silently MUST NOT be added: an agent that cannot read a result either guesses at it or probes the host with another command. A usage error SHALL print its message on stderr, print nothing on stdout and exit non-zero.

#### Scenario: The commands answer
- **WHEN** `start`, `resume`, `send`, `wait`, `prune`, `last-message`, `nudge` or `close` succeeds
- **THEN** it printed at least one line on stdout

#### Scenario: A usage error stays on stderr
- **WHEN** any of those commands runs with a missing or unusable flag
- **THEN** it printed a message on stderr, printed nothing on stdout and exited non-zero
