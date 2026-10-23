# Surface Placement

## Purpose

Defines how the subagent surface placement choice (pane, tab or float) is resolved and persisted: a user-set default in `config.json`, a live `/pmux-surface` slash command in the TUI, and the role's `surface:` frontmatter.

## Requirements

### Requirement: Surface placement default in config
The extension SHALL read an optional `surface` key from its package `config.json` (the same file that holds `status.enabled`). The value SHALL be either `"pane"` or `"tab"`. The legacy values `"right"` and `"down"` SHALL be read as `"pane"`. The value `"float"` SHALL be treated as invalid. When the key is absent or invalid, the default SHALL be `"pane"`. When the value is `"tab"`, spawning or resuming a subagent SHALL place the new pane in its own tmux window; otherwise it SHALL place the pane by the tmux-backend split rule. The default applies only when the role names no surface.

#### Scenario: Default set to tab
- **WHEN** `config.json` contains `"surface": "tab"` and a subagent of a role with no `surface:` is spawned
- **THEN** the subagent's pane is placed in its own tmux window and the caller's window regains focus

#### Scenario: Default unset
- **WHEN** `config.json` has no `surface` key or an invalid value and a subagent is spawned
- **THEN** the subagent's pane is placed by the tmux-backend split rule

#### Scenario: Legacy split value
- **WHEN** `config.json` contains `"surface": "down"` or `"surface": "right"`
- **THEN** the default is `pane`, and the split axis comes from the target pane's shape, not from the old value

#### Scenario: Float is not a default
- **WHEN** `config.json` contains `"surface": "float"` and a subagent of a role with no `surface:` is spawned
- **THEN** the default is `pane`, and the subagent's pane is placed by the tmux-backend split rule

### Requirement: Slash command to show and change the default
The extension SHALL register a `/pmux-surface` command. With no argument it SHALL report the current default. With `tab` or `pane` as argument it SHALL set the default, confirm the new value to the user, and persist it to `config.json` so it survives restart. With `right` or `down` it SHALL do the same as with `pane`. With any other argument, `float` included, it SHALL show the current default and the accepted arguments without changing anything.

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

#### Scenario: Float argument
- **WHEN** the user runs `/pmux-surface float`
- **THEN** the current default is reported unchanged, along with the accepted arguments `pane` and `tab`, and `config.json` is not written

### Requirement: Role surface preference
A role file MAY set `surface:` in its frontmatter to `pane`, `tab` or `float`. When a subagent of that role is spawned, the role's value SHALL be used instead of the configured default. An invalid value SHALL be ignored, and the role then has no surface preference. A role without `surface:` SHALL use the configured default.

#### Scenario: Floating role
- **WHEN** the role file of `reviewer` has `surface: float` and `pmux_spawn` starts `reviewer`
- **THEN** the reviewer opens as a float

#### Scenario: Per call beats the role
- **WHEN** the role file of `reviewer` has `surface: float` and the call carries a stray `surface: "pane"` parameter
- **THEN** the value is ignored, and the reviewer opens as a float

#### Scenario: Role beats the default
- **WHEN** the role file of `worker` has `surface: pane`, the default is `tab`, and `pmux_spawn` starts `worker`
- **THEN** the worker is placed by the tmux-backend split rule, not in a tab

#### Scenario: Invalid role value
- **WHEN** the role file has `surface: window`
- **THEN** the role has no surface preference, and the configured default applies

#### Scenario: No role
- **WHEN** `pmux_spawn` is called without an agent
- **THEN** the configured default applies

### Requirement: No per-call surface parameter
The `pmux_spawn` and `pmux_resume` tools SHALL NOT declare a `surface` parameter, and their descriptions SHALL NOT name a surface value or ask the agent to choose a placement. A subagent's surface SHALL come from the role's `surface:` frontmatter when it names `pane`, `tab` or `float`, and from the configured default otherwise. A `surface` value that arrives in a call anyway SHALL be ignored.

#### Scenario: Schema has no surface parameter
- **WHEN** the agent reads the `pmux_spawn` or `pmux_resume` tool schema
- **THEN** the parameter list holds no `surface` entry and no description text names `pane`, `tab` or `float`

#### Scenario: No role uses the default
- **WHEN** `pmux_spawn` is called without an agent and the configured default is `tab`
- **THEN** the subagent opens in its own tmux window
