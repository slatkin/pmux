# Design

## Context

`resolveMessageTarget` in `pi-extension/pmux/index.ts` maps `to` onto
`parent`, the sender's own children (by id or name) and siblings from the
parent roster (by id or name). Every candidate carries its tmux pane id
(`RunningSubagent.surface`, `SubagentRosterChild.pane`). Delivery is
`agentPrompt`: `send-keys -l` plus one Enter — pane-agnostic. The tool
lives behind `sendSubagentMessage`, which already takes injectable `deps`,
so the new lookup joins that seam instead of touching tmux directly.

## Goals / Non-Goals

**Goals:**

- `to` addresses any pane on the caller's tmux server by pane id, tmux
  target syntax, or exact pane title, with delivery unchanged.
- A bare shell pane can never be typed into, whether it is foreign or a
  managed pane that dropped back to a shell.
- Name/id resolution for managed agents is untouched and always wins.

**Non-Goals:**

- Fuzzy/prefix title matching, glob targets, `pmux_message` flags.
- Reaching other tmux servers or sessions on other sockets.
- Verifying the receiver is an agent at all — a non-shell foreign pane is
  trusted to be what the caller meant (the caller asked for it by
  address).

## Decisions

### D1 — One `list-panes -a` listing feeds resolution and the shell gate

`sendSubagentMessage` gains an optional `deps.panes` that returns one
snapshot of `tmux list-panes -a` rows (`pane_id`, `pane_title`,
`pane_current_command`, `pane_index`, `pane_active`, `session_id`,
`session_name`, `window_id`, `window_index`, `window_name`). Resolution
consumes it for foreign targets; the delivery gate re-checks the resolved
pane's `pane_current_command` against the denylist from the *same* row, so
a target can never be resolved as safe and delivered as a shell. When the
listing fails, `panes` is undefined: managed-agent addressing and delivery
behave exactly as today (fail-open), and foreign targets error with the
reachable-agent list plus a note that pane lookup was unavailable.

### D2 — Matching precedence: managed agents, then pane id, then target syntax, then title

`parent`, exact ids and names match first and can never be shadowed. A
`to` equal to a candidate's own pane id returns that candidate with its
real relation. Only then does tmux matching run on the listing:

1. `#{pane_id}` equality (`%12`).
2. Target syntax: `sess:win.pane`, `sess:win`, `win.pane`, `win`, `.pane`,
   `@N` (window id), or a bare token. Session-less forms anchor on the
   caller pane's session — looked up in the same listing via `TMUX_PANE` —
   so an untargeted name can never resolve in another session's window.
   `win` without a pane part means that window's active pane
   (`pane_active`). A bare token tries caller-window pane index first when
   numeric, then session window index/name, then falls through to titles.
3. Exact `#{pane_title}` equality.

Zero matches ends in the existing no-reachable-agent error with a pane
note appended; multiple matches (window name or title) end in an
ambiguity error listing each match's pane id and `session:window`. tmux
specials (`{last}`, `{up}`, `^`, `!`) are not parsed: they match nothing
and fall through to the error.

### D3 — `pane_title` sits last in the listing format

`list-panes -F` has no escaping and titles are free text, so
`pane_title` is the final `|`-separated field; an overflow `|` in a title
rejoins instead of corrupting the structured fields. Session and window
names are matched alongside their numeric ids so a `|` in a name degrades
that row's name matching only.

### D4 — Shell denial is a delivery gate, not a resolution rule

`resolveMessageTarget` stays about identity: it returns the pane the
caller meant. `sendSubagentMessage` refuses right before `deps.prompt`
when the resolved pane's `pane_current_command` basename is in the
denylist (sh, bash, dash, ash, zsh, fish, ksh, mksh, csh, tcsh, nu,
elvish, xonsh, pwsh, powershell, rc, es, osh, yash, login). Keeping the
check at delivery means it also guards managed candidates whose surface
turned back into a shell — resolution cannot know that, only the fresh
listing can. A pane absent from the listing passes through and lets
`send-keys` report its own "can't find pane" error, preserving the
existing delivery-failure contract.

### D5 — Foreign panes get `relation: "pane"`, name echoes `to`

`SubagentRelation` gains `"pane"`. The sender header reuses the generic
`[subagent message from <name>]` form and the success text reports the
resolved `%N`. `parent`-file delivery is untouched: only a relation of
`parent` writes the message file.

## Testing seam

`deps.panes` and `context.callerPane` keep `sendSubagentMessage` and
`resolveMessageTarget` pure: unit tests inject pane rows, no tmux server
needed — the same pattern as `deps.prompt`.
