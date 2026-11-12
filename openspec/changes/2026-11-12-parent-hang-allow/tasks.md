# Tasks

## 1. Engine: allow exemption and grace

- [x] 1.1 Add `parentAllowGraceSec` (default 90) to `HangGuardSettings`/`DEFAULT_GUARD_SETTINGS` in `hang-engine.ts`, and the `PI_PMUX_GUARD_ALLOW_GRACE_SEC` override where `resolveGuardSettings` reads env. Entry fields: `allowedByParent`, `parentAllowDeadlineAt`.
- [x] 1.2 Defer the critical action while `PI_PMUX_SESSION` is set: at critical, run the notification path and set the deadline instead of acting; on deadline elapsed, fire the mode's action. Exempt `allowedByParent` entries from measure/escalate until the entry retires. Tests with the fake clock: parented critical notifies immediately and acts only after the grace; unparented acts at once; exempted entry never acts.

## 2. Allow marker

- [x] 2.1 `exit-sidecar.ts`: `allowMarkerPath(sessionFile)` and a read-and-delete consume helper next to the interrupt marker helpers; consume accepts an optional `{"toolCallId"}` body.
- [x] 2.2 `hang-guard.ts`: resolve the session file once (the way the interrupt-marker write already does), poll the marker each tick, exempt matching entries at warning/critical (all of them when the body is empty/unparseable), retract their `hang` blocks via `hangUpdate(undefined)`, pane-notify the exemption, delete the marker. Tests: marker during grace exempts and clears the hang block; named marker exempts one call; marker with nothing hung is dropped; marker after the action does nothing.

## 3. Parent tool and CLI

- [x] 3.1 `pmux_allow` in `index.ts` mirroring `pmux_interrupt` (id/name params, render lines), `supervisor.allow` writing the empty marker at the running child's session file. Tests: marker lands at the right path; unknown child fails like interrupt.
- [x] 3.2 `cli.ts` `allow --session <file>` writing the marker; one line in `skills/pmux/SKILL.md` next to the nudge guidance. `skills/pmux/launch.ts` untouched. Tests: CLI writes the file.

## 4. Steering message

- [x] 4.1 Update the critical parent-message text in `hang-guard.ts` to name the allow action (`pmux_allow`, or `allow --session` for external children per `PI_PMUX_EXTERNAL_PARENT`), the interrupt, and the grace duration. Test the message body.

## 5. Verification

- [x] 5.1 Replay the test scenario with the fake clock: parented yolo child, quiet `bash` at critical → notification at the threshold, no action during grace; write the marker → call survives to `tool_execution_end`; same shape without a marker → soft kill after the grace; no `PI_PMUX_SESSION` → action at critical.
- [x] 5.2 `pnpm test`, `pnpm run typecheck`, `pnpm run lint`, `pnpm run format:check`.
