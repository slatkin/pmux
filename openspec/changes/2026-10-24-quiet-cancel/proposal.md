# Proposal

## Why

When the user presses Escape in a subagent's pane, the child writes a
`cancelled` `.exit` sidecar and the parent gets a `pmux_cancel` steer that
triggers a turn (report-user-cancel D4). For a user who cancelled in order
to type the next instruction themselves, the wake is wrong: the parent
starts a turn underneath them and they have to cancel the orchestrator
too. The wake is the right default for an unattended run — the parent
should ask the user how to proceed — but a user who is driving wants the
signal recorded, not acted on.

A second gap sits underneath the first. A cancelled child reports `waiting`
in its activity file and stays alive, so the parent-side idle watchdog
treats it like any other child that ended a turn without finishing: ~30 s
after the cancel it types the completion nudge into the child's pane,
restarting the very turn the user aborted, and after two unanswered nudges
it writes a `done` sidecar that reports a fabricated completion and wakes
the parent anyway. Suppressing the steer alone does not buy the quiet the
setting promises — the watchdog brings the wake back through the back
door, in both modes.

## What Changes

- The `notify` block of the extension `config.json` gains a `quietCancel`
  boolean, default `false`.
- `quietCancel: false` — today unchanged: the cancel message triggers a
  parent turn.
- `quietCancel: true` — the same `pmux_cancel` message is appended to the
  parent's session without triggering a turn. It is still displayed and
  still lands in context, so the parent's next turn sees it; a parent
  mid-turn gets it appended when that turn ends. One message per cancel,
  the run stays registered, and the poll keeps watching.
- A reported cancel marks the run user-cancelled. While the mark stands,
  the idle watchdog's nudge/finish arm skips the run; the gone arm still
  runs, so a dead pane is still reported. The mark clears when the child's
  activity reports an active phase — a new turn means someone deliberately
  restarted the child and the watchdog owes it normal duty again. The
  suppression applies in both modes: a watchdog nudge restarts the turn
  the user aborted, which contradicts a deliberate cancel regardless of
  how the parent was told.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `subagent-supervision`: the cancel-notification delivery gains the quiet
  mode, and a user-cancelled run is exempt from the idle watchdog's
  nudge/finish until it shows new activity.

## Impact

- `pi-extension/pmux/status.ts`: `parseStatusConfig` accepts
  `notify.quietCancel`; `StatusConfig` carries it; `config.json.example`
  documents it.
- `pi-extension/pmux/supervisor.ts`: `RunningSubagent` gains a
  user-cancelled mark; `onCancel` sets it; the watch tick clears it on a
  fresh active phase; `deliverSubagentCancel` picks its send options from
  the config; `runIdleWatchdog` skips its nudge/finish arm while the mark
  stands.
- `docs/guide.md`: the Configuration section documents `quietCancel`.
- Tests in `test/test.ts`, `test/supervisor.test.ts` and the status-config
  suite.
- Ordering: this change's spec delta modifies the requirement added by
  `2026-10-23-report-user-cancel`, which is implemented but not yet
  archived. That change archives first.
