# Proposal

## Why

The tmux-agent-sidebar repository's `tasks-tab` change gives every agent a
per-pane todo list written through the sidebar's `task-set` and
`task-update` commands and shown in the sidebar's Tasks tab, with reminder
wording defined exactly once in that repository's `src/task_reminders.rs`.
Nothing yet carries the reminder to a pi pane. The sidebar owns the
wording, the tab and the write path, but the reminder still needs a
producer, and for pi that producer is this extension: it already sits in
the pane at the settlement boundary the reminder needs (the boundary it
maps to `stop`). Without delivery, a pi pane that records work but never
updates it keeps a stale list.

Recording is a human-prompted action, not a default tag. This change
therefore delivers only the update-before-finish reminder, and only to a
pane that already holds tasks; an empty store is never nudged.

The wording is fixed in the other repository. This change is
delivery-only: it decides when and how the reminder reaches the agent, and
it never paraphrases the wording.

## What Changes

- A new module holds the reminder text, copied byte-for-byte from
  `src/task_reminders.rs` in the tmux-agent-sidebar repository — the
  constant `UPDATE_BEFORE_FINISH_REMINDER` — with a comment naming that
  file as its single source.
- When a turn settles on a pane whose sidebar task store holds open items,
  the extension injects the update-before-finish reminder.
- No record-first reminder is delivered. A turn that starts with an empty
  store gets nothing: an agent records tasks when a human asks it to, not
  as a default tag.
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
  constant lives there; delivery only copies it at implementation time and
  names its source.
- Writing to the task store. The agent is the store's only writer, through
  the sidebar's task command; the extension only reads.
- Nudging a pane that has recorded no tasks. An empty store is silent at
  every boundary.
- A reminder per tool call. The reminder checks the turn boundary only.
- Delivering reminders to pmux children (see design decision D4).

## Impact

- New capability spec: `task-reminders`.
- New code: `pi-extension/pmux/task-reminders.ts` (name at implementation)
  plus one registration point in `index.ts`, tests under `test/`, and a
  README note beside the sidebar-publishing text.
- A reminder wording update in the tmux-agent-sidebar source file is a
  one-line update in this copy, caught by the wording test if skipped.
