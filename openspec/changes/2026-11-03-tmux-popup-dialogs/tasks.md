# Tasks

## 1. Popup plumbing (popup-dialogs)

- [x] 1.1 Add `openPopup(args)` to `tmux.ts` (design D2): through `__setTmuxExecForTests__` when set, else a detached `spawn("tmux", ...)` with no timeout and stdio `ignore` except stderr, which the thrown error carries, and an `unref()` hook for D1's stop. Verify with `test/tmux.test.ts` cases that assert the exact argv and the error text.
- [x] 1.2 Add the outer/inner state-file protocol (design D1) in a new `dialog-host.ts`: private temp dir, `PMUX_DIALOG_STATE`, `open`/`done`/`cancel` states, the 200 ms poll, the dead-pid cancel and the 10-second no-open failure. Inject the clock, the pid check and the popup call. Verify with `test/dialog-host.test.ts`: a done result, Escape (pid dead, no final state) as a cancel, a popup error with nothing changed, a missing `TMUX_PANE` refused before any tmux call, a wait longer than 5 seconds, and, on the Claude Code path, the stop at 100 seconds with the "still open" line (design D1), and a stop at 100 seconds that completes, and calls the `unref` hook, while the injected popup call never settles.
- [x] 1.3 Add `dialog-ui.ts` (design D3): the pure list reducer (Up/Down, case-insensitive filter, Backspace, Enter, Escape) and the raw-mode renderer. Verify the reducer with `test/dialog-ui.test.ts`, including the `sc` filter scenario.

## 2. Role files (role-editor)

- [x] 2.1 Add `setFrontmatterKey(text, key, value | null)` to `agent-defs.ts` (design D4). Verify with `test/agent-defs.test.ts` (new) cases: replace in place, append before the closing `---`, delete, CRLF file, and body bytes unchanged.
- [x] 2.2 Add `listRoles(cwd, agentDir)`: one row per name, winning file by the existing order, source label, the three values; skip files the parser rejects; write nothing. Verify with temp-dir tests for a shadowed built-in, a built-in only role and a project role.
- [x] 2.3 Add `writeRoleKey` with copy-on-first-edit of a built-in role to `<agentDir>/agents/<name>.md` and an atomic temp-file-and-rename write. Verify with tests: built-in edit makes a user copy and leaves the package file unchanged, second edit changes only the copy, project file edited in place.
- [x] 2.4 Add the model-list parser for `pi --list-models` output (design D5): skip the header, build `provider/model`, report a non-zero exit or empty list as an error. Verify with tests on captured output and on a failing command.

## 3. Role editor dialog and commands (role-editor)

- [x] 3.1 Add `cli.ts roles` (outer) and `roles --inner` (inner): role list, key choice, value list (models, thinking levels, remove), the "edits create a user copy" confirm for a built-in role, and the write. Pass `--cwd`, `--agent-dir` and `--pane` as arguments. Verify with `test/cli.test.ts` cases for the argv the outer side sends to `openPopup` (including `-e PI_CODING_AGENT_DIR=<agent dir>`, `-e PATH=<caller PATH>`, and `-e VISUAL`/`EDITOR`/`PAGER` only when the caller's env sets them, design D1), and for an inner run with injected keys that edits a temp role file.
- [x] 3.2 Register `/pmux-roles` in `index.ts` (design D9), with the tmux refusal and the result line through `ctx.ui.notify`. Verify with a test that the command is registered and refuses outside tmux.
- [x] 3.3 Add `skills/pmux-roles/SKILL.md` (design D7) and verify that `node skills/pmux/launch.ts roles` with `TMUX_PANE` unset exits with the tmux refusal through the shim.

## 4. Spawn dialog and commands (spawn-dialog)

- [x] 4.1 Add `cli.ts spawn-dialog` (outer) and `spawn-dialog --inner` (inner): role step (same rows as `listRoles`), brief step through `$VISUAL`/`$EDITOR`/`vi` into `<scratch>/briefs/`, cancel on an empty brief or an editor error, and the `--args` split for the Claude Code skill (design D7). Verify with tests for the role-given entry, the empty-brief cancel, the unknown-role refusal before any popup, and, through `--args`, the role-only entry and the task-text refusal before any popup.
- [x] 4.2 On the Claude Code path, make the inner side call the `start` path after the brief step (design D6), with `--report send`, `--name <role>`, `--role <role>`, `--cwd`, `--brief` and `--parent <--pane value>`, with `TMUX_PANE` also set to the `--pane` value, and write the result line to the state file; the outer side prints it, or the "still open" line after its limit. Verify with a `test/cli.test.ts` case that the launch spec carries `PI_PMUX_REPORT_PROTOCOL=file-ack-v1`, and that `spec.parent` and the caller pane both equal the `--pane` value even when the popup env holds a different `TMUX_PANE`.
- [x] 4.3 Change the pi `/pmux-spawn` handler: no args opens the dialog at the role list, a role opens it at the brief step, a role and a task start at once; each start calls `supervisor.spawn` like `pmux_spawn` and sends no user message. Verify with tests on a fake supervisor that `sendUserMessage` is never called and `spawn` gets `{ name, task, agent }`.
- [x] 4.4 Add `skills/pmux-spawn/SKILL.md`, whose body passes `'$ARGUMENTS'` as `--args` (design D7), and note the **BREAKING** `/pmux-spawn` change in `README.md`. Verify the README text by reading it.

## 5. Report history and viewer (report-viewer)

- [ ] 5.1 Add `report-history.ts` (design D8): `historyDirPath` on the inbox hash under `pmux-history`, `writeHistoryRecord` (temp file and rename, owner-only dir), `listHistory` newest first, `pruneHistory`. Verify with `test/report-history.test.ts`, including the "same key as the inbox" scenario.
- [ ] 5.2 Make `registerReport` take `from` and `env` and write the history record after a successful registration, dropping any error; update the `send` and run-wrapper callers. Verify with `test/report-delivery.test.ts` and `test/run.test.ts` cases: a record exists after `send` and after a wake row, delivery still succeeds when the history dir is unwritable, and `ack` leaves the record.
- [ ] 5.3 Add history pruning to `cli.ts prune` and its output. Verify with `test/prune.test.ts` cases for old and recent records and an empty directory.
- [ ] 5.4 Add `cli.ts reports` (outer) and `reports --inner` (inner): the list with sender, time and ack state from `readReportLog`, "missing" for a gone file, "no reports" for an empty history, and `$PAGER`/`less` on Enter, back to the list after. Verify with tests that the list order and ack marks are right and that reading writes no `ack` record.
- [ ] 5.5 Register `/pmux-reports` in `index.ts` and add `skills/pmux-reports/SKILL.md`. Verify the command is registered and refuses outside tmux.

## 6. Claude Code host check and docs

- [ ] 6.1 Write the three `SKILL.md` bodies to the host facts in design D7: use `${CLAUDE_SKILL_DIR}` in the `!` command, quote `$ARGUMENTS` with single quotes, and print each refusal on a non-zero exit; make the `!` command one `node` invocation with no shell operator, with an `allowed-tools` rule that matches its exact text, quotes included; and add `!./skills/pmux-roles`, `!./skills/pmux-spawn` and `!./skills/pmux-reports` to `package.json` `pi.skills`. Verify by reading the three files and `package.json` against D7.
- [ ] 6.2 Document the three commands, the copy-on-edit rule and the history in `README.md` and `docs/guide.md`, and add the three skills to `skills/pmux/SKILL.md` only where the user starts them. Verify by reading the changed sections.
- [ ] 6.3 Run `pnpm run format:check`, `pnpm run lint`, `pnpm run typecheck` and `pnpm test`, and verify all four pass.

## Workflow follow-up

- The user runs the live checks in tmux: each dialog opens, Escape cancels, a role edit changes the file, a spawned child reports to the orchestrator, and the viewer shows an acknowledged report, and, from the Claude Code skill, a dialog left open past two minutes still prints "still open" and still does its action.
- Archive the change after review, and add the **BREAKING** `/pmux-spawn` note to the release changelog.
