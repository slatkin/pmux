# Proposal

## Why

pmux has two launch paths that build a pi child separately. The pi parent uses `supervisor.ts` (`buildPiLaunch`). The external orchestrator uses `cli.ts start|resume`. The two paths duplicate role resolution, pi argv, the launch spec, the prompt files and resume. Because of this, they drift. An external child gets its prompt as `<scratch>/<name>-<hex>.prompt.md`. The tmux-agent-sidebar parser accepts only `artifacts/<id>/context|pmux-resume/<name>-<timestamp>.md`. The result is that a child of Claude Code shows no badge, no task name and no parent link in the sidebar.

## What Changes

- One launch builder makes the pi launch spec for both paths. The supervisor and `cli.ts start|resume` both call it. The only input that differs is the parent contact: a pi parent (sibling names, roster file) or an external parent (parent, report mode, close grace).
- One role resolution makes a launch record for both paths. `start` now writes `<session>.launch.json` beside the session file, like `pmux_spawn`.
- `start` writes the task prompt to `<scratch>/artifacts/<parent session id>/context/<name>-<timestamp>.md`. The role prompt goes to the same folder. The `.prompt.md` and `.role.md` scratch files go away.
- `start` reads the parent session id from the `@pane_session_id` option of the caller's pane. If that value is empty, `start` uses the caller pane id. The launch continues, and the sidebar shows the child without a parent link.
- `resume` rebuilds the launch spec from the launch record through the same builder. It writes the follow-up prompt to `<scratch>/artifacts/<id>/pmux-resume/<name>-<timestamp>.md`. The `.resume.md` file goes away.
- **BREAKING**: `resume` refuses a launch spec that has no launch record beside its session file (a spec from an older version). The message tells the caller to run `start` again.
- The CLI flags and the stdout JSON of `start` and `resume` do not change. The footer texts, `PI_PMUX_EXTERNAL_PARENT` and the report modes do not change. The pi-parent prompt text and the sidebar parser do not change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `external-orchestration`: `start` writes a launch record. It puts the prompt under an artifact path that holds the parent session id. `resume` rebuilds from the record and refuses a spec without one.

## Impact

- Code: new `pi-extension/pmux/launch-build.ts`. `supervisor.ts` loses `buildPiLaunch`, `writeRunContextFile` and the prompt helpers to it. `cli.ts` `startCommand` and `resumeCommand` call it. `tmux.ts` gains a read of one pane option.
- Tests: `test/cli.test.ts` assertions on `.prompt.md`, `.role.md` and `.resume.md` change. Supervisor tests keep passing unchanged.
- Docs: `skills/pmux/SKILL.md` text on the scratch contents.
- No change to `pmux-done.ts`, the `PI_PMUX_*` keys or the `.exit` format.
