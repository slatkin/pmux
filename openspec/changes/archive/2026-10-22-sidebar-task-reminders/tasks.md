# Tasks

## 1. Reminder module

- [x] 1.1 Add `pi-extension/pmux/task-reminders.ts` holding the reminder text copied byte-for-byte from `src/task_reminders.rs` of the tmux-agent-sidebar repository (the constant `UPDATE_BEFORE_FINISH_REMINDER`), with the source file named in a comment, and verify with a wording test that pins the copy against a literal.
- [x] 1.2 Add the store reader: the path from `TMUX_PANE` encoded the way the sidebar's `task_store.rs` encodes it (`%` becomes `_`), the JSON shape that module defines (`tasks: [{ id, subject, status }]`, statuses `pending | in_progress | completed`), and "empty"/"open" predicates over it; a missing or unreadable file counts as empty. Verify with tests for the readable, missing, unreadable, and no-`TMUX_PANE` cases.
- [x] 1.3 Verify the design decisions with tests: a pmux child (`isSubagentChild`) receives nothing, an empty store receives nothing at any boundary (no `before_agent_start` anchor is registered), the `turn_end` anchor skips `error` and `aborted` stops, and the update-before-finish flag does not re-fire until the store's open set changes.

## 2. Delivery

- [x] 2.1 Register `createTaskReminders(deps)` once in `index.ts` in the `sidebar-events.ts` factory shape, and verify with tests that the reminder injects through `pi.sendUserMessage(..., { deliverAs: "steer" })` without `triggerTurn` at a `turn_end` whose store holds open items.
- [x] 2.2 Verify the never-disturbs properties with tests: a failing store read or injection is swallowed, a read never awaits, and neither the registration nor a failure raises an extension error or writes to the session output.

## 3. Docs

- [x] 3.1 Note the delivery beside the README text that describes the sidebar publishing, and name `src/task_reminders.rs` there as the wording source.
