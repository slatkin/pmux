# Proposal

## Why

The fork of the tmux sidebar is teaching the sidebar about pi. The sidebar
learns about an agent through one thing only: a producer that calls
`tmux-agent-sidebar hook <agent> <event>` with a JSON payload on stdin.
Claude Code produces those calls from a hook, OpenCode from a plugin. For pi
there is no hook mechanism at all, so the producer has to be a pi extension.

pmux already ships a pi extension, and pmux is installed as a pi package on
this machine, so that extension loads in every pi session, not only in the
sessions pmux started. That property is the whole reason the producer belongs
here: the sidebar's promise is that it shows every agent pane in every tmux
session, and a producer that lives in pmux's supervisor would see only the
children pmux spawned. A pi pane that a human opened by hand would stay
invisible.

The alternative would be a separate pi package that only exists to feed the
sidebar. That is one more package to install, one more thing to keep alive
beside pmux, and it would have to re-implement the pane bookkeeping that
pmux's extension already does.

## What Changes

- A new module, `pi-extension/pmux/sidebar.ts`, publishes the activity of the
  pi session it runs in to the sidebar. It subscribes to pi's `session_start`,
  `input`, `tool_execution_start`, `tool_execution_end`, `agent_settled`,
  `ui_prompt_start`, `ui_prompt_end` and `session_shutdown` events, and for
  each of them spawns `tmux-agent-sidebar hook pi <event>` with the payload
  the sidebar's protocol defines.
- The calls are fire and forget. A turn is never delayed by the sidebar, and
  a missing or broken sidebar binary is not an error the pi session sees.
- The pane is the one the pi session runs in, taken from `$TMUX_PANE`. A pi
  session outside tmux publishes nothing, because there is no pane to describe.
- The worktree fields come from the pane's own tmux window options, so a pi
  pane that works in a worktree shows the worktree and its branch.
- The turn's outcome comes from pi's `agent_settled` event: an errored run
  becomes a failure, a completed or aborted run becomes an ordinary end of
  turn, and the last assistant message of the run becomes the response
  preview.
- A pi session that waits on a blocking extension prompt, which is how a
  permission extension asks the user, is reported as a wait. When the prompt
  closes, the pane returns to running.
- Nothing is published for a pi session whose sidebar binary cannot be found.
  The lookup is an environment override, then the tmux plugin path, then
  `PATH`.

## Capabilities

### New Capabilities

- `sidebar-events`: the extension publishes the activity of a pi session to the
  tmux sidebar, so that a pi pane is listed with its status, its prompt, its
  last response and its tool activity.

### Modified Capabilities

None.

## Impact

- `pi-extension/pmux/sidebar.ts`: a new module, with the publisher, the
  binary lookup and the payload builders.
- `pi-extension/pmux/index.ts`: the registration of the new subscriptions.
- `pi-extension/pmux/tmux.ts`: a helper that reads a pane's window options,
  if the existing helpers do not already cover it.
- `test/sidebar.test.ts`: the publisher's tests, with a fake spawner and a
  fake tmux.
- `docs/guide.md`: a section on what the sidebar shows for a pi pane and how
  to turn the publishing off.
- The sidebar itself is not touched by this change. The protocol it consumes
  is defined in the fork, under `docs/agent-protocol.md`, and the pi side of
  the sidebar is the change `2026-10-20-pi-agent-support` there.
- Not in this change: the task progress, which pi has no tool for, and the
  subagent tree, which pmux already shows as separate panes.
