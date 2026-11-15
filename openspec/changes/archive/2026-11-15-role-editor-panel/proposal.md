# Proposal

## Why

The role editor (`/pmux-roles`) does one key per open. To set `model`, `model-fallback` and `thinking` on one role, the user goes through the role list, the key list and the value list three times. The value list holds every model that `pi --list-models` prints (559 on the author's machine), and only a plain substring filter narrows it. The user changes one role at a time, but always sets all three values of that role together, so the one-key-per-open flow costs the most exactly where it is used most.

## What Changes

- The role list opens a **role panel** for the chosen role. The panel shows `model`, `model-fallback` and `thinking` with their current values. The user changes any of them, and the changes stay staged until the user saves.
- **Save writes once.** `s` writes all staged changes of the role to its winning file in one atomic write. Escape in the panel discards the staged changes and goes back to the role list.
- **The editor stays open.** After a save or a discard, the role list shows again with the new values, so the user can edit another role. Escape in the role list closes the editor. The result line lists every save of the open.
- **Thinking cycles in place.** Left and Right on the `thinking` row move through the unset mark and the seven levels. `d` on any row stages the removal of that key.
- **Model picker.** Enter on a model row opens a picker that lists the models that `enabledModels` in pi's settings selects first. Tab switches to all models. The current value is marked and selected when the picker opens. Escape returns to the panel and changes nothing.
- **Word filter in every dialog list.** The typed filter splits on spaces, and an item matches when it contains every word (case-insensitive). A filter without a space matches as before. This applies to the spawn dialog and the report viewer too.
- **Built-in copy in one write.** The first save of a built-in role writes the user copy with the staged changes already in it, in one atomic write. The panel shows the copy notice before the save.
- **Saves survive a killed popup.** When the popup ends without a final state after one or more saves, the caller's result line still lists those saves instead of "no role file changed".

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `role-editor`: the key-then-value flow becomes the role panel with staged edits and one save. Adds the model picker with the enabled-models scope, the editor that stays open across roles, and the result line that lists every save. The frontmatter edit and the built-in copy apply several keys in one write.
- `popup-dialogs`: the list filter matches space-separated words, and Escape cancels the current list, with the dialog deciding whether that ends the dialog or goes back one step.

## Impact

- Code: `pi-extension/pmux/dialog-roles.ts` (new flow), `pi-extension/pmux/dialog-ui.ts` (word filter, initial selection, the panel and picker reducers and renderers), `pi-extension/pmux/agent-defs.ts` (a multi-key write, the `enabledModels` reader), `pi-extension/pmux/dialog-host.ts` (save progress in the `open` record).
- Unchanged: the spawn dialog and the report viewer keep their flows. They only get the word filter. `roleRow` and `rolesSizeHints` keep their output.
- Tests: `test/dialog-ui.test.ts`, `test/dialog-host.test.ts`, `test/agent-defs.test.ts`, and the `cli.ts roles` suite in `test/cli.test.ts`.
- Docs: `README.md`, `docs/guide.md` (role editor section) and `skills/pmux-roles/SKILL.md`.
- No new dependency. The popup runs a plain `node` process, and the installed package has no `node_modules`, so pi-tui cannot be used there.
- No change to `pmux-done.ts`, `PI_PMUX_*` or the `.exit` sidecar.
