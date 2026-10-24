# Tasks

Ordering note: this change's spec delta modifies the requirement added
by `2026-10-23-report-user-cancel`. That change archives first, or the
delta has no `MODIFIED` target to apply to.

## 1. Config

- [ ] 1.1 In `pi-extension/pmux/status.ts`, accept `quietCancel` in the
  `notify` block's allowed keys, parse it as a boolean defaulting to
  `false`, and carry it on `StatusConfig` (quiet-cancel D1). Verify the
  status-config tests pass: absent defaults to `false`, `true` parses, a
  non-boolean value is a config error that names the key.
- [ ] 1.2 In `config.json.example`, add `"quietCancel": false` to the
  `notify` object.

## 2. Supervisor

- [ ] 2.1 In `pi-extension/pmux/supervisor.ts`, add a `userCancelled`
  flag to `RunningSubagent`. The poll's `onCancel` sets it; the watch
  tick clears it when `running.activity.phase === "active"`
  (quiet-cancel D3).
- [ ] 2.2 In `deliverSubagentCancel`, send the same `pmux_cancel` message
  with `{ triggerTurn: false }` when `deps.statusConfig.quietCancel` is
  set, and keep `{ triggerTurn: true, deliverAs: "steer" }` otherwise
  (quiet-cancel D2). Verify the supervisor tests pass: quiet mode
  delivers one message with no turn, wake mode still triggers a turn,
  the run stays registered either way, and a later completion still
  reports normally.
- [ ] 2.3 In `runIdleWatchdog`, skip the `decideIdleAction` arm while
  `running.userCancelled` stands — no nudge, no finish — and keep
  running `decideGoneAction` (quiet-cancel D4). Verify the tests pass: a
  marked child in a long `waiting` stretch gets no pane input and no
  `done` sidecar; a marked child whose activity goes stale still gets
  the `error` sidecar; the mark clearing on `active` restores normal
  nudge/finish behavior.

## 3. Documentation

- [ ] 3.1 Update `docs/guide.md`: the Configuration section gains a
  `notify.quietCancel` paragraph (default `false`; `true` records the
  cancel without waking the parent), and the cancel behavior paragraph,
  where the guide describes the parent notification, names both modes.
  Check the example JSON block in the same section shows the new key.
- [ ] 3.2 Check `README.md` for a config example or a description of the
  cancel notification, and update any text that would read as false once
  quiet mode exists.

## 4. Gates

- [ ] 4.1 Run `pnpm run format:check`, `pnpm run lint`,
  `pnpm run typecheck` and `pnpm test` and verify all pass.
- [ ] 4.2 Run `openspec validate 2026-10-24-quiet-cancel --strict` and
  verify it is clean.

## Workflow follow-up

- Archive `2026-10-23-report-user-cancel` first (see the ordering note),
  then archive this change after the project's review requirements are
  satisfied.
- Verify the archived result.
