# Proposal

## Why

A send-mode child's report is typed into the orchestrator's pane as
literal input followed by one Enter keypress. `send` prints
`{"sent":true}` and appends a `.sent` receipt as soon as tmux accepts
the keystrokes — before any byte reaches the receiving application.
Nothing verifies that the text landed.

On 2026-10-24 a 5568-byte report into a Claude Code pane vanished
entirely: tmux accepted the keys, the receipt was written, but the text
never appeared in the prompt, the scrollback, or the transcript. The
receipt then suppressed the run wrapper's "exited without a report"
wake-up, so the loss was silent and permanent. Four earlier reports on
the same pane, all under 4 KB, had arrived. This was not the first
occurrence.

The exact eater is unprovable — a key-eating pane state (copy-mode, a
modal) or an input burst the TUI dropped both fit total disappearance —
so the fix must not depend on diagnosing it. It must make consumption
observable: a durable report artifact, a short typed pointer, and an
acknowledgement the orchestrator sends after reading.

## What Changes

- `send` gains a new protocol, `file-ack-v1`, selected by the
  `PI_PMUX_REPORT_PROTOCOL` launch-env marker. In that mode `send`
  writes the report to a unique immutable file
  `<session>.<report-id>.report.md` before any tmux call, then types a
  short pointer that names the file, an `ack` command, and a unique
  visibility token.
- Pane submission is verified: the backend refuses when the pane is in
  a mode, requires the token to appear on the visible screen within a
  bounded poll, and issues exactly one Enter. It never sends editing
  keys into the parent's pane.
- `.sent` becomes an event log: `report` registrations,
  `notification` submissions and `ack` records. Kindless legacy lines
  still parse as notifications. Only an `ack` is a read receipt.
- `send` waits a bounded time for the ack and reports
  `acknowledged:true|false`. Timeout is not a failure: exit stays 0
  and the footer forbids the child from retrying.
- The new `ack` command appends the ack record. It is idempotent and
  refuses to claim success when it cannot persist.
- The run wrapper re-delivers every current-run report that lacks an
  ack at child exit — same report ID, fresh visibility token — and its
  own wake-ups become durable artifacts with pointers instead of raw
  typed text.
- Unmarked launches keep today's behaviour: raw typed text, kindless
  receipts, count-based wake-up suppression. A resumed old spec picks
  up the new protocol because the env is rebuilt.

## Capabilities

### Modified Capabilities

- `external-orchestration`: the send-mode report path becomes
  file+pointer+ack; footer, skill text, receipts, report counting and
  the wake-up change; `ack` joins the CLI.
- `tmux-backend`: a verified report-input primitive is added beside
  the existing fire-and-forget pane commands.

### Unchanged Capabilities

- `subagent-messaging`: `pmux_message` keeps its promised asynchronous
  fire-and-forget semantics, and the idle watchdog stays best-effort.

## Impact

- New modules: `pi-extension/pmux/report-artifact.ts` (IDs, immutable
  report files, pointer construction, atomic writes) and
  `pi-extension/pmux/report-delivery.ts` (verified submission and the
  bounded ack wait, shared by the CLI and the wrapper).
- `pi-extension/pmux/report-receipt.ts`: the `.sent` event formats and
  the state reader.
- `pi-extension/pmux/tmux.ts`: `verifiedAgentPrompt` beside
  `agentPrompt`.
- `pi-extension/pmux/cli.ts`: `send` becomes async and
  protocol-aware; new `ack` command and usage lines.
- `pi-extension/pmux/run.ts`: protocol selection, ID baseline,
  same-ID re-delivery, durable wake-up artifacts.
- `pi-extension/pmux/launch-build.ts`: `PI_PMUX_REPORT_PROTOCOL` in
  send-mode env; new send footer text.
- `skills/pmux/SKILL.md`, `docs/guide.md`, `README.md`: pointer
  workflow and the orchestrator's ack step.
- `skills/pmux/launch.ts`: no change (argv pass-through only).
- Tests in `test/test.ts`, `test/run.test.ts`, the cli and tmux
  suites.
