# Spec Delta

## ADDED Requirements

### Requirement: Report mode selection
`start` SHALL accept `--report last|send`, with `last` as the default. In `last` mode the report is the child's last assistant message, as before. In `send` mode the child types its report into the parent's pane with `send`, and `--parent` SHALL be the orchestrator's tmux pane id. Any other value MUST make `start` exit 2 with a stderr message naming the value, before any file is written or any pane is split.

#### Scenario: Default mode
- **WHEN** `start` runs without `--report`
- **THEN** the prompt ends with the `last` footer

#### Scenario: Invalid mode
- **WHEN** `start` runs with `--report email`
- **THEN** it exits 2 with a message on stderr naming `email`, writes no scratch file, and splits no pane

### Requirement: Report mode in the launch spec
In `send` mode the launch spec SHALL hold `report` with the value `send`. In `last` mode the spec SHALL hold no `report` field. A spec with no `report` field SHALL be read as `last`. A spec whose `report` field is present and is neither `last` nor `send` SHALL be invalid.

#### Scenario: Last mode writes no field
- **WHEN** `start` runs without `--report`
- **THEN** the launch spec holds no `report` field

#### Scenario: Send mode is recorded
- **WHEN** `start` runs with `--report send --parent %12`
- **THEN** the launch spec holds `report` with the value `send` and `parent` with the value `%12`

#### Scenario: Unknown stored mode
- **WHEN** `run` is given a launch spec whose `report` is `email`
- **THEN** it exits non-zero naming the file, and no child starts

### Requirement: Send command
The CLI SHALL provide `send --to <pane> --text <text>`. It SHALL type the text into the pane as literal input, followed by one Enter keypress, through the tmux backend's pane-input primitive, without a shell. Text with newlines SHALL be delivered as one paste. A missing `--to` or `--text` MUST fail with an error naming the flag, and nothing is sent.

#### Scenario: Report delivered
- **WHEN** a child runs `send --to %12 --text 'PASS abc123'`
- **THEN** tmux receives `send-keys -t %12 -l 'PASS abc123'` and then `send-keys -t %12 Enter`

#### Scenario: Multiline report
- **WHEN** the text holds several lines
- **THEN** it is sent in one literal paste, followed by one Enter

#### Scenario: Missing flag
- **WHEN** `send` runs without `--text`
- **THEN** it fails with an error naming `--text`, and tmux receives no call

### Requirement: Report receipts
When `send` runs with `PI_PMUX_SESSION` set, it SHALL append, after the delivery, one JSON line `{"at":<ISO time>,"to":<to>,"bytes":<text length>}` to `<PI_PMUX_SESSION>.sent`. When `PI_PMUX_SESSION` is not set, it SHALL write no receipt. A failed receipt write MUST NOT fail the send. `prune` SHALL treat `.sent` files as launcher files, so it deletes them past the retention and keeps them within it.

#### Scenario: Receipt inside a child
- **WHEN** `send --to %12 --text hi` runs with `PI_PMUX_SESSION=/s/w.jsonl`
- **THEN** `/s/w.jsonl.sent` gains one line whose JSON has `to` equal to `%12`, `bytes` equal to `2` and an ISO `at`

#### Scenario: No receipt outside a child
- **WHEN** `send` runs without `PI_PMUX_SESSION`
- **THEN** no `.sent` file is written

#### Scenario: Receipt write fails
- **WHEN** `<session>.sent` cannot be written
- **THEN** `send` still delivers the text and exits 0

#### Scenario: Prune reclaims receipts
- **WHEN** `prune` runs on a scratch directory holding a `.sent` file older than the retention and one within it
- **THEN** the old one is deleted and the fresh one is kept

### Requirement: Send-mode report count
For a send-mode spec with a `parent`, the run wrapper SHALL count the `<session>.sent` lines that parse as JSON and whose `to` equals `parent`, once before the child starts and once after the sentinel. A missing file counts as zero; an unparseable line is skipped. When the count did not grow, the wrapper SHALL send the send-mode wake-up. In `last` mode the wrapper SHALL NOT count and SHALL NOT wake anyone.

#### Scenario: Count grows
- **WHEN** a send-mode child with parent `%12` runs `send --to %12` once and exits
- **THEN** the second count is one more than the first, and no wake-up is sent

### Requirement: Send-mode wake-up
The send-mode wake-up SHALL be one message typed into the parent's pane through the pane-input primitive of `send`, before the close-on-done step. For a `ping` sidecar with a string `message` it SHALL be `<name> pinged: <message>`. Otherwise it SHALL be `<name> <state> without sending a report. Read its last message: node <cli> last-message --session <session>`, where `<state>` is the sidecar `type`, else `exited` for code 0, else `crashed (code <n>)`. A failed wake-up SHALL go to stderr only.

#### Scenario: Exit without a report
- **WHEN** a send-mode child with parent `%12` exits with a `done` sidecar and wrote no receipt
- **THEN** `%12` receives one message naming the child, the state `done` and the `last-message --session <session>` command

#### Scenario: Failed wake-up
- **WHEN** the wake-up cannot be delivered to the parent's pane
- **THEN** the wrapper writes an error naming the parent to stderr, and its exit code is the child's code

#### Scenario: Ping is quoted
- **WHEN** a send-mode child exits with `{"type":"ping","name":"w","message":"Which DB?"}` and no receipt
- **THEN** the parent receives `<name> pinged: Which DB?`

#### Scenario: Crash without a report
- **WHEN** a send-mode child exits with code 2 and wrote no sidecar and no receipt
- **THEN** the wrapper writes its `error` sidecar, and the parent receives a message with the state `error` and the `last-message` command

#### Scenario: Report suppresses the wake-up
- **WHEN** a send-mode child sends its report to its parent and exits
- **THEN** the parent receives no message from the wrapper

#### Scenario: Report to another pane
- **WHEN** a send-mode child sends only to a pane that is not its parent and exits
- **THEN** the parent is still woken

#### Scenario: Malformed receipt line
- **WHEN** the only new line in `<session>.sent` is not JSON
- **THEN** the parent is still woken

#### Scenario: Earlier runs do not count
- **WHEN** a resumed send-mode child exits without a report, and `<session>.sent` holds receipts to the parent from the earlier run
- **THEN** the parent is woken

#### Scenario: Footer placeholders do not count
- **WHEN** a send-mode child exits without running `send`, while its prompt holds the footer's `send` command with placeholders
- **THEN** the parent is woken

#### Scenario: Last mode stays silent
- **WHEN** a last-mode child exits without a report
- **THEN** no text is typed into any pane but the child's own

### Requirement: Wait on the exit sidecar
`wait` SHALL accept `--signal status|sidecar`, with `status` as the default. With `status`, `wait` SHALL behave as before. With `sidecar`, `wait` SHALL poll `<session>.exit` every 500 ms and MUST NOT delete, move or write it. When the file exists, `wait` SHALL print one JSON line, the sidecar decoded by `interpretExitSidecar` plus `sidecar` set to the sidecar's absolute path, and exit 0.

#### Scenario: Sidecar present
- **WHEN** `wait --session <file> --signal sidecar` runs and `<file>.exit` holds `{"type":"done"}`
- **THEN** stdout is one JSON line with `reason` `done` and `sidecar` the absolute sidecar path, the exit code is 0, and the sidecar still exists

#### Scenario: Repeated wait
- **WHEN** the same sidecar wait runs twice
- **THEN** both runs print the same result

#### Scenario: Ping payload
- **WHEN** the sidecar is a `ping`
- **THEN** the printed JSON carries the ping's name and message

#### Scenario: Sidecar appears while polling
- **WHEN** the sidecar is written after the wait starts and before the timeout
- **THEN** the wait prints it and exits 0

#### Scenario: Malformed sidecar
- **WHEN** the sidecar holds text that is not JSON
- **THEN** the wait exits 0 and prints the `done` result, without a crash

### Requirement: Sidecar wait failures
When the timeout of a sidecar wait passes before the sidecar exists, `wait` SHALL print `{"sidecar":null}` on stdout and a timeout message on stderr, and exit 2. A missing `--session`, a bad `--timeout`, an unknown `--signal` value, or `--status` given together with `--signal sidecar` SHALL be a usage error: a message on stderr, nothing on stdout, exit 1.

#### Scenario: Timeout
- **WHEN** no sidecar appears before the timeout
- **THEN** stdout is `{"sidecar":null}`, stderr holds a timeout message, and the exit code is 2

#### Scenario: Usage error
- **WHEN** `wait --signal sidecar` runs without `--session`, or with `--signal fast`, or with `--status done`
- **THEN** the exit code is 1 and stdout is empty

## MODIFIED Requirements

### Requirement: Packaged orchestration skill
The package SHALL ship a `pmux` skill at `skills/pmux/` with its `SKILL.md` and a TypeScript launcher shim, `launch.ts`, which runs under `node`. The skill directory MUST NOT contain shell scripts. The skill MUST be installable with the `npx skills` CLI from the GitHub repository or a local checkout, and MUST work when the CLI copies the directory instead of linking it. It MUST be listed in the package manifest `files`, so a packaged install carries it. The pi manifest MUST NOT register the skill. `SKILL.md` SHALL document the tmux protocol: the launch commands, the `wait` command, the completion signal, the close-on-done behaviour and the report lookup. It SHALL tell the orchestrator to read `<session>.exit` after a wait, because the sidecar says whether the child finished, handed off, pinged or failed. `SKILL.md` SHALL have a section named "External orchestrators (Claude Code)" that documents the `send` mode: start with `--report send` and `--parent "$TMUX_PANE"`; the report arrives as text typed into the orchestrator's pane; wait with `--signal sidecar`; leave the sidecar in place, because the wrapper reads it after the child exits, `start` and `resume` clear it on relaunch, and `prune` reclaims it; and `resume --launch <spec> --prompt <file>` appends the footer again. The skill's frontmatter description SHALL say that the skill serves external orchestrators such as Claude Code.

#### Scenario: Install from GitHub
- **WHEN** a user runs `npx skills add slatkin/pmux -g -a claude-code`
- **THEN** the `pmux` skill, with `launch.ts`, is installed for Claude Code

#### Scenario: Copied install still launches
- **WHEN** the skill directory is a copy outside any checkout and the extension is installed through pi's git install
- **THEN** `node <skill-dir>/launch.ts start ...` finds the extension and launches the child

#### Scenario: Pi does not load the skill
- **WHEN** the package is installed into pi with `pi install`
- **THEN** pi's skill list does not include `pmux`

#### Scenario: The skill teaches send mode
- **WHEN** an external orchestrator follows the "External orchestrators (Claude Code)" section
- **THEN** it starts the child with `--report send --parent "$TMUX_PANE"`, ends its turn, waits with `--signal sidecar` when it is woken, and does not delete the sidecar

### Requirement: Parent-contact footer
`start` SHALL append a footer to the brief. In `last` mode the footer SHALL give the parent's name and pane, tell the child that its last assistant message is the report the parent reads and that it SHALL then call `pmux_done`, and tell the child not to use `caller_ping` or `pmux_message` to reach the parent; its text SHALL be the same bytes as before the `--report` flag existed. In `send` mode the footer SHALL name the parent's pane, and SHALL teach `node <cli> send --to <parent pane> --text '<report>'`, where `<cli>` is the absolute path of the package's `cli.ts`, as the report step, followed by a call to `pmux_done`. It SHALL tell a blocked child to send its question with the same command and stop. It SHALL tell the child to ignore a reminder's claim that its last message was already delivered, and to send its report first. The `send` footer MUST NOT say that the last assistant message is delivered or read as the report.

#### Scenario: Footer names the parent
- **WHEN** `start` runs with parent name `orch` from pane `%12` in `last` mode
- **THEN** the prompt the child receives ends with a footer naming the parent `orch` and pane `%12`, and states that the last assistant message is the report

#### Scenario: Send footer teaches the command
- **WHEN** `start` runs with `--report send --parent %12`
- **THEN** the prompt ends with a footer that holds `node <cli> send --to %12 --text`, names `pmux_done`, tells a blocked child to send its question and stop, and does not say that the last assistant message is the report

#### Scenario: Send footer overrides the nudge
- **WHEN** a send-mode child reads its footer
- **THEN** the footer tells it to ignore a reminder's claim that its last message was already delivered, and to send its report before it calls `pmux_done`

### Requirement: Close on done
After the child exits, the skill-path run wrapper SHALL print `__SUBAGENT_DONE_<exit code>__`. It SHALL then close its own pane through tmux only when `<session>.exit` parses as JSON with `type` equal to `done` or `handoff`, and only after a grace period. The grace period SHALL default to 5000 ms, SHALL be set per launch with `start --close-grace-ms <n>`, and SHALL be stored in the launch spec so that a resume reuses it. A value of `0` closes at once. For any other `.exit` content, unparseable content, or no `.exit`, the pane MUST stay open with the sentinel visible. The wrapper MUST NOT delete the `.exit` file. In `last` mode the wrapper SHALL NOT contact the parent: it SHALL NOT address any pane by title and SHALL NOT type text into any other pane; the orchestrator's wake is the `wait` command, which polls the status file, and the report is the child's last assistant message, read with `last-message`. In `send` mode the wrapper SHALL contact the parent only by the send-mode wake-up, and SHALL NOT address any pane by title.

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
- **WHEN** a last-mode skill-launched child exits and the wrapper prints `__SUBAGENT_DONE_<code>__`
- **THEN** no pane is addressed by title and no text is typed into any pane but the child's own

#### Scenario: Send mode wakes before it closes
- **WHEN** a send-mode child exits with a `done` sidecar and no receipt to its parent
- **THEN** the wrapper sends the wake-up to the parent's pane, and then closes its own pane after the grace

### Requirement: Resume in a new pane
`resume --launch <spec> --prompt <file> [--name <child>]` SHALL create a new pane by the tmux-backend placement rule, with the caller's pane as the anchor, name it (after `--name`, or the child name stored in the spec), and run the existing launch spec there with the new prompt, so that pi resumes the same session with its context. When the spec holds a `parent`, the prompt sent to the child SHALL be the given prompt followed by the parent-contact footer of the spec's report mode, built from the spec's `parent`. Resume MUST NOT need the child's previous pane to exist. The surface SHALL be the role surface stored in the spec, else the `config.json` default. On success it SHALL print JSON with `pane` and `launch`.

#### Scenario: Resume after close-on-done
- **WHEN** a child's pane closed on done and the orchestrator resumes it with a follow-up prompt
- **THEN** a new pane runs pi on the same session file, and the child keeps its earlier context

#### Scenario: Resume keeps the role's float
- **WHEN** a child of a role with `surface: float` was started with `start`, and it is resumed with `resume`
- **THEN** the resumed child opens as a float

#### Scenario: Spec without a role surface
- **WHEN** a child is resumed from a launch spec that holds no role surface
- **THEN** the `config.json` default applies

#### Scenario: Resume keeps the send footer
- **WHEN** a child started with `--report send --parent %12` is resumed with a follow-up prompt
- **THEN** the prompt the resumed child receives ends with the `send` footer naming pane `%12`

#### Scenario: Resume keeps the last footer
- **WHEN** a child started without `--report` is resumed with a follow-up prompt
- **THEN** the prompt the resumed child receives ends with the `last` footer

### Requirement: The skill waits through the CLI
`SKILL.md` SHALL tell the orchestrator to wait for a child with the CLI `wait` command, run through the launcher. For the `last` mode it SHALL use `node <skill-dir>/launch.ts wait --session <file> --status done,blocked --timeout <seconds>`, tell the orchestrator to read the report with `last-message --session <file>`, and to read `<session>.exit` when the wait ends. For the `send` mode it SHALL use `node <skill-dir>/launch.ts wait --session <file> --signal sidecar [--timeout <seconds>]` and tell the orchestrator to act on the printed reason without deleting the sidecar. It SHALL NOT document a multiplexer command for the wait or for reading a report.

#### Scenario: The orchestrator waits for a child
- **WHEN** the orchestrator follows `SKILL.md` and waits for a last-mode child
- **THEN** it runs the CLI `wait` command with the child's session file and the `done,blocked` statuses, and reads the sidecar when the wait ends

#### Scenario: The orchestrator reads the report
- **WHEN** the wait returns `done` for a last-mode child
- **THEN** the skill tells the orchestrator to run `last-message --session <file>` for the report

#### Scenario: The orchestrator waits on the sidecar
- **WHEN** the orchestrator follows the send-mode section and is woken by a report
- **THEN** it runs `wait --session <file> --signal sidecar`, reads the printed reason, and leaves the sidecar in place
