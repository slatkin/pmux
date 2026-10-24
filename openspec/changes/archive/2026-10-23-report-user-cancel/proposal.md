# Proposal

## Why

When the user presses Escape in a subagent's pane, the child's turn ends with
`stopReason: "aborted"`. Today that event is invisible to the calling agent:
no `.exit` sidecar is written, the session stays open, and the parent only
sees the child go idle. The caller cannot tell "the user stopped this on
purpose" apart from "the child is stuck" or "the child is still thinking",
so it either waits blindly or scrambles to recover a run that was not
failed but cancelled.

Failure and cancel are different signals. A failure needs recovery; a user
cancel almost always has a reason, and the right response is to ask the
user how to proceed — not to retry.

## What Changes

- The child extension writes a `cancelled` `.exit` sidecar
  (`{"type":"cancelled"}`) when a turn ends with `stopReason: "aborted"`.
  The session stays open exactly as today.
- The child clears the `cancelled` sidecar when a new agent turn starts,
  so a stale cancel never satisfies a later wait.
- The pi parent's exit poll reports a `cancelled` sidecar as a
  non-terminal notification: the parent gets one steer per cancel with
  wording that tells it to ask the user how to proceed, and the watcher
  keeps watching. A later `done`/`error`/`handoff`/`ping` still completes
  the run normally.
- The skill path's `wait --signal sidecar` returns on a `cancelled`
  sidecar like any other; the SKILL.md documentation learns what the
  cancel means and how re-waiting behaves.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `subagent-completion`: the abort path gains the `cancelled` sidecar write
  and its self-clear on the next turn start.
- `subagent-supervision`: the delivery contract gains a fifth message
  kind (cancel), and the exit poll gains the non-terminal cancel
  notification with de-duplication.
- `external-orchestration`: the SKILL.md documentation requirement learns
  that the sidecar can also say the child was cancelled, and what that
  means for a later wait.

## Impact

- `pi-extension/pmux/pmux-done.ts`: write the `cancelled` sidecar on an
  aborted `agent_end`; clear it on `agent_start`.
- `pi-extension/pmux/exit-sidecar.ts`: `ExitResult.reason` gains
  `"cancelled"`; the decoder maps `{"type":"cancelled"}`.
- `pi-extension/pmux/tmux.ts`: `pollForExit` gains an `onCancel` option
  that fires once per distinct `cancelled` sidecar without completing the
  poll.
- `pi-extension/pmux/supervisor.ts`: wire `onCancel` to a parent steer
  with consult-the-user wording; the run stays registered.
- `skills/pmux/SKILL.md`, possibly `docs/guide.md` / `README.md`:
  document the cancel signal.
- Tests in `test/test.ts`, `test/supervisor.test.ts` and the tmux/exit
  sidecar suites.
