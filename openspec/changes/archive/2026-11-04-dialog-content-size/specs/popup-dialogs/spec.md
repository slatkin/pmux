## ADDED Requirements

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
