# Tasks

## 1. Spike: does Claude Code's Monitor wake an idle session?

The user runs these live checks; the agent prepares nothing beyond this task
list. Record every answer in `openspec/changes/inbox-monitor-wake/spike.md`.
A failed 1.1 stops the change (design D6); the other answers only change the
skill text in group 5.

- [x] 1.1 Idle wake. In a fresh `claude` session in a tmux pane, ask it to run a persistent `Monitor` with the command `while true; do sleep 1; done` variant that prints a line only when a file appears (`until [ -f <scratch>/ping ]; do sleep 1; done; echo ping`). Wait until Claude is idle at its prompt, then `touch <scratch>/ping` from another pane. Record whether a turn starts with nobody typing; 1.2–1.5 proceed only if it does.
- [x] 1.2 Mid-turn arrival. With a monitor running, give Claude a long tool-heavy task, emit a line mid-turn, and record whether the notification arrives between tool calls or only at turn end, and how it is rendered.
- [x] 1.3 Permission and flags. Record whether the `Monitor` tool call or its shell command prompts for permission in the user's normal mode, and whether `persistent: true` is accepted without `timeout_ms`.
- [x] 1.4 Lifetime. Record whether a persistent monitor survives `/compact`, what happens at the `timeout_ms` ceiling when one is set, and whether a `--resume` restores it (expect not). After quitting Claude, record whether the pid in `<inbox>/.monitor` is still alive (`kill -0`); if it is, the change must make the follower exit when its stdout or parent goes away before group 5 is written.
- [x] 1.5 Re-arm rule. From 1.3–1.4, write into `spike.md` the exact instruction group 5 must put in `SKILL.md`: when the orchestrator must run `inbox --follow` again.

## 2. Inbox module

- [x] 2.1 Create `pi-extension/pmux/report-inbox.ts`: `inboxDirPath` (same FNV-1a 64 + `runtimeDirPath` derivation as `channel-endpoint.ts`, directory `pmux-inbox`), `InboxEntry` and its atomic write/read/list, `liveMonitor` (marker read + `process.kill(pid, 0)`), and `InboxUnavailableReason` (`no-inbox`, `unmonitored`, `write-failed`). `test/report-inbox.test.ts` pins the shared test vector (`79301cf9592f327a-12`), the no-`TMUX` case, the target-pane rule, atomic write, and live/dead/malformed markers. Verify with `node --test test/report-inbox.test.ts`.
- [x] 2.2 Add entry retirement helpers: `removeInboxEntry` and a list-and-drain that skips and deletes entries whose ID already has an `ack` record in `<session>.sent`, reusing `readReportLog`. Tests cover acked-entry sweeping, prune-style retention filtering, and the registration-before-entry ordering assumption. Verify with the same test file.
- [x] 2.3 Add `followInbox`: initial drain in `at` order, `fs.watch` plus a rescan interval (default 5 s, injectable), `(id, delivery)` dedup, and pointer-line formatting exactly as `report-inbox` specifies. Tests drive it with an injected rescan clock and a temp dir, including an inbox created after the follower starts. Verify with the same test file.

## 3. CLI: `inbox` command, `ack` retirement, `prune` sweep

- [x] 3.1 Add `inbox (--follow | --once) [--parent <pane>]` to `cli.ts`, dispatching beside `ack`; exactly one of `--follow` or `--once` is required (neither or both is exit 1, stderr names both flags, empty stdout), `--parent` defaults to `TMUX_PANE`, missing pane is exit 1 with a stderr message and empty stdout, `--once` writes no marker, the follower writes `.monitor` on start and removes it on SIGINT/SIGTERM, and a second follower on a live marker exits 1 naming the pid. `test/cli.test.ts` covers each case with an injected env and temp runtime dir. Verify with `node --test test/cli.test.ts`.
- [x] 3.2 Make `ackCommand` remove the report's inbox entry after the `ack` append, tolerating a missing entry and a failed removal. Tests cover ack-with-entry, ack-without-entry, and the exit code staying 0 on a removal failure. Verify with `node --test test/cli.test.ts`.
- [x] 3.3 Sweep runtime-dir inboxes in `pruneCommand`: delete entries past the launcher retention, drop empty inbox directories without a live marker, honour `--dry-run`, and include the counts in the prune output. Tests use a temp runtime dir with old and fresh entries. Verify with `node --test test/cli.test.ts`.

## 4. Transport: inbox first in the delivery flow

- [x] 4.1 Add `"inbox"` to `ReportVia` and `inboxError` to the notification record and result types in `report-receipt.ts` / `report-delivery.ts`; readers keep treating a record without `via` as `tmux`. Extend `test/report-receipt.test.ts` for the new fields and the old-record case. Verify with `node --test test/report-receipt.test.ts`.
- [x] 4.2 Add the inbox branch at the top of `submitReportPointer`: on a live marker write the entry (`from` = launch name, `delivery` 1 or incremented for the wrapper's re-delivery), append the `notification` record with `via:"inbox"`, and return without calling the channel or `verifiedAgentPrompt`; on `unavailable` fall through with `inboxError` set. `test/report-delivery.test.ts` covers delivered-by-inbox, unmonitored-then-channel, write-failed-then-channel, no-fallback-on-missing-ack, and re-delivery incrementing `delivery`. Verify with `node --test test/report-delivery.test.ts`.
- [x] 4.3 Update `sendCommand`'s result lines (`via`, `inboxError` on both success and the exit-2 failure line) and confirm the run wrapper's no-report wake-up and ping flow through the same branch. Extend `test/cli.test.ts` for the inbox result line and the wrapper cases (no typed input when monitored, durable wake entry). Verify with `node --test test/cli.test.ts` and `node --test test/test.ts`.

## 5. Docs: teach the monitor, demote the channel

- [x] 5.1 Rewrite the send-mode part of `skills/pmux/SKILL.md`: new "Inbox monitor" subsection with the exact `Monitor` call (`timeout_ms` 1800000; this build has no `persistent`), the re-arm rule from `spike.md` 1.5, the pointer-and-`delivery` reading rule, and the no-typed-pointer guarantee; retitle "Channel wake-up" to "Channel wake-up (legacy fallback)" with the do-not-pass-`--dangerously-load-development-channels` opening; forbid editing inbox entries alongside report and `.sent` files. Verify by reading the rendered section against the spec scenarios.
- [x] 5.2 Update `docs/guide.md` and `README.md` where they describe the channel or the typed pointer, so a new setup starts with the monitor. Verify with a search that no remaining text recommends the channels flag for pmux.

## 6. Gates

- [x] 6.1 Run `pnpm run format:check`, `pnpm run lint`, `pnpm run typecheck` and `pnpm test`; all four pass, and the full suite runs with no live tmux or Claude.
- [x] 6.2 Live rehearsal with the user: one Claude orchestrator running the monitor, one send-mode child, and a report sent while the orchestrator is idle at its prompt. Record the outcome in `spike.md`; the orchestrator is woken, reads the report, and its `ack` removes the entry.

## Workflow follow-up

- After the rehearsal and a real campaign, open the follow-up change that removes `report-channel`, `channel-endpoint.ts` and pmux-explorer's `--mcp`/`channel-ready`.
- Optional follow-up: a `Stop`/`PostToolBatch` hook that runs `inbox --once`, so a dead monitor still drains at turn boundaries.
