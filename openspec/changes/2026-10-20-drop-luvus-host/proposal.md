# Proposal

## Why

pmux exists to run subagent panes in tmux. The Luvus host was kept only
because it was the host pmux started from, and it now costs more than it
returns: 1292 lines of Luvus-only code (the backend, the status reporter and
the event stream), a second code path through every surface call, and a
package whose names all say Luvus.

Two of the features that were added to pi-luvus after the Luvus-only change
are genuinely Luvus-bound and cannot be inherited by a tmux host: the leased
live status (`working` / `idle` / `done` / `blocked`, plus the pi session
binding) and the UHP event stream. Everything else was built on the surface
API or on files, and works under tmux unchanged.

Stripping Luvus therefore also forces one real decision: what an external
orchestrator waits on, now that `luvus wait agent-status` is gone.

## What Changes

- **BREAKING** The extension supports exactly one host: tmux. The Luvus
  backend, the Luvus status reporter and the UHP event stream are deleted
  (1292 lines), and the host dispatch disappears with them.
- **BREAKING** The external orchestration protocol changes. The skill waits on
  the `.exit` sidecar and reads the report with the CLI's `last-message`
  command, instead of `luvus wait agent-status` and `luvus agent read`.
- The live status becomes a file: the child writes its status next to its
  session file, and the CLI gains a `wait` command that polls it, so an
  external orchestrator keeps the "wait for done or blocked" capability
  without a multiplexer daemon.
- Agent messages keep their routing (parent, child, sibling) and change their
  delivery: the text is typed into the target pane instead of going through
  the Luvus agent channel.
- The child completion protocol is untouched: `luvus_done`, the `.exit`
  sidecar, the completion nudge and the auto-exit keep working, because none
  of them depended on Luvus.
- The package is renamed to `pmux`, the extension directory to
  `pi-extension/pmux/`, and the tools and environment variables are renamed
  from `luvus_*` and `PI_LUVUS_*` to `pmux_*` and `PI_PMUX_*`.
- The skill moves to `skills/pmux/`. An orchestrator that installed the old
  skill reinstalls it; the old skill's Luvus commands do not exist any more.

## Capabilities

### New Capabilities

- `pmux-host`: the single tmux host — availability, the surface API, the
  status file, and the completion protocol it serves.

### Removed Capabilities

- `luvus-backend`: the Luvus host.
- `luvus-agent-status`: the leased live status.
- `luvus-uhp-events`: the Luvus event stream.

### Modified Capabilities

- `portable-launch`: the CLI launches into tmux panes.
- `external-orchestration`: the skill waits on the sidecar and the status
  file, and reads the report from the session file.
- `luvus-messaging`: messages are typed into the target pane.
- `luvus-surface`: the surface is a tmux pane.
- `luvus-agent-titles`: the title is the tmux pane title.
- `luvus-completion`: unchanged in behaviour, renamed in identifiers.

## Impact

- Deleted: `pi-extension/luvus/luvus.ts`, `pi-extension/luvus/luvus-status.ts`,
  `pi-extension/luvus/uhp-events.ts` and `pi-extension/luvus/backend.ts`.
- The remaining modules keep their surface API, so the supervisor, the stream
  panes, the launcher, the child contract and the completion protocol are
  unaffected by the host change.
- The rename touches the tool names, the environment variables, the extension
  directory, the skill and the docs. Every child process and every external
  orchestrator that pins the old names must be reinstalled; that is a major
  version, not a patch.
- `PI_LUVUS_*` becomes `PI_PMUX_*`. The `.exit` sidecar format does not
  change.
