# Tasks

## 1. Child

- [x] 1.1 In `exit-sidecar.ts`, add the interrupt-marker path and the
  write and take helpers (D3).
- [x] 1.2 In `pmux-done.ts`, end the session on a user abort: `cancelled`
  sidecar, status `done` with message `cancelled`, `ctx.shutdown()` (D1).
  Take the marker at every `agent_end` and remove it at every
  `agent_start`; an abort with the marker stays open with no sidecar (D3).
  Verify with tests: user abort exits, parent interrupt stays open, stale
  marker does not exempt, settled backstop exits.

## 2. Wrapper

- [x] 2.1 In `run.ts`, skip the send-mode wake-up for `cancelled` (D2) and
  close the pane for it (D4). Verify with tests.

## 3. Pi parent

- [x] 3.1 In `tmux.ts`, return `cancelled` from `pollForExit` and remove
  `onCancel` (D2).
- [x] 3.2 In `supervisor.ts`, release a cancelled run without a message,
  remove `deliverSubagentCancel`, and write the marker in
  `requestSubagentInterrupt` before Escape (D2, D3). Verify with tests.

## 4. Docs

- [x] 4.1 Update the cancel text in `skills/pmux/SKILL.md` and
  `docs/guide.md`.
- [x] 4.2 Run format:check, lint, typecheck and test.
