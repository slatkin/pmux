# Tasks

## 1. Reminder module

- [ ] 1.1 Add `pi-extension/pmux/task-reminders.ts` holding the two reminder texts copied byte-for-byte from `src/task_reminders.rs` of the tmux-agent-sidebar repository (the constants `RECORD_FIRST_REMINDER` and `UPDATE_BEFORE_FINISH_REMINDER`), with the source file named in a comment, and verify with a wording test that pins both copies against literals.
- [ ] 1.2 Add the store reader: the path from `TMUX_PANE` encoded the way the sidebar's `task_store.rs` encodes it (`%` becomes `_`), the JSON shape that module defines (`tasks: [{ id, subject, status }]`, statuses `pending | in_progress | completed`), and "empty"/"open" predicates over it; a missing or unreadable file counts as empty. Verify with tests for the readable, missing, unreadable, and no-`TMUX_PANE` cases.
- [ ] 1.3 Verify the design decisions with tests: the `before_agent_start` anchor skips steer turns via the `messageType` check, a pmux child (`isSubagentChild`) receives nothing, the `turn_end` anchor skips `error` and `aborted` stops, and the update-before-finish flag does not re-fire until the store's open set changes.

## 2. Delivery

- [ ] 2.1 Register `createTaskReminders(deps)` once in `index.ts` in the `sidebar-events.ts` factory shape, and verify with tests that both reminders inject through `pi.sendUserMessage(..., { deliverAs: "steer" })` without `triggerTurn`: record-first on a user turn that starts with an empty store, update-before-finish at a `turn_end` whose store still holds open items.
- [ ] 2.2 Verify the never-disturbs properties with tests: a failing store read or injection is swallowed, a read never awaits, and neither the registration nor a failure raises an extension error or writes to the session output.

## 3. Docs

- [ ] 3.1 Note the delivery beside the README text that describes the sidebar publishing, and name `src/task_reminders.rs` there as the wording source.
