## MODIFIED Requirements

### Requirement: Report viewer commands
pi SHALL provide `/pmux-reports` and the package SHALL provide a Claude Code skill `pmux-reports`. The skill SHALL NOT be invoked by the model on its own. Each SHALL read the caller pane's report history before it opens anything. When the history is empty or missing, the command SHALL answer `no reports` and SHALL NOT open a popup. Otherwise the command SHALL open the report viewer for the caller's pane.

#### Scenario: Open the viewer
- **WHEN** the user runs `/pmux-reports` in a pane inside tmux whose history holds at least one report
- **THEN** the report viewer opens in a popup over that pane

#### Scenario: No reports opens nothing
- **WHEN** the user runs `/pmux-reports` in a pane inside tmux whose history is empty or missing
- **THEN** the command answers `no reports` and no popup opens
