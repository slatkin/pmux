# Tasks

## 1. Child-side cancel sidecar

The decoder (1.1) MUST land before or with the writer (1.2): until it
does, `interpretExitSidecar`'s fallthrough decodes `cancelled` as
`done`.

- [ ] 1.1 In `pi-extension/pmux/exit-sidecar.ts`, add `"cancelled"` to
  `ExitResult.reason` and decode `{"type":"cancelled"}` as
  `{ reason: "cancelled", exitCode: 0 }` (report-user-cancel D3), and
  verify the decoder tests pass.
- [ ] 1.2 In `pi-extension/pmux/pmux-done.ts`, write `{"type":"cancelled"}`
  to the `.exit` sidecar when `agent_end` sees the latest assistant
  message end with `stopReason: "aborted"` (report-user-cancel D1), and
  verify the new cases in `test/test.ts` (or the pmux-done suite) pass:
  auto-exit and non-auto-exit sessions, session stays open, no nudge
  scheduled. Migrate the pinned abort test in `test/test.ts` ("auto-exit
  agent_end on an aborted stop keeps the session open"), which currently
  asserts no `.exit` file exists, to assert the `cancelled` payload
  instead.
- [ ] 1.3 In `pi-extension/pmux/pmux-done.ts`, remove the sidecar on
  `agent_start` when it holds `{"type":"cancelled"}` and leave every
  other payload untouched (report-user-cancel D2), and verify the tests
  pass: cancelled cleared, done/error/handoff/ping preserved.

## 2. Parent-side notification

- [ ] 2.1 In `pi-extension/pmux/tmux.ts`, add the `onCancel` option to
  `pollForExit`: when the decoded sidecar reason is `cancelled`, call
  `onCancel`, consume the sidecar as for any other payload, and keep
  polling (report-user-cancel D4), and verify the poll tests pass: one
  call per cancelled file, no completion on cancel, a later cancel
  notifies again.
- [ ] 2.2 In `pi-extension/pmux/supervisor.ts`, wire `onCancel` to a
  parent steer with the report-user-cancel D4 wording (trigger a turn,
  carry the session file, keep the run registered), and verify the
  supervisor tests pass: the parent gets one cancel message per cancel,
  the child stays in the registry, and a later done still completes the
  run.

## 3. Documentation

- [ ] 3.1 Update `skills/pmux/SKILL.md`: the `.exit` sidecar can also say
  the child was cancelled by the user, the session is still open, the
  child clears the cancelled sidecar on the next turn start, a
  re-issued `wait --signal sidecar` then waits for real completion, and
  a `wait --signal status` does not return on a cancel.
- [ ] 3.2 Check `docs/guide.md` and `README.md` for enumerations of the
  exit outcomes, and update any that would read as false once `cancelled`
  exists.

## 4. Gates

- [ ] 4.1 Run `pnpm run format:check`, `pnpm run lint`,
  `pnpm run typecheck` and `pnpm test` and verify all pass.
- [ ] 4.2 Run `openspec validate 2026-10-23-report-user-cancel --strict`
  and verify it is clean.

## Workflow follow-up

- Archive the change after the project's review requirements are satisfied.
- Verify the archived result.
