---
name: sidebar-tasks
description: Record, update and track a per-pane todo list in pmux-explorer's Tasks tab through `pmux-explorer task-describe <text>`, `task-set <subject>` and `task-update <id> <status>`. Use it when asked to keep a task or todo list for the pane, when the pane's Tasks tab should reflect the work, or when a record-first or update-before-finish reminder told you to use task-set, task-update or task-describe.
---

# The Tasks tab (pmux-explorer)

pmux-explorer shows a todo list for the focused tmux pane in its
Tasks tab. The pane's agent writes that list through three shell commands;
this skill is the full instruction set for them. Every agent harness that
runs a shell can use them — no registration, no hook wiring.

Requires a tmux session (`TMUX` and `TMUX_PANE` in the environment). The
command reads `TMUX_PANE` itself and records for the pane it runs in, so
run it in your own pane's shell, the way your shell tool already runs.
Outside tmux the commands record nothing and exit 0.

The list is one file per pane, `/tmp/pmux-explorer-tasks<PANE>.json`. A new
session starts with an empty list: the sidebar clears the pane's store at
session start.

## Describe the work

```sh
pmux-explorer task-describe <text>
```

Sets the pane-wide description — one or two lines naming the work the
list covers, shown pinned above the items in the Tasks tab. Describe the
work before recording the first item; the command is expected as part of
registration. Later calls replace the description (a blank one clears
it), so the description stays the current goal even as the plan shifts.
Every argument after `task-describe` joins into the text, the same join
`task-set` uses, so quoting is optional:

```sh
pmux-explorer task-describe Fix the login crash end to end
```

## Record a task

```sh
pmux-explorer task-set <subject>
```

Records the subject as `pending` and prints the assigned id — keep it, it
is how every later command names the item. Every argument after `task-set`
joins into the subject, so quoting is optional and unnecessary:

```sh
pmux-explorer task-set Fix the login crash on empty email
```

Subjects wrap to the tab's width instead of truncating, but the tab is
still a glanceable list: keep subjects short enough to read at a glance
and put detail in the work, not the subject.

## Read the list

There is no list subcommand; read the store file. The pane id is encoded in
the file name with `%` replaced by `_`:

```sh
pane_file=/tmp/pmux-explorer-tasks"$(printf %s "$TMUX_PANE" | tr '%' '_')".json
cat "$pane_file"
```

Optionally, when `jq` exists, the description and one line per item:

```sh
jq -r '.description' "$pane_file"
jq -r '.tasks[] | "\(.id)\t\(.status)\t\(.subject)"' "$pane_file"
```

Read it when the ids are out of context — for instance after a
compaction — or when you must know what is still open before updating.

## Update a status

```sh
pmux-explorer task-update <id> <status>
```

`status` is `pending`, `in_progress` or `completed`. Mark an item
`in_progress` when you start it and `completed` when it is done — the tab
and the finish reminders both act on what is still open. On success the
command prints `<id> <status>`. An unknown id or an unknown status changes
nothing, prints nothing, and still exits 0. Updating works in every
direction: an item can go back to `pending` or `in_progress` after being
`completed`.

## Retiring an item

There is no delete command and no cancelled status. Retire an item that no
longer needs work by updating it to `completed` — that is the list's only
exit, and the sidebar trims completed items first: the store keeps at most
50 items, and past the cap completed ones go oldest-first; ids never get
reused, so a stored id stays valid after a trim.

## The reminders

The pane's agent may receive the task reminders, quoted verbatim from the
sidebar's `src/task_reminders.rs`:

- A turn that starts while the pane's todo list is empty may receive:
  `No tasks recorded yet: describe the work with task-describe <text>, then record tasks with task-set <subject>.`
- A turn that ends while items are still open receives:
  `Reminder: make sure the task board is up to date.`

The update reminder points at the whole board, not at a command form —
bring it in step with the `task-update` forms above. Which reminders reach
you depends on the harness: the update-before-finish one is delivered to
pi panes by the pmux extension, and it is buffered: it does not fire turn
after turn. It waits until the pane's store file has been untouched for
five minutes and three turn ends have passed since its last write, so a
turn spent actively updating the list is not nagged at its own end.
