# popup-dialogs Specification

## Purpose
Defines how pmux opens an interactive dialog in a tmux popup over the caller's pane, how the caller gets the dialog's result, and how the dialog fails when no popup can open. The role editor, the spawn dialog and the report viewer use it.

## Requirements

### Requirement: Dialog opens in a popup over the caller's pane
A dialog command SHALL open its dialog with `tmux display-popup -E`, targeted at the caller's pane (`-t` set to `TMUX_PANE`), with a title that names the dialog. The dialog SHALL run in the popup, and the popup SHALL close when the dialog exits. The command SHALL NOT create a pane, a window or a split.

#### Scenario: Popup command shape
- **WHEN** a dialog command runs in pane `%5`
- **THEN** pmux runs one `tmux display-popup` command with `-E`, `-t %5` and `-T` set to the dialog's title, and creates no pane or window

#### Scenario: Popup closes with the dialog
- **WHEN** the dialog inside the popup exits
- **THEN** the popup closes

### Requirement: Dialog result reaches the caller
The command that opened the popup SHALL wait until the dialog ends and SHALL then read the dialog's result: either a completed result or a cancel. The wait SHALL NOT end because of the 5-second limit that other tmux calls use. A dialog that ends without writing a result, for example when the user closes the popup with Escape or `C-c`, SHALL count as a cancel.

#### Scenario: Dialog open longer than five seconds
- **WHEN** the user keeps a dialog open for two minutes in pi and then completes it
- **THEN** the caller receives the completed result

#### Scenario: Popup closed with Escape
- **WHEN** the user closes the popup with Escape before the dialog completes
- **THEN** the caller receives a cancel, and the command changes nothing

### Requirement: Dialog outlives a host time limit
When the host stops the command after a time limit (the Claude Code skill path, with its 2-minute limit), the command SHALL stop waiting before that limit and SHALL report that the dialog is still open. The dialog SHALL stay open and SHALL still do its action when the user completes it.

#### Scenario: Dialog open past the Claude Code limit
- **WHEN** the user keeps a dialog open for three minutes from the Claude Code skill and then completes it
- **THEN** the command reports that the dialog is still open before two minutes pass, and the dialog's edit or start still happens when it completes

### Requirement: Dialog needs a tmux pane
A dialog command SHALL refuse to run when `TMUX` or `TMUX_PANE` is unset, with a message that names tmux, and SHALL change nothing. When `tmux display-popup` fails, for example on tmux older than 3.3, the command SHALL report tmux's error and SHALL change nothing.

#### Scenario: Outside tmux
- **WHEN** a dialog command runs with `TMUX_PANE` unset
- **THEN** it exits with a message that names tmux, and no popup opens and no file is written

#### Scenario: Popup unsupported
- **WHEN** `tmux display-popup` exits with an error
- **THEN** the command reports that error and changes nothing

### Requirement: Dialog keyboard model
A list in a dialog SHALL move its selection with Up and Down, SHALL narrow its items to those whose text contains the typed characters (case-insensitive), SHALL choose the selected item with Enter, and SHALL cancel the dialog with Escape. A dialog SHALL need no program outside Node and tmux, except the user's editor and pager.

#### Scenario: Filter by typing
- **WHEN** a list shows `reviewer`, `scout` and `worker` and the user types `sc`
- **THEN** the list shows only `scout`

#### Scenario: Escape cancels
- **WHEN** the user presses Escape in a list
- **THEN** the dialog ends with a cancel

### Requirement: Dialog size fits the content
A dialog command SHALL size its popup to the dialog's content instead of a fixed share of the terminal: the width SHALL cover the title and the widest row the dialog's outer side knows, plus a margin, and the height SHALL cover the largest known list's lines plus the list chrome. Both SHALL be capped at four fifths of the caller pane's size. A dialog whose hints are unset SHALL keep the `80%` by `80%` popup.

#### Scenario: Narrow content opens a narrow popup
- **WHEN** the widest role row line is 40 cells on a 200-column pane
- **THEN** the popup opens near 42 columns, not 80% of the pane

#### Scenario: Content past the cap
- **WHEN** the content's width exceeds four fifths of the caller pane's width
- **THEN** the popup is four fifths of the pane's width, and longer lines wrap inside it

### Requirement: List rows divide and wrap
A list in a dialog SHALL draw an item on one or more lines when the item holds divided rows, SHALL wrap any drawn line longer than the popup's width, and SHALL highlight every line of the selected item. A list SHALL scroll by display lines, so a divided item stays visible as a whole.

#### Scenario: Long line wraps inside the popup
- **WHEN** a row, the title or the footer is longer than the popup's width
- **THEN** the list wraps it onto following lines, and the selection covers every line of the selected item

#### Scenario: Divided item scrolls as a whole
- **WHEN** the selected item draws on more lines than fit after it and the user presses Down past it
- **THEN** the window moves so the newly selected item shows with all of its lines
