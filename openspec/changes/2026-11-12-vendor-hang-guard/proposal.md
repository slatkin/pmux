# Proposal

## Why

The parent-side idle watchdog declares a non-interactive child "gone" after 180 seconds of a stale activity file and kills its pane. But the activity file is event-sourced, not a heartbeat: a child blocked inside one quiet tool call (`cargo bench`, a redirected build, `sleep 600`) produces no events, so a perfectly alive child is declared dead. Two worker kills on 2026-11-12 were exactly this: the child logged a graceful `Command aborted` when its pane died, and pi's detached bash left the hung cargo running as an orphan — the watchdog killed the babysitter and spared the problem.

pmux cannot fix this alone: it has no way to tell a dead child from a quiet one, and `kill-pane` cannot reap pi's detached (setsid) tool processes anyway. pi-hang-guard already solves the other half — it classifies commands (self-timed, idle-tolerant, watcher, interactive), measures silence against class thresholds, and aborts hung calls in-process where the abort reaps the process tree. It is MIT licensed. Vendoring it into pmux gives us both halves under one roof: a real liveness signal and an in-child hang handler we can customise for subagents.

## What Changes

- Vendor pi-hang-guard's `classify.ts` and a trimmed `engine.ts` into `pi-extension/pmux/` (MIT header retained). Dropped: i18n, the config file, the `/guard` command. Config comes from `PI_PMUX_GUARD_*` env keys and the pmux config.
- Children load the guard as a second `-e` extension next to `pmux-done.ts`; both launch paths (pi parent and external orchestrator) go through `buildPiLaunch`, so one argv change covers both. Non-interactive children default to `yolo` mode (soft-kill the hung process, turn survives, abort as fallback); interactive children and the parent session default to `observe`.
- The child gains an activity heartbeat: `aliveAt` refreshes on an always-on interval while the session lives, so a stale file means a dead or event-loop-wedged process — the watchdog's documented assumption becomes true.
- The activity file gains `toolCommand` (truncated, at `tool_execution_start`) and a `hang` block (silent duration, command class, level) so the parent sees *why* a child is quiet instead of guessing.
- A critical-level hang additionally messages the orchestrator: one steering message through the child's parent message file for a pi parent, the status/activity channel for an external one. Warnings stay pane-local, and a session with no orchestrator keeps the upstream notify-only behavior.
- The parent's gone-check switches from `updatedAt` staleness to `aliveAt` staleness. A live child is never killed for silence; a hung command is handled inside the child, where the abort path reaps the detached process tree. The status surface shows the hang state.
- To avoid two engines racing in children, launches detect an installed `pi-hang-guard` package in the pi config and pass `--no-guard` to the child when it is present.

## Capabilities

### New Capabilities

- `command-hang-guard`: classifies a child's tool executions, measures output silence and runtime against per-class thresholds, escalates (observe / guard / yolo) inside the child process, and publishes liveness (`aliveAt`) and hang state to the activity file for the parent.

### Modified Capabilities

- `subagent-supervision`: the gone-check measures heartbeat (`aliveAt`) staleness rather than event staleness; a live child is not finished for a quiet tool call; the supervisor surfaces the child's hang state.
- `external-orchestration`: the child extension lookup and launch spec gain the vendored guard file and the `PI_PMUX_GUARD_*` env keys, including the `--no-guard` deconfliction for an installed pi-hang-guard package.

## Impact

- Code: new `pi-extension/pmux/hang-classify.ts`, `hang-engine.ts`, `hang-guard.ts`; edits to `activity.ts` (schema + recorder), `pmux-done.ts` (heartbeat wiring), `launch-build.ts` (`-e` list, guard env, `--no-guard` detection), `idle-watchdog.ts` and `supervisor.ts` (`aliveAt` staleness, hang surfacing), `status.ts` (hang display).
- Contract: activity-file schema gains optional `aliveAt`, `toolCommand`, `hang` fields (backward-compatible; readers tolerate their absence). New `PI_PMUX_GUARD_MODE` / `PI_PMUX_GUARD_DISABLED` env keys.
- The external-orchestration spec must keep passing: the `-e` list and child env change are part of this change's deltas.
- Users who keep `npm:pi-hang-guard` installed see no change in their own sessions unless they uninstall it; children are deconflicted via `--no-guard`.
- Known limitation, unchanged: a *dead* child can still orphan detached grandchildren, because `kill-pane` does not reach other process groups. This change shrinks the window (live children are no longer killed) but does not add process-tree reaping to the gone path.
