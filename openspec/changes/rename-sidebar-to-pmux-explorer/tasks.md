## 1. Code

- [ ] 1.1 `pi-extension/pmux/sidebar.ts` `resolveSidebarBinary`: env var `PMUX_EXPLORER_BIN`, plugin paths `~/.tmux/plugins/pmux-explorer/{bin,target/release}/pmux-explorer`, PATH candidate `pmux-explorer`; update the doc comment
- [ ] 1.2 `pi-extension/pmux/sidebar.ts` `sidebarSwitchEnabled` + doc comment: `PMUX_EXPLORER !== "0"`; `SIDEBAR_WORKTREE_OPTION`/`SIDEBAR_BRANCH_OPTION` values → `@pmux-explorer-spawned-*` (keep the constant names)
- [ ] 1.3 `pi-extension/pmux/task-reminders.ts`: store path → `/tmp/pmux-explorer-tasks*.json`; `pi-extension/pmux/index.ts:537` comment → `pmux-explorer/src/task_reminders.rs`; any old form in `pi-extension/pmux/tmux.ts`
- [ ] 1.4 `test/{sidebar,sidebar-events,task-reminders,cli}.test.ts`: every old-name expectation rewritten to the new names; no test-count changes

## 2. Docs and specs

- [ ] 2.1 `skills/sidebar-tasks/SKILL.md`: command `pmux-explorer task-set`/`task-update`, `/tmp/pmux-explorer-tasks` path (incl. the `:45` snippet), prose names
- [ ] 2.2 `docs/guide.md`: section title/link, `slatkin/pmux-explorer` URL, `PMUX_EXPLORER_BIN`/`PMUX_EXPLORER=0`, plugin paths, `pmux-explorer` binary name
- [ ] 2.3 `openspec/specs/sidebar-events/spec.md` and `openspec/specs/task-reminders/spec.md`: rename the repo/product references per this change's deltas (`pmux-explorer hook pi <event>`, `pmux-explorer` repository)

## 3. Verify

- [ ] 3.1 `git grep` for `tmux-agent-sidebar`, `TMUX_AGENT_SIDEBAR`, `tmux-agent-`, `agent-sidebar` outside `openspec/changes/archive/`: zero matches
- [ ] 3.2 The repo's test command passes (see AGENTS.md/package.json for the suite name)
- [ ] 3.3 `openspec validate rename-sidebar-to-pmux-explorer` passes
