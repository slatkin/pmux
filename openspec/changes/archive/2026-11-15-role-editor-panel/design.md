# Design

## Context

See proposal.md for the motivation and specs/ for the required behavior.

Current state that shapes the approach:

- `dialog-roles.ts` `collectRoleEdit` runs three `chooseFromList` calls (role, key, value), calls `writeRoleKey` once and returns one result line. The inner side then writes `done` and exits, so the popup closes.
- `dialog-ui.ts` holds one widget: a pure reducer `reduceListKey` over `{ items, filter, selected, outcome }` plus a raw-mode renderer. The spawn dialog and the report viewer use the same widget. The tests drive dialogs through an injected `choose` that feeds scripted keys into the reducer (`scriptedChoose` in `test/cli.test.ts`).
- `writeRoleKey` in `agent-defs.ts` applies one key with the pure `setFrontmatterKey`. For a built-in role it first copies the package file to the user agents directory (one rename) and then writes the edit (a second rename).
- The popup runs `node cli.ts roles --inner`, a plain Node process. pi's git install of the package (`~/.pi/agent/git/github.com/slatkin/pmux`) has no `node_modules`, and pi provides pi-tui only to the extension that pi itself loads. The popup therefore cannot import pi-tui.
- pi's `enabledModels` setting (`settings.json`) is a list of patterns with the `--models` format. pi resolves it in `resolveModelScopeFromModels`: globs through minimatch against `provider/id` or the id, an optional `:<thinking>` suffix, and fuzzy matching for plain entries.
- The dialog host's `open` record is `{"state":"open","pid":n}`. `readDialogState` drops other fields. When the inner pid dies without a final record, `runDialog` returns `{ kind: "cancel" }`.

## Goals / Non-Goals

**Goals:**

- Three screens in the role editor (role list, role panel, model picker), each a pure reducer that the tests drive with scripted keys, as the list is now.
- One atomic file write per save, including the first save of a built-in role.
- The spawn dialog and the report viewer keep their flows. They change only through the shared word filter.

**Non-Goals:**

- A general TUI framework. The design adds two fixed screens, not a layout system. This relaxes the earlier popup-dialogs non-goal ("a filtered list and a confirm line, nothing more") by exactly the panel and the picker.
- Mouse input, and model metadata (context size, thinking support) in the picker rows.
- Edits to keys other than `model`, `model-fallback` and `thinking`, bulk edits across roles, and profiles.
- A confirm prompt on a discard.
- Full parity with pi's fuzzy matching of plain `enabledModels` entries (see D4).

## Decisions

### D1. Hand-written screens in `dialog-ui.ts`, not pi-tui

The panel and the picker are new reducers and renderers in `dialog-ui.ts`, built on Node built-ins like the list. pi-tui's `SettingsList` has the right shape (value column, cycling values, submenu), but the popup process cannot resolve pi-tui in an installed package (Context). Vendoring pi-tui would add a copy to keep in step with pi. The reducer pattern also keeps every key path testable without a TTY.

### D2. The editor loop and its screens

```
                +-----------------+
   open ------> |   role list     | --- Esc ---> close: done (saves) / cancel (none)
                +-----------------+
                   |  Enter   ^
                   v          | s (save, re-list) / Esc (discard)
                +-----------------+
                |   role panel    |  Up/Down rows, Left/Right/Enter thinking,
                |  model          |  d clear, s save, Esc discard
                |  model-fallback |
                |  thinking       |
                +-----------------+
                   | Enter on      ^
                   | a model row   | pick (stage) / Esc (no change)
                   v               |
                +-----------------+
                |  model picker   |  list keys + Tab scope toggle
                +-----------------+
```

`dialog-roles.ts` owns the loop. Each screen is a function that takes its items or state and resolves with an outcome. The loop re-reads `listRoles` after every save, so the role list shows new values and a built-in role that became `user`.

The panel's state is `{ rows: [{ key, file, staged }], selected, outcome }`. `file` is the value read from the file when the panel opened, and `staged` is the value that a save writes; both use `null` for absent. A row is changed when `staged !== file`. The outcomes are `pending`, `pick` (with the row's key), `save` and `discard`. The reducer handles Up and Down, Left and Right on the `thinking` row (the wrapping cycle from the spec), Enter (`pick` on a model row when a model list exists, one Right step on the `thinking` row), `d` (stage `null`), `s` and Escape. The panel draws the role name and source as its title, one row per key with a `*` changed mark, the copy notice for a built-in role or the `pi --list-models` error, and a key-hint line.

The picker reuses the list reducer. The list gains two options: an initial selection (the current value's index in the shown items, else 0) and a marked item that the renderer draws with a marker. The picker wraps the list state with two item arrays, `enabled` and `all`, and the active one. Tab swaps the active array, keeps the filter, and moves the selection back to the marked item or the top. When `enabled` is empty, the picker opens on `all` and Tab does nothing.

The loop takes its three screens as injected deps (`choose`, `panel`, `pick`). The defaults are the TTY renderers, and the tests pass scripted versions that feed keys into the reducers, as `scriptedChoose` does now.

*Alternatives:* a grid of roles and keys in one screen (more 2D state, and the user edits one role at a time); a write per field instead of staged edits (rejected in exploration: a half-done change lands on disk).

### D3. One multi-key write

`writeRoleKeys(role, changes, { agentDir })` replaces `writeRoleKey`. `changes` maps keys to a value or `null`. It reads the source text (the built-in file for a `built-in` role, else the winning file), folds `setFrontmatterKey` over the changes in the fixed order `model`, `model-fallback`, `thinking`, and writes the target through one temp file in the target's directory plus one rename. For a built-in role, the target is `<agentDir>/agents/<name>.md`, created with its directory. The separate copy rename goes away, so a reader never sees a copy without the edit.

The save reads the file at save time, not at panel-open time. A key that the user did not stage keeps whatever the file holds then, and an edit made by hand while the panel was open survives.

`dialog-roles.ts` is the only caller of `writeRoleKey`, so the old function is removed and its tests move to `writeRoleKeys`.

### D4. Reading `enabledModels`

`readEnabledModels(cwd, agentDir)` returns the setting's list from `<cwd>/.pi/settings.json` when that file sets the key, else from `<agentDir>/settings.json`, else `null`. A missing, unreadable or invalid JSON file, or a value that is not an array of strings, counts as not setting the key.

The pure `enabledScope(patterns, models)` resolves the list against the `provider/model` strings from `listModels`, in pattern order and without repeats:

- It strips a trailing `:<level>` when `<level>` is one of the seven thinking levels.
- A pattern with `*`, `?` or `[` becomes a case-insensitive anchored regex (`*` to `.*`, `?` to `.`, a `[...]` class kept, every other character escaped). It matches against `provider/model` and against the model id, which is the part after the first `/`.
- Any other pattern matches a model whose `provider/model` or model id equals it, case-insensitive.

pi also matches plain entries fuzzily. pmux does not: an entry that pi resolves only by its fuzzy match is skipped here, and the user can still reach that model with Tab. Exact and glob entries, the forms in use, give the same set as pi.

### D5. Save progress in the `open` record

The `open` record gains an optional `progress: string[]`. `markDialogProgress(path, lines)` rewrites `{"state":"open","pid":n,"progress":[...]}` after each save, with the same whole-file replace as the other records. `readDialogState` keeps `progress` when it is an array of strings. When the inner pid dies without a final record, `runDialog` returns `{ kind: "cancel", progress }`. `rolesDialogOuter` reports the progress lines when they exist, and the "no role file changed" line otherwise. The spawn dialog and the report viewer write no progress, so their cancels do not change.

### D6. The result line

Each save makes one line: `<role>: <key> = <value>, removed <key> (<path>)`, with the changed keys in the fixed key order. The inner side writes `done` with the save lines joined by `; ` when the open saved at least one role, and `cancel` when it saved none. The existing cancel line ("role editor closed; no role file changed") stays.

### D7. Word filter in the shared list reducer

`filteredItems` splits the filter on spaces, drops empty words and keeps an item that contains every word, case-insensitive. A filter without a space keeps the substring match. The change is in the shared reducer, so the spawn dialog's role step and the report viewer get it as well. Before this change, a typed space matched a literal space. That was useful only for items with double spaces, such as the role rows' `name  [source]`, and the name alone already narrows those rows.

### D8. Popup size

`rolesSizeHints` does not change. The role list is still the tallest known screen. The panel is shorter and narrower than the role rows. Model ids longer than the popup wrap, as they do now. The outer side does not run `pi --list-models`, so it cannot size for the picker.

## Risks / Trade-offs

- [Escape in the panel discards staged changes with no prompt] → The changed marks show what Escape throws away, and the key-hint line names `esc discard`. Each panel holds at most three changes, so a lost set costs little to redo.
- [`enabledModels` matching differs from pi for fuzzy plain entries] → Those entries are skipped and stay reachable through Tab (D4). The picker never hides a model; the scope only puts models first.
- [A role file changes on disk while its panel is open] → The save applies only the staged keys to the file it reads at save time (D3). The panel's shown file values can be stale, but the save writes no stale value.
- [`progress` makes the `open` record larger] → It holds one short line per save, and the outer side reads it only after the inner pid is gone.
- [A lone Escape is slow to register in raw mode] → This is the current readline behavior for every dialog, and the change does not touch it.

## Migration Plan

No data migration. Role files keep their format, and a user copy written before this change is edited in place. The `open` record's new field is optional, and the outer and inner sides always come from the same package version. Rollback is a revert of the change.
