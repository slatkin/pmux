# Proposal

## Why

When the user presses Escape in a child's pane, the child writes a
`cancelled` sidecar and stays alive (report-user-cancel). That causes
three failures:

- A Claude Code orchestrator in `send` mode never learns of the cancel:
  only the run wrapper can wake it, and the wrapper runs only after the
  child exits. The child does not exit.
- The orchestrator then resumes the session in a new pane while the old
  child is still alive on the same session file. Two pi processes share
  one session.
- When the user closes the old, useless pane, the old run sends
  "`<name>` cancelled without sending a report" to the orchestrator. The
  text does not identify the run, so the orchestrator applies it to the
  new child. The old run also overwrites the shared `.exit` sidecar with
  `cancelled`.

A pi parent gets a steer that starts a turn under the user, who wanted to
take over.

The user's intent for a cancel is: stop the child completely, and tell no
one. A quiet cancel is a cancel that wakes no parent. It applies to every
parent, pi or external.

## What Changes

- A user Escape that aborts a child's turn ends the child: the child
  writes the `cancelled` sidecar, writes status `done` with the message
  `cancelled`, and shuts down.
- The run wrapper sends no wake-up for a `cancelled` sidecar, and the
  skill-path wrapper closes the pane for it as it does for `done`.
- The pi parent's exit poll treats `cancelled` as terminal: it ends the
  run, closes the pane, and sends no message. The `pmux_cancel` message
  is removed.
- `pmux_interrupt` keeps its current behaviour: it stops the turn and
  the child stays alive. Before it sends Escape, the parent writes an
  interrupt marker beside the session file. A child whose turn is
  aborted while the marker is present removes the marker and stays open,
  with no `cancelled` sidecar.
- The quiet-cancel change (`notify.quietCancel`, the watchdog exemption)
  is reverted. It is not necessary, because a cancelled child is no
  longer alive.

## Capabilities

### Modified Capabilities

- `subagent-completion`: a user abort ends the session; the parent
  interrupt marker keeps it open.
- `subagent-supervision`: a cancel ends the run without a message.
- `external-orchestration`: no wake-up for a cancel; close-on-cancel; the
  skill text.
- `pane-lifecycle`: `pmux_interrupt` writes the interrupt marker.

## Impact

- `pi-extension/pmux/exit-sidecar.ts`: interrupt-marker path, write and
  take helpers.
- `pi-extension/pmux/pmux-done.ts`: exit on a user abort; honour the
  marker.
- `pi-extension/pmux/run.ts`: no wake-up and close-on-done for
  `cancelled`.
- `pi-extension/pmux/tmux.ts`: `pollForExit` returns `cancelled`; the
  `onCancel` option is removed.
- `pi-extension/pmux/supervisor.ts`: no delivery for a cancelled run;
  `requestSubagentInterrupt` writes the marker.
- `skills/pmux/SKILL.md`, `docs/guide.md`: cancel text.
- Tests in `test/test.ts`, `test/supervisor.test.ts`, the run-wrapper and
  tmux suites.
