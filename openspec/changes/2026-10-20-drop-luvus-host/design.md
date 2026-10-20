# Design

## Context

pmux currently carries two hosts. The question this change answers is what
survives when one of them goes.

## Feature audit

The features that were added after the Luvus-only change split into three
groups. Most of them were never Luvus-specific: they were built on the
surface API or on files, so a tmux host inherits them unchanged.

| Feature | Spec | Under tmux |
| --- | --- | --- |
| Pane lifecycle: create, name, run, read, Escape, close | `luvus-surface` | Inherited. The tmux backend implements it (commit `426dc57`). |
| Pane titles (OSC 2) | `luvus-agent-titles` | Inherited. tmux reads the OSC title as the pane title and shows it on the pane border. The Luvus sidebar entry disappears with Luvus. |
| Completion: `luvus_done`, `.exit` sidecar, nudge, auto-exit | `luvus-completion` | Inherited. The protocol is a file and a tool call, not a daemon. |
| Context alert and handoff | `context-alert` | Inherited. The handoff text travels in the sidecar. |
| Portable launch: the CLI and the launch spec | `portable-launch` | Inherited. The CLI was already host-neutral apart from the pane host. |
| Supervisor: spawn, stop, resume, roster | `subagent-supervision` | Inherited. It drives the surface API. |
| Stream panes (`/stream`) | `stream-panes` | Inherited. The follower panes use `splitPane`, `namePane` and `runInPane`. |
| Child environment contract | `child-env-contract` | Inherited. The encoding is host-neutral. |
| Turn notifications | — | Inherited. The tmux backend implements the focus check and the status-line notification. |
| Agent messaging | `luvus-messaging` | Partly. The routing (parent, child, sibling) is host-neutral; the delivery changes from the Luvus agent channel to typing the text into the target pane. |
| External orchestration skill | `external-orchestration` | Changes. The skill waits on `luvus wait agent-status` and reads reports with `luvus agent read`; both move to the status file and the session file. |
| Live agent status lease | `luvus-agent-status` | Lost. The lease (`agent report`, the session binding) is a Luvus daemon feature. |
| UHP event stream | `luvus-uhp-events` | Lost. The event stream is a Luvus daemon feature; the supervisor polls the pane instead. |

So the answer to "does tmux get the new features for free" is: everything that
was built on the surface API or on files, yes. The two daemon-bound features
are the exception, and the skill has to be rewritten because it was written
against those daemon commands.

## Decisions

### Decision 1: One host, and the dispatch layer goes with it

With a single host the dispatcher is indirection with no payoff, so
`backend.ts` is deleted and the call sites import the surface API from the
tmux backend directly. The exported names stay host-neutral
(`createSurface`, `runInPane`, `pollForExit`), so the supervisor and the
stream panes do not change.

### Decision 2: The live status becomes a file, not a lease

The lease is a Luvus daemon feature: a pi process holds a lease on its own
pane and the daemon publishes it. The capability an orchestrator needs is
narrower — "is this child done, blocked, or still working" — and it can be
expressed as a status file next to the child's session file.

The child writes its status there (`working`, `idle`, `done`, `blocked`), and
the CLI gains a `wait` command that polls the file until it reaches a wanted
status or times out. The orchestrator then runs `pmux wait --session <file>
--status done,blocked --timeout <seconds>`, which is the same shape as the
Luvus command it replaces.

Rejected: keeping a `tmux` status registry. It would need its own daemon, and
the file already exists next to the data it describes.

### Decision 3: The completion signal stays the sidecar

The `.exit` sidecar is the child's completion signal and needs no host. The
skill waits on the sidecar for a clean exit and falls back to the status file
for the blocked case, so a child that dies without a sidecar is still seen.

### Decision 4: The report is the session file

`luvus agent read` was how the orchestrator read a child's report. The
session file already holds it: the CLI's `last-message --session <file>`
prints the child's last assistant message, which is what `luvus_done` defines
as the report. The skill uses that command.

### Decision 5: Messages are typed into the target pane

The routing rules (who may address whom) stay as they are. The delivery
changes: the text is sent to the target pane with `send-keys -l` followed by
Enter. A message to a pane that is not a subagent is rejected by the same
rules as before, so the Luvus "reachable targets" error text still applies.

### Decision 6: The rename is part of this change

A package with no Luvus in it must not keep names that say Luvus. The tools
become `pmux_spawn`, `pmux_resume`, `pmux_message`, `pmux_list`,
`pmux_interrupt` and `pmux_done`; the environment variables become
`PI_PMUX_*`; the extension moves to `pi-extension/pmux/`; the skill moves to
`skills/pmux/`.

This breaks every installed child and every external orchestrator that pins
the old names, so it is a major version. The alternative — keeping the old
names for one release — was rejected: a compatibility alias for a
multiplexer that is no longer supported is a permanent lie in the tool list.

### Decision 7: The `.exit` sidecar format does not change

The sidecar is a file both ends already read, and the orchestrator side is
the skill in this same repository. Keeping the format means a child written
for the old version still completes correctly; only the tool names inside the
child change.

## Risks

- The status file is written by the child process, so a child that dies
  before its first write leaves no status. The orchestrator falls back to the
  sidecar and the pane sentinel, and the timeout covers the rest.
- Renaming the tools changes the child's tool list, so a child started by an
  old parent (or an old skill) will not find `pmux_done`. The child is
  launched with the extension from the same checkout, so the versions move
  together.
- The `PI_PMUX_*` rename touches the child environment contract, which the
  external-orchestration spec covers; the spec delta updates it in the same
  change.
