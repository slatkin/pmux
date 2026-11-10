# Design

## D1. The read leaves the session's thread

Pi enables its input box after the `session_start` handlers return; a handler
that blocks delays the pane, not just its own work. That was verified with a
handler that ran a synchronous `sleep 3`: the panel painted at once, and a key
typed 1.5 s later appeared only when the 3 s were up.

The worktree read is the only tmux call the extension makes on its own thread
during startup. `readWindowOptions` uses the synchronous `tmux()` helper with
a 5 s deadline, and it ran before the publish that spawns the hook — so a busy
server froze the pane and, at the same time, delayed the very event that makes
the sidebar show the agent. The fix is to do the read anywhere but there.

`readWindowOptionsAsync` is the existing `readWindowOptions` over `tmuxAsync`
(`execFile`), so the process can be busy with the TUI while tmux answers, and
the deadline still bounds a wedged server.

## D2. `publishAfter` keeps the queue's order

The queue exists because two concurrent hooks can interleave their tmux reads
and applies: a `session-start` reset landing after its session's
`user-prompt-submit` pins the pane at `idle` for the whole run. Deferring
`session-start` behind an async read must not reopen that race — pi can emit
`session_start` and the first `input` inside one startup stretch.

`publishAfter` therefore takes the slot synchronously, when the handler runs:

- the queue chain is extended immediately, so a `publish` that comes later
  chains behind it even though its payload is not loaded yet;
- the load and the spawn both run inside that step, so only one hook is ever
  in flight and the load cannot overtake the previous hook either;
- a load that throws settles the step and publishes nothing, so one failed
  read leaves the chain usable rather than poisoning it.

The stall bound is unchanged: it still governs the spawn, and a load is bound
by its own tmux deadline.

## D3. A failed read still publishes the session start

`readSidebarWorktree` (`index.ts`) turns any failure of the tmux call into
`undefined`, so the payload is built without a worktree and `session-start`
still applies. A pane that cannot be read is not worth a stale row: the reset
that marks the pane as an agent matters more than the worktree marker.

`publishAfter`'s own "a failed load publishes nothing" rule covers the case
the dependency should never produce — a rejection — and is what keeps the
queue alive if it does.

## D4. Alternatives

- **Shorten the deadline.** A blocked thread is still a blocked thread: the
  read would still run before the input box opens, and any value above "zero"
  is a freeze a slow server can reach.
- **Read the markers in the hook instead.** The Rust hook already reads the
  pane's options and could take the worktree from its own snapshot, which also
  saves one tmux round trip. That changes the payload contract and its
  documentation in the other repository; the async read keeps the protocol as
  it is, and both can be done later without a second change to pi.
- **Drop the worktree from the payload.** It costs the sidebar's worktree
  marker on a pi pane the sidebar spawned into a worktree, which is a
  feature, not slack.
