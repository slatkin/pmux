# Design

## Context

See proposal.md — Why. What the code gives this change already:

- `report-delivery.ts` is the one funnel every marked submission goes through.
  `submitReportPointer` builds one pointer shape (`buildReportPointer`) and
  then runs channel-first-then-verified-input; both `send` and the run
  wrapper's exit re-delivery call it. The new transport is therefore one new
  branch in one function, not a parallel delivery path.
- `registerReport` already writes the report file and the `report` record
  before any transport, so the inbox entry can be derived from the
  registration; the entry never holds report text.
- `channel-endpoint.ts` already solves the "which directory belongs to this
  parent" problem: FNV-1a 64 of the first `TMUX` field, the pane id, and
  `runtimeDirPath`. The inbox reuses the same derivation with a different
  directory name so sender and receiver agree without a registry.
- `launch.ts` forwards any subcommand to `cli.ts`, so `inbox` is a CLI command
  only; the shim, and therefore `npx skills add` compatibility, is untouched.
- `prune` walks the pi scratch dir; the inbox lives in the runtime dir, so its
  cleanup needs a small explicit sweep, not a change to the scratch walk.

Constraints: `external-orchestration` must keep passing (nothing here touches
`pmux-done.ts`, `PI_PMUX_*` or `.exit`); tests never need live tmux or live
Claude; the orchestrator may not have the `Monitor` tool at all.

## Goals / Non-Goals

**Goals:**

- A report owed to a Claude Code parent is a durable inbox entry until it is
  acknowledged, and the parent's `Monitor` prints its pointer, so no delivery
  depends on the parent being idle, in the right mode, or channel-armed.
- Every existing transport keeps working unchanged when no monitor runs.
- One module owns the inbox; the delivery flow gains a branch, not a rewrite.

**Non-Goals:**

- Claude Code hooks (`Stop`, `PostToolBatch`) draining the inbox. The monitor
  is the wake; a hook-based idle drain is a follow-up, and the entry format is
  chosen so it can be added without migration.
- Removing the channel transport or anything in pmux-explorer.
- The pi-parent supervisor, `pmux_message`, and the `last` report mode.
- Sub-second delivery guarantees. 5 s rescan bound is enough for a wake.

## Decisions

### D1 — The entry is the delivery; the monitor is only a printer

`send` writes `<inbox>/<id>.json` (atomic temp+rename) and considers the
report submitted. It does not wait for the monitor to print, and it never
tries to find out whether the parent read the line. Reading is still proved
only by the `ack` record, which is why the existing `--ack-timeout` wait and
the wrapper's exit re-delivery of unacknowledged reports stay meaningful and
unchanged in shape. Alternative considered: treat the printed line as a
delivery receipt and drop re-delivery. Rejected because a `Monitor` batches
lines and can be killed mid-run; only the ack is a read receipt today, and
inventing a second receipt class would weaken the contract the child footer
already teaches.

### D2 — Liveness is a marker file with a pid, not a process probe by the sender

`inbox --follow` writes `.monitor` (`{"v":1,"pid","at"}`) on start, removes it
on SIGINT/SIGTERM/normal exit. The sender checks the marker and
`process.kill(pid, 0)`; anything else (missing, malformed, dead pid) means
`unmonitored` and the old transports run. This is the cheapest liveness rule
that never leaves a sender typing into a pane while a monitor is printing.
Alternatives considered: a Unix socket handshake like the channel (adds a
server and the same connect-timeout machinery I am trying to leave behind);
an always-inbox rule with no liveness (a forgotten monitor would silently
swallow every report). A pid file can be stale after a reboot, but the runtime
dir is `$XDG_RUNTIME_DIR` (tmpfs, cleared at logout) or `/tmp`, and the pid
check plus `at` timestamp is enough here.

### D3 — `inbox --follow` prints pending entries first, then follows

On start it lists un-acked entries in `at` order and prints them, then follows
with `fs.watch` on the inbox directory plus a rescan every 5 s (the rescan
also covers an inbox directory that is created after the follower starts).
State is `(id, delivery)` per printed entry, so an entry is printed once per
re-delivery and never twice for the same write. `--once` shares the drain
path and is what a future `Stop` hook would call. Alternative considered:
`inotifywait -m` in the `Monitor` command. Rejected: the skill ships no shell
scripts, the command must drain the backlog before following, and a CLI
command is testable with `node:test`.

### D4 — Transport order is a strict chain, and errors accumulate

`submitReportPointer` gains `deliverInbox` as its first step. `ReportVia`
gains `"inbox"`; `PointerSubmitResult` gains `inboxError` (an
`InboxUnavailableReason`: `no-inbox`, `unmonitored`, `write-failed`), present
on every result that did not go through the inbox, mirroring how
`channelError` behaves. The `send` result line and the `notification` record
carry the new fields. Existing scenarios for channel/tmux paths keep their
behaviour; only their preconditions gain "inbox unmonitored", which the spec
delta states. Unmarked sends never look at the inbox.

### D5 — `ack` retires the entry; readers also sweep

`ack` removes `<inbox>/<id>.json` after appending the `ack` record, and a
failure to remove is not a failure of the ack (the reader's own rule — an
entry whose ID is acked is removed, not printed — covers it). Sweeping in the
reader too means an entry can never be printed after it has been read, which
is what makes "no duplicates except re-delivery" hold without coordination
between processes.

### D6 — The spike is a gate, not a task that can be half-done

Before any module is written, the user runs the live checks (tasks 1.1–1.5):
idle wake, mid-turn arrival, permission prompt, `persistent` versus
`timeout_ms` expiry, `/compact` and `--resume` survival, and whether the
follower process outlives a quit Claude session. Results are recorded
in `openspec/changes/inbox-monitor-wake/spike.md`. If idle wake does not
happen, the change stops: the design depends on it and no fallback would
satisfy the requirement that an idle orchestrator is woken. If the follower
outlives its session, its live marker would swallow every later report, so
the follower must exit when its stdout or parent goes away before group 5 is
written. The other answers only change the skill text (when to re-arm, whether to add a `Stop`-hook
follow-up), so they do not block implementation.

## Risks / Trade-offs

- Monitor does not wake an idle session → stop after the spike (D6). Nothing
  has been removed, so the channel/tmux path is still the shipped behaviour.
- A monitor dies silently and reports pile up unprinted → D2 makes senders
  fall back to typing, and the entry stays durable, so a later `--once` or a
  restarted follower drains them. The skill tells the orchestrator to restart
  the monitor after `--resume`.
- Pid reuse makes a dead monitor look live → bounded: the entry is still
  durable and the wrapper re-delivers at exit; `at` gives a human a way to see
  the marker is old. Accepted rather than adding a socket handshake.
- Two orchestrators on one pane (after `/clear` plus a forgotten old monitor)
  → the second `inbox --follow` exits 1 naming the live pid, so the old one
  keeps printing; the user kills it with `TaskStop`.
- `fs.watch` coalescing or platform quirks → the 5 s rescan is the correctness
  path; the watcher is only a latency optimisation, so tests can drive the
  rescan alone.
- Inbox grows unbounded when the parent never acks → `prune` reclaims entries
  past retention and removes empty inboxes; un-acked entries are by
  definition small JSON pointers, not report bodies.

## Migration Plan

1. Spike, recorded in `spike.md`; abort here if idle wake fails.
2. Land `report-inbox.ts` + `inbox` command with no transport change: the
   command can be run and tested against entries written by tests.
3. Wire the inbox branch into `submitReportPointer` and `ack`; extend
   `ReportVia` and the result lines. Existing suites keep passing with the
   inbox unmonitored.
4. Update `SKILL.md`, `docs/guide.md`, `README.md`; demote the channel section.
5. Run the four gates (`format:check`, `lint`, `typecheck`, `test`), then one
   real campaign with a Claude orchestrator before considering the follow-up
   that removes the channel.

Rollback: with no live marker the new code is inert, so reverting the skill
text alone restores today's behaviour; a full revert of the commits leaves no
state behind except runtime-dir entries that `prune` reclaims.
