# Design

## Context

The parent's `runIdleWatchdog` (`supervisor.ts`) finishes a non-interactive child after `IDLE_GONE_MS` (180 s) of a stale activity file (`idle-watchdog.ts`). The file is written by `createSubagentActivityRecorder` (`activity.ts`) and is **event-sourced**: `updatedAt` only advances when a pi event fires. A live child inside one quiet tool call trips the gone-check. The kill is also incomplete: pi's bash tool spawns its shell `detached` (own process group), so `tmux kill-pane` kills the pi child but orphans the hung command — the exact failure observed twice on 2026-11-12.

pi-hang-guard (MIT, `npm:pi-hang-guard`) already implements the missing judgment: `classify.ts` (229 lines, pure regex) and `engine.ts` (606 lines, tick-based). Both launch paths build the child argv in one place, `buildPiLaunch` (`launch-build.ts`), which already adds `-e pmux-done.ts`.

## Goals / Non-Goals

**Goals:**

- A stale activity file means dead-or-wedged, never "quiet tool call".
- A live child is never killed for silence; a hung command is aborted inside the child, where pi's abort path reaps the detached process tree.
- The parent sees *why* a child is quiet (command, class, measurement).

**Non-Goals:**

- Reaping the process tree of a *dead* child. `kill-pane` still orphans grandchildren of a crashed child; the window shrinks because live children are no longer killed, but the gap stays.
- The `/guard` TUI command, i18n, and the upstream config-file format. Config is env + pmux config only.
- Changing the idle nudge/finish path for `waiting`-phase children (30 s × 2 nudges → `done` sidecar stays as-is).

## Decisions

### D1 — Vendor layout: three flat modules

`pi-extension/pmux/hang-classify.ts` is a near-verbatim copy of upstream `classify.ts` with the MIT header. `pi-extension/pmux/hang-engine.ts` ports `engine.ts`: per-tool-call entries, a tick, `measure` (idle vs. runtime by class), and the `escalate` ladder — minus i18n (fixed STE strings), the config file, and the status widget. `pi-extension/pmux/hang-guard.ts` is the extension entry: a default-export function that reads its config from env and registers the `tool_execution_*` handlers and the ticker.

Upstream keeps a `stale` flag so a `/reload` stops the ticker; keep that pattern, and also clear the ticker on `session_shutdown`. The interval is `unref`'d as upstream does.

*Alternative considered:* importing the installed package. Rejected — installed packages are frozen, imports across pi packages are unsupported, and the whole point is customisation.

### D2 — `aliveAt`, not a re-purposed `updatedAt`

The activity schema gains a separate `aliveAt` field, refreshed by the heartbeat and by every event write. `updatedAt` keeps meaning "last event", which the gone-error detail and the idle-nudge logic still want. A separate field is backward-compatible: the validator gains an optional finite-number field, and the parent reads `aliveAt ?? updatedAt`, so a child on an older pmux still works.

*Alternative considered:* heartbeat bumps `updatedAt`. Rejected — it erases the distinction between "alive" and "last did something", which is exactly the diagnostic the error message prints.

### D3 — Heartbeat lives in `pmux-done.ts`, not the guard

Liveness is pmux's own contract with the parent; it must survive `PI_PMUX_GUARD_DISABLED=1`. `pmux-done.ts` owns the recorder and the session lifecycle, so it sets one `unref`'d interval (~15 s, well under the 180 s bound) that calls a new `recorder.heartbeat()` and clears it on `session_shutdown`. The upstream ticker pattern (stop when no tools run) is fine for the engine but would fail the heartbeat — hence two timers.

### D4 — Children default to `yolo`; `ctx.abort()` is the real reaper

`yolo` is the stated non-interactive default because it is the best behavior where it works: soft-kill the hung process, keep the turn, let the model see a non-zero exit and adapt. On the *bundled* pi build the soft kill is unreachable — upstream's own code detects `dist/bundle` and reports it unavailable, so `yolo` degrades to the abort path. That fallback is still correct: `ctx.abort()` drives pi's bash abort handler, which calls `killProcessTree(child.pid)` and reaps the whole detached process group — cargo included. Either branch kills inside the child, which is what `kill-pane` cannot do. Interactive children and the parent session default to `observe` — a human is there to see warnings.

### D5 — Guard abort reuses the interrupt marker

A `guard`-mode `ctx.abort()` makes the turn end with `stopReason: "aborted"`. `pmux-done.ts` would read that as a user cancel and write the `cancelled` sidecar — killing the child instead of letting it continue. Before aborting, the guard writes `<session>.interrupt`, the same marker `pmux_interrupt` writes; `pmux-done` then applies the established "parent interrupt keeps the session open" path: marker removed at `agent_end`, no sidecar, session stays open, and the guard's structured report goes in as a new user message. No new mechanism, no spec ambiguity — this only works because the vendored guard can write pmux's own marker, which is the customisation the change exists for.

### D6 — One shared activity recorder via `globalThis`

Two extension files (`pmux-done.ts`, `hang-guard.ts`) in the same child process must not race writes to the same activity file — last writer wins and fields would be lost. `pmux-done.ts` publishes its recorder on `globalThis` under a `Symbol.for` key (the reload-safety pattern `index.ts` already uses); `hang-guard.ts` fetches it and no-ops when absent (a non-pmux session has no activity file anyway). The recorder gains `heartbeat()`, and `toolExecutionStart` gains a `command` argument that lands in `toolCommand` (truncated to the existing 200-char cap); the engine's tick calls a `hangUpdate()` recorder method to add/clear the `hang` block, on the existing 500 ms throttle.

### D7 — `--no-guard` deconfliction in `buildPiLaunch`

The builder scans the pi settings the child will load (`~/.pi/agent/settings.json` plus the child cwd's `.pi/settings.json`) `packages` arrays for an entry naming `pi-hang-guard` (`npm:` prefix or path basename). A match adds `--no-guard` to the child's pi argv — the flag is registered by that package, so it exists exactly when needed. Missing the check (e.g. the user `-e`s the package manually) means two engines warn twice; aborts are idempotent enough that the first wins, so the failure mode is noise, not corruption.

### D8 — Critical hangs reach the orchestrator as a steering message

Upstream reports everything through `ctx.ui.notify`, which a subagent's orchestrator never sees. The vendored guard routes by level and parent kind: warning stays in the pane plus the activity `hang` block; critical additionally appends one `ParentMessage` to `getParentMessageFile(PI_PMUX_SESSION)` — the same file `pmux_message` writes — so `deliverParentMessages` injects it into the parent's conversation on its next poll tick and the orchestrator can `pmux_interrupt`, reply, or wait. One append per tool call per level keeps it a signal, not a drip feed. With no `PI_PMUX_SESSION` (a single agent or the parent session itself) the pane notify is the whole behavior — identical to upstream. For an external orchestrator no steering channel exists; its `wait` polls the status file and the activity `hang` block, so the hang is visible there instead. The `blocked` status is not used — it is terminal and latches for the process.

### D9 — Parent consumes, does not act

`decideGoneAction` measures staleness against `aliveAt ?? updatedAt`. `observeRunningSubagent` reads the `hang` block into the status observation so the widget/status line can show e.g. `bash 150s idle · one-shot`. The parent never auto-interrupts on hang: the child's own engine handles it (`guard` default), and `pmux_interrupt` stays the manual escape hatch — which now reaps correctly because the abort happens inside the child.

## Risks / Trade-offs

- **Guard abort loops.** A wedged fixture could hang every retry. → The ported engine keeps upstream's bounded auto-resume (`maxAutoResumes`); after that it stays in observe for that command.
- **Stale interrupt marker masks a real cancel.** If `ctx.abort()` fails after the marker is written, the next genuine user abort looks parent-driven and writes no `cancelled` sidecar. → The marker is written immediately before the abort call in one tick; `pmux-done` removes markers on every agent start/end, so staleness is bounded to one turn. Same exposure the existing interrupt path already accepts.
- **`--no-guard` detection is a heuristic.** A `packages` entry that names the package by a path not matching the basename check is missed → double warnings, not corruption. Documented in the spec's scenario as best-effort.
- **Heartbeat write volume.** One small JSON write per child per ~15 s — negligible; writes use the existing temp+rename path.
- **Upstream drift.** The vendored copy no longer tracks pi-hang-guard releases; accepted — customisation is the point, and the user may uninstall the npm package once this lands.

## Migration Plan

1. Land the vendored modules + activity schema fields + heartbeat first; parents and children can run mixed versions (old child writes no `aliveAt` → parent falls back to `updatedAt`; new child with old parent → extra fields ignored).
2. Then the `-e` argv, env keys and `--no-guard` detection in `buildPiLaunch`, then the parent-side consumption.
3. Rollback: revert the launch change — children lose the guard file but old `pmux-done` alone is the previous behavior.
4. After release, the user may uninstall `npm:pi-hang-guard`; the vendored engine covers their sessions via `index.ts`.

## Open Questions

- Should `observe` also be the parent-session mode forever, or should the pmux config get a `hangGuard` section (`mode`, thresholds) so users can opt the parent into `guard`? The env override already exists; a config key is a small follow-up and does not change the specs.
- Should an external-orchestrator child get a real steering channel for critical hangs (the `file-ack-v1` `send` path can already type a pointer into the orchestrator's pane)? Deferred: the status/activity channel is enough for a first cut, and reusing the report protocol for mid-run notices deserves its own design.
