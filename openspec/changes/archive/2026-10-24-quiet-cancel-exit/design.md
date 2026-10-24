# Design

## D1. A user abort ends the child

On an aborted turn the child writes `{"type":"cancelled"}`, writes status
`done` with message `cancelled`, and calls `ctx.shutdown()`. The terminal
status makes a `wait --signal status` return, so no wait hangs. The
`agent_settled` backstop (an abort between tool calls) does the same when
no sidecar exists. The `agent_start` removal of a `cancelled` sidecar
stays: a `resume` reuses the session file, and a stale cancel must not end
the new run's wait.

## D2. No one is woken

The run wrapper skips the send-mode wake-up when the sidecar is
`cancelled`. The pi parent's poll returns `cancelled` as a terminal result;
the supervisor releases the run (closes the pane, drops the entry,
refreshes the widget) and sends nothing. There is no configuration: quiet
is the only behaviour.

## D3. `pmux_interrupt` keeps the child alive

The child cannot tell the parent's Escape from the user's. The parent
writes `<session>.interrupt` before it sends Escape. On an aborted turn the
child checks the marker: when it exists, the child removes it, writes no
sidecar, and stays open, as before this change. The child also removes a
marker on every `agent_start` and every `agent_end`, so a marker written
while the child was idle (Escape then aborts nothing) cannot exempt a later
user Escape.

## D4. Close the pane on cancel

The skill-path wrapper closes its pane after the grace period for
`cancelled`, as it does for `done` and `handoff`. The pi parent closes the
pane through `releaseRun`, as for every finished run.
