# Spec Delta

## Purpose

Lets the user see which model each subagent role uses and change a role's `model`, `model-fallback` or `thinking` from a popup, so that model changes for usage windows need no hand edits of role files.

## ADDED Requirements

### Requirement: Role editor commands
pi SHALL provide a `/pmux-roles` command and the package SHALL provide a Claude Code skill `pmux-roles`. Each SHALL open the role editor dialog for the caller's cwd. The skill SHALL NOT be invoked by the model on its own.

#### Scenario: Open from pi
- **WHEN** the user runs `/pmux-roles` in pi inside tmux
- **THEN** the role editor opens in a popup over the pi pane

#### Scenario: Open from Claude Code
- **WHEN** the user runs `/pmux-roles` in Claude Code inside tmux
- **THEN** the role editor opens in a popup over the Claude Code pane

### Requirement: Role list
The role editor SHALL list every role name found in `<cwd>/.pi/agents/`, in `$PI_CODING_AGENT_DIR/agents/` (or `~/.pi/agent/agents/`) and in the package's `agents/`, once per name. For each name it SHALL show the file that wins by the existing resolution order, that file's source (`project`, `user` or `built-in`), and its `model`, `model-fallback` and `thinking` values, or a mark when a value is absent. A file without valid frontmatter SHALL NOT be listed. Listing SHALL write no file.

#### Scenario: Shadowed built-in
- **WHEN** `reviewer.md` exists in `~/.pi/agent/agents/` and in the package's `agents/`
- **THEN** the list shows `reviewer` once, with source `user` and the user file's values

#### Scenario: Built-in only
- **WHEN** `visual-tester.md` exists only in the package's `agents/`
- **THEN** the list shows `visual-tester` with source `built-in`, and no file is created

### Requirement: Editable keys and values
The role editor SHALL edit only the keys `model`, `model-fallback` and `thinking`. A `model` or `model-fallback` value SHALL be chosen from the `provider/model` pairs that `pi --list-models` prints. A `thinking` value SHALL be one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`. Each key SHALL also offer a choice that removes it. When `pi --list-models` fails, the editor SHALL show its error and SHALL NOT offer model values.

#### Scenario: Pick a model
- **WHEN** the user chooses `model` for `worker` and picks `devin/swe-2`
- **THEN** the winning `worker` file holds `model: devin/swe-2`

#### Scenario: Remove a key
- **WHEN** the user chooses `thinking` for `scout` and picks the remove choice
- **THEN** the winning `scout` file holds no `thinking:` line

#### Scenario: Model list unavailable
- **WHEN** `pi --list-models` exits with an error
- **THEN** the editor shows the error, and no role file changes

### Requirement: Frontmatter-only edit
An edit SHALL replace the line of the edited key in place when the key is present, SHALL add `<key>: <value>` as the last frontmatter line when it is absent, and SHALL delete the line when the key is removed. Every other byte of the file SHALL stay the same, including the order of lines, CRLF line endings and the body. The write SHALL replace the file atomically, so a reader sees the old file or the new file.

#### Scenario: Replace in place
- **WHEN** a role file holds `name`, `model: a/x`, `thinking: high` and a body, and the user sets `model` to `b/y`
- **THEN** the file is the same except that the second line is `model: b/y`

#### Scenario: CRLF file
- **WHEN** the edited role file uses CRLF line endings
- **THEN** the new or changed line ends with CRLF, and all other lines are unchanged

#### Scenario: Add an absent key
- **WHEN** a role file has no `model-fallback:` line and the user sets it to `a/z`
- **THEN** `model-fallback: a/z` is the last line before the closing `---`

### Requirement: Physical file edited in place
When the winning file of a role is in `<cwd>/.pi/agents/` or in the user agents directory, the editor SHALL edit that file and SHALL write no other file.

#### Scenario: Project role
- **WHEN** the winning `worker` file is `<cwd>/.pi/agents/worker.md` and the user changes its model
- **THEN** only `<cwd>/.pi/agents/worker.md` changes

### Requirement: Copy on first edit of a built-in role
When the winning file of a role is the package's built-in file, the first edit SHALL copy that file whole to `<user agents directory>/<role>.md`, SHALL apply the edit to the copy, and SHALL leave the built-in file unchanged. The dialog SHALL show that the edit creates a user copy before it writes. After the copy, the role SHALL list with source `user`.

#### Scenario: Edit a built-in role
- **WHEN** `claude-code` resolves only to the package's `agents/claude-code.md` and the user sets its model to `opus-x`
- **THEN** `~/.pi/agent/agents/claude-code.md` exists with the built-in body and `model: opus-x`, and the package file is unchanged

#### Scenario: Second edit uses the copy
- **WHEN** the user edits `claude-code` again after the first edit
- **THEN** only the user copy changes

### Requirement: Edits affect new starts only
A role edit SHALL apply to children started after the edit. A running child SHALL keep its model, and a resumed child SHALL keep the model in its launch record.

#### Scenario: Resume after an edit
- **WHEN** a `worker` child started on `a/x`, the user changes `worker` to `b/y`, and the child is resumed
- **THEN** the resumed child runs on `a/x`
