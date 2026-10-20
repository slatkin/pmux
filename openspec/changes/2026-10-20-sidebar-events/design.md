# Design

## D1. The producer lives in the extension, not in the supervisor

pmux has two halves: a pi extension that runs inside every pi session, and a
supervisor that watches the children pmux started. The publisher belongs to
the extension.

The reason is coverage. The sidebar's promise is that it shows every agent
pane in every tmux session, and a pi pane a human opened by hand is exactly
the pane a supervisor-based publisher would miss. The extension is installed
with the pmux package, so it is present in every pi session, whether pmux
started that session or not.

The supervisor has a status channel of its own, the `.status` sidecar, which
carries `working`, `idle`, `done` and `blocked`. It is not the channel to
extend: it exists only for pmux children, and it carries a coarser vocabulary
than the sidebar needs. The sidebar's protocol already has the finer one.

## D2. Fire and forget, one process per event

Each event spawns `tmux-agent-sidebar hook pi <event>` and writes the payload
to its stdin. The call is never awaited, the child's stdout and stderr are
ignored, and a failure to start the child is swallowed. This is the pattern
the OpenCode producer in the sidebar uses, and it has the property that
matters here: a turn is never delayed by the sidebar, and a missing or
broken sidebar is not an error the pi session sees.

One process per event is the sidebar's existing cost model. Claude Code pays
it on every hook, and the sidebar's own design keeps that entry point.

## D3. Finding the binary

The lookup is, in order:

1. `TMUX_AGENT_SIDEBAR_BIN`, when it is set and the file is there.
2. `~/.tmux/plugins/tmux-agent-sidebar/bin/tmux-agent-sidebar`, the path the
   tmux plugin manager installs.
3. `~/.tmux/plugins/tmux-agent-sidebar/target/release/tmux-agent-sidebar`, for
   a plugin directory that was built from source.
4. `tmux-agent-sidebar` on `PATH`.

When none of them is there, the publisher does nothing. It does not warn, and
it does not fall back to a log line on every event: the sidebar is optional
software, and a machine without it should stay quiet.

The lookup is done once per session and the result is kept, so that the cost
of the lookup is not paid per event.

## D4. The pane

The pane is `$TMUX_PANE`, the pane the pi session runs in. When it is unset,
the session is not in tmux and there is nothing to describe, so nothing is
published. `callerPaneId` in `tmux.ts` already reads that variable.

## D5. The payload builders are pure functions

Every mapping from a pi event to a protocol payload is a pure function from
the event object to a JSON object, with no side effect. The publisher itself
does the side effect: it spawns the binary.

That split is the pmux house style, and it is what makes the mapping testable
without pi, without tmux and without a sidebar. The tests assert on the JSON
that a given pi event produces.

## D6. The event mapping

| pi event | protocol event | payload |
| --- | --- | --- |
| `session_start` | `session-start` | `cwd`, `session_id`, `source`, `worktree` |
| `input` | `user-prompt-submit` | `cwd`, `prompt`, `session_id` |
| `tool_execution_start` | `activity-log` | `tool_name`, `tool_input` |
| `tool_execution_end` | `activity-log` | `tool_name`, `tool_input`, `tool_response` |
| `agent_settled` with outcome `error` | `stop-failure` | `error` |
| `agent_settled` with outcome `completed` or `aborted` | `stop` | `last_assistant_message` |
| `ui_prompt_start` | `notification` | `wait_reason` |
| `ui_prompt_end` | `user-prompt-submit` | empty `prompt` |
| `session_shutdown` | `session-end` | `end_reason` |

`agent_settled` is the event that ends a run, and its `outcome` says how the
run ended. The last assistant message is the text of the last assistant
message in the run, which the publisher keeps as it goes, because
`agent_settled` does not carry the messages.

`tool_execution_start` and `tool_execution_end` both publish an activity
entry, so that the sidebar's activity log shows the tool while it runs and
again when it is done. The sidebar trims its log, and the second entry is
what carries the result. The publisher does not deduplicate, because the
sidebar's activity log is a stream, not a set.

`ui_prompt_start` fires when pi waits on a blocking user-facing extension
prompt, which is what a permission extension's confirmation dialog is. The
publisher reports it as a wait. `ui_prompt_end` closes it, and the publisher
reports the end of the wait with an empty `user-prompt-submit`, which returns
the pane to running without touching the prompt text it already shows.

## D7. The worktree

The sidebar creates a worktree and an agent in it when the user presses `n`.
It records the worktree and the branch as window options on that window:
`@agent-sidebar-spawned-worktree` and `@agent-sidebar-spawned-branch`. The
publisher reads those two options from its own pane's window and sends them
as the worktree fields of the session-start payload, so that a pi pane in a
worktree shows the worktree and its branch.

When the options are absent, the payload carries no worktree, and the row
shows the directory alone.

## D8. The cwd and the session id

The cwd is `ctx.cwd`, which pi gives the extension on every event. The
session id comes from the session manager, `ctx.sessionManager`, and is the
same id the sidebar's session-name feature reads, so that a renamed pi
session shows its name in the sidebar.

## D9. What is not published

The task progress, because pi has no task tool. The subagent tree, because
pmux runs child agents in their own panes and the sidebar already shows each
of those panes on its own.

The permission mode, because pi has none that the sidebar can read. The
sidebar's badge for it stays a Claude concept.

## D10. Turning it off

A session that has no sidebar binary publishes nothing, so the absence of the
binary is the switch. An environment variable, `TMUX_AGENT_SIDEBAR=0`, turns
the publishing off for a session that does have one, for the case where a
machine has the sidebar installed but a session should stay out of it.
