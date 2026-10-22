# Proposal

## Why

The sidebar task reminder fires on every turn end while open tasks remain. When the agent is actively building or updating the task list, it still receives a reminder on every turn, which is noise. The reminder should back off while the agent is maintaining the list and only nag when the list has been left untouched for a while.

## What Changes

- Modify the `task-reminders` capability to add a buffer: the reminder does not fire unless the pane's task store has not been written for a configured quiet period and a minimum number of turn ends have passed since the last store write.
- The open-set guard stays, but firing also resets a turn counter so consecutive reminders are spaced out.
- No new commands, no new files; the buffer lives in the existing `pi-extension/pmux/task-reminders.ts` module and its tests.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `task-reminders`: requirement "the extension delivers the sidebar's update-before-finish reminder" changes to include the buffer conditions (mtime quiet period + turn-count buffer) in addition to the open-set guard.

## Impact

- `pi-extension/pmux/task-reminders.ts`: add the buffer logic (read store mtime, count turn ends since last write).
- `test/task-reminders.test.ts`: new tests covering the buffer cases.
- `skills/sidebar-tasks/SKILL.md`: optionally mention that the reminder is buffered, so agents know they will not be nagged immediately.
