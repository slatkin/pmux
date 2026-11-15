# Tasks

## 1. Role file writes and model scope (`agent-defs.ts`)

- [x] 1.1 Add `writeRoleKeys(role, changes, { agentDir })` (design D3): read the source text at save time, fold `setFrontmatterKey` over the changes in the order `model`, `model-fallback`, `thinking`, and write the target with one temp file plus one rename; for a built-in role the target is `<agentDir>/agents/<name>.md`. Remove `writeRoleKey` and move its tests in `test/agent-defs.test.ts` to the new function. Verify with tests for three keys in one write, a removal mixed with sets, a CRLF file, a built-in first save (the package file unchanged, the copy holds the body and every staged key, no copy-only state), and a second save that edits only the copy.
- [x] 1.2 Add `readEnabledModels(cwd, agentDir)` (design D4): `<cwd>/.pi/settings.json` wins when it sets `enabledModels`, else `<agentDir>/settings.json`, else `null`. A missing file, invalid JSON or a non-string-array value counts as unset. Verify with `test/agent-defs.test.ts` cases for each source and each invalid form.
- [x] 1.3 Add the pure `enabledScope(patterns, models)` (design D4): strip a valid `:<level>` suffix, glob (`*`, `?`, `[...]`) or exact match against `provider/model` and the model id, case-insensitive, in pattern order without repeats, skipping entries with no match. Verify with tests that cover the spec scenarios "Glob entry" and "Thinking suffix", a model-id-only entry, a model id that holds a `/`, an unmatched entry and a repeated match.

## 2. Dialog widgets (`dialog-ui.ts`)

- [x] 2.1 Change `filteredItems` to the word filter (design D7): split on spaces, drop empty words, keep items that contain every word. Verify with `test/dialog-ui.test.ts` cases for the spec scenario "Filter by words", a one-word filter that matches as before, and a filter with repeated spaces.
- [x] 2.2 Add the list options for an initial selection and a marked item, and draw the marker in `renderListLines`. Verify with reducer and render tests: the list opens on the given index, the marker shows on the marked item in the filtered view, and filtering still resets the selection to the top.
- [x] 2.3 Add the picker reducer over two item arrays with Tab to swap them (design D2): the filter stays, the selection moves to the marked item or the top, and Tab does nothing when `enabled` is empty. Escape and Enter keep the list's outcomes. Verify with reducer tests for each case in the spec requirements "Model picker" and "Enabled models first".
- [x] 2.4 Add the panel reducer and its renderer (design D2): rows with `file` and `staged`, the changed mark, Up and Down, the wrapping `thinking` cycle on Left, Right and Enter, `d` to stage `null`, Enter to `pick` on a model row only when models exist, `s` to `save`, Escape to `discard`. Draw the title with role and source, the rows with the absent mark and `*`, the footer (copy notice or model-list error), and the key-hint line. Verify with reducer tests for the spec scenarios "Cycle forward", "Wrap back to absent", "Clear a fallback" and "Changed mark after a pick", and with render tests for the marks and the copy notice.
- [x] 2.5 Add the TTY runners for the panel and the picker that follow `chooseFromList` (raw mode, keypress, cursor restore on finish). Verify with `pnpm run typecheck` and a render test of the first draw with a fake output stream.

## 3. Dialog host progress (`dialog-host.ts`)

- [x] 3.1 Add `markDialogProgress(path, lines)` and an optional `progress` field on the `open` record, kept by `readDialogState` only when it is an array of strings; return `{ kind: "cancel", progress }` when the inner pid dies without a final record (design D5). Verify with `test/dialog-host.test.ts` cases: progress written and read back, a malformed `progress` dropped, a dead inner with progress yields a cancel that carries it, and a dead inner without progress yields the plain cancel.

## 4. Role editor loop (`dialog-roles.ts`, `cli.ts`)

- [x] 4.1 Replace `collectRoleEdit` with the editor loop (design D2): role list, then panel, then picker and back; `writeRoleKeys` on `save`; `markDialogProgress` after each save; re-read `listRoles` after each save; Escape in the role list ends the open. Add the `panel` and `pick` deps beside `choose`, read `enabledModels` once per open, and keep `roleRow` and `rolesSizeHints` unchanged. Verify with `pnpm run typecheck`.
- [x] 4.2 Write the result per design D6: `done` with the save lines joined by `; ` when the open saved at least one role, `cancel` when it saved none. In `rolesDialogOuter`, report the progress lines for a cancel that carries progress. Verify with the tests in 4.3.
- [x] 4.3 Rewrite the `cli.ts roles` suite in `test/cli.test.ts` with scripted panel and picker helpers beside `scriptedChoose`. Cover the spec scenarios "Three keys in one save", "Save and return", "Save with nothing staged", "Discard and return", "Two roles in one open", "Escape keeps the value", "Current value selected", "Enabled scope", "No setting", "Edit a built-in role", "Copy notice before the save", "Model list unavailable", "Two saves", "Nothing saved" and "Popup killed after a save". Verify with `node --test test/cli.test.ts`.
- [x] 4.4 Confirm that the spawn dialog and the report viewer keep their flows: their suites in `test/cli.test.ts` pass with only the word filter changed. Verify with `node --test test/cli.test.ts`.

## 5. Docs

- [x] 5.1 Update the role editor section of `docs/guide.md` and the `/pmux-roles` paragraph of `README.md`: the panel, staged edits with `s` and Escape, the thinking cycle, `d`, the picker with `enabledModels` first and Tab, the editor that stays open, the single-write user copy, and the word filter in the dialogs section. Verify by reading the sections against the spec deltas; Prettier does not check `*.md`.
- [x] 5.2 Update `skills/pmux-roles/SKILL.md`: the description and body describe the panel flow and say the result line can name several saves. Verify that the `allowed-tools` line and the `!` command are unchanged with `git diff skills/pmux-roles/SKILL.md`.

## 6. Spec and gates

- [x] 6.1 Run `openspec validate 2026-11-15-role-editor-panel --strict` and fix every reported problem.
- [x] 6.2 Run the pre-commit gates in order: `pnpm run format:check`, `pnpm run lint`, `pnpm run typecheck`, `pnpm test`. Verify that each exits 0.

## Workflow follow-up

- The user runs the live check in tmux: `/pmux-roles` from pi and from Claude Code, one role edited end to end, Tab in the picker, and a second role in the same open.
- Archive the change after review.
