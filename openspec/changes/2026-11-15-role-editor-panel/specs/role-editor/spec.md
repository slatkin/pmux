# Spec Delta

## MODIFIED Requirements

### Requirement: Editable keys and values
The role editor SHALL edit only the keys `model`, `model-fallback` and `thinking`. A `model` or `model-fallback` value SHALL be chosen from the `provider/model` pairs that `pi --list-models` prints. A `thinking` value SHALL be one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`. Each key SHALL also offer a choice that removes it. When `pi --list-models` fails, the editor SHALL show its error and SHALL NOT offer model values; the `thinking` row SHALL stay editable.

#### Scenario: Pick a model
- **WHEN** the user opens `worker`, picks `devin/swe-2` for `model` and saves
- **THEN** the winning `worker` file holds `model: devin/swe-2`

#### Scenario: Remove a key
- **WHEN** the user opens `scout`, stages the removal of `thinking` and saves
- **THEN** the winning `scout` file holds no `thinking:` line

#### Scenario: Model list unavailable
- **WHEN** `pi --list-models` exits with an error
- **THEN** the editor shows the error, Enter on a model row opens no picker, and no role file changes until the user saves a `thinking` change

### Requirement: Frontmatter-only edit
A save SHALL apply each staged key to the frontmatter: it SHALL replace the line of the key in place when the key is present, SHALL add `<key>: <value>` as the last frontmatter line when it is absent, and SHALL delete the line when the key is removed. Every other byte of the file SHALL stay the same, including the order of lines, CRLF line endings and the body. All staged keys of one save SHALL reach the file in one atomic replace, so a reader sees the old file or the new file with every staged key applied.

#### Scenario: Replace in place
- **WHEN** a role file holds `name`, `model: a/x`, `thinking: high` and a body, and the user sets `model` to `b/y` and saves
- **THEN** the file is the same except that the second line is `model: b/y`

#### Scenario: CRLF file
- **WHEN** the edited role file uses CRLF line endings
- **THEN** each new or changed line ends with CRLF, and all other lines are unchanged

#### Scenario: Add an absent key
- **WHEN** a role file has no `model-fallback:` line and the user sets it to `a/z` and saves
- **THEN** `model-fallback: a/z` is the last line before the closing `---`

#### Scenario: Three keys in one save
- **WHEN** the user stages a new `model`, a new `model-fallback` and a new `thinking` for one role and saves
- **THEN** the role file is replaced once, and the new file holds all three values

### Requirement: Copy on first edit of a built-in role
When the winning file of a role is the package's built-in file, the first save SHALL write `<user agents directory>/<role>.md` as the whole built-in file with the staged keys applied, in one atomic write, and SHALL leave the built-in file unchanged. The role panel SHALL show that the save creates a user copy, with the copy's path, before the user saves. After the copy, the role SHALL list with source `user`.

#### Scenario: Edit a built-in role
- **WHEN** `claude-code` resolves only to the package's `agents/claude-code.md` and the user sets its model to `opus-x` and saves
- **THEN** `~/.pi/agent/agents/claude-code.md` exists with the built-in body and `model: opus-x`, and the package file is unchanged

#### Scenario: Copy notice before the save
- **WHEN** the user opens the role panel of a built-in role
- **THEN** the panel shows that a save creates a user copy at `<user agents directory>/<role>.md`, and no file exists there yet

#### Scenario: Second edit uses the copy
- **WHEN** the user edits `claude-code` again after the first save
- **THEN** only the user copy changes

## ADDED Requirements

### Requirement: Role panel
Choosing a role in the role list SHALL open a role panel for that role. The panel SHALL show one row each for `model`, `model-fallback` and `thinking`, with the value that will be saved, or a mark when the key is absent. A row whose value differs from the file SHALL show a changed mark. The panel SHALL show the winning file's source.

#### Scenario: Panel shows current values
- **WHEN** the user chooses `worker`, whose file holds `model: a/x` and no `thinking:` line
- **THEN** the panel shows `model` as `a/x`, `thinking` with the absent mark, and no changed mark

#### Scenario: Changed mark after a pick
- **WHEN** the user picks `b/y` for `model` in the panel
- **THEN** the `model` row shows `b/y` with the changed mark, and the role file is unchanged

### Requirement: Thinking cycles in the panel
On the `thinking` row, Right SHALL stage the next value and Left the previous value, in the order: absent, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. The order SHALL wrap at both ends. A cycle SHALL write no file.

#### Scenario: Cycle forward
- **WHEN** the `thinking` row shows `high` and the user presses Right
- **THEN** the row shows `xhigh` with the changed mark

#### Scenario: Wrap back to absent
- **WHEN** the `thinking` row shows `max` and the user presses Right
- **THEN** the row shows the absent mark

### Requirement: Clear a key in the panel
`d` on a row SHALL stage the removal of that row's key. The row SHALL then show the absent mark, with the changed mark when the file holds the key.

#### Scenario: Clear a fallback
- **WHEN** the file holds `model-fallback: a/z` and the user presses `d` on the `model-fallback` row
- **THEN** the row shows the absent mark with the changed mark, and the file is unchanged

### Requirement: Save writes staged changes
`s` in the role panel SHALL write every staged change of the role in one save and SHALL then return to the role list, which SHALL show the role's new values and source. A save with no staged change SHALL write no file and SHALL return to the role list.

#### Scenario: Save and return
- **WHEN** the user stages a new `model` and a new `thinking` for `worker` and presses `s`
- **THEN** the `worker` file holds both values, and the role list shows them on the `worker` row

#### Scenario: Save with nothing staged
- **WHEN** the user opens a role panel and presses `s` without a change
- **THEN** no file changes, and the role list shows

### Requirement: Escape discards staged changes
Escape in the role panel SHALL discard every staged change of the role, SHALL write no file, and SHALL return to the role list.

#### Scenario: Discard and return
- **WHEN** the user stages a new `model` and presses Escape in the panel
- **THEN** the role file is unchanged, and the role list shows the old value

### Requirement: Editor stays open across roles
After a save or a discard, the role editor SHALL stay open on the role list, so the user can edit more roles in the same open. Escape in the role list SHALL close the editor.

#### Scenario: Two roles in one open
- **WHEN** the user saves a change to `worker`, then opens `scout` and saves a change
- **THEN** both files change, and the editor was opened once

### Requirement: Model picker
Enter on the `model` or `model-fallback` row SHALL open a model picker. Choosing a model SHALL stage it for that row and return to the panel. Escape in the picker SHALL return to the panel with the row unchanged. When the row's value is in the shown list, the picker SHALL mark it and SHALL select it when it opens.

#### Scenario: Pick returns to the panel
- **WHEN** the user picks `devin/swe-2` in the picker for `model-fallback`
- **THEN** the panel shows `model-fallback` as `devin/swe-2` with the changed mark

#### Scenario: Current value selected
- **WHEN** the `model` row holds `devin/swe-2` and the user opens the picker
- **THEN** `devin/swe-2` is marked and selected

#### Scenario: Escape keeps the value
- **WHEN** the user opens the picker and presses Escape
- **THEN** the panel shows the row's value from before the picker

### Requirement: Enabled models first
The model picker SHALL open on the models that pi's `enabledModels` setting selects, in the setting's order. The setting SHALL come from `<cwd>/.pi/settings.json` when that file sets it, else from `<user agent directory>/settings.json`. Tab SHALL switch between the enabled models and all models. When the setting is absent, or selects no listed model, the picker SHALL show all models.

#### Scenario: Enabled scope
- **WHEN** `enabledModels` is `["devin/swe-2", "claude-bridge/claude-opus-5-5"]` and both are listed
- **THEN** the picker opens with only those two models, in that order

#### Scenario: Tab shows all models
- **WHEN** the picker shows the enabled models and the user presses Tab
- **THEN** the picker shows every model that `pi --list-models` printed, and the typed filter stays

#### Scenario: No setting
- **WHEN** neither settings file sets `enabledModels`
- **THEN** the picker opens with all models

### Requirement: Enabled model patterns
An `enabledModels` entry SHALL select the listed models that match it, case-insensitive: an exact `provider/model`, a model id alone, or a glob with `*`, `?` or `[...]` matched against `provider/model` or the model id. A trailing `:<thinking level>` SHALL be ignored for the match. An entry that matches no listed model SHALL be skipped. A model SHALL appear once.

#### Scenario: Glob entry
- **WHEN** an entry is `devin/*` and `pi --list-models` lists `devin/swe-2` and `devin/gpt-6-astra`
- **THEN** the enabled scope holds both models

#### Scenario: Thinking suffix
- **WHEN** an entry is `devin/swe-2:high`
- **THEN** the enabled scope holds `devin/swe-2`

### Requirement: Result line lists every save
When the editor closes, the result line SHALL name each save of the open: the role, each changed key with its new value or its removal, and the written file. When the open saved nothing, the result line SHALL say that no role file changed.

#### Scenario: Two saves
- **WHEN** the user saves `worker` and `scout` and then closes the editor
- **THEN** the result line names both roles, their changed keys and both files

#### Scenario: Nothing saved
- **WHEN** the user closes the editor without a save
- **THEN** the result line says that no role file changed

### Requirement: Saves reported after a lost popup
When the popup ends without a final result after one or more saves, for example because the popup was killed, the caller SHALL report those saves, not that no role file changed.

#### Scenario: Popup killed after a save
- **WHEN** the user saves `worker` and the popup is then killed
- **THEN** the caller's result line names the `worker` save
