# Proposal

## Why

The `send` command answers nobody. It types the report into the parent's
pane, writes a receipt and exits 0 in silence, so a child cannot tell a
delivery from a no-op. On 2026-10-22 a reviewer child finished a bounded
review of commit `cb042b780`, sent its PASS report, saw no confirmation, and
sent a second message to the parent: `ping-check-cb042b780`. The parent
read the token as an unexplained turn and answered with a state summary it
had no reason to produce.

The probe could not have worked. The child exits right after the report, the
receipt is on disk before the child exits, and the pane-side wrapper counts
that receipt to decide it must not wake the parent. The delivery was already
proven; the child only lacked a positive signal.

A command an agent runs must answer. Silence reads as failure, and an agent
that cannot read the result either guesses or probes. Every other pmux
command already answers: `start` and `resume` print JSON, `wait` prints its
JSON line, `prune` prints its counters, `last-message` prints the message.
`send` was the only silent one, and this change closes that gap and pins the
rule so the next command cannot repeat it.

## What Changes

- `send` prints one JSON line on stdout when it delivers:
  `{"sent":true,"to":<pane>,"bytes":<n>,"receipt":<path or null>}`. The byte
  count is the UTF-8 length of the text as given, the same unit the receipt
  uses. The receipt path is the absolute path of the `<session>.sent` file,
  or null when the send ran outside a child or the receipt could not be
  written.
- A usage error keeps its current shape: a message on stderr, nothing on
  stdout, exit 1.
- The send-mode parent-contact footer tells the child that the command
  prints a confirmation line, that the line is the delivery receipt, and
  that it must not send a second message to check.
- The spec pins the general rule: every CLI command prints on success, and a
  usage error prints on stderr with an empty stdout.

## Non-goals

- No acknowledgement from the parent back to the child. The delivery proof
  stays one-way: the receipt and the child's own exit.
- No change to the exit codes, the typed text, the receipt format, the
  `.exit` sidecar or the wake-up rule.
- No new command, and no change to the pi-parent path.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `external-orchestration`: the `send` command's success output, the general
  rule that a command answers on success, and the send footer's confirmation
  sentence.

## Impact

- `pi-extension/pmux/cli.ts`: `sendCommand` prints the confirmation line;
  `writeReportReceipt` returns the receipt path.
- `pi-extension/pmux/report-receipt.ts`: `appendReportReceipt` reports
  whether the line was written.
- `pi-extension/pmux/launch-build.ts`: the send footer's confirmation
  sentence.
- `skills/pmux/SKILL.md` and `docs/guide.md`: the confirmation line.
- Tests: `test/cli.test.ts` and `test/launch-build.test.ts`.
