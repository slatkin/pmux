# Tasks

## 1. Vendored guard core

- [x] 1.1 Copy upstream `classify.ts` to `pi-extension/pmux/hang-classify.ts` with the MIT copyright header; port `test/hang-classify.test.ts` covering interactive, watcher, self-timed, idle-tolerant and `cd &&`/env-prefix normalization. Verify with `node --test test/hang-classify.test.ts`.
- [x] 1.2 Port the engine to `pi-extension/pmux/hang-engine.ts`: entries map, tick, idle-vs-runtime `measure`, the observe/guard/yolo `escalate` ladder, bounded auto-resume, action log; STE strings only, no i18n/config-file. Port the engine unit tests (`test/hang-engine.test.ts`) with a fake clock, covering thresholds per class, soft-kill fallback to abort, and resume cap. Verify with `node --test test/hang-engine.test.ts`.

## 2. Activity schema and heartbeat

- [x] 2.1 Extend `activity.ts`: optional `aliveAt`, `toolCommand`, `hang` fields in `SubagentActivityState` + validation; `recorder.heartbeat()`, a `command` argument on `toolExecutionStart` (truncated to the 200-char cap), and `recorder.hangUpdate()`; every write refreshes `aliveAt`. Publish the recorder on `globalThis` under a `Symbol.for` key in `pmux-done.ts`. Extend `test/test.ts` activity coverage: schema round-trip with and without the new fields, heartbeat refresh, hang set/clear.
- [x] 2.2 Add the always-on `unref`'d heartbeat interval (~15 s) in `pmux-done.ts`, cleared on `session_shutdown`. Test: a recorder with no events still refreshes `aliveAt`; shutdown stops writes.

## 3. Guard extension wiring

- [x] 3.1 Write `pi-extension/pmux/hang-guard.ts` (default-export extension): resolves mode from `PI_PMUX_GUARD_MODE` / `PI_PMUX_GUARD_DISABLED` and session interactivity (`yolo` for non-interactive pmux children, `observe` otherwise); fetches the shared recorder from `globalThis` for `hangUpdate`; registers `tool_execution_*` handlers and the `unref`'d ticker with the stale-on-reload guard; before `ctx.abort()` in guard/yolo-fallback, writes `<session>.interrupt` so `pmux-done` keeps the session open, then delivers the structured report as a user message. Tests: mode resolution matrix, marker written before abort, no activity write when recorder absent.
- [x] 3.2 Add orchestrator notification: warning → pane notify + activity `hang` block; critical → also one `ParentMessage` append to `getParentMessageFile(PI_PMUX_SESSION)` per tool call per level when a pi parent exists; no-op without a pmux parent. Tests: critical appends exactly once to the parent message file, repeated ticks do not re-append, a session with no parent sends nothing.
- [x] 3.3 Register the guard in `index.ts` for the parent session (`observe` default), timers retired on reload/shutdown per the `Symbol.for` pattern. Test: a second module load stops the first load's ticker.

## 4. Launch changes

- [x] 4.1 In `launch-build.ts`, add `-e hang-guard.ts` next to `pmux-done.ts` for pi children and set `PI_PMUX_GUARD_MODE` in the child env (resolved from run interactivity). Cover both launch paths in `test/cli.test.ts` and the supervisor launch-spec test: spec env holds `PI_PMUX_GUARD_MODE=yolo` for a non-interactive external child.
- [x] 4.2 Add the `--no-guard` detection: scan the pi `settings.json` `packages` arrays the child will load for `pi-hang-guard`; add `--no-guard` to the child argv only on a match. Tests: match by name/`npm:` prefix/path basename adds the flag; no match omits it; absent settings file is not an error.
- [x] 4.3 Update `skills/pmux/launch.ts` package-root validation to require `hang-guard.ts` alongside `cli.ts`/`pmux-done.ts` (self-contained, Node built-ins only). Test: a root missing `hang-guard.ts` fails the lookup with the `pi install` error.

## 5. Parent-side consumption

- [x] 5.1 Change `decideGoneAction`/`runIdleWatchdog` to measure staleness against `aliveAt ?? updatedAt`; keep `IDLE_GONE_MS`. Tests in the idle-watchdog suite: fresh `aliveAt` + ancient `updatedAt` is not gone; stale `aliveAt` is gone; missing `aliveAt` falls back to `updatedAt`; interactive never gone.
- [x] 5.2 Read the `hang` block into the status observation in `supervisor.ts`/`status.ts` and show the class + measurement in the child's status detail. Test: an activity file with `hang` level 2 renders the hang detail; the run continues.

## 6. Verification

- [x] 6.1 `pnpm test`, `pnpm run typecheck`, `pnpm run lint`, `pnpm run format:check` all pass (the pre-commit set).
- [x] 6.2 Replay the incident shape as a test: a fake child whose activity shows `tool_execution_start` then only heartbeats for a simulated 200 s must not get a gone sidecar; the same child with `aliveAt` frozen 200 s must get the error sidecar.
