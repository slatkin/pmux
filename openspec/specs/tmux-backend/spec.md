# tmux-backend Specification

## Purpose

Lets the extension run subagent panes in tmux, the package's only terminal host, with the same surface API and the same completion protocol.

## Requirements

### Requirement: tmux availability

The extension SHALL treat tmux as available only when `TMUX` and `TMUX_PANE` are both set and non-empty. The caller's own pane id SHALL be `TMUX_PANE`.

#### Scenario: Spawn inside a tmux pane
- **WHEN** `TMUX` and `TMUX_PANE` are set
- **THEN** the extension accepts the host and the caller's pane id is `TMUX_PANE`

#### Scenario: tmux keys are incomplete
- **WHEN** `TMUX_PANE` is unset
- **THEN** tmux is not available and no pane is created

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
- **THEN** a new window is opened in the caller's session detached (`-d`), so no client's focus moves: not the caller's, and not a client watching another window

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

#### Scenario: Only the sidebar would keep the window
- **WHEN** the extension closes a pane whose window holds only that pane and sidebar panes
- **THEN** the window is closed instead of the pane, so no empty tab is left behind

#### Scenario: A shared session keeps its last window
- **WHEN** the extension closes a pane whose window holds only that pane and sidebar panes
- **AND** that window is the session's last window and more than one client is attached
- **THEN** only the pane is closed, so the session and its clients stay

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

### Requirement: Verified report input

For send-mode reports the backend SHALL provide a verified pane-input primitive beside the unchanged fire-and-forget one. Given a target pane, a one-line text and a unique token, it SHALL type the text only with the pane out of any mode and the token absent from the visible screen, poll for the token, then issue exactly one Enter. Failure before the Enter reports `not-submitted`; an Enter exception reports `unknown`. It SHALL NEVER send an editing key into the target pane.

#### Scenario: Pane in a mode
- **WHEN** the target pane reports `pane_in_mode` `1`
- **THEN** no capture, no input and no Enter is sent, and the result is `not-submitted`

#### Scenario: Token appears
- **WHEN** the visible pane shows the token after the text is typed
- **THEN** exactly one Enter is sent, and the result reports the submission

#### Scenario: Token never appears
- **WHEN** the token is still absent after the poll deadline
- **THEN** no Enter is sent and the result is `not-submitted`

#### Scenario: Poll bounds
- **WHEN** the token has not yet appeared
- **THEN** the mode and the visible pane contents are polled every 100 ms for up to 2 seconds, and both are rechecked once more before the Enter

#### Scenario: Unsubmitted text is left alone
- **WHEN** a poll refuses after the text was typed
- **THEN** the typed text is left in the target pane as it is, and no editing key clears it

#### Scenario: Pane enters a mode mid-poll
- **WHEN** `pane_in_mode` becomes `1` after the text was typed
- **THEN** no Enter is sent and the result is `not-submitted`

#### Scenario: Enter throws
- **WHEN** the Enter call raises after the token was verified
- **THEN** the result is `unknown` and no second Enter is attempted

#### Scenario: Post-Enter captures do not count
- **WHEN** the Enter has been sent
- **THEN** no later pane capture changes the reported result

#### Scenario: Never edits the target
- **WHEN** any step refuses or fails
- **THEN** no Escape, Ctrl-U or other editing key is ever sent to the target pane

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
