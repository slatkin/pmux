# Spec Delta

## MODIFIED Requirements

### Requirement: Send command
The CLI SHALL provide `send --to <pane> --text <text>`. It SHALL type the text into the pane as literal input, followed by one Enter keypress, through the tmux backend's pane-input primitive, without a shell. Before it is typed, the text SHALL be encoded so that it holds no line terminator and no tab: a newline (U+000A) SHALL become the two characters `\n`, a carriage return (U+000D) the two characters `\r`, a tab (U+0009) the two characters `\t`, and any other C0 control character or DEL (U+007F) the four characters `\xNN` with two lowercase hex digits. Every other character, a backslash included, SHALL be typed as it is. The report therefore reaches the parent as one input, whatever the parent pane runs. When the text has been typed, the command SHALL print one JSON line on stdout: `{"sent":true,"to":<pane>,"bytes":<n>,"receipt":<path or null>}`, where `<n>` is the length in bytes of the text the command received, before the pane-input encoding, and `<path>` is the absolute path of the receipt file, or null when no receipt was written — the command ran outside a child, or the receipt write failed. A missing `--to` or `--text` MUST be a usage error: a message on stderr naming the flag, nothing on stdout, exit 1, and nothing is sent.

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

#### Scenario: The command answers
- **WHEN** `send --to %12 --text 'PASS abc123'` delivers
- **THEN** stdout holds one JSON line whose `sent` is `true`, whose `to` is `%12` and whose `bytes` is the UTF-8 length of the text as given, before the encoding

#### Scenario: The confirmation names the receipt
- **WHEN** `send --to %12 --text hi` runs with `PI_PMUX_SESSION=/s/w.jsonl` and the receipt is written
- **THEN** the printed line's `receipt` is the absolute path of `/s/w.jsonl.sent`

#### Scenario: No receipt to name
- **WHEN** `send --to %12 --text hi` runs without `PI_PMUX_SESSION`, or the receipt cannot be written
- **THEN** the printed line's `receipt` is null, and the command still exits 0

### Requirement: Parent-contact footer
`start` SHALL append a footer to the brief. In `last` mode the footer SHALL give the parent's name and pane, tell the child that its last assistant message is the report the parent reads and that it SHALL then call `pmux_done`, and tell the child not to use `caller_ping` or `pmux_message` to reach the parent; its text SHALL be the same bytes as before the `--report` flag existed. In `send` mode the footer SHALL name the parent's pane, and SHALL teach `node <cli> send --to <parent pane> --text '<report>'`, where `<cli>` is the absolute path of the package's `cli.ts`, as the report step, followed by a call to `pmux_done`. It SHALL tell the child that the command prints one confirmation line, that the line is the delivery receipt, and that the child SHALL NOT send anything else to the parent to check whether the report arrived. It SHALL tell a blocked child to send its question with the same command and stop. It SHALL tell the child to ignore a reminder's claim that its last message was already delivered, and to send its report first. It SHALL NOT say that a missing report leaves the parent unaware of the exit, because the send-mode wake-up reports the exit state. Its statement about the session closing when a turn ends SHALL be conditional, because a role without `auto-exit: true` keeps its session open and gets the completion nudge. The `send` footer MUST NOT say that the last assistant message is delivered or read as the report.

#### Scenario: Footer names the parent
- **WHEN** `start` runs with parent name `orch` from pane `%12` in `last` mode
- **THEN** the prompt the child receives ends with a footer naming the parent `orch` and pane `%12`, and states that the last assistant message is the report

#### Scenario: Send footer teaches the command
- **WHEN** `start` runs with `--report send --parent %12`
- **THEN** the prompt ends with a footer that holds `node <cli> send --to %12 --text`, names `pmux_done`, tells a blocked child to send its question and stop, and does not say that the last assistant message is the report

#### Scenario: Send footer overrides the nudge
- **WHEN** a send-mode child reads its footer
- **THEN** the footer tells it to ignore a reminder's claim that its last message was already delivered, and to send its report before it calls `pmux_done`

#### Scenario: Send footer names the confirmation
- **WHEN** a send-mode child reads its footer
- **THEN** the footer names the confirmation line the `send` command prints, calls it the delivery receipt, and tells the child not to send anything else to the parent to check

## ADDED Requirements

### Requirement: Every command answers on success
Every CLI command SHALL print at least one line on stdout when it succeeds, so an agent that ran it can read the result. A command that succeeds silently MUST NOT be added: an agent that cannot read a result either guesses at it or probes the host with another command. A usage error SHALL print its message on stderr, print nothing on stdout and exit non-zero.

#### Scenario: The commands answer
- **WHEN** `start`, `resume`, `send`, `wait`, `prune` or `last-message` succeeds
- **THEN** it printed at least one line on stdout

#### Scenario: A usage error stays on stderr
- **WHEN** any of those commands runs with a missing or unusable flag
- **THEN** it printed a message on stderr, printed nothing on stdout and exited non-zero
