# report-viewer Specification

## Purpose
Lets the user read the reports that children sent to a pane, in a popup pager, also after the orchestrator agent has acknowledged them. It adds a per-pane report history that `ack` does not remove.

## Requirements

### Requirement: History path
pmux SHALL derive the report history of a pane from the tmux socket path and the pane id with the same rule as the report inbox, under the runtime directory name `pmux-history`: `$XDG_RUNTIME_DIR/pmux-history/<h>-<n>`, or `/tmp/pmux-history-<uid>/<h>-<n>`. A writer SHALL create the directory with owner-only permissions when it is missing. When `TMUX` is unset or empty, no history exists.

#### Scenario: Same key as the inbox
- **WHEN** the inbox of pane `%7` is `$XDG_RUNTIME_DIR/pmux-inbox/abc-7`
- **THEN** the history of pane `%7` is `$XDG_RUNTIME_DIR/pmux-history/abc-7`

### Requirement: History record
Each `report` registration addressed to a pane SHALL also write one history record `<id>.json` in that pane's history, through a temporary file and a rename, holding `{"v":1,"id":<id>,"from":<child launch name>,"session":<abs session path>,"report":<abs report path>,"at":<ISO>}`. This SHALL hold for a registration by `send` and for one by the run wrapper. A failed history write SHALL NOT fail or delay the registration or the delivery.

#### Scenario: Send writes a record
- **WHEN** a marked child named `scout` sends a report to pane `%7`
- **THEN** pane `%7`'s history holds a record with the report ID, `from` `scout`, and the report path from the registration

#### Scenario: History write fails
- **WHEN** the history directory cannot be written
- **THEN** the report is registered and delivered as before

### Requirement: History outlives ack
`ack` SHALL NOT remove a history record. `prune` SHALL delete history records past the launcher-file retention, keep records within it, and remove a history directory that holds no record.

#### Scenario: After ack
- **WHEN** the parent acknowledges report `<id>`
- **THEN** the history record for `<id>` still exists

#### Scenario: Prune old records
- **WHEN** `prune` runs and a history record is older than the retention
- **THEN** the record is deleted

### Requirement: Report viewer commands
pi SHALL provide `/pmux-reports` and the package SHALL provide a Claude Code skill `pmux-reports`. The skill SHALL NOT be invoked by the model on its own. Each SHALL read the caller pane's report history before it opens anything. When the history is empty or missing, the command SHALL answer `no reports` and SHALL NOT open a popup. Otherwise the command SHALL open the report viewer for the caller's pane.

#### Scenario: Open the viewer
- **WHEN** the user runs `/pmux-reports` in a pane inside tmux whose history holds at least one report
- **THEN** the report viewer opens in a popup over that pane

#### Scenario: No reports opens nothing
- **WHEN** the user runs `/pmux-reports` in a pane inside tmux whose history is empty or missing
- **THEN** the command answers `no reports` and no popup opens

### Requirement: Report list
The viewer SHALL list the history records of the caller's pane, newest first. Each item SHALL show the sender, the time, and whether the report is acknowledged. A record whose report file no longer exists SHALL show as missing and SHALL NOT open. An empty history SHALL show that there are no reports.

#### Scenario: Acknowledged and pending
- **WHEN** the history holds report A, acknowledged, and a newer report B, not acknowledged
- **THEN** the list shows B first marked pending, then A marked acknowledged

#### Scenario: No reports
- **WHEN** the caller's pane has no history
- **THEN** the viewer shows that there are no reports

### Requirement: Read a report in a pager
Choosing a report SHALL open its report file in the user's pager (`$PAGER`, else `less`) inside the popup. Closing the pager SHALL return to the list. Reading a report SHALL NOT acknowledge it and SHALL NOT change the report log, the inbox or the history.

#### Scenario: Read without ack
- **WHEN** the user opens pending report B and closes the pager
- **THEN** the list shows again, B is still pending, and no `ack` record exists for B
