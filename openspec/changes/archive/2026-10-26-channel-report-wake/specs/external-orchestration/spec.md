# Spec Delta

## MODIFIED Requirements

### Requirement: Send command
The CLI SHALL provide `send --to <pane> --text <text> [--ack-timeout <seconds>]`. Its behaviour is selected by `PI_PMUX_REPORT_PROTOCOL` in the environment.

When the variable is absent or holds a value other than `file-ack-v1`, `send` SHALL keep the legacy behaviour: it types the text into the pane as literal input, followed by one Enter keypress, through the tmux backend's pane-input primitive, without a shell, and prints `{"sent":true,"to":<pane>,"bytes":<n>,"receipt":<path or null>}`.

When the variable holds `file-ack-v1`, `PI_PMUX_SESSION` SHALL be required: a marked invocation without it is a configuration error, not a legacy fallback. `send` SHALL then, in order:

1. Mint a fresh report ID of 32 lowercase hex characters, write the received text unchanged to `<session>.<id>.report.md` through an atomic temporary-file-and-rename write, and append the `report` registration record to `<session>.sent`. A failure here refuses the send before any pane input and before any channel request.
2. Build the one-line pointer `pmux report <id>. Read <shell-quoted-report-path>, then run: node <shell-quoted-cli> ack --session <shell-quoted-session> --id <id>. Acknowledge only after reading. [pmux-eom-<token>]` with a fresh 32-hex visibility token, and submit it through the report transport (`report-channel`): the parent's channel endpoint first, then, when the channel is unavailable, the tmux backend's verified report-input primitive. A refusal or a failed submission on the fallback SHALL exit 2 with the structured failure line.
3. On submission by either transport, append the `notification` record (best effort) and poll the event log every 250 ms for an `ack` of the same ID, for `--ack-timeout` seconds (default 15; `0` checks once without waiting; the flag is invalid in legacy mode).
4. Print the result line and exit 0: `{"sent":true,"notification":"submitted","via":"channel"|"tmux","acknowledged":<bool>,"id":<id>,"to":<pane>,"bytes":<n>,"report":<abs path>,"receipt":<abs path or null>,"notificationRecorded":<bool>}`, plus `"channelError":<reason>` when `via` is `tmux`. `acknowledged:false` after the timeout is not a failure and MUST NOT be presented as one.

A pane refusal or verification failure on the fallback SHALL exit 2, print an operational error on stderr, and print the structured line `{"sent":false,"notification":"not-submitted"|"unknown","acknowledged":false,"id":<id>,"to":<pane>,"bytes":<n>,"report":<abs path>,"receipt":<abs path or null>,"notificationRecorded":false,"error":<reason>,"enterAttempted":<bool>,"channelError":<reason>}` on stdout. A missing `--to` or `--text` MUST be a usage error: a message on stderr naming the flag, nothing on stdout, exit 1, and nothing is sent and no file is written.

In both modes the typed text SHALL be encoded so that it holds no line terminator and no tab, by the same encoding rules as before.

#### Scenario: Report delivered
- **WHEN** a child without `PI_PMUX_REPORT_PROTOCOL` runs `send --to %12 --text 'PASS abc123'`
- **THEN** tmux receives `send-keys -t %12 -l 'PASS abc123'` and then `send-keys -t %12 Enter`, and stdout is the legacy line

#### Scenario: Artifact before pane input
- **WHEN** a marked child runs `send --to %12 --text 'PASS abc123'` and `%12` has no channel endpoint
- **THEN** `<session>.<id>.report.md` holding `PASS abc123` and its `report` record exist before any tmux call, and the typed input is the pointer line ending in `pmux-eom-<token>`

#### Scenario: Artifact before the channel request
- **WHEN** a marked child runs `send` and `%12` has an armed channel endpoint
- **THEN** the report file and its `report` record exist before the endpoint receives the request

#### Scenario: Report delivered by the channel
- **WHEN** a marked child runs `send --to %12` and the endpoint of `%12` replies `emitted`
- **THEN** tmux receives no `send-keys` call, and the result line has `sent:true`, `notification:"submitted"` and `via:"channel"`, and no `channelError`

#### Scenario: Report delivered by the fallback
- **WHEN** a marked child runs `send --to %12`, the endpoint replies `unarmed`, and the verified input submits the pointer
- **THEN** the result line has `via:"tmux"` and `channelError:"unarmed"`, and the exit code is 0

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
- **WHEN** the channel is unavailable and the parent pane refuses the verified input when a marked child runs `send`
- **THEN** no keys are typed, the exit code is 2, and the stdout line has `sent:false`, `notification:"not-submitted"`, `enterAttempted:false`, a `channelError`, and a `report` path that exists

#### Scenario: Enter failed
- **WHEN** the channel is unavailable and the Enter call throws after the token was verified
- **THEN** the exit code is 2 and the stdout line has `notification:"unknown"` and `enterAttempted:true`

#### Scenario: Marked without a session
- **WHEN** `send` runs with `PI_PMUX_REPORT_PROTOCOL=file-ack-v1` and no `PI_PMUX_SESSION`
- **THEN** it exits 1 with a message on stderr naming `PI_PMUX_SESSION`, sends nothing, makes no channel request and writes no `.report.md` file

#### Scenario: Multiline report
- **WHEN** the text holds several lines
- **THEN** the report file holds them unchanged, and the pointer, typed or sent to the channel, remains one line

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
- **THEN** stdout holds one JSON line whose `sent` is `true`, whose `to`, `bytes`, `id`, `via`, `report` and `receipt` are set

#### Scenario: The confirmation names the receipt
- **WHEN** an unmarked `send --to %12 --text hi` runs with `PI_PMUX_SESSION=/s/w.jsonl` and the receipt is written
- **THEN** the printed line's `receipt` is the absolute path of `/s/w.jsonl.sent`

#### Scenario: No receipt to name
- **WHEN** an unmarked `send --to %12 --text hi` runs without `PI_PMUX_SESSION`, or the receipt cannot be written
- **THEN** the printed line's `receipt` is null, and the command still exits 0

### Requirement: Report receipts
When `send` runs under `file-ack-v1`, `<PI_PMUX_SESSION>.sent` SHALL be an append-only JSON-lines event log. `send` SHALL append a `report` record `{"at":<ISO>,"kind":"report","id":<32hex>,"to":<pane>,"bytes":<n>,"report":<path>}` before transport — a failed registration refuses the send — and a `notification` record `{"at":<ISO>,"kind":"notification","id":<32hex>,"token":<32hex>,"to":<pane>,"bytes":<n>,"report":<path>,"via":"channel"|"tmux"}` after a submission, plus `"channelError":<reason>` when `via` is `tmux` — a failed notification write MUST NOT fail the send. `ack` SHALL append `{"at":<ISO>,"kind":"ack","id":<32hex>}`; a failed append MUST NOT produce a success result. Readers SHALL skip malformed lines and unknown kinds, SHALL treat a `notification` record without `via` as `via:"tmux"`, SHALL treat a kindless line with a string `to` as a legacy notification with no ID and no ack semantics, and an `ack` record carries no `to`. `<bytes>` is the UTF-8 length of the text `send` received. When `send` runs unmarked it SHALL keep appending the kindless receipt line `{"at":<ISO>,"to":<to>,"bytes":<n>}`. `prune` SHALL treat `.sent` and `.report.md` files as launcher files, so it deletes them past the retention and keeps them within it; an abandoned atomic temporary file also ends in `.report.md` and is reclaimed by the same rule.

#### Scenario: Receipt inside a child
- **WHEN** an unmarked `send --to %12 --text hi` runs with `PI_PMUX_SESSION=/s/w.jsonl`
- **THEN** `/s/w.jsonl.sent` gains one kindless line whose JSON has `to` equal to `%12`, `bytes` equal to `2` UTF-8 bytes and an ISO `at`

#### Scenario: Registration before notification
- **WHEN** a marked child runs `send` with `PI_PMUX_SESSION=/s/w.jsonl`
- **THEN** `/s/w.jsonl.sent` gains a `report` line for the ID before the pointer is submitted, and a `notification` line with a `token` and a `via` after submission

#### Scenario: Channel notification record
- **WHEN** the channel emits the pointer
- **THEN** the `notification` line has `via:"channel"` and no `channelError`

#### Scenario: Fallback notification record
- **WHEN** the channel result is `unavailable` with reason `refused` and the verified input submits the pointer
- **THEN** the `notification` line has `via:"tmux"` and `channelError:"refused"`

#### Scenario: Old notification record
- **WHEN** the event log holds a `notification` record written before this change, with no `via`
- **THEN** readers see it as a notification with `via:"tmux"`

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
- **THEN** `send` exits without a channel request and without typing into the pane

#### Scenario: Receipt write fails
- **WHEN** `<session>.sent` cannot be appended under the legacy protocol
- **THEN** `send` still delivers the text and exits 0

#### Scenario: Notification write fails
- **WHEN** the `notification` record cannot be appended after a submission
- **THEN** `send` still exits 0 with `notificationRecorded:false`

#### Scenario: Prune reclaims receipts
- **WHEN** `prune` runs on a scratch directory holding `.sent`, `.report.md` and abandoned `.tmp-*.report.md` files older than the retention and within it
- **THEN** the old ones are deleted and the fresh ones are kept

### Requirement: Send-mode wake-up
For a send-mode spec with a `parent`, the wrapper SHALL contact the parent after the sentinel and before the close-on-done step. For an unmarked spec the legacy behaviour applies: one text message typed through the pane-input primitive, encoded the way `send` encodes its text — `<name> pinged: <message>` for a `ping` sidecar with a string message, else `<name> <state> without sending a report. Read its last message: node <cli> last-message --session <session>`, where `<state>` is the sidecar `type`, else `exited` for code 0, else `crashed (code <n>)`.

For a `file-ack-v1` spec:

- Every current-run report addressed to `parent` that has no `ack` record SHALL be re-delivered in registration order through the report transport (`report-channel`: the channel endpoint first, then the verified report-input primitive): the same report file and ID, a fresh visibility token, and no ack wait. The wrapper SHALL recheck the ack immediately before each retry.
- When there is no current-run parent report at all, the wrapper SHALL write the wake text to its own durable report file, register it with a `report` record as `send` does, and deliver its pointer the same way: the `<name> <state> without sending a report…` text above for a finished or crashed child, and `<name> pinged: <message>` for a `ping` sidecar, with the original multiline text unchanged.
- A `cancelled` sidecar produces no re-delivery and no wake-up.
- A failed re-delivery or wake-up SHALL go to stderr only and MUST NOT change the child's exit code.

#### Scenario: Exit without a report
- **WHEN** an unmarked send-mode child with parent `%12` exits with a `done` sidecar and wrote no receipt
- **THEN** `%12` receives one message naming the child, the state `done` and the `last-message --session <session>` command

#### Scenario: Failed wake-up
- **WHEN** a re-delivery or wake-up can be submitted neither to the channel nor to the parent's pane
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

#### Scenario: A cancel sends no wake-up
- **WHEN** a send-mode child with parent `%12` exits with a `cancelled` sidecar and wrote no receipt
- **THEN** `%12` receives nothing

#### Scenario: Last mode stays silent
- **WHEN** a last-mode child exits without a report
- **THEN** no text is typed into any pane but the child's own

#### Scenario: Re-delivery by the channel
- **WHEN** a marked send-mode child with parent `%12` exits with one unacknowledged report and the endpoint of `%12` replies `emitted`
- **THEN** the pointer reaches the endpoint with the same report ID and a fresh token, and tmux receives no `send-keys` call for it
