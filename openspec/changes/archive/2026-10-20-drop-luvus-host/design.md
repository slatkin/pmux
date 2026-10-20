# Design

## Context

pmux currently carries two hosts. The question this change answers is what
survives when one of them goes.

## Prerequisite

The change `2026-10-20-tmux-backend` is implemented (20 of 20 tasks) but not
archived. It adds the `tmux-backend` capability and rewrites the
`luvus-backend` requirement "Luvus environment is required". This change
removes that same requirement and relies on `tmux-backend` for the pane
mechanics (availability, split from the caller's pane, pane commands, named
panes, exit detection). Archive `2026-10-20-tmux-backend` first. The deltas
here do not touch `tmux-backend`, so `openspec validate` passes without it.

## Feature audit

The features that were added after the Luvus-only change split into three
groups. Most of them were never Luvus-specific: they were built on the
surface API or on files, so a tmux host inherits them unchanged.

| Feature | Spec | Under tmux |
| --- | --- | --- |
| Pane lifecycle: create, name, run, read, Escape, close | `luvus-backend`, `tmux-backend` | Inherited. The tmux backend implements it (commit `426dc57`). The Luvus text in `luvus-backend` is replaced. |
| Pane titles (OSC 2) | `luvus-agent-titles`, `luvus-backend` | Inherited. tmux reads the OSC title as the pane title. The Luvus history row has no equivalent and is removed. |
| Completion: `luvus_done`, `.exit` sidecar, nudge, auto-exit | `luvus-completion` | Inherited. The protocol is a file and a tool call. Only the Luvus status writes change (D2). |
| Context alert and handoff | `context-alert` | Partly. The handoff log row carries `luvusSession`, taken from the Luvus session list (`luvus-done.ts`, `listLuvusSessionsAsync`). The field goes (D8). |
| Portable launch: the CLI and the launch spec | `portable-launch` | Inherited. The CLI was already host-neutral apart from the pane host. |
| Supervisor: spawn, stop, resume, roster | `subagent-supervision` | Inherited. It drives the surface API. The event watch goes with the stream. |
| Stream panes (`/stream`) | `stream-panes` | Inherited. The follower panes use `splitPane`, `namePane` and `runInPane`. |
| Child environment contract | `external-orchestration` ("Launch contract") | Inherited. The encoding is host-neutral. The variables are renamed (D6). |
| Turn notifications | none | Inherited. The tmux backend implements the focus check and the status-line notification. |
| Agent messaging | `luvus-messaging` | Inherited. `agentPrompt` in `tmux.ts` already sends the text with `send-keys -l` and Enter. The Luvus error handling goes (D5). |
| External orchestration skill | `external-orchestration` | Changes. The skill waited on `luvus wait agent-status` and read reports with `luvus agent read`; both move to the status file and the session file. |
| Live agent status lease | `luvus-agent-status` | Lost. Replaced by the status file (D2). |
| UHP event stream | `luvus-uhp-events` | Lost. The supervisor polls the sidecar and the pane. |

## Decisions

### Decision 1: One host, and the dispatch layer goes with it

With a single host the dispatcher is indirection with no payoff, so
`backend.ts` is deleted and the call sites import from `tmux.ts` directly.
The surface function names stay (`createSurface`, `runInPane`, `pollForExit`,
and the rest), so the supervisor and the stream panes keep their calls.
Four names change, and the call sites list them:

- `isMuxAvailable` becomes `isTmuxAvailable`, which `tmux.ts` already
  exports (callers: `index.ts` three times, `turn-notify.ts`).
- `muxSetupHint` becomes `tmuxSetupHint`, a new export of `tmux.ts` (caller:
  `index.ts`). It returns the tmux text only.
- `activeHost`, the `Host` type and every `target?: Host` parameter are
  deleted. The only other caller of `activeHost` is the event watch in
  `supervisor.ts`, which goes with the stream.
- `DEFAULT_SURFACE_PLACEMENT`, `parseSurfacePlacement` and the shared types
  are imported from `placement.ts`, `exit-sidecar.ts` and `surface-types.ts`.
  `status.ts` imports the placement helpers from `luvus.ts` today and
  changes to `placement.ts`.

`cli.ts` drops `hostOf` and the host argument of `parentFooter`.

### Decision 2: The live status becomes a file, not a lease

The lease is a Luvus daemon feature. The capability an orchestrator needs is
narrower: "is this child done, blocked, or still working". It becomes a file
next to the session file.

- **File**: `<session file>.status`, one JSON object with `status`
  (`working`, `idle`, `done`, `blocked`), `at` and an optional `message`.
  Each write replaces the whole file (a temp file renamed over it), so a
  reader never sees a partial object.
- **Writers**: the child extension (`pmux-done.ts`) takes over the work of
  `luvus-status.ts`: `working` at the start of a turn, `idle` at the end,
  and the terminal writes at the three exit points that call the reporter
  today. `done` is written for `pmux_done` with or without a handoff and for
  auto-exit. `blocked` is written for `caller_ping` (the question) and for
  a provider error (the error text). A terminal write comes before the
  sidecar write and latches: later writes are skipped and shutdown does not
  remove the file. This is the lease behaviour, kept.
- **Dropped**: the `working` message that names the running tool, and the
  renewal timer. A file needs no renewal.
- **The CLI**: `wait --session <file> [--status <list>] [--timeout <s>]`.
  Defaults are `done,blocked` and 600 seconds. Exit 0 prints the status line,
  exit 2 is a timeout and prints the last status line seen, exit 1 is a usage
  error. The orchestrator runs it through the launcher:
  `node <skill-dir>/launch.ts wait ...`. `launch.ts` forwards its argv to
  the CLI, so it needs no change for this.

Rejected: a registry kept in tmux (a pane option or a server variable). It
would tie the status to a pane that can be gone when the orchestrator looks,
and the file already sits next to the data it describes.

### Decision 3: The completion signal stays the sidecar; stale and crash cases are closed

The `.exit` sidecar is the child's completion signal and needs no host. The
status file adds the answer to "is it blocked or still working" while the
child lives. Two cases would otherwise lie:

- **Stale status.** A resume reuses the session file, so the status of the
  earlier run is still on disk. `pmux_spawn`, `pmux_resume`, `start` and
  `resume` remove `<session file>.status` before the child starts. A missing
  file means "no status yet", and `wait` keeps polling.
- **Crash.** A child that dies leaves `working` or `idle`. The run wrapper
  (`cli.ts run`) knows the exit code. When the child exits with no sidecar
  and no terminal status, the wrapper writes `blocked` with a message that
  gives the exit code. `wait --status done,blocked` then ends. If the wrapper
  itself is killed (the pane is killed), nothing is written and the wait ends
  by timeout. That case is accepted.

The skill reads `<session>.exit` after every wait, because the sidecar says
whether the child finished, handed off, pinged or failed.

### Decision 4: The report is the session file

The Luvus agent read command was how the orchestrator read a child's report.
The session file already holds it: the CLI's `last-message --session <file>`
(`cli.ts`) prints the child's last assistant message. The footer that `start`
writes into the brief tells the child that this message is the report. The
skill uses that command.

### Decision 5: Messages are typed into the target pane

The routing rules (who may address whom) stay as they are, with the same
reachable-target error text (it is this package's own text). Messages to the
parent still go through the message file and bypass the parent's composer.
Delivery to a child or sibling uses `agentPrompt` in `tmux.ts`: `send-keys -l`
with the text, then Enter, addressed by pane id.

tmux cannot say whether the target is ready for input. A target on an approval
screen gets the text typed as input. The old "not ready" error is gone, and a
failed tmux call is reported without a retry. This is a real loss against the
Luvus path and the spec says so.

### Decision 6: The rename is part of this change

A package with no Luvus in it must not keep names that say Luvus. The rename
covers:

- the tools: `pmux_spawn`, `pmux_resume`, `pmux_message`, `pmux_list`,
  `pmux_interrupt` and `pmux_done`;
- the slash commands: `/luvus-spawn` becomes `/pmux-spawn` and
  `/luvus-surface` becomes `/pmux-surface`. `/stream` keeps its name;
- the environment variables: `PI_LUVUS_*` becomes `PI_PMUX_*` (including
  `PI_LUVUS_DIR` and `PI_LUVUS_PI_ENTRY`);
- the files: `pi-extension/luvus/` becomes `pi-extension/pmux/`,
  `luvus-done.ts` becomes `pmux-done.ts`, `skills/pi-luvus/` becomes
  `skills/pmux/`;
- the widget key `luvus-status` in `supervisor.ts` becomes `pmux-status`;
- the persisted paths: the config directory `extensions/pi-luvus/` becomes
  `extensions/pmux/`. `config.json` is read from the new directory first, and
  from the old directory when the new file is absent (the code already does
  the same for its legacy package-root location). New writes, including the
  `/pmux-surface` setting, go to the new directory. A new `handoffs.jsonl`
  starts there, and the old file stays where it is. The scratch directory
  `<tmp>/pi-luvus` becomes `<tmp>/pmux`.

The GitHub repository path is `slatkin/pmux`: the package was forked into
that repository before this change, so the install command and the lookup
path of pi's git install name `slatkin/pmux`. `slatkin/pi-luvus` is the old
upstream package and must not appear in an install path.

This breaks every installed child and every external orchestrator that pins
the old names, so it is a major version. The alternative, keeping the old
names for one release, was rejected: a compatibility alias for a multiplexer
that is no longer supported is a permanent lie in the tool list.

The `luvus-surface` main spec lists the accepted values as `pane` and `tab`,
and the command text in `index.ts` lists `right`, `down` and `tab`. That
mismatch is older than this change and this change does not fix it.

### Decision 7: The `.exit` sidecar format does not change

The sidecar is a file both ends already read, and the orchestrator side is
the skill in this same repository. The format stays so that the parent's
reader and the child's writer, which ship together, need no migration. A
child that was started before the upgrade is not supported: it holds the old
tool names and the old variables, so it is stopped and restarted.

### Decision 8: The handoff log drops the Luvus session

`writeHandoffLogRow` in `pmux-done.ts` calls `listLuvusSessionsAsync` to fill
`luvusSession`. That call, `matchLuvusSession`, the cached lookup and the
field are removed. New rows have no `luvusSession` key. Old rows keep it and
nothing reads it. The `context-alert` spec drops "Server session in log
rows" and the field from "Handoff log".

### Decision 9: The widget does not change

The status widget reads the child's activity file, not the lease
(`status.ts`). The status file therefore adds no widget input, and the old
task to feed the widget from it is dropped. The widget key is renamed (D6).

### Decision 10: Spec housekeeping

Capability ids keep their names, so `luvus-backend`, `luvus-messaging`,
`luvus-surface`, `luvus-agent-titles` and `luvus-completion` stay as ids.
Scenario headings are identifiers and keep their old spelling in the
requirements that the deltas modify (for example "Model forgets to call
luvus_done"). The `Purpose` lines of the specs that still say Luvus cannot be
changed by a delta, so a task edits them by hand after the archive. When the
archive leaves `luvus-agent-status` and `luvus-uhp-events` with no
requirement, a task removes the two directories.

## Risks

- The status file is written by the child process. A child that dies before
  its first write leaves no file. The run wrapper covers a crash after the
  start, and the timeout covers the rest.
- Renaming the tools and the variables changes the child's tool list, so a
  child started by an old parent or an old skill will not find `pmux_done`.
  The child is launched with the extension from the same checkout, so the
  versions move together (D7).
- The `PI_PMUX_*` rename touches the child environment contract, which the
  `external-orchestration` spec covers. The spec delta updates it in the same
  change.
- tmux typed delivery has no readiness check (D5).
- If `2026-10-20-tmux-backend` is archived after this change, the archive of
  one of the two fails on the shared requirement. Archive that change first.
