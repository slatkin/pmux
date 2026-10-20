# Proposal

## Why

The `/stream` follower-pane feature came over from pi-luvus, and it is not what
pmux is for. pmux runs subagents in tmux panes; `/stream` runs a second set of
panes that mirror the parent's own model output. The feature costs a per-session
unix socket server, a transcript projection that rewrites pi's rendered TUI, a
follower tailer, six test files and two test helpers, and the projection reaches
into pi's transcript layout, so it only stays correct while pi keeps that
layout. Removing it leaves pmux with one job and one less moving part.

## What Changes

- **BREAKING** The extension no longer registers a `/stream` command.
  `/stream thinking`, `/stream tools`, `/stream both` and `/stream close` become
  unknown commands in pi.
- **BREAKING** The transcript no longer omits thinking blocks or tool rows.
  There is no attach state, so the transcript always renders pi's normal output.
- Delete `pi-extension/pmux/stream-state.ts` (session socket hub, coalescer and
  replay ring), `pi-extension/pmux/stream-projection.ts` (transcript
  projection) and `pi-extension/pmux/stream-tail.mjs` (the follower-pane
  viewer).
- Remove the stream runtime from the reload-safe `globalThis` registry, so
  `/reload` now retires only the supervisor.
- Remove the `streamTailScriptPath` and `tailerCommandLine` helpers from
  `pi-extension/pmux/launch.ts`, and with them the `StreamName` import there.
- Delete the stream tests: `test/stream-state.test.ts`,
  `test/stream-runtime.test.ts`, `test/stream-command.test.ts`,
  `test/stream-projection.test.ts`, `test/stream-projection-wiring.test.ts`,
  `test/stream-tail.test.ts`, plus the helpers `test/stream-fakes.ts` and
  `test/stream-harness.ts`.
- Delete the `stream-panes` capability spec, the "Stream panes" section of
  `docs/guide.md`, and the "Stream panes" section of `AGENTS.md`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `stream-panes`: every requirement is removed, and the capability itself is
  deleted because nothing is left to specify.

## Impact

The `/stream` command disappears from pi's command list, so any user who
scripted `/stream` in a session, a prompt, or a habit loses it. Nothing else in
pmux changes: the subagent tools, the status widget, the turn-end notification,
the external-orchestration contract (`pmux-done.ts`, the `PI_PMUX_*` variables
and the `.exit` sidecar) and the tmux backend are untouched.

The change removes about 1,400 lines of extension code and the stream test
files. The `openspec/changes/archive/2026-10-19-stream-panes/` history stays as
the record of the feature that shipped and is now withdrawn.
