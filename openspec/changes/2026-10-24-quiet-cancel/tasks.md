# Tasks

## 1. Config

- [x] 1.1 In `pi-extension/pmux/status.ts`, accept `quietCancel` in the
  `notify` block's allowed keys, parse it as a boolean defaulting to
  `false`, and carry it on `StatusConfig` (quiet-cancel D1). Add three
  cases to the existing `parseStatusConfig` block in `test/test.ts`
  (~line 503): absent defaults to `false`, `true` parses, a non-boolean
  value is a config error that names the key.
- [x] 1.2 In `config.json.example`, add `"quietCancel": false` to the
  `notify` object.

## 2. Supervisor

- [x] 2.1 In `pi-extension/pmux/supervisor.ts`, add a `userCancelled`
  flag to `RunningSubagent`. The poll's `onCancel` sets it. The clear is
  ordering-sensitive (quiet-cancel D3): the poll iteration calls
  `onCancel` before `onTick`, so on the tick that sets the mark
  `running.activity` still holds the previous tick's `active` snapshot.
  Clear the mark in `onTick` AFTER `observeRunningSubagent`, and only
  when `running.activityRead.ok` is true and `running.activity.phase
  === "active"` — a failed read leaves the stale `active` snapshot in
  place and must not clear the mark.
- [x] 2.2 In `deliverSubagentCancel`, send the same `pmux_cancel` message
  with `{ triggerTurn: false }` when `deps.statusConfig.quietCancel` is
  set, and keep `{ triggerTurn: true, deliverAs: "steer" }` otherwise
  (quiet-cancel D2). One new test in `test/supervisor.test.ts` next to
  the existing cancel tests (~lines 1173, 1199): in quiet mode the
  message goes out with `triggerTurn: false`. The wake-mode turn, the
  run staying registered, and a later completion already have coverage
  there — do not duplicate them.
- [x] 2.3 In `runIdleWatchdog`, skip the `decideIdleAction` arm while
  `running.userCancelled` stands — no nudge, no finish — and keep
  running `decideGoneAction` (quiet-cancel D4). `runIdleWatchdog` is
  module-private; tests reach it through the fake poll's captured
  `onTick` option (`test/supervisor.test.ts` ~lines 121-142) after
  writing an activity file — no new export needed. Verify: a marked
  non-interactive child in a long `waiting` stretch gets no pane input
  and no `done` sidecar; a marked child whose activity goes stale still
  gets the `error` sidecar; the mark clearing on `active` restores
  nudge/finish. The no-nudge test MUST start the run with a stale
  `active` activity snapshot written before the cancel — otherwise it
  cannot catch the same-tick clear bug of quiet-cancel D3.

## 3. Documentation

- [x] 3.1 Update `docs/guide.md`: the Configuration section gains a
  `notify.quietCancel` paragraph (default `false`; `true` records the
  cancel without waking the parent), the example JSON block in that
  section shows the new key, and the cancel/interrupt paragraph (~line
  299) gains one sentence saying a cancelled non-interactive child is
  no longer nudged or finished by the idle watchdog and stays
  registered until it is restarted or its pane dies — `pmux_message`
  or typing in its pane restarts it.
- [x] 3.2 Check `README.md` for a config example or a description of the
  cancel notification — including the "a watchdog finishes a stuck
  child" claim (~line 10), which now needs the cancelled-child
  exception — and update any text that would read as false once quiet
  mode exists.

## 4. Gates

- [x] 4.1 Run `pnpm run format:check`, `pnpm run lint`,
  `pnpm run typecheck` and `pnpm test` and verify all pass.
- [x] 4.2 Run `openspec validate 2026-10-24-quiet-cancel --strict` and
  verify it is clean.

## Workflow follow-up

- Archive this change after the project's review requirements are
  satisfied.
- Verify the archived result.
