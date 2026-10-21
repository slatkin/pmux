# Subagent Surface

## Purpose

Defines how the subagent surface placement choice (pane or tab) is resolved and persisted: a user-set default in `config.json`, a live `/pmux-surface` slash command in the TUI, and a per-call `surface` tool override.

## Requirements

### Requirement: Surface placement default in config
The extension SHALL read an optional `surface` key from its package `config.json` (the same file that holds `status.enabled`). The value SHALL be either `"pane"` or `"tab"`. The legacy values `"right"` and `"down"` SHALL be read as `"pane"`. When the key is absent or invalid, the default SHALL be `"pane"`. When the value is `"tab"`, spawning or resuming a subagent SHALL place the new pane in its own tmux window; otherwise it SHALL place the pane by the tmux-backend split rule.

#### Scenario: Default set to tab
- **WHEN** `config.json` contains `"surface": "tab"` and a subagent is spawned without a `surface` parameter
- **THEN** the subagent's pane is placed in its own tmux window and the caller's window regains focus

#### Scenario: Default unset
- **WHEN** `config.json` has no `surface` key or an invalid value and a subagent is spawned
- **THEN** the subagent's pane is placed by the tmux-backend split rule

#### Scenario: Legacy split value
- **WHEN** `config.json` contains `"surface": "down"` or `"surface": "right"`
- **THEN** the default is `pane`, and the split axis comes from the target pane's shape, not from the old value

### Requirement: Slash command to show and change the default
The extension SHALL register a `/pmux-surface` command. With no argument it SHALL report the current default. With `tab` or `pane` as argument it SHALL set the default, confirm the new value to the user, and persist it to `config.json` so it survives restart. With `right` or `down` it SHALL do the same as with `pane`. With any other argument it SHALL show the current default and the accepted arguments without changing anything.

#### Scenario: Show current default
- **WHEN** the user runs `/pmux-surface` with no argument
- **THEN** the current default surface is reported

#### Scenario: Change the default
- **WHEN** the user runs `/pmux-surface tab`
- **THEN** the default becomes `tab`, the user sees a confirmation naming the new value, and the value is persisted so it survives a restart

#### Scenario: Legacy argument
- **WHEN** the user runs `/pmux-surface down`
- **THEN** the default becomes `pane`, the confirmation names `pane`, and `config.json` holds `"pane"`

#### Scenario: Invalid argument
- **WHEN** the user runs `/pmux-surface window`
- **THEN** the current default is reported unchanged, along with the accepted arguments `pane` and `tab`

### Requirement: Per-call tool override
The `pmux_spawn` and `pmux_resume` tools SHALL accept an optional `surface` parameter with values `"pane"` and `"tab"`. When present, it SHALL override the configured default for that spawn. When absent, the configured default applies. An invalid `surface` value SHALL be treated as absent. The tool descriptions SHALL NOT ask the agent to choose a split direction.

#### Scenario: Override the default for one spawn
- **WHEN** the default surface is `pane` and `pmux_spawn` is called with `surface: "tab"`
- **THEN** that one subagent opens in its own tab and the default stays `pane` for later spawns

#### Scenario: Invalid override value
- **WHEN** `pmux_spawn` is called with `surface: "window"`
- **THEN** the value is ignored and the configured default applies

#### Scenario: No direction in the tool schema
- **WHEN** the agent reads the `pmux_spawn` or `pmux_resume` tool schema
- **THEN** the `surface` parameter offers only `pane` and `tab`, and no text asks the agent to pick `right` or `down`
