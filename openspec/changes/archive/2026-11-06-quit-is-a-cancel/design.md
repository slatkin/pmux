# Design

## D1. A quit is a cancel

Pi emits `session_shutdown` with `reason: "quit"` for Ctrl-C twice, Ctrl-D,
`/quit`, and a SIGTERM or SIGHUP that pi handles. The child extension treats
that shutdown as the user stopping the child, the same act as an Escape
abort, and writes `{"type":"cancelled"}` plus status `done` with the message
`cancelled`. The quiet-cancel rule is unchanged: no parent is woken, the pane
closes for the sidecar as it does for `done`, and the skill path's `wait`
reports `cancelled`.

A quit that carries no terminal payload is the case a crash report used to
cover. A real crash still writes nothing: an uncaught exception exits the
process with code 1 without a shutdown event, and SIGKILL gives no event at
all. The wrapper then writes its `error` sidecar with `source: "wrapper"`,
which stays the crash signal.

A signal that pi handles as a shutdown is reported as cancelled too. The
extension cannot tell a user's Ctrl-C from a SIGTERM, and "someone stopped
this child deliberately" is closer to a cancel than to a crash.

## D2. Which payload wins

The parent's poll may consume a sidecar before the child's shutdown handler
runs. The extension therefore remembers the terminal payload the session
wrote (`done`, `handoff`, `ping`, `error` or `cancelled`) and applies one
rule on a quit:

- no payload of its own: write `cancelled`;
- `cancelled`: rewrite it, so a consumed notice is restored;
- any other payload: write nothing, so a completed, pinged or failed run
  keeps its meaning.

The sidecar already on disk also wins: a payload the handler did not write
is never overwritten.

The error and auto-exit paths write their sidecar best effort. Their status
write is evidence on its own: the payload is recorded before the sidecar
write is attempted, so one failed write can never downgrade a provider
error or a completion to a cancel (a terminal status also latches in the
status file, so the quit cannot overwrite the `blocked` message either).

## D3. Session switches write nothing

`reload`, `new`, `resume` and `fork` end the extension instance but not the
run; the child keeps going on the new session file. Those reasons write no
sidecar in either direction, as before.
