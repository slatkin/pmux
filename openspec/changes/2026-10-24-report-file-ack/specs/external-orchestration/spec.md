# Spec Delta

## MODIFIED Requirements

### Requirement: Packaged orchestration skill
The package SHALL ship a `pmux` skill at `skills/pmux/` with its `SKILL.md` and a TypeScript launcher shim, `launch.ts`, which runs under `node`. The skill directory MUST NOT contain shell scripts. The skill MUST be installable with the `npx skills` CLI from the GitHub repository or a local checkout, and MUST work when the CLI copies the directory instead of linking it. It MUST be listed in the package manifest `files`, so a packaged install carries it. The pi manifest MUST NOT register the skill. `SKILL.md` SHALL document the tmux protocol: the launch commands, the `wait` command, the completion signal, the close-on-done behaviour and the report lookup. It SHALL tell the orchestrator to read `<session>.exit` after a wait, because the sidecar says whether the child finished, handed off, pinged, failed or was cancelled by the user. It SHALL say that a `cancelled` sidecar means the user stopped the child with Escape: the child has exited, its pane closes, no report is coming, and no wake-up is sent. It SHALL say that a `wait --signal status` returns `done` on a cancel, and that the orchestrator must not resume or replace a cancelled child unless the user asks. The statement that there is no channel from the child back to the orchestrator, and the bullet that the report is the child's last assistant message, SHALL be scoped to the default `last` mode and SHALL point at the new section, so that neither reads as false in `send` mode. The shared recipes that assume a last-mode child SHALL say that they apply to `last` mode only: the idle-child nudge text in `SKILL.md`, the `wait` paragraph in `docs/guide.md`, and the external-orchestrator paragraph in `README.md`. `SKILL.md` SHALL have a section named "External orchestrators (Claude Code)" that documents the `send` mode: start with `--report send` and `--parent "$TMUX_PANE"`; the report is written to a durable file and a short pointer naming the file and its `ack` command is typed into the orchestrator's pane; the orchestrator reads the named file, runs the `ack` command in the pointer, and deduplicates repeated pointers by report ID; wait with `--signal sidecar`; leave the sidecar in place, because the wrapper reads it after the child exits, `start` and `resume` clear it on relaunch, and `prune` reclaims it; and `resume --launch <spec> --prompt <file>` appends the footer again. The section SHALL say that the run wrapper re-delivers each unacknowledged report of the run at the child's exit with the same report ID, that an acknowledgement means the report file was read, and that the orchestrator SHALL NOT edit or delete report files or `.sent` files. The skill's frontmatter description SHALL say that the skill serves external orchestrators such as Claude Code. A recipe SHALL be stated once in `SKILL.md`: the follow-up `resume` recipe lives in "While it runs / after", and the "External orchestrators (Claude Code)" section points at it, keeping only the send-mode fact that `resume` re-appends the send footer.

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
- **THEN** it starts the child with `--report send --parent "$TMUX_PANE"`, ends its turn, and waits with `--signal sidecar` when it is woken

#### Scenario: The skill teaches the pointer workflow
- **WHEN** an external orchestrator reads the "External orchestrators (Claude Code)" section
- **THEN** it is told to read the report file the pointer names, to run the `ack` command the pointer carries after reading, to deduplicate repeated pointers by report ID, and not to edit or delete report files or `.sent` files

#### Scenario: The skill explains re-delivery
- **WHEN** an external orchestrator reads how the wrapper ends a send-mode run
- **THEN** the text says that every unacknowledged report of the run is re-delivered at exit with the same report ID, so a second pointer for an already-read report can be ignored

#### Scenario: The last-mode claims are scoped
- **WHEN** a reader reads the skill's intro, the "The report" bullet, or the idle-child nudge recipe
- **THEN** each says that it describes the default `last` mode, and the intro points at the "External orchestrators (Claude Code)" section

#### Scenario: The follow-up recipe is stated once
- **WHEN** a reader reads the "External orchestrators (Claude Code)" section and then "While it runs / after"
- **THEN** the `resume` command, the `<spec>` field and the "no launch record" rule appear once, in "While it runs / after", and the external-orchestrator section points at it and says that `resume` re-appends the send footer

#### Scenario: The skill explains a cancel
- **WHEN** a reader reads how to interpret `<session>.exit` after a wait
- **THEN** the text says that `{"type":"cancelled"}` means the user stopped the child, that the child has exited and its pane closes, that no wake-up is sent, and that the orchestrator must not resume or replace the child unless the user asks

### Requirement: Launch contract
`start` SHALL create a new pane by the tmux-backend placement rule, with the caller's pane as the anchor, without taking focus, and name it after the child. It SHALL write a launch spec that starts pi with `--session`, the env vars `pmux-done.ts` reads (with `PI_PMUX_SESSION` equal to `--session`), and the brief as the prompt. It SHALL remove `<session>.status` before it runs that spec, and then run the spec in the pane. On success it SHALL print exactly one JSON document on stdout, giving the pane id, the session file and the launch-spec path. Everything else SHALL go to stderr. Because every `start` is an external-orchestrator launch, it SHALL set `PI_PMUX_EXTERNAL_PARENT=1` in the launch spec env; a pi-parent launch does not set that key. A `resume` rebuilds the launch spec from the launch record with the same external parent, so the resumed child carries the marker too. A `send`-mode spec SHALL also carry `PI_PMUX_REPORT_PROTOCOL` with the value `file-ack-v1`, which selects the file, pointer and acknowledgement protocol in `send` and in the run wrapper; a `last`-mode spec and a pi-parent launch SHALL NOT set it.

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

### Requirement: Parent-contact footer
`start` SHALL append a footer to the brief. In `last` mode the footer SHALL give the parent's name and pane, tell the child that its last assistant message is the report the parent reads and that it SHALL then call `pmux_done`, and tell the child not to use `caller_ping` or `pmux_message` to reach the parent. In `send` mode the footer SHALL name the parent's pane, and SHALL teach `node <cli> send --to <parent pane> --text '<report>'`, where `<cli>` is the absolute path of the package's `cli.ts`, as the report step, followed by a call to `pmux_done`. The send footer SHALL say that `send` writes the report to a durable file and types only a pointer naming it, that the confirmation line's `sent:true` means the pointer was submitted to the parent's pane and `acknowledged:true` means the parent read the report file, and that the line is not a delivery receipt. It SHALL tell the child that `acknowledged:false` means the parent is busy, that the child SHALL NOT resend the report or send anything else to check, because the run wrapper re-delivers an unacknowledged report at exit, and that on `sent:false` it SHALL call `pmux_done` without improvising retries. It SHALL tell a blocked child to send its question with the same command and stop. It SHALL tell the child to ignore a reminder's claim that its last message was already delivered, and to send its report first. It SHALL NOT say that a missing report leaves the parent unaware of the exit, because the send-mode wake-up reports the exit state. Its statement about the session closing when a turn ends SHALL be conditional, because a role without `auto-exit: true` keeps its session open and gets the completion nudge. The `send` footer MUST NOT say that the last assistant message is delivered or read as the report. Each footer SHALL carry every rule it needs exactly once: a rule the footer states SHALL NOT be stated again in the same footer, and a rule the child's tool schema already states MAY be left out of it.

#### Scenario: Footer names the parent
- **WHEN** `start` runs with parent name `orch` from pane `%12` in `last` mode
- **THEN** the prompt the child receives ends with a footer naming the parent `orch` and pane `%12`, and states that the last assistant message is the report

#### Scenario: Send footer teaches the command
- **WHEN** `start` runs with `--report send --parent %12`
- **THEN** the prompt ends with a footer that holds `node <cli> send --to %12 --text`, names `pmux_done`, tells a blocked child to send its question and stop, and does not say that the last assistant message is the report

#### Scenario: Send footer names the confirmation
- **WHEN** a send-mode child reads its footer
- **THEN** the footer names the confirmation line the `send` command prints, says `sent:true` means the pointer was submitted and `acknowledged:true` means the parent read the report file, says the line is not a delivery receipt, and tells the child not to send anything else to the parent to check

#### Scenario: Send footer forbids retrying
- **WHEN** a send-mode child reads its footer
- **THEN** the footer says `acknowledged:false` means the parent is busy, forbids resending or sending a check message, says the wrapper re-delivers at exit, and says `sent:false` means call `pmux_done`

#### Scenario: Send footer overrides the nudge
- **WHEN** a send-mode child reads its footer
- **THEN** the footer tells it to ignore a reminder's claim that its last message was already delivered, and to send its report before it calls `pmux_done`

#### Scenario: The footer states each rule once
- **WHEN** a reader reads either footer
- **THEN** the rule about the report, the rule about `pmux_done`, the rule about a blocked child and the rule about the reminder each appear once in it

### Requirement: Close on done
After the child exits, the skill-path run wrapper SHALL print `__SUBAGENT_DONE_<exit code>__`. It SHALL then close its own pane through tmux only when `<session>.exit` parses as JSON with `type` equal to `done`, `handoff` or `cancelled`, and only after a grace period. The grace period SHALL default to 5000 ms, SHALL be set per launch with `start --close-grace-ms <n>`, and SHALL be stored in the launch spec so that a resume reuses it. A value of `0` closes at once. For any other `.exit` content, unparseable content, or no `.exit`, the pane MUST stay open with the sentinel visible. The wrapper MUST NOT delete the `.exit` file. In `last` mode the wrapper SHALL NOT contact the parent: it SHALL NOT address any pane by title and SHALL NOT type text into any other pane; the orchestrator's wake is the `wait` command, which polls the status file, and the report is the child's last assistant message, read with `last-message`. In `send` mode the wrapper SHALL contact the parent only through the send-mode report re-delivery and the send-mode wake-up, and SHALL NOT address any pane by title.

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
- **WHEN** `<session>.exit` holds text that is not JSON, or JSON whose `type` is not `done`, `handoff` or `cancelled`
- **THEN** the pane stays open

#### Scenario: The wrapper contacts nobody
- **WHEN** a last-mode skill-launched child exits and the wrapper prints `__SUBAGENT_DONE_<code>__`
- **THEN** no pane is addressed by title and no text is typed into any pane but the child's own

#### Scenario: Send mode wakes before it closes
- **WHEN** a send-mode child exits with a `done` sidecar and nothing was delivered to its parent
- **THEN** the wrapper sends the send-mode parent contact to the parent's pane, and then closes its own pane after the grace

### Requirement: Report mode selection
`start` SHALL accept `--report last|send`, with `last` as the default. In `last` mode the report is the child's last assistant message, as before. In `send` mode the child reports through the `file-ack-v1` protocol: the report goes to a durable file and a pointer is typed into the parent's pane by `send`, and `--parent` SHALL be the orchestrator's tmux pane id. Any other value MUST make `start` exit 2 with a stderr message naming the value, before any file is written or any pane is split.

#### Scenario: Default mode
- **WHEN** `start` runs without `--report`
- **THEN** the prompt ends with the `last` footer

#### Scenario: Invalid mode
- **WHEN** `start` runs with `--report email`
- **THEN** it exits 2 with a message on stderr naming `email`, writes no scratch file, and splits no pane

### Requirement: Send command
The CLI SHALL provide `send --to <pane> --text <text> [--ack-timeout <seconds>]`. Its behaviour is selected by `PI_PMUX_REPORT_PROTOCOL` in the environment.

When the variable is absent or holds a value other than `file-ack-v1`, `send` SHALL keep the legacy behaviour: it types the text into the pane as literal input, followed by one Enter keypress, through the tmux backend's pane-input primitive, without a shell, and prints `{"sent":true,"to":<pane>,"bytes":<n>,"receipt":<path or null>}`.

When the variable holds `file-ack-v1`, `PI_PMUX_SESSION` SHALL be required: a marked invocation without it is a configuration error, not a legacy fallback. `send` SHALL then, in order:

1. Mint a fresh report ID of 32 lowercase hex characters, write the received text unchanged to `<session>.<id>.report.md` through an atomic temporary-file-and-rename write, and append the `report` registration record to `<session>.sent`. A failure here refuses the send before any pane input.
2. Build the one-line pointer `pmux report <id>. Read <shell-quoted-report-path>, then run: node <shell-quoted-cli> ack --session <shell-quoted-session> --id <id>. Acknowledge only after reading. [pmux-eom-<token>]` with a fresh 32-hex visibility token, and submit it through the tmux backend's verified report-input primitive. A refusal or a failed submission SHALL exit 2 with the structured failure line.
3. On submission, append the `notification` record (best effort) and poll the event log every 250 ms for an `ack` of the same ID, for `--ack-timeout` seconds (default 15; `0` checks once without waiting; the flag is invalid in legacy mode).
4. Print the result line and exit 0: `{"sent":true,"notification":"submitted","acknowledged":<bool>,"id":<id>,"to":<pane>,"bytes":<n>,"report":<abs path>,"receipt":<abs path or null>,"notificationRecorded":<bool>}`. `acknowledged:false` after the timeout is not a failure and MUST NOT be presented as one.

A pane refusal or verification failure SHALL exit 2, print an operational error on stderr, and print the structured line `{"sent":false,"notification":"not-submitted"|"unknown","acknowledged":false,"id":<id>,"to":<pane>,"bytes":<n>,"report":<abs path>,"receipt":<abs path or null>,"notificationRecorded":false,"error":<reason>,"enterAttempted":<bool>}` on stdout. A missing `--to` or `--text` MUST be a usage error: a message on stderr naming the flag, nothing on stdout, exit 1, and nothing is sent and no file is written.

In both modes the typed text SHALL be encoded so that it holds no line terminator and no tab, by the same encoding rules as before.

#### Scenario: Report delivered
- **WHEN** a child without `PI_PMUX_REPORT_PROTOCOL` runs `send --to %12 --text 'PASS abc123'`
- **THEN** tmux receives `send-keys -t %12 -l 'PASS abc123'` and then `send-keys -t %12 Enter`, and stdout is the legacy line

#### Scenario: Artifact before pane input
- **WHEN** a marked child runs `send --to %12 --text 'PASS abc123'`
- **THEN** `<session>.<id>.report.md` holding `PASS abc123` and its `report` record exist before any tmux call, and the typed input is the pointer line ending in `pmux-eom-<token>`

#### Scenario: Acknowledged report
- **WHEN** a marked child runs `send` and `ack` runs for its ID within the timeout
- **THEN** the result line has `sent:true`, `notification:"submitted"` and `acknowledged:true`, and the exit code is 0

#### Scenario: Unacknowledged timeout
- **WHEN** a marked child runs `send` and no ack arrives within `--ack-timeout`
- **THEN** the result line has `sent:true` and `acknowledged:false`, stderr is empty, and the exit code is 0

#### Scenario: Ack timeout zero
- **WHEN** a marked child runs `send --ack-timeout 0` with no ack present
- **THEN** it checks the log once, does not sleep, and exits 0 with `acknowledged:false`

#### Scenario: Submission refused
- **WHEN** the parent pane is in a mode when a marked child runs `send`
- **THEN** no keys are typed, the exit code is 2, and the stdout line has `sent:false`, `notification:"not-submitted"`, `enterAttempted:false` and a `report` path that exists

#### Scenario: Enter failed
- **WHEN** the Enter call throws after the token was verified
- **THEN** the exit code is 2 and the stdout line has `notification:"unknown"` and `enterAttempted:true`

#### Scenario: Marked without a session
- **WHEN** `send` runs with `PI_PMUX_REPORT_PROTOCOL=file-ack-v1` and no `PI_PMUX_SESSION`
- **THEN** it exits 1 with a message on stderr naming `PI_PMUX_SESSION`, sends nothing and writes no `.report.md` file

#### Scenario: Multiline report
- **WHEN** the text holds several lines
- **THEN** the report file holds them unchanged, and the typed pointer remains one line

#### Scenario: Control characters
- **WHEN** an unmarked `send` text holds a tab or another control character
- **THEN** the typed text holds `\t` or `\xNN` in its place, and no tab and no control byte is typed

#### Scenario: Missing flag
- **WHEN** `send` runs without `--text`
- **THEN** it exits 1 with an error naming `--text` on stderr, stdout is empty, and tmux receives no call

#### Scenario: Legacy timeout flag rejected
- **WHEN** an unmarked invocation carries `--ack-timeout`
- **THEN** it is a usage error: exit 1, stderr message, no pane input

#### Scenario: The command answers
- **WHEN** `send --to %12 --text 'PASS abc123'` delivers under `file-ack-v1`
- **THEN** stdout holds one JSON line whose `sent` is `true`, whose `to`, `bytes`, `id`, `report` and `receipt` are set

#### Scenario: The confirmation names the receipt
- **WHEN** an unmarked `send --to %12 --text hi` runs with `PI_PMUX_SESSION=/s/w.jsonl` and the receipt is written
- **THEN** the printed line's `receipt` is the absolute path of `/s/w.jsonl.sent`

#### Scenario: No receipt to name
- **WHEN** an unmarked `send --to %12 --text hi` runs without `PI_PMUX_SESSION`, or the receipt cannot be written
- **THEN** the printed line's `receipt` is null, and the command still exits 0

### Requirement: Report receipts
When `send` runs under `file-ack-v1`, `<PI_PMUX_SESSION>.sent` SHALL be an append-only JSON-lines event log. `send` SHALL append a `report` record `{"at":<ISO>,"kind":"report","id":<32hex>,"to":<pane>,"bytes":<n>,"report":<path>}` before transport — a failed registration refuses the send — and a `notification` record `{"at":<ISO>,"kind":"notification","id":<32hex>,"token":<32hex>,"to":<pane>,"bytes":<n>,"report":<path>}` after a submission — a failed notification write MUST NOT fail the send. `ack` SHALL append `{"at":<ISO>,"kind":"ack","id":<32hex>}`; a failed append MUST NOT produce a success result. Readers SHALL skip malformed lines and unknown kinds, SHALL treat a kindless line with a string `to` as a legacy notification with no ID and no ack semantics, and an `ack` record carries no `to`. `<bytes>` is the UTF-8 length of the text `send` received. When `send` runs unmarked it SHALL keep appending the kindless receipt line `{"at":<ISO>,"to":<to>,"bytes":<n>}`. `prune` SHALL treat `.sent` and `.report.md` files as launcher files, so it deletes them past the retention and keeps them within it; an abandoned atomic temporary file also ends in `.report.md` and is reclaimed by the same rule.

#### Scenario: Receipt inside a child
- **WHEN** an unmarked `send --to %12 --text hi` runs with `PI_PMUX_SESSION=/s/w.jsonl`
- **THEN** `/s/w.jsonl.sent` gains one kindless line whose JSON has `to` equal to `%12`, `bytes` equal to `2` UTF-8 bytes and an ISO `at`

#### Scenario: Registration before notification
- **WHEN** a marked child runs `send` with `PI_PMUX_SESSION=/s/w.jsonl`
- **THEN** `/s/w.jsonl.sent` gains a `report` line for the ID before the pointer is typed, and a `notification` line with a `token` after submission

#### Scenario: Ack record
- **WHEN** `ack --session /s/w.jsonl --id <id>` runs for a registered report
- **THEN** `/s/w.jsonl.sent` gains an `ack` line naming the ID and no `to`

#### Scenario: Receipt counts the text as received
- **WHEN** an unmarked `send --to %12 --text 'line one\nline two'` runs with `PI_PMUX_SESSION=/s/w.jsonl`
- **THEN** the receipt's `bytes` counts the newline in the text, not the encoded form that was typed

#### Scenario: No receipt outside a child
- **WHEN** an unmarked `send` runs without `PI_PMUX_SESSION`
- **THEN** no `.sent` file is written

#### Scenario: Malformed lines are skipped
- **WHEN** the event log holds a line that is not JSON and a JSON line with an unknown `kind`
- **THEN** readers ignore both and still see the valid records

#### Scenario: Registration failure refuses the send
- **WHEN** the `report` record cannot be appended under `file-ack-v1`
- **THEN** `send` exits without typing into the pane

#### Scenario: Receipt write fails
- **WHEN** `<session>.sent` cannot be appended under the legacy protocol
- **THEN** `send` still delivers the text and exits 0

#### Scenario: Notification write fails
- **WHEN** the `notification` record cannot be appended after a submission
- **THEN** `send` still exits 0 with `notificationRecorded:false`

#### Scenario: Prune reclaims receipts
- **WHEN** `prune` runs on a scratch directory holding `.sent`, `.report.md` and abandoned `.tmp-*.report.md` files older than the retention and within it
- **THEN** the old ones are deleted and the fresh ones are kept

### Requirement: Send-mode report count
For a send-mode spec with a `parent`, the run wrapper SHALL detect whether the current run produced parent reports. For an unmarked spec it SHALL count the `<session>.sent` kindless lines whose `to` equals `parent`, once before the child starts and once after the sentinel; a missing file counts as zero and an unparseable line is skipped. For a `file-ack-v1` spec it SHALL snapshot the registered report IDs and the kindless-line count before the child starts, and after the sentinel examine only `report` records whose `to` equals `parent` and whose IDs were absent from the baseline, together with their `ack` records. A report with a matching `ack` is consumed; one without is unacknowledged and subject to re-delivery. A new kindless line whose `to` equals `parent` counts as parent contact for the wake decision — an unmarked `send` still ran against the session — but, having no report ID, it is never re-delivered. In `last` mode the wrapper SHALL NOT check and SHALL NOT contact anyone.

#### Scenario: Count grows
- **WHEN** an unmarked send-mode child with parent `%12` runs `send --to %12` once and exits
- **THEN** the second count is one more than the first, and no wake-up is sent

#### Scenario: Acked report is consumed
- **WHEN** a marked child's only new report to the parent has an `ack` record
- **THEN** the wrapper neither re-delivers it nor sends the no-report wake-up

#### Scenario: Unacknowledged report
- **WHEN** a marked child's report to the parent has no `ack` record
- **THEN** the wrapper re-delivers it by the Send-mode wake-up rules

#### Scenario: Earlier marked runs do not count
- **WHEN** a resumed marked child exits and `.sent` holds report and ack records from the earlier run
- **THEN** only the current run's reports are examined

### Requirement: Send-mode wake-up
For a send-mode spec with a `parent`, the wrapper SHALL contact the parent after the sentinel and before the close-on-done step. For an unmarked spec the legacy behaviour applies: one text message typed through the pane-input primitive, encoded the way `send` encodes its text — `<name> pinged: <message>` for a `ping` sidecar with a string message, else `<name> <state> without sending a report. Read its last message: node <cli> last-message --session <session>`, where `<state>` is the sidecar `type`, else `exited` for code 0, else `crashed (code <n>)`.

For a `file-ack-v1` spec:

- Every current-run report addressed to `parent` that has no `ack` record SHALL be re-delivered in registration order through the verified report-input primitive: the same report file and ID, a fresh visibility token, and no ack wait. The wrapper SHALL recheck the ack immediately before each retry.
- When there is no current-run parent report at all, the wrapper SHALL write the wake text to its own durable report file, register it with a `report` record as `send` does, and deliver its pointer the same way: the `<name> <state> without sending a report…` text above for a finished or crashed child, and `<name> pinged: <message>` for a `ping` sidecar, with the original multiline text unchanged.
- A `cancelled` sidecar produces no re-delivery and no wake-up.
- A failed re-delivery or wake-up SHALL go to stderr only and MUST NOT change the child's exit code.

#### Scenario: Exit without a report
- **WHEN** an unmarked send-mode child with parent `%12` exits with a `done` sidecar and wrote no receipt
- **THEN** `%12` receives one message naming the child, the state `done` and the `last-message --session <session>` command

#### Scenario: Failed wake-up
- **WHEN** a re-delivery or wake-up cannot be submitted to the parent's pane
- **THEN** the wrapper writes an error naming the parent to stderr, and its exit code is the child's code

#### Scenario: Ping is quoted
- **WHEN** an unmarked send-mode child exits with `{"type":"ping","name":"w","message":"Which DB?"}` and no receipt
- **THEN** the parent receives `<name> pinged: Which DB?`

#### Scenario: A ping question that spans lines
- **WHEN** an unmarked send-mode child exits with a ping sidecar whose message holds a line break, and no receipt
- **THEN** the parent receives one message, with the line break written as the two characters `\n`

#### Scenario: The name is the launch spec's name
- **WHEN** a send-mode child launched as `worker-a` exits and its own sidecar names `w`
- **THEN** the parent-facing text names `worker-a`

#### Scenario: Crash without a report
- **WHEN** an unmarked send-mode child exits with code 2, wrote no sidecar, left no terminal status, and wrote no receipt
- **THEN** the wrapper writes its `error` sidecar, and the parent receives a message with the state `error` and the `last-message` command

#### Scenario: Crash after a terminal status
- **WHEN** an unmarked send-mode child exits with code 2, wrote no sidecar, left a `done` status, and wrote no receipt
- **THEN** the wrapper writes no `error` sidecar, and the parent receives a message with the state `crashed (code 2)` and the `last-message` command

#### Scenario: Report suppresses the wake-up
- **WHEN** an unmarked send-mode child sends its report to its parent and exits
- **THEN** the parent receives no message from the wrapper

#### Scenario: Report to another pane
- **WHEN** the only current-run reports name a pane that is not the parent
- **THEN** they are neither re-delivered nor counted for this parent, and the no-report wake-up applies

#### Scenario: Malformed receipt line
- **WHEN** the only new line in `<session>.sent` is not JSON
- **THEN** the parent is still woken

#### Scenario: Earlier runs do not count
- **WHEN** a resumed unmarked send-mode child exits without a report, and `<session>.sent` holds receipts to the parent from the earlier run
- **THEN** the parent is woken

#### Scenario: Unacknowledged report is re-delivered
- **WHEN** a marked send-mode child exits with a `done` sidecar and its report to the parent has no ack
- **THEN** the parent's pane receives a new pointer naming the same report ID and file, with a fresh token

#### Scenario: Acked report is not re-delivered
- **WHEN** the report has an `ack` record
- **THEN** no pointer is typed for it at exit

#### Scenario: Ack raced the retry
- **WHEN** the ack lands after the sentinel but before a pending retry
- **THEN** the recheck sees it and that report is skipped

#### Scenario: No-report wake is durable
- **WHEN** a marked send-mode child exits with a `done` sidecar and no current-run report
- **THEN** a durable artifact holding the wake text is written and its pointer is delivered to the parent's pane

#### Scenario: Ping is durable
- **WHEN** a marked child exits with `{"type":"ping","name":"w","message":"Which DB?"}` and no current-run report
- **THEN** the artifact holds `<launch-name> pinged: Which DB?` and the parent's pane receives its pointer

#### Scenario: Cancelled stays quiet
- **WHEN** a marked child exits with a `cancelled` sidecar and unacknowledged reports
- **THEN** no pointer is typed into the parent's pane

#### Scenario: Last mode stays silent
- **WHEN** a last-mode child exits without a report
- **THEN** no text is typed into any pane but the child's own

### Requirement: Every command answers on success
Every CLI command SHALL print at least one line on stdout when it succeeds, so an agent that ran it can read the result. A command that succeeds silently MUST NOT be added: an agent that cannot read a result either guesses at it or probes the host with another command. A usage error SHALL print its message on stderr, print nothing on stdout and exit non-zero.

#### Scenario: The commands answer
- **WHEN** `start`, `resume`, `send`, `ack`, `wait`, `prune` or `last-message` succeeds
- **THEN** it printed at least one line on stdout

#### Scenario: A usage error stays on stderr
- **WHEN** any of those commands runs with a missing or unusable flag
- **THEN** it printed a message on stderr, printed nothing on stdout and exited non-zero

## ADDED Requirements

### Requirement: Acknowledge a report
The CLI SHALL provide `ack --session <file> --id <report-id>` for the `file-ack-v1` report protocol. The ID SHALL match `^[0-9a-f]{32}$` and its report file `<session>.<id>.report.md` SHALL exist. `ack` SHALL append `{"at":<ISO>,"kind":"ack","id":<id>}` to `<session>.sent`, print `{"acked":true,"alreadyAcknowledged":<bool>,"id":<id>,"session":<abs path>,"receipt":<abs path>}` and exit 0; it MUST NOT claim success when the append fails.

#### Scenario: First ack
- **WHEN** `ack` runs for a registered report with no prior ack
- **THEN** the event log gains the `ack` record and stdout prints `acked:true` with `alreadyAcknowledged:false`

#### Scenario: Repeat ack
- **WHEN** `ack` runs again for the same ID
- **THEN** nothing is appended and stdout prints `acked:true` with `alreadyAcknowledged:true`

#### Scenario: Missing artifact
- **WHEN** the report file for the ID does not exist
- **THEN** `ack` exits 2, appends nothing and prints no `acked:true`

#### Scenario: Malformed ID
- **WHEN** `ack` runs with `--id hello`
- **THEN** it exits 1 with an error naming `--id`, stdout is empty and nothing is appended

#### Scenario: Append failure
- **WHEN** `<session>.sent` cannot be appended
- **THEN** `ack` exits 2 and does not claim success
