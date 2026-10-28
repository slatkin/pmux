# Proposal

Tracks GitHub issue [#19](https://github.com/slatkin/pmux/issues/19). The issue
asked for a tmux `wait-for` doorbell; the discussion under it found that the
real problem is not latency but delivery reliability to a Claude Code
orchestrator, and that no tmux primitive can solve it. This change is the
outcome of that discussion. Issues #20–#22 stay separate.

## Why

A send-mode report reaches a Claude Code orchestrator today through two push
transports, and both are unreliable by construction: the verified `send-keys`
input types into Claude's prompt buffer and fails or misfires when the session
is busy, in a mode, or mid-paste; the channel endpoint depends on a research-
preview Claude feature (`--dangerously-load-development-channels`), on an
arm step the prompt has to remember, and on org-level enablement. Claude Code
2.1.98+ ships a built-in `Monitor` tool: a background shell command whose
stdout lines wake the session, idle or busy, through the harness itself. A
Claude session on this machine has already improvised exactly that to wait for
a pi report. pmux should make it the delivery path.

## What Changes

- **New: a per-parent report inbox.** A directory derived from `TMUX` and the
  parent pane id, beside the existing channel socket rule. `send` and the run
  wrapper drop one entry per report (or no-report wake-up, or ping) into it,
  and `ack` retires the entry. The inbox is the durable truth: an entry stays
  until it is acknowledged, so a delivery can be late but never lost.
- **New: an `inbox` CLI command**, reachable through the skill shim as
  `node <skill-dir>/launch.ts inbox --follow`. It prints the pending entries
  once, then prints one line per new or re-delivered entry for as long as it
  runs, and records itself as the inbox's live monitor. The orchestrator runs
  it once per session as a `Monitor` with `timeout_ms` (re-armed when it expires); each printed line is the
  pointer the orchestrator already knows how to act on.
- **Changed: report transport selection.** A marked (`file-ack-v1`) submission
  checks the inbox first. With a live monitor it writes the entry and stops:
  no channel request, no `send-keys`. Without one, the channel-first-then-tmux
  fallback runs unchanged. The `send` result line and the `notification`
  record gain `via:"inbox"`.
- **Changed: exit re-delivery.** With a live monitor, an unacknowledged
  report is re-delivered by rewriting its inbox entry, which the monitor
  prints again; the no-report wake-up and the ping become inbox entries too.
- **Changed: the skill.** `SKILL.md` tells a Claude Code orchestrator to start
  the inbox monitor at the start of a send-mode orchestration and after a
  `--resume`, and demotes the "Channel wake-up" section to a legacy fallback
  that is no longer recommended.
- **Spike first.** The live behaviour of `Monitor` (idle wake, mid-turn
  arrival, permission prompt, `persistent` versus `timeout_ms`, survival
  across `/compact`, whether the follower outlives a quit session) is
  verified by hand before any code is written; a failed spike stops the
  change with nothing torn down.

Not in scope: removing `report-channel`, `channel-endpoint.ts`, or
pmux-explorer's `--mcp` and `channel-ready`. They stay as the fallback and are
never contacted while a monitor is live. A follow-up change removes them once
the inbox has carried real campaigns. Claude Code hooks (`Stop`,
`PostToolBatch`) as a second drain of the same inbox are also a follow-up.
The pi-parent path (`pmux_spawn`, the supervisor) is untouched.

## Capabilities

### New Capabilities
- `report-inbox`: the per-parent inbox directory, its entry format and
  lifecycle (dropped by `send` and the wrapper, retired by `ack`), the live-
  monitor marker, and the `inbox` command that follows it.

### Modified Capabilities
- `report-channel`: "Report transport selection" puts the inbox first and
  runs the channel/tmux fallback only when no live monitor exists.
- `external-orchestration`: "Send command" (inbox step and `via:"inbox"` in
  the result line), "Report receipts" (`via:"inbox"` in the `notification`
  record), "Send-mode wake-up" (inbox re-delivery, no-report wake-up and ping
  as inbox entries), and "Packaged orchestration skill" (`SKILL.md` teaches
  the monitor and demotes the channel).

## Impact

- `pi-extension/pmux/`: a new `report-inbox.ts` (path rule, entry read/write,
  marker liveness, follow loop); `report-delivery.ts` (`submitReportPointer`
  gains the inbox branch); `report-receipt.ts` (`ReportVia` gains `"inbox"`);
  `cli.ts` (`inbox` command, `ack` retires the entry, wrapper re-delivery);
  `runtime-dir.ts` is reused as is.
- `skills/pmux/SKILL.md` and `README.md`/`docs/guide.md` where they describe
  the channel; `launch.ts` is unchanged (it forwards every subcommand).
- Tests: new `test/report-inbox.test.ts`; `report-delivery.test.ts`,
  `cli.test.ts` and `report-receipt.test.ts` grow the inbox cases. No live
  tmux and no live Claude in tests; the spike is the only live step and the
  user runs it.
- No change to `pmux-done.ts`, the `PI_PMUX_*` variables or the `.exit`
  format, so the `external-orchestration` contract for children holds.
- Dependency: the orchestrator's Claude Code must have the `Monitor` tool
  (2.1.98+; 2.1.311 is installed here). Without it the fallback transports
  apply exactly as today.
