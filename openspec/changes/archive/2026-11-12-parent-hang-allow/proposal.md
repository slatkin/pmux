# Proposal

## Why

A live test of the vendored hang guard exposed a missing move in the orchestrator's hand. A yolo child running `sleep 240` crossed the critical threshold at 150 s of silence; the parent got the steering message — and the guard soft-killed the command ~15 s later. The message offers `pmux_interrupt` or "wait", but waiting cannot save a legitimate long quiet command, and interrupt kills it. The orchestrator is the one actor that knows whether the silence is legitimate — it dispatched the `cargo bench` — yet it has no way to say "let it run".

Two gaps follow: there is no *allow* signal at all, and even if one existed, the soft-kill lands seconds after the notification — far too fast for a human, and unreliable even for an AI orchestrator.

## What Changes

- A session-local allow marker, `<session file>.allow` next to the existing `.interrupt` marker: while it is present, the watchdog's tick exempts the watched execution it names — or every execution currently at warning/critical when the marker carries no name — for the rest of that tool call. The hang block retracts, the file is consumed, and the pane notes the exemption.
- `pmux_allow`, a parent tool mirroring `pmux_interrupt`: it writes the allow marker next to a running child's session file and returns an acknowledgement. The external CLI gains `allow --session <file>` writing the same marker, and the skill documents the file.
- A parent-response grace: when the session is a pmux child (`PI_PMUX_SESSION` set — pi parent and external orchestrator alike), the critical level first sends its notification, then defers the mode's action (soft-kill in `yolo`, abort in `guard`) until the grace elapses or an allow arrives. A session with no parent acts at critical exactly as today. The grace is a guard setting, default 90 s, overridable through `PI_PMUX_GUARD_ALLOW_GRACE_SEC`.
- The critical steering message names the allow option so the parent learns the move exists at the moment it needs it.

## Capabilities

### Modified Capabilities

- `command-hang-guard`: the critical-level action defers to the parent-response grace in a pmux child, and the allow marker exempts a watched execution for its remaining lifetime.
- `subagent-supervision`: the parent gains `pmux_allow`, writing the allow marker for a running child.
- `external-orchestration`: the `.allow` marker becomes a documented input next to the session file, and the CLI gains `allow --session`.

## Impact

- Code: `hang-engine.ts` (allow exemption, grace-pending state), `exit-sidecar.ts` (allow marker path/read, next to the interrupt marker), `hang-guard.ts` (marker poll on tick, retract-and-notify on consume, updated steering text), `index.ts` + `supervisor.ts` (`pmux_allow`), `cli.ts` (`allow` command). `skills/pmux/launch.ts` stays a pure shim — no change needed.
- Contract: one new marker file `<session>.allow` (sibling of `.interrupt`), one new env key `PI_PMUX_GUARD_ALLOW_GRACE_SEC`, one new tool `pmux_allow`. All additive; a child without the marker or a parent behaves exactly as today.
- Timing: a parented child's critical action moves from ~150 s to ~150 s + grace (default 240 s total). Accepted — the alternative is an allow option that exists only on paper.
- Non-goals: allow applies to the running tool call only — no command-signature whitelist, no session-wide snooze, no indefinite hold; a marker that arrives after the action has no effect.
