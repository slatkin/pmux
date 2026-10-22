# Proposal

## Why

The tmux-agent-sidebar repository's `tasks-tab` change gives every agent a
per-pane todo list written through the sidebar's `task-set` and
`task-update` commands and shown in the sidebar's Tasks tab, with two
reminders whose wording is defined exactly once in that repository's
`src/task_reminders.rs`. Nothing yet carries those reminders to a pi pane.
The sidebar owns the wording, the tab and the write path, but the reminders
still need a producer, and for pi that producer is this extension: it
already sits in the pane at both boundaries the reminders need (the `input`
boundary it maps to `user-prompt-submit`, and the settlement boundary it
maps to `stop`). Without delivery, a pi pane that never records anything
keeps an empty Tasks tab, and a pi pane that records but never updates
keeps a stale list — the two conditions the reminders exist to name.

The wording is fixed in the other repository. This change is
delivery-only: it decides when and how each reminder reaches the agent, and
it never paraphrases the wording.

## What Changes

- A new module holds the two reminder texts, copied byte-for-byte from
  `src/task_reminders.rs` in the tmux-agent-sidebar repository — the
  constants `RECORD_FIRST_REMINDER` and `UPDATE_BEFORE_FINISH_REMINDER` —
  with a comment naming that file as their single source.
- When a turn starts on a pane whose sidebar task store is empty, the
  extension injects the record-first reminder into that turn.
- When the turn settles while items are still open, the extension injects
  the update-before-finish reminder.
- The store is `/tmp/tmux-agent-tasks<PANE>.json`, the file the sidebar's
  own `task_store.rs` defines. The extension reads it directly from the
  pane's environment; a missing or unreadable store means no conditions and
  no reminders.
- The injection rides the same steer channel the context alert uses
  (`pi.sendUserMessage(..., { deliverAs: "steer" })`) and never spawns a
  turn of its own.
- The module registers beside the existing ones in `index.ts`. Nothing else
  changes: no `pmux-done.ts` edit, no new env var, no store writing from
  here — the agent writes the store only through the sidebar's command.

## Non-Goals

- Editing the reminder wording, or any other tmux-agent-sidebar change. The
  two constants live there; delivery only copies them at implementation
  time and names their source.
- Writing to the task store. The agent is the store's only writer, through
  the sidebar's task command; the extension only reads.
- A reminder per tool call. The reminders check the turn boundaries only.
- Delivering reminders to pmux children (see design decision D4).

## Impact

- New capability spec: `task-reminders`.
- New code: `pi-extension/pmux/task-reminders.ts` (name at implementation)
  plus one registration point in `index.ts`, tests under `test/`, and a
  README note beside the sidebar-publishing text.
- A reminder wording update in the tmux-agent-sidebar source file is a
  one-line update in this copy, caught by the wording test if skipped.
