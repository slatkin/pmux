# Proposal

## Why

The extension runs subagents in panes of a terminal multiplexer, and today
that multiplexer is Luvus only. The same code ran in tmux before the
Luvus-only change (archived `pi-luvus-subagents`, commit `a428eb2`), and the
tmux path was correct in one respect that matters most: it split the
*caller's* pane, resolved from `$TMUX_PANE`. A split that resolves the pane
through tmux's "current pane" instead lands in whichever window another
client last used, so a subagent opens somewhere the user is not looking.

The Luvus-only path also cannot be used at all in a plain tmux session, which
is where the campaign orchestration actually runs.

## What Changes

- A second host backend: tmux. It implements the same surface API as the
  Luvus backend (create, name, run, read, escape, close, prompt, poll for
  exit) on top of plain `tmux` commands.
- Host dispatch: the extension picks Luvus when `LUVUS_ENV`, `LUVUS_BIN_PATH`
  and `LUVUS_PANE_ID` are set, tmux when `TMUX` and `TMUX_PANE` are set, and
  refuses to spawn in neither.
- The tmux backend splits the caller's own pane (`$TMUX_PANE`) with
  `split-window -d`, so a subagent opens beside its parent even when another
  client is attached to another window of the same server.
- The child's report channel becomes host independent: the last assistant
  message before `luvus_done` is the report the parent reads, and the
  `.exit` sidecar stays the completion signal.
- The CLI accepts a tmux pane as a valid launch environment and writes a
  parent-contact footer that matches the host.
- Live agent status (the Luvus status lease and the UHP event stream) stays
  Luvus only. Under tmux the parent polls the pane and the sidecar.

## Capabilities

### New Capabilities

- `tmux-backend`: running subagent panes in tmux — availability, pane
  creation and placement, naming, command delivery, screen reads, exit
  detection and the close behaviour.

### Modified Capabilities

- `luvus-backend`: Luvus is no longer the only supported terminal host; the
  extension refuses to spawn only when neither host is available.

## Impact

- New modules under `pi-extension/luvus/`: `tmux.ts` (the tmux backend),
  `backend.ts` (host dispatch) and the shared `placement.ts`,
  `exit-sidecar.ts` and `surface-types.ts` modules the two backends use.
- `luvus.ts` keeps its implementation but now re-exports the shared modules,
  so existing imports keep working.
- `cli.ts` and `run.ts` learn the second host; the `.exit` sidecar format, the
  `PI_LUVUS_*` environment variables and the `luvus_done` tool are unchanged,
  so `external-orchestration` stays untouched.
- The UHP event stream is used only under Luvus; under tmux the supervisor
  polls the pane instead.
