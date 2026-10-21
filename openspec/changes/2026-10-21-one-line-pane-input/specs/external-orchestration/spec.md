# Spec Delta

## MODIFIED Requirements

### Requirement: Send command
The CLI SHALL provide `send --to <pane> --text <text>`. It SHALL type the text into the pane as literal input, followed by one Enter keypress, through the tmux backend's pane-input primitive, without a shell. Before it is typed, the text SHALL be encoded so that it holds no line terminator and no tab: a newline (U+000A) SHALL become the two characters `\n`, a carriage return (U+000D) the two characters `\r`, a tab (U+0009) the two characters `\t`, and any other C0 control character or DEL (U+007F) the four characters `\xNN` with two lowercase hex digits. Every other character, a backslash included, SHALL be typed as it is. The report therefore reaches the parent as one input, whatever the parent pane runs. A missing `--to` or `--text` MUST be a usage error: a message on stderr naming the flag, nothing on stdout, exit 1, and nothing is sent.

#### Scenario: Report delivered
- **WHEN** a child runs `send --to %12 --text 'PASS abc123'`
- **THEN** tmux receives `send-keys -t %12 -l 'PASS abc123'` and then `send-keys -t %12 Enter`

#### Scenario: Multiline report
- **WHEN** the text holds several lines
- **THEN** tmux receives one `send-keys -t %12 -l` call whose text holds the lines joined by the two characters `\n`, and then `send-keys -t %12 Enter`

#### Scenario: Control characters
- **WHEN** the text holds a tab or another control character
- **THEN** the typed text holds `\t` or `\xNN` in its place, and no tab and no control byte is typed

#### Scenario: Missing flag
- **WHEN** `send` runs without `--text`
- **THEN** it exits 1 with an error naming `--text` on stderr, stdout is empty, and tmux receives no call

### Requirement: Report receipts
When `send` runs with `PI_PMUX_SESSION` set, it SHALL append, after the delivery, one JSON line `{"at":<ISO time>,"to":<to>,"bytes":<text length>}` to `<PI_PMUX_SESSION>.sent`, where `<text length>` is the length of the text `send` received, before the pane-input encoding. When `PI_PMUX_SESSION` is not set, it SHALL write no receipt. A failed receipt write MUST NOT fail the send. `prune` SHALL treat `.sent` files as launcher files, so it deletes them past the retention and keeps them within it.

#### Scenario: Receipt inside a child
- **WHEN** `send --to %12 --text hi` runs with `PI_PMUX_SESSION=/s/w.jsonl`
- **THEN** `/s/w.jsonl.sent` gains one line whose JSON has `to` equal to `%12`, `bytes` equal to `2` and an ISO `at`

#### Scenario: Receipt counts the text as received
- **WHEN** `send --to %12 --text 'line one\nline two'` runs with `PI_PMUX_SESSION=/s/w.jsonl`
- **THEN** the receipt's `bytes` counts the newline in the text, not the encoded form that was typed

#### Scenario: No receipt outside a child
- **WHEN** `send` runs without `PI_PMUX_SESSION`
- **THEN** no `.sent` file is written

#### Scenario: Receipt write fails
- **WHEN** `<session>.sent` cannot be written
- **THEN** `send` still delivers the text and exits 0

#### Scenario: Prune reclaims receipts
- **WHEN** `prune` runs on a scratch directory holding a `.sent` file older than the retention and one within it
- **THEN** the old one is deleted and the fresh one is kept

### Requirement: Send-mode wake-up
The send-mode wake-up SHALL be one message typed into the parent's pane through the pane-input primitive of `send`, before the close-on-done step. Its text SHALL be encoded the way the `send` command encodes its text, so a ping question that spans lines reaches the parent as one input. For a `ping` sidecar with a string `message` it SHALL be `<name> pinged: <message>`. Otherwise it SHALL be `<name> <state> without sending a report. Read its last message: node <cli> last-message --session <session>`, where `<state>` is the sidecar `type`, else `exited` for code 0, else `crashed (code <n>)`. A failed wake-up SHALL go to stderr only.

#### Scenario: Exit without a report
- **WHEN** a send-mode child with parent `%12` exits with a `done` sidecar and wrote no receipt
- **THEN** `%12` receives one message naming the child, the state `done` and the `last-message --session <session>` command

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
