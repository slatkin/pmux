# Design

## Context

See proposal.md - Why. The reminder's current guard is an open-set key: it
prevents re-firing on an unchanged set, but any `task-set` or `task-update`
call changes the open set and re-arms the guard. While the agent is actively
building or updating the list, the reminder fires on every turn end.

The sidebar already exposes the store's modification time through
`store_mtime` in `tmux-agent-sidebar/src/task_store.rs`, so the filesystem
carries an honest "last touched" signal. The extension reads the store file
directly, so `statSync` on the same path is the natural place to pick that
signal up.

## Goals / Non-Goals

**Goals:**

- The reminder stays silent while the agent is actively maintaining the
  task list, and for a short buffer after.
- The reminder still fires when the list has been left open and untouched
  for a while.
- The change stays local to `pi-extension/pmux/task-reminders.ts` and its
  tests.

**Non-Goals:**

- Changing the wording of the reminder. The sidebar owns
  `UPDATE_BEFORE_FINISH_REMINDER`; the reworded constant ("Reminder: make
  sure the task board is up to date.") already shipped on main in both
  repositories (tmux-agent-sidebar `155949b`, pmux `6f3dbc7`), and the
  byte-for-byte test already matches it.
- Adding configuration. The quiet period and turn count are constants,
  not settings.

## Decisions

**D1: The buffer is a store-mtime quiet period of five minutes.** The
sidebar rewrites the store on every `task-set` and `task-update`, so the
file's mtime is the moment the agent last touched the list. When the
extension reads the store, it also stats the file. If the mtime is within
five minutes of the turn end, the reminder is skipped. Five minutes is
long enough to cover a burst of planning turns and short enough that an
abandoned list still gets a nudge.

**D2: The buffer is also a turn count of three.** Wall-clock time alone
is not enough: a burst of short turns can all fall inside five minutes,
and a single long turn can stretch past it. The extension counts turn ends
since the store's last write. The reminder fires only when at least three
turn ends have passed with the store untouched. The count resets when the
store is written and when the reminder is injected.

**D3: The two buffers are checked in order, mtime first, then turns.**
Both conditions must be satisfied. The mtime check is cheap and covers the
common case; the turn count catches the edge cases where time is
misleading.

**D4: The open-set guard stays as the backstop.** After the buffers
expire, the reminder fires only if the open set differs from the last one
injected. The guard and the buffers work together: the guard stops
identical repeats, the buffers stop rapid-fire during active maintenance.

**D5: The implementation adds no new state beyond two scalars.** The
module already keeps `remindedOpenKey` in closure. The buffer adds
`lastStoreWriteMs` (from the stat) and `turnsSinceLastWrite`. Both are
reset by a store write and by an injection. No timers, no global state, so
`/reload` safety is unchanged.

**D6: The reworded reminder is already live.** The sidebar shipped
"Reminder: make sure the task board is up to date." as
`UPDATE_BEFORE_FINISH_REMINDER`, and the pmux copy plus pinned test moved
with it. The new wording no longer names the `task-update` command, so
agents that receive only the reminder learn the command forms from the
record-first reminder and the `sidebar-tasks` skill, both of which still
teach them. This design therefore touches timing only.

## Risks / Trade-offs

- [A legitimately idle list stays silent for five minutes plus three turns]
  This is the intent: a few missed turns without updating the plan are not
  the end of the world. The cost is that a truly forgotten list is nagged
  later than before.
- [The mtime and turn count must be kept in sync] A store write resets
  both; an injection resets both. A missed reset would either delay or
  accelerate the next reminder. Mitigation: the reset logic is a single
  function called from both places, and the tests cover the reset cases.
- [The sidebar's mtime semantics could change] The sidebar currently
  rewrites the store on every mutation. If that changes, the extension's
  quiet period becomes unreliable. Mitigation: the wording test already
  fails when the sidebar drifts; the same test suite is the place to catch
  an mtime-semantics drift.
