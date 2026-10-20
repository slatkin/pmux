# Spec Delta

## Purpose

The Luvus event stream is removed. The supervisor polls the sidecar and the pane.

## REMOVED Requirements

### Requirement: Events come from one long-lived event stream

**Reason**: The stream is a Luvus daemon feature. The supervisor already falls back to polling the pane and the sidecar when no stream runs, and that is the only path under tmux.

**Migration**: A child that finishes is still detected through the `.exit` sidecar, and a child that dies through the terminal sentinel in the pane. The difference is latency: the poll interval instead of an event.

### Requirement: Stream restart and snapshot

**Reason**: The stream is a Luvus daemon feature. The supervisor already falls back to polling the pane and the sidecar when no stream runs, and that is the only path under tmux.

**Migration**: A child that finishes is still detected through the `.exit` sidecar, and a child that dies through the terminal sentinel in the pane. The difference is latency: the poll interval instead of an event.

### Requirement: Only status and lifecycle events trigger checks

**Reason**: The stream is a Luvus daemon feature. The supervisor already falls back to polling the pane and the sidecar when no stream runs, and that is the only path under tmux.

**Migration**: A child that finishes is still detected through the `.exit` sidecar, and a child that dies through the terminal sentinel in the pane. The difference is latency: the poll interval instead of an event.

### Requirement: Stream shutdown kills the child

**Reason**: The stream is a Luvus daemon feature. The supervisor already falls back to polling the pane and the sidecar when no stream runs, and that is the only path under tmux.

**Migration**: A child that finishes is still detected through the `.exit` sidecar, and a child that dies through the terminal sentinel in the pane. The difference is latency: the poll interval instead of an event.
