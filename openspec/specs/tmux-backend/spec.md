# tmux-backend Specification

## Purpose

Lets the extension run subagent panes in tmux, the package's only terminal host, with the same surface API and the same completion protocol.

## Requirements

### Requirement: tmux availability

The extension SHALL treat tmux as available only when `TMUX` and `TMUX_PANE` are both set and non-empty. The caller's own pane id SHALL be `TMUX_PANE`.

#### Scenario: Spawn inside a tmux pane
- **WHEN** `TMUX` and `TMUX_PANE` are set and the Luvus keys are not
- **THEN** the extension accepts the host and the caller's pane id is `TMUX_PANE`

#### Scenario: tmux keys are incomplete
- **WHEN** `TMUX_PANE` is unset
- **THEN** tmux is not available and no pane is created

### Requirement: Subagent panes are split from the caller's own pane

Creating a subagent pane with the `pane` placement SHALL split a target pane in the caller's own window and SHALL NOT take focus. The target SHALL be the newest living pane that this caller created in that window, or the caller's pane (`$TMUX_PANE`) when there is none. The split SHALL be anchored on pane ids, never on the server's most recently used window.

#### Scenario: Split next to the parent
- **WHEN** a subagent is spawned from pane `%3` and `%3` has no living child pane
- **THEN** the new pane is created by splitting `%3` without selecting it, and the caller's pane keeps the focus

#### Scenario: Later child splits the newest child
- **WHEN** pane `%3` created child panes `%5` and then `%7`, both still alive, and a third subagent is spawned from `%3`
- **THEN** the new pane is created by splitting `%7`, and `%3` and `%5` keep their size

#### Scenario: The newest child was closed
- **WHEN** pane `%3` created `%5` and then `%7`, the user closed `%7`, and a subagent is spawned from `%3`
- **THEN** the new pane is created by splitting `%5`

#### Scenario: A child pane left the caller's window
- **WHEN** the newest child pane of `%3` was moved to another window
- **THEN** that pane is not a target, and the split goes to the newest child pane still in the caller's window, or to `%3`

#### Scenario: Children of a child are not the parent's targets
- **WHEN** child pane `%5` spawned its own child `%8`, and pane `%3` then spawns a subagent
- **THEN** the target for `%3` is chosen only from the panes that `%3` created

#### Scenario: Another client is on another window
- **WHEN** a second client is attached to another window of the same server
- **THEN** the new pane still opens in the caller's own window

#### Scenario: Tab placement
- **WHEN** the placement is `tab`
- **THEN** a new window is opened in the caller's session and the focus is returned to the caller's window

### Requirement: Pane commands

The extension SHALL deliver a launch command to a pane as literal text followed by an Enter keypress, SHALL read the visible pane contents, SHALL send one Escape keypress to interrupt a child, and SHALL close a pane when the subagent ends.

#### Scenario: Launch a child
- **WHEN** the parent runs the launch command in a new pane
- **THEN** the command is sent to that pane as literal text and submitted

#### Scenario: Read the child back
- **WHEN** the parent reads a pane
- **THEN** the visible contents of that pane are returned

#### Scenario: The pane is already gone
- **WHEN** the extension closes a pane that no longer exists
- **THEN** the close succeeds without raising an error

### Requirement: Named agent panes

A pane SHALL be named after its subagent, and the name SHALL be the pane's title. Delivering a message to a named agent SHALL reach the pane that carries that title.

#### Scenario: Wake a named agent
- **WHEN** the extension sends a message to the agent named `Scout`
- **THEN** the text is delivered to the pane titled `Scout`

#### Scenario: The name is unknown
- **WHEN** no pane carries the requested name
- **THEN** the call fails with an error naming the agent

### Requirement: Exit detection

The extension SHALL end the wait for a subagent on the `.exit` sidecar and SHALL fall back to the terminal sentinel when the sidecar is absent. A sentinel match SHALL count only when the pane is gone, because a live pane may show the pattern as echo.

#### Scenario: The child finished cleanly
- **WHEN** the child writes a `done` sidecar
- **THEN** the wait ends with the `done` result and the sidecar is removed

#### Scenario: The child died without a sidecar
- **WHEN** the pane shows the exit sentinel and the pane is gone
- **THEN** the wait ends with the sentinel exit code

#### Scenario: The pattern is only echo
- **WHEN** the pane shows the exit sentinel and the pane is still alive
- **THEN** the wait continues

### Requirement: Split axis follows the target pane's shape

For a `pane` placement, the extension SHALL read the target pane's width and height in cells just before the split. It SHALL split side by side when the width is at least twice the height, and SHALL stack the new pane below the target otherwise. The caller SHALL NOT choose the axis.

#### Scenario: Wide target
- **WHEN** the target pane is 200 columns by 50 rows
- **THEN** the new pane opens to the right of the target

#### Scenario: Tall target
- **WHEN** the target pane is 49 columns by 50 rows
- **THEN** the new pane opens below the target

#### Scenario: Exact ratio
- **WHEN** the target pane is 100 columns by 50 rows
- **THEN** the new pane opens to the right of the target

#### Scenario: Shape after a pane closed
- **WHEN** the user closed a pane and tmux gave its space to the target, so the target is now 49 columns by 50 rows
- **THEN** the next split stacks the new pane below the target

### Requirement: No re-tiling of existing panes

Creating a subagent pane SHALL change only the target pane, which is split in two. It SHALL NOT apply a window layout, swap panes, or move or resize any other pane.

#### Scenario: The user's own panes stay put
- **WHEN** the caller's window also holds panes that the user opened, and a subagent is spawned
- **THEN** those panes keep their position and size
