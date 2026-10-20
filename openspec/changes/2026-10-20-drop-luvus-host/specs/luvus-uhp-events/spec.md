# Spec Delta

## Purpose

The Luvus event stream is removed; the supervisor polls the pane.

## REMOVED Requirements

### Requirement: The UHP event stream

**Reason**: The stream is a Luvus daemon feature. The supervisor already
falls back to polling the pane and the sidecar when no stream runs, and that
is the only path under tmux.

**Migration**: A child that finishes is still detected through the `.exit`
sidecar, and a child that dies is still detected through the terminal
sentinel in the pane. The difference is the latency of the fallback path: the
poll interval rather than an event.

### Requirement: Event-driven watching

**Reason**: It depends on the removed stream.

**Migration**: The supervisor's watch loop polls the sidecar and the pane on
its fixed interval.
