# Design

## Context

The stream feature spans three extension modules and the extension entry point:

- `pi-extension/pmux/stream-state.ts` owns the per-session unix socket hub, the
  coalescer, the bounded replay ring and the `StreamName` type.
- `pi-extension/pmux/stream-projection.ts` reaches into pi's rendered TUI
  through a zero-height widget (`pmux-streams`) and swaps the chat container for
  a view that hides the attached stream's content.
- `pi-extension/pmux/stream-tail.mjs` is the plain-Node viewer that runs in the
  follower pane.
- `pi-extension/pmux/index.ts` owns the command handler, the pane records, the
  open gate, the reload-safe `globalThis` entry (`STREAM_KEY`) and the event
  handlers that feed the hub.
- `pi-extension/pmux/launch.ts` owns `streamTailScriptPath` and
  `tailerCommandLine`, the shell-neutral command line for the tailer.

Two constraints shape the work. The extension is loaded by pi directly from
TypeScript, so every deleted import must go with its module or the extension
fails to load. And the `globalThis` registry is reload-safe by contract: the
new module load must retire what the old one started, so the stream runtime
cannot simply be dropped from the registry while an old socket, hub or pane is
still alive.

## Goals / Non-Goals

**Goals:**

- The extension no longer registers `/stream`, and no stream code remains in
  the shipped package.
- The transcript renders pi's normal output at all times.
- `/reload` retires exactly the resources that still exist: the supervisor.
- The repository states the removal in the same places the feature was
  described: the capability spec, the guide and `AGENTS.md`.

**Non-Goals:**

- No replacement for the feature. The design does not port the JSONL-tailing
  idea from `/home/slatkin/Dev/pi-streams/plan.md`; that plan stays a plan.
- No change to the subagent tools, the status widget, the turn-end
  notification, the tmux backend or the external-orchestration contract
  (`pmux-done.ts`, the `PI_PMUX_*` variables, the `.exit` sidecar).
- No change to `johnny-cant-read`, which carries its own port of the feature.

## Decisions

**Delete the feature outright, with no deprecation switch.** A config flag or a
hidden command would keep the socket hub, the projection and the tailer in the
package, which is the cost the change exists to remove. The alternative was a
stub `/stream` that answers "this command was removed"; pi already answers an
unknown command, so the stub adds a surface without adding information.

**Delete the whole `pmux-streams` widget with the projection.** The widget
factory exists only to hand the projection the `tui` it needs. Nothing else
registers a widget under that id, so the widget goes with the projection rather
than staying as an empty hook.

**Keep the `globalThis` registry, drop the stream entry.** `INSTANCE_KEY` and
`SUPERVISOR_KEY` stay; `STREAM_KEY` and `retireStreamRuntime` go. The retire
path for the old load keeps its current shape for the supervisor, so the
reload contract in `AGENTS.md` still holds with one resource instead of two.

**Remove the launch helpers rather than generalising them.** `streamTailScriptPath`
and `tailerCommandLine` exist only for the tailer command line.
`assertPaneToken` stays, because `paneCommandLine` uses it for the subagent
launch. The `StreamName` import in `launch.ts` goes with the helper.

**Delete the capability spec instead of emptying it.** The delta removes every
requirement of `stream-panes`, so the archived main spec would have nothing
left to say. `openspec/specs/stream-panes/spec.md` is deleted as part of the
change, and the archive step must not re-create it from an empty delta.

**Leave the archived change in place.** `openspec/changes/archive/2026-10-19-stream-panes/`
is the record of a feature that shipped and is now withdrawn. It stays, as the
`luvus-backend` history did when the Luvus host was dropped.

## Risks / Trade-offs

[A user's `/stream` now fails with pi's unknown-command message] → The
removal is a breaking change, so it rides the next release notes and the
proposal names it.

[An old module load's hub, socket or follower pane outlives the reload] → The
stream entry is removed from the registry only together with the code that
retired it, and the removal lands in one commit, so no intermediate state
exists where the registry keeps a stream runtime that nothing can retire.

[The tailer script stays in the published package] → `package.json` ships the
whole `pi-extension/` directory, so deleting `stream-tail.mjs` from the source
tree removes it from the tarball; no manifest edit is needed.

[The transcript layout changes in a future pi release] → The projection was
the only code that depended on that layout, and it is gone.

## Migration Plan

One change, applied in this order: delete the three stream modules, strip the
stream code from `index.ts` and `launch.ts`, delete the stream tests and test
helpers, then update the spec, the guide and `AGENTS.md`. The gates
(`format:check`, `lint`, `typecheck`, `test`) run at the end. Rollback is a
revert of the commit; no data or configuration migrates, because the feature
writes nothing to disk.
