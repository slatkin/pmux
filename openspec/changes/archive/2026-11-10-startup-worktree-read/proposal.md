# Proposal

## Why

A pi pane with the sidebar installed can start without a usable input box for
as long as the tmux server takes to answer.

The extension's `session_start` handler read the pane's two worktree markers
with `readWindowOptions`, which runs `tmux display-message` through
`execFileSync` under a 5 s deadline. Pi enables the input box only after the
`session_start` handlers return, so that one tmux client round trip sat on the
startup critical path: the panel painted, keys were swallowed, and nothing
reached the sidebar — the hook that marks the pane as an agent had not been
spawned yet, because the synchronous read comes first.

Measured in a fresh pane, with each tmux call slowed to 1 s to stand in for a
busy server: the pane froze for about 1.2 s and letters typed during it
appeared only after the freeze. The same freeze happens for the whole 5 s
deadline when the server is wedged. On an idle server the same read costs
milliseconds, which is why the fault only shows up "sometimes" — under the
sidebar's per-second sync, a window being created, or a restoring session.

## What Changes

- The worktree markers are read asynchronously (`readWindowOptionsAsync`,
  built on the existing `tmuxAsync`), so no tmux call runs on the session's
  thread.
- The publisher gains `publishAfter`, which takes its queue slot
  synchronously and loads the payload inside its own step: the event still
  applies before anything published after it, and a load that fails publishes
  nothing without breaking the chain.
- `session_start` publishes through `publishAfter` when publishing is
  possible, and stays on the immediate path (no worktree, no read) when the
  sidebar binary is missing or publishing is off.
- The read's failure still publishes `session-start`, without a worktree.
- Docs: the guide says the worktree read runs in the background and that a
  busy tmux server cannot freeze the session.

## Capabilities

### Modified Capabilities

- `sidebar-events`: the worktree read no longer runs on the session's thread,
  and publishing never blocks the session's startup.

## Impact

- `pi-extension/pmux/tmux.ts`: `readWindowOptionsAsync`.
- `pi-extension/pmux/sidebar.ts`: `SidebarPublisher.publishAfter`.
- `pi-extension/pmux/sidebar-events.ts`: the `session_start` handler and the
  `readWorktree` dependency.
- `pi-extension/pmux/index.ts`: the worktree read is async.
- `test/sidebar.test.ts`, `test/sidebar-events.test.ts`: the new path.
- `docs/guide.md`: the tmux sidebar section.
