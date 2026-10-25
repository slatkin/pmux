# Proposal

## Why

The `file-ack-v1` pointer reaches a Claude Code parent only through
`send-keys`, and `send-keys` simulates terminal input. It can fail with
no error. A busy Claude prompt can show the pointer and accept the Enter
without reading it, output can scroll the visibility token away, and an
Enter exception becomes `unknown`. A `notification` record proves that
the text was typed, not that it was read. The 2026-10-24 loss of a
5,568-byte report (archived change `2026-10-24-report-file-ack`) came
from this class of failure.

Claude Code Channels is Claude Code's own path for external events: an
MCP server pushes `notifications/claude/channel` into the open session,
and the event queues until the next turn when Claude is busy. It removes
the TTY-input failure class. Most of its limits are setup-time checks,
not silent loss per report.

## What Changes

- For a marked (`file-ack-v1`) report, `send` and the run wrapper's exit
  re-delivery first submit the pointer to a **channel endpoint**: a
  local Unix socket that the parent's `pmux-explorer --mcp` process
  owns, one socket per parent pane. The endpoint emits the pointer into
  its own Claude session as a channel event.
- `send-keys` (the verified report input) stays only as the fallback.
  pmux uses it when the endpoint is missing, refuses the connection,
  times out, replies that it is not armed, or replies with an error.
  pmux never falls back because the `ack` did not come: a busy parent is
  not a transport failure.
- The endpoint accepts reports only after Claude has proved that the
  session registered the server as a channel (the arm probe, specified
  in the `pmux-explorer` change `channel-endpoint`). Claude Code drops
  channel events silently in a session that did not register the
  channel, so without this proof the fallback rule could not work.
- An accepted endpoint request is not a read receipt. The explicit
  `ack` stays the only proof that the parent read the report. Report
  ID, artifact, `report` registration, `ack` and exit re-delivery do
  not change.
- The `notification` record gains `via` (`"channel"` or `"tmux"`) and,
  after a fallback, `channelError`. The `send` result line gains `via`
  and, after a fallback, `channelError`; the refusal line gains
  `channelError`. These fields are additive.
  Exit codes do not change.
- Unmarked (legacy) `send`, `pmux_message`, the pi-parent path and
  all pane lifecycle stay on tmux and do not change.

## Capabilities

### New Capabilities

- `report-channel`: the pmux side of the channel transport. It covers
  the endpoint path rule, the request and reply line, the result
  classes, and the rule that selects the channel or the tmux fallback.

### Modified Capabilities

- `external-orchestration`: `send` submits through the report
  transport (channel first) and reports `via` and `channelError`. The
  `notification` record carries `via` and `channelError`. The wrapper's
  exit re-delivery and its wake-up pointer use the same transport.

### Unchanged Capabilities

- `tmux-backend`: the verified report input does not change. It becomes
  the fallback.
- `subagent-messaging`: `pmux_message` keeps raw typed input.

## Non-goals

- A refusal of the tmux fallback when the parent pane runs a shell.
  That is a separate change.
- A channel for a pi parent. The pi parent gets reports through the
  supervisor, not through `send`.
- Any change to Claude Code. pmux uses the Channels contract as
  Claude Code ships it.

## Impact

- New module `pi-extension/pmux/channel-endpoint.ts`: the path rule and
  the socket client (Node built-ins only).
- `pi-extension/pmux/report-delivery.ts`: `submitReportPointer` routes
  channel first, then the verified input. It gets a new injected
  dependency, `submitChannel`.
- `pi-extension/pmux/report-receipt.ts`: optional `via` and
  `channelError` on `notification` records.
- `pi-extension/pmux/cli.ts`: `via` and `channelError` in the `send`
  output lines.
- `pi-extension/pmux/run.ts`: no code change. It reaches the routing
  through `deliverReport`.
- `skills/pmux/SKILL.md`, `docs/guide.md`, `AGENTS.md`: how to start a
  Claude parent with the channel, and the fallback.
- **Prerequisite:** the `pmux-explorer` change `channel-endpoint`
  (repository `slatkin/pmux-explorer`) provides the endpoint, the arm
  probe and the shared path rule. It must land first. Without it, this
  change has no channel to deliver to.
- Tests: a new `test/channel-endpoint.test.ts`, plus cases in the
  delivery, receipt and cli suites.
