# Design

## Context

`createSurface` in `pi-extension/pmux/tmux.ts` is the single seam that turns
a placement into a tmux surface. Its `tab` branch runs
`new-window -d -t <session> -P -F #{pane_id}`, restores focus to the caller's
window, and returns the new pane id. Naming happens afterwards and only on
the pane: `namePane` runs `select-pane -T <name>`, and the run wrapper later
writes the `<name> — <task>` OSC 2 title. Both write the *pane* title
(`pane_title`); neither touches `window_name`. A window created without an
explicit name has `automatic-rename` on, so the window list shows whatever
command runs in the pane — `zsh`, then `node`.

All three launch paths call `createSurface` with the display name already in
hand: the supervisor (`params.name` / launch-record name) and the CLI
(`--name`, or the rebuilt record's name on `resume`).

## Goals / Non-Goals

**Goals:**

- A pmux tab is identifiable in `choose-tree`, the status-line window list
  and `display-message`/`list-windows` output by the subagent's name.
- The name survives everything the child does in the window, including the
  wrapper's OSC title write.

**Non-Goals:**

- Renaming the caller's window for `pane`/`float` spawns. That window is the
  user's; pmux must not touch its name.
- A per-role or per-call window name. The display name is the name.
- Retroactive naming of tabs created before this change.

## Decisions

### D1 — `new-window -n`, not a `rename-window` afterwards

tmux disables `automatic-rename` for an individual window as soon as the
window gets an explicit name — at creation (`new-window -n`,
`new-session -n`) or later (`rename-window`). Passing `-n` in the same call
therefore solves both halves of the problem — setting the name and freezing
it — in one command, with no window-lookup step and no race where the shell
start could rename it first. A follow-up `rename-window` would work too but
costs a second tmux call and a window target for nothing.

The `-n` argument goes through the argv array like every other `tmux()`
call, so names with spaces or shell metacharacters are safe. A name
containing `.` or `:` would be awkward *as a target*, but pmux never
targets windows by name — it holds the `#{window_id}` and pane ids — so the
name needs no sanitisation beyond what `name` already is. An empty name
omits `-n` (in practice unreachable: `pmux_spawn` and `cli.ts start`
require a name, and `resume` falls back to the record's).

### D2 — Window name is the display name, verbatim

Candidates: plain `<name>`, `pmux:<name>`, and `<name> — <task>` (the OSC
title format). Plain `<name>` wins: the window list is narrow, a `pmux:`
prefix spends six columns of it on information the pane border already
gives, and the task text is long — it belongs in the pane title, where
`buildPaneTitle` already puts it. Keeping window name and pane title
identical also means one value to search for everywhere.

### D3 — Naming is not a separate failure mode, and has no switch

Unlike `namePane` (a second command wrapped in try/catch because naming is
cosmetic), `-n` rides inside `new-window`: if it were to fail, the window
itself failed, which is the existing spawn-failure path — nothing new to
swallow. And like `namePane`, naming needs no config or role key: it is
always what the user wants, and a window name costs nothing when ignored.

### D4 — `cli.ts resume` and the supervisor need no code change

`createSurface` already takes `name` as its first argument on every path.
`resume` passes `values.name ?? rebuilt.name`, so `--name` on a resumed tab
renames the window to match the pane, and a plain `resume` reuses the
record's name. The "…renames the pane only" comment at `cli.ts:438` is
updated to say the window too.
