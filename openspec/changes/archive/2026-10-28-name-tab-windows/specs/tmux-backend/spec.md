# Spec Delta

## Purpose

Adds window naming for `tab`-placement surfaces to the tmux backend: the
window pmux opens for a subagent carries the subagent's name instead of the
automatic-rename process name.

## ADDED Requirements

### Requirement: Named tab windows

When a subagent surface is created with the `tab` placement, the extension
SHALL name the new tmux window after the subagent, passing the display name
to `new-window -n` in the same call that creates the window. `pane` and
`float` placements SHALL NOT name any window.

#### Scenario: Tab spawn names the window
- **WHEN** a subagent named `fix-7` is spawned with the `tab` placement
- **THEN** the new window's name is `fix-7`, set by `new-window -n` in the same call that creates it

#### Scenario: The name survives the child's boot
- **WHEN** the child process starts inside the named window and writes its OSC pane title
- **THEN** the window name stays `fix-7`, because tmux disables `automatic-rename` for an explicitly named window, and the pane title is `<name> — <task>` as before

#### Scenario: Resume names the window
- **WHEN** `cli.ts resume` recreates a `tab` surface with the record's name `scout-1`
- **THEN** the new window's name is `scout-1`

#### Scenario: `resume --name` renames the window
- **WHEN** `cli.ts resume --name scout-2` recreates a `tab` surface
- **THEN** the new window's name is `scout-2`, matching the pane title

#### Scenario: Pane and float placements leave windows alone
- **WHEN** a subagent is spawned with the `pane` or `float` placement
- **THEN** no window is renamed: the caller's window keeps its own name
