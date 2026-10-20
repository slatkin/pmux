# Proposal

## Why

pmux exists to run subagent panes in tmux. The Luvus host was kept only
because it was the host pmux started from, and it now costs more than it
returns: 1480 lines in four modules (the Luvus backend, 584; the status
reporter, 301; the event stream, 407; and the host dispatcher, 188), a second
code path through every surface call, and a package whose names all say
Luvus.

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
  (1480 lines with the host dispatcher), and the host dispatch disappears
  with them.
- **BREAKING** The external orchestration protocol changes. The skill waits on
  the `.exit` sidecar and reads the report with the CLI's `last-message`
  command, instead of `luvus wait agent-status` and `luvus agent read`.
- The live status becomes a file: the child writes its status next to its
  session file, and the CLI gains a `wait` command that polls it, so an
  external orchestrator keeps the "wait for done or blocked" capability
  without a multiplexer daemon. The spec defines the file name and format,
  the `wait` invocation and its exit codes, and the status for `handoff`,
  `error` and a crashed child. A resume never reads the status of the
  previous run.
- Agent messages keep their routing (parent, child, sibling) and change their
  delivery: the text is typed into the target pane instead of going through
  the Luvus agent channel.
- The child completion protocol keeps its behaviour: `luvus_done`, the
  `.exit` sidecar, the completion nudge and the auto-exit keep working. The
  status reporter and the Luvus session lookup in `luvus-done.ts` are
  removed.
- `handoffs.jsonl` rows no longer carry `luvusSession`. The value came from
  the Luvus session list. Old rows stay readable.
- Persisted paths follow the rename. The config directory
  `extensions/pi-luvus/` becomes `extensions/pmux/`, and the old config file
  is still read if the new one is absent. The scratch directory
  `<tmp>/pi-luvus` becomes `<tmp>/pmux`. A new `handoffs.jsonl` starts in the
  new directory, and the old file stays where it is.
- The package is renamed to `pmux`, the extension directory to
  `pi-extension/pmux/`, and the tools, the slash commands and the environment
  variables are renamed from `luvus_*`, `/luvus-spawn`, `/luvus-surface` and
  `PI_LUVUS_*` to `pmux_*`, `/pmux-spawn`, `/pmux-surface` and `PI_PMUX_*`.
  `/stream` keeps its name. The GitHub repository path does not change.
- The skill moves to `skills/pmux/`. An orchestrator that installed the old
  skill reinstalls it; the old skill's Luvus commands do not exist any more.

## Capabilities

### New Capabilities

- `pmux-host`: the single-host rule, the one surface API, the status file,
  the rule that a new run starts with no status, and the `wait` command. The
  pane mechanics stay in `tmux-backend`.

### Removed Capabilities

- `luvus-agent-status`: the leased live status.
- `luvus-uhp-events`: the Luvus event stream.

### Modified Capabilities

- `luvus-backend`: the Luvus environment and binary requirements go. Pane
  naming and titles, launch, interrupt and the close after the wait move to
  tmux. "Current pi packages" is unchanged.
- `portable-launch`: the CLI launches into tmux panes.
- `external-orchestration`: the skill waits on the sidecar and the status
  file, and reads the report from the session file.
- `luvus-messaging`: messages are typed into the target pane.
- `luvus-surface`: the surface is a tmux pane.
- `luvus-agent-titles`: the title is the tmux pane title.
- `luvus-completion`: drops the Luvus status requirements and renames
  identifiers.
- `context-alert`: renames identifiers and drops the Luvus session field from
  the handoff log.
- `subagent-supervision`: renames identifiers and drops the event stream and
  the Luvus text.
- `stream-panes`: renames identifiers and drops the Luvus text.

Capability ids keep their names. Renaming spec directories is not part of
this change.

## Impact

- Prerequisite: archive `2026-10-20-tmux-backend` first. It is implemented and
  shares a requirement with this change.
- Deleted: `pi-extension/luvus/luvus.ts`, `pi-extension/luvus/luvus-status.ts`,
  `pi-extension/luvus/uhp-events.ts` and `pi-extension/luvus/backend.ts`.
- The import sites of `backend.ts` (`cli.ts`, `turn-notify.ts`,
  `supervisor.ts`, `index.ts` and `run.ts`) and the imports in `status.ts`
  and `luvus-done.ts` change. `activeHost`, `isMuxAvailable` and
  `muxSetupHint` have no tmux equivalent under those names, and the design
  names their replacements.
- The rename touches the tool names, the environment variables, the extension
  directory, the skill, the docs and the persisted paths (the config
  directory, `handoffs.jsonl` and the scratch directory). Every child
  process and every external orchestrator that pins the old names must be
  reinstalled; that is a major version, not a patch.
- `PI_LUVUS_*` becomes `PI_PMUX_*`. The `.exit` sidecar format does not
  change.
