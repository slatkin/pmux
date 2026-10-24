## Why

The tmux sidebar fork was renamed: product, binary, tmux options, storage paths, and repository are now `pmux-explorer` (`slatkin/pmux-explorer`, merged as PR #9 of that repo). pmux still resolves the old binary name, reads the old tmux option names, builds the old `/tmp` task-store path, and documents the old env vars — every one of those lookups now misses against the renamed sidebar.

## What Changes

- **BREAKING** `resolveSidebarBinary` (`pi-extension/pmux/sidebar.ts`) looks up `pmux-explorer`: the override env var becomes `PMUX_EXPLORER_BIN`, the plugin paths become `~/.tmux/plugins/pmux-explorer/{bin,target/release}/pmux-explorer`, and the PATH candidate becomes `pmux-explorer`.
- **BREAKING** The off-switch env var `TMUX_AGENT_SIDEBAR=0` becomes `PMUX_EXPLORER=0`.
- **BREAKING** The spawned-worktree window options read by pmux become `@pmux-explorer-spawned-worktree` and `@pmux-explorer-spawned-branch`.
- **BREAKING** The task-store path becomes `/tmp/pmux-explorer-tasks<PANE>.json`.
- The `sidebar-events` and `task-reminders` specs, `skills/sidebar-tasks/SKILL.md`, `docs/guide.md`, the comment in `index.ts`, and all four affected test files are renamed in step. No compat aliases: old env vars, options, and paths are not read.

## Capabilities

### Modified Capabilities
- `sidebar-events`: binary resolution, the off-switch, the `hook pi` command string, and the spawned-worktree option names all name `pmux-explorer`.
- `task-reminders`: the task-store path and the repository references name `pmux-explorer`.

## Impact

- Code: `pi-extension/pmux/{sidebar,task-reminders,index,tmux}.ts`, `test/{sidebar,sidebar-events,task-reminders,cli}.test.ts`.
- Docs/specs: `skills/sidebar-tasks/SKILL.md`, `docs/guide.md`, `openspec/specs/{sidebar-events,task-reminders}/spec.md`.
- User machines: anyone exporting `TMUX_AGENT_SIDEBAR_BIN` or `TMUX_AGENT_SIDEBAR=0` must rename the variable; this is the same breaking cut-over as the sidebar rename itself.
