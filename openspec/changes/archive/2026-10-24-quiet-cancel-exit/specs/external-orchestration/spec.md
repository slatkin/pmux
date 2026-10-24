# Spec Delta

## MODIFIED Requirements

### Requirement: Packaged orchestration skill
The package SHALL ship a `pmux` skill at `skills/pmux/` with its `SKILL.md` and a TypeScript launcher shim, `launch.ts`, which runs under `node`. The skill directory MUST NOT contain shell scripts. The skill MUST be installable with the `npx skills` CLI from the GitHub repository or a local checkout, and MUST work when the CLI copies the directory instead of linking it. It MUST be listed in the package manifest `files`, so a packaged install carries it. The pi manifest MUST NOT register the skill. `SKILL.md` SHALL document the tmux protocol: the launch commands, the `wait` command, the completion signal, the close-on-done behaviour and the report lookup. It SHALL tell the orchestrator to read `<session>.exit` after a wait, because the sidecar says whether the child finished, handed off, pinged, failed or was cancelled by the user. It SHALL say that a `cancelled` sidecar means the user stopped the child with Escape: the child has exited, its pane closes, no report is coming, and no wake-up is sent. It SHALL say that a `wait --signal status` returns `done` on a cancel, and that the orchestrator must not resume or replace a cancelled child unless the user asks. The statement that there is no channel from the child back to the orchestrator, and the bullet that the report is the child's last assistant message, SHALL be scoped to the default `last` mode and SHALL point at the new section, so that neither reads as false in `send` mode. The shared recipes that assume a last-mode child SHALL say that they apply to `last` mode only: the idle-child nudge text in `SKILL.md`, the `wait` paragraph in `docs/guide.md`, and the external-orchestrator paragraph in `README.md`. `SKILL.md` SHALL have a section named "External orchestrators (Claude Code)" that documents the `send` mode: start with `--report send` and `--parent "$TMUX_PANE"`; the report arrives as text typed into the orchestrator's pane; wait with `--signal sidecar`; leave the sidecar in place, because the wrapper reads it after the child exits, `start` and `resume` clear it on relaunch, and `prune` reclaims it; and `resume --launch <spec> --prompt <file>` appends the footer again. The skill's frontmatter description SHALL say that the skill serves external orchestrators such as Claude Code. A recipe SHALL be stated once in `SKILL.md`: the follow-up `resume` recipe lives in "While it runs / after", and the "External orchestrators (Claude Code)" section points at it, keeping only the send-mode fact that `resume` re-appends the send footer.

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

#### Scenario: The last-mode claims are scoped
- **WHEN** a reader reads the skill's intro, the "The report" bullet, or the idle-child nudge recipe
- **THEN** each says that it describes the default `last` mode, and the intro points at the "External orchestrators (Claude Code)" section

#### Scenario: The follow-up recipe is stated once
- **WHEN** a reader reads the "External orchestrators (Claude Code)" section and then "While it runs / after"
- **THEN** the `resume` command, the `<spec>` field and the "no launch record" rule appear once, in "While it runs / after", and the external-orchestrator section points at it and says that `resume` re-appends the send footer

#### Scenario: The skill explains a cancel
- **WHEN** a reader reads how to interpret `<session>.exit` after a wait
- **THEN** the text says that `{"type":"cancelled"}` means the user stopped the child, that the child has exited and its pane closes, that no wake-up is sent, and that the orchestrator must not resume or replace the child unless the user asks

### Requirement: Close on done
After the child exits, the skill-path run wrapper SHALL print `__SUBAGENT_DONE_<exit code>__`. It SHALL then close its own pane through tmux only when `<session>.exit` parses as JSON with `type` equal to `done`, `handoff` or `cancelled`, and only after a grace period. The grace period SHALL default to 5000 ms, SHALL be set per launch with `start --close-grace-ms <n>`, and SHALL be stored in the launch spec so that a resume reuses it. A value of `0` closes at once. For any other `.exit` content, unparseable content, or no `.exit`, the pane MUST stay open with the sentinel visible. The wrapper MUST NOT delete the `.exit` file. In `last` mode the wrapper SHALL NOT contact the parent: it SHALL NOT address any pane by title and SHALL NOT type text into any other pane; the orchestrator's wake is the `wait` command, which polls the status file, and the report is the child's last assistant message, read with `last-message`. In `send` mode the wrapper SHALL contact the parent only by the send-mode wake-up, and SHALL NOT address any pane by title.

#### Scenario: Clean completion
- **WHEN** the child calls `pmux_done` and pi exits
- **THEN** after the grace period the child's pane closes, and `<session>.exit` still holds `{"type":"done"}`

#### Scenario: Handoff completion
- **WHEN** the child calls `pmux_done` with a `handoff` and pi exits
- **THEN** after the grace period the child's pane closes, and `<session>.exit` still holds the `handoff` sidecar

#### Scenario: External wait observes done before close
- **WHEN** an orchestrator is blocked in `wait --session <file> --status done,blocked` and the child completes with `pmux_done` under the default grace period
- **THEN** the wait exits 0 before the pane closes

#### Scenario: User cancel
- **WHEN** the user presses Escape in the child's pane and pi exits after writing the `cancelled` sidecar
- **THEN** after the grace period the child's pane closes, and `<session>.exit` still holds `{"type":"cancelled"}`

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

### Requirement: Send-mode wake-up
The wrapper SHALL NOT send the wake-up when `<session>.exit` holds `{"type":"cancelled"}`: a user cancel wakes no one. Otherwise the send-mode wake-up SHALL be one message typed into the parent's pane through the pane-input primitive of `send`, before the close-on-done step. Its text SHALL be encoded the way the `send` command encodes its text, so a ping question that spans lines reaches the parent as one input. For a `ping` sidecar with a string `message` it SHALL be `<name> pinged: <message>`. Otherwise it SHALL be `<name> <state> without sending a report. Read its last message: node <cli> last-message --session <session>`, where `<state>` is the sidecar `type`, else `exited` for code 0, else `crashed (code <n>)`. A failed wake-up SHALL go to stderr only.

#### Scenario: Exit without a report
- **WHEN** a send-mode child with parent `%12` exits with a `done` sidecar and wrote no receipt
- **THEN** `%12` receives one message naming the child, the state `done` and the `last-message --session <session>` command

#### Scenario: A cancel sends no wake-up
- **WHEN** a send-mode child with parent `%12` exits with a `cancelled` sidecar and wrote no receipt
- **THEN** `%12` receives nothing

#### Scenario: Failed wake-up
- **WHEN** the wake-up cannot be delivered to the parent's pane
- **THEN** the wrapper writes an error naming the parent to stderr, and its exit code is the child's code

#### Scenario: Ping is quoted
- **WHEN** a send-mode child exits with `{"type":"ping","name":"w","message":"Which DB?"}` and no receipt
- **THEN** the parent receives `<name> pinged: Which DB?`

#### Scenario: A ping question that spans lines
- **WHEN** a send-mode child exits with a ping sidecar whose message holds a line break, and no receipt
- **THEN** the parent receives one message, with the line break written as the two characters `\n`

#### Scenario: The name is the launch spec's name
- **WHEN** a send-mode child launched as `worker-a` exits and its own sidecar names `w`
- **THEN** the wake-up text names `worker-a`

#### Scenario: Crash without a report
- **WHEN** a send-mode child exits with code 2, wrote no sidecar, left no terminal status, and wrote no receipt
- **THEN** the wrapper writes its `error` sidecar, and the parent receives a message with the state `error` and the `last-message` command

#### Scenario: Crash after a terminal status
- **WHEN** a send-mode child exits with code 2, wrote no sidecar, left a `done` status, and wrote no receipt
- **THEN** the wrapper writes no `error` sidecar, and the parent receives a message with the state `crashed (code 2)` and the `last-message` command

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

#### Scenario: Last mode stays silent
- **WHEN** a last-mode child exits without a report
- **THEN** no text is typed into any pane but the child's own
