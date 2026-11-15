# Spec Delta

## MODIFIED Requirements

### Requirement: Dialog result reaches the caller
The command that opened the popup SHALL wait until the dialog ends and SHALL then read the dialog's result: either a completed result or a cancel. The wait SHALL NOT end because of the 5-second limit that other tmux calls use. A dialog that ends without writing a result, for example when the user closes the popup with Escape or `C-c`, SHALL count as a cancel. When the dialog recorded progress before it ended without a result, the caller SHALL receive that progress with the cancel.

#### Scenario: Dialog open longer than five seconds
- **WHEN** the user keeps a dialog open for two minutes in pi and then completes it
- **THEN** the caller receives the completed result

#### Scenario: Popup closed with Escape
- **WHEN** the user closes the popup with Escape before the dialog completes
- **THEN** the caller receives a cancel, and the command changes nothing

#### Scenario: Progress survives a lost popup
- **WHEN** the dialog records progress and the popup is then killed before a result is written
- **THEN** the caller receives a cancel that carries the recorded progress

### Requirement: Dialog keyboard model
A list in a dialog SHALL move its selection with Up and Down, SHALL narrow its items to those whose text contains every space-separated word of the typed filter (case-insensitive), SHALL choose the selected item with Enter, and SHALL cancel the list with Escape. A cancelled list SHALL end the dialog with a cancel, except where the dialog's own spec names the step that the cancel returns to. A dialog SHALL need no program outside Node and tmux, except the user's editor and pager.

#### Scenario: Filter by typing
- **WHEN** a list shows `reviewer`, `scout` and `worker` and the user types `sc`
- **THEN** the list shows only `scout`

#### Scenario: Filter by words
- **WHEN** a list shows `opencode-go/glm-5.3-flash`, `opencode-go/glm-5.3` and `devin/swe-2` and the user types `glm flash`
- **THEN** the list shows only `opencode-go/glm-5.3-flash`

#### Scenario: Escape cancels
- **WHEN** the user presses Escape in a list whose dialog names no return step for it
- **THEN** the dialog ends with a cancel
