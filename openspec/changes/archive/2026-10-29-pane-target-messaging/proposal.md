# Proposal

## Why

`pmux_message` reaches only agents pmux manages: `parent`, the sender's own
running children, and running siblings. Everything else is refused — the
external orchestrator's pane that launched a skill child, a pi session in
another window, a Claude Code pane the user pointed at by hand. Yet the
delivery mechanism is already "type a line and press Enter into a pane",
which works on *any* pane on the tmux server. The only thing missing is an
addressing form for panes that are not in the subagent tree: today there is
no way to name one.

## What Changes

- **`to` accepts raw tmux pane targets.** After `parent`, subagent ids and
  display names fail to match, `pmux_message` resolves `to` against the
  tmux server's pane listing, in this order: exact pane id (`%12`), tmux
  target syntax (`session:window.pane`, `window.pane`, `window`, a bare
  pane index, `@N` window id — session-less forms anchor on the caller's
  own session, never the server's current window), then exact
  `pane_title`. A match resolves to that pane's `%N` and delivers exactly
  like a child/sibling message.
- **Shell panes are refused.** Before any pane is typed into — managed or
  foreign — its `pane_current_command` is checked against a shell
  denylist (sh, bash, zsh, fish, …). Typing a message into a bare shell
  executes it as a command, so the tool errors instead. This also covers
  a managed child whose process exited and dropped its pane back to a
  shell while it was still registered as running.
- **Managed agents keep precedence.** `parent`, ids and names resolve
  before any tmux interpretation, so a subagent name can never be
  shadowed by a foreign pane, and pane titles still never resolve to a
  managed agent.

Not in scope: fuzzy or prefix title matching, per-call opt-out of the
shell check, wildcard targets, and reaching panes on another tmux server
(`-L` socket). `pmux_message` stays a sender-side convenience; the
external orchestrator's report protocol is unchanged.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `subagent-messaging`: the reachable-target rule gains raw tmux pane
  addressing with the shell-pane refusal, and the delivery rule's
  pane-title ban is replaced by a resolve-to-pane-id-first rule.
