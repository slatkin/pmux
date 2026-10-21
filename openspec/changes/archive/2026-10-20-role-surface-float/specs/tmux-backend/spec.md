# Spec Delta

## MODIFIED Requirements

### Requirement: Subagent panes are split from the caller's own pane

Creating a subagent pane with the `pane` placement SHALL split a target pane in the caller's own window and SHALL NOT take focus. The target SHALL be the newest living tiled pane that this caller created in that window, or the caller's pane (`$TMUX_PANE`) when there is none. A floating pane SHALL NOT be a target, except the caller's own pane. The split SHALL be anchored on pane ids, never on the server's most recently used window.

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

#### Scenario: A floating child is not a split target
- **WHEN** pane `%3` created tiled child `%5` and then floating child `%7`, and a subagent with the `pane` placement is spawned from `%3`
- **THEN** the new pane is created by splitting `%5`

#### Scenario: Another client is on another window
- **WHEN** a second client is attached to another window of the same server
- **THEN** the new pane still opens in the caller's own window

#### Scenario: Tab placement
- **WHEN** the placement is `tab`
- **THEN** a new window is opened in the caller's session and the focus is returned to the caller's window

## ADDED Requirements

### Requirement: Floating subagent panes

Creating a subagent pane with the `float` placement SHALL open a tmux floating pane in the caller's own window and SHALL NOT take focus. With no other pmux float in that window, the float SHALL be half the window width by half the window height (rounded down, border included), with its top border on row 1 and 2 columns of space between its right border and the window's right edge. The tiled panes SHALL keep their size and position.

#### Scenario: First float on a 200x50 window
- **WHEN** a subagent with the `float` placement is spawned from pane `%3` in a 200x50 window that has no pmux float
- **THEN** a floating pane of 100 by 25 cells (border included) opens with its top-left corner at column 98, row 1, and `%3` keeps the focus

#### Scenario: Tiled panes are not changed
- **WHEN** a float is opened in a window with tiled panes
- **THEN** every tiled pane keeps its size and position

### Requirement: Floats cascade

When the caller's window already holds one or more living floats that pmux opened, a new float SHALL open 1 row lower and 2 columns further left than the newest of them, at that float's current position. If the new float would then go past the bottom or the left edge of the window, it SHALL open at the first-float position. Floating panes that pmux did not open SHALL be ignored. Floats opened by every caller in the window SHALL count.

#### Scenario: Second float
- **WHEN** a pmux float is at column 98, row 1 of a 200x50 window, and another float is spawned
- **THEN** the new float opens at column 96, row 2, on top of the first float

#### Scenario: The newest float was closed
- **WHEN** pmux floats were opened at row 1 and then row 2, the user closed the row-2 float, and another float is spawned
- **THEN** the new float opens at column 96, row 2

#### Scenario: The user moved the newest float
- **WHEN** the user moved the newest pmux float to column 40, row 10, and another float is spawned
- **THEN** the new float opens at column 38, row 11

#### Scenario: No room left
- **WHEN** the next cascade position would put the float's bottom border past the last row of the window
- **THEN** the new float opens at the first-float position

#### Scenario: User float is ignored
- **WHEN** the only floating pane in the window was opened by the user, not by pmux
- **THEN** the new float opens at the first-float position

#### Scenario: Float of another caller
- **WHEN** pane `%3` opened a float, and pane `%4` in the same window then spawns a float
- **THEN** the new float cascades from the float of `%3`

### Requirement: Pane child of a floating caller

When the caller's own pane is floating and it spawns a subagent with the `pane` placement, the extension SHALL split the target as usual. Because tmux turns a split of a floating pane into a new floating pane next to it, the child SHALL then be a float next to its target. The extension SHALL NOT change this.

#### Scenario: Floating reviewer spawns a pane child
- **WHEN** the caller's pane `%7` is floating, has no child, and spawns a subagent with the `pane` placement
- **THEN** the new pane is made by splitting `%7`, and tmux shows it as a float next to `%7`
