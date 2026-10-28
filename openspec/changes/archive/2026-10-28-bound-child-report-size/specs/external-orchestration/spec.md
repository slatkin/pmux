# Spec Delta

## MODIFIED Requirements

### Requirement: Parent-contact footer
`start` SHALL append a footer to the brief. In `last` mode the footer SHALL give the parent's name and pane, tell the child that its last assistant message is the report the parent reads and that it SHALL then call `pmux_done`, and tell the child not to use `caller_ping` or `pmux_message` to reach the parent. In `send` mode the footer SHALL name the parent's pane, and SHALL teach `node <cli> send --to <parent pane> --text '<report>'`, where `<cli>` is the absolute path of the package's `cli.ts`, as the report step, followed by a call to `pmux_done`. The send footer SHALL say that `send` writes the report to a durable file and types only a pointer naming it, that the confirmation line's `sent:true` means the pointer was submitted to the parent's pane and `acknowledged:true` means the parent read the report file, and that the line is not a delivery receipt. It SHALL tell the child that `acknowledged:false` means the parent is busy, that the child SHALL NOT resend the report or send anything else to check, because the run wrapper re-delivers an unacknowledged report at exit, and that on `sent:false` it SHALL call `pmux_done` without improvising retries. It SHALL tell a blocked child to send its question with the same command and stop. It SHALL tell the child to ignore a reminder's claim that its last message was already delivered, and to send its report first. It SHALL NOT say that a missing report leaves the parent unaware of the exit, because the send-mode wake-up reports the exit state. Its statement about the session closing when a turn ends SHALL be conditional, because a role without `auto-exit: true` keeps its session open and gets the completion nudge. The `send` footer MUST NOT say that the last assistant message is delivered or read as the report. Both footers SHALL give the same report shape: at most 15 lines; the verdict first, then the commit SHA; one line for each verification check, PASS or FAIL, without command output; one line for each deviation and each open question. Both footers MUST NOT ask for the list of changed files, and SHALL say that the parent gets the changed files from the commit SHA. Both footers SHALL tell the child that it MAY put longer details in a file and name that file's path in the report, and that a report format in the brief overrides the footer's report shape and line limit. Each footer SHALL carry every rule it needs exactly once: a rule the footer states SHALL NOT be stated again in the same footer, and a rule the child's tool schema already states MAY be left out of it.

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
- **THEN** the rule about the report, the rule about `pmux_done`, the rule about a blocked child, the rule about the reminder and the report-shape rule each appear once in it

#### Scenario: Both footers bound the report
- **WHEN** a child reads its footer in `last` mode or in `send` mode
- **THEN** the footer sets a limit of 15 lines, puts the verdict first and the commit SHA next, and asks for one PASS or FAIL line for each verification check, without command output, and one line for each deviation and each open question

#### Scenario: Footers do not ask for changed files
- **WHEN** a child reads its footer in `last` mode or in `send` mode
- **THEN** the footer does not ask for the files changed, and says that the parent gets them from the commit SHA

#### Scenario: Details go in a named file
- **WHEN** a child reads its footer in `last` mode or in `send` mode
- **THEN** the footer says that the child may put longer details in a file and name that file's path in the report

#### Scenario: The brief's report format wins
- **WHEN** a child reads its footer in `last` mode or in `send` mode
- **THEN** the footer says that a report format in the brief overrides the footer's report shape and line limit
