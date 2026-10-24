# Spec Delta

## MODIFIED Requirements

### Requirement: Explicit exit only
A sub-agent session SHALL end its run when the child calls the `pmux_done` tool or the `caller_ping` tool. `pmux_done` writes the `done` `.exit` sidecar, or the `handoff` sidecar when it is called with a `handoff` (see "Handoff exit"). Additionally, when the session runs with auto-exit active (`PI_PMUX_AUTO_EXIT=1`, set from `auto-exit: true` agent frontmatter), the latest assistant message of the ending turn does not carry `stopReason: "aborted"`, and the user has not taken over the session, the child extension SHALL write the `done` `.exit` sidecar from the `agent_end` event so the session exits automatically. The `auto-exit` frontmatter field and the `PI_PMUX_AUTO_EXIT` environment variable SHALL continue to drive the `interactive` default and the task hint wording.

#### Scenario: Auto-exit agent finishes its turn
- **WHEN** a sub-agent with `auto-exit: true` finishes a turn normally without calling `pmux_done`
- **THEN** the child writes the `done` `.exit` sidecar and the session exits, delivering the completion to the parent

#### Scenario: Auto-exit agent aborted mid-turn
- **WHEN** a sub-agent with `auto-exit: true` has its turn end with `stopReason: "aborted"`
- **THEN** no `done` sidecar is written; the `cancelled` sidecar is written and the session shuts down (see "User cancel is reported")

#### Scenario: Auto-exit agent after user takeover
- **WHEN** the user has sent input to the sub-agent after its first agent run started, and the agent then finishes a turn normally
- **THEN** the session stays open and the completion nudge path applies instead of auto-exit

#### Scenario: Non-auto-exit agent finishes its turn
- **WHEN** a sub-agent without `auto-exit` finishes a turn normally without calling `pmux_done`
- **THEN** the session stays open and the completion nudge is scheduled

#### Scenario: Explicit exit
- **WHEN** the child calls `pmux_done`
- **THEN** the session exits and the parent receives the completion as before

#### Scenario: Explicit exit with handoff
- **WHEN** the child calls `pmux_done` with a `handoff`
- **THEN** the session exits with the `handoff` sidecar instead of the `done` sidecar

### Requirement: User cancel is reported
When a sub-agent's turn ends because it was aborted (the latest assistant message carries `stopReason: "aborted"`, or the run settles with its abort flag set and no sidecar exists), and no interrupt marker `<session>.interrupt` exists, the child extension SHALL write `{"type":"cancelled"}` to the `.exit` sidecar, SHALL write status `done` with the message `cancelled`, and SHALL shut the session down. When the interrupt marker exists when that aborted run ends, the child extension SHALL remove the marker, SHALL NOT write a sidecar, and the session SHALL stay open. The child extension SHALL remove the interrupt marker on every agent start and every agent end. When a new agent turn starts and the sidecar holds `{"type":"cancelled"}`, the child extension SHALL remove it, and SHALL NOT remove a sidecar holding any other payload on turn start.

#### Scenario: Aborted turn reports the cancel
- **WHEN** the user presses Escape and the child's turn ends with `stopReason: "aborted"`, in an auto-exit or a non-auto-exit session, and no interrupt marker exists
- **THEN** the `.exit` sidecar holds `{"type":"cancelled"}`, the status file holds `done` with message `cancelled`, and the session shuts down

#### Scenario: Parent interrupt keeps the session open
- **WHEN** the child's turn ends with `stopReason: "aborted"` and the interrupt marker exists
- **THEN** the marker is removed, no `.exit` sidecar is written, and the session stays open

#### Scenario: A stale marker does not exempt a later cancel
- **WHEN** the interrupt marker was written while the child was idle, and the child later starts a turn that the user aborts
- **THEN** the marker was removed at the agent start, and the abort ends the session with the `cancelled` sidecar

#### Scenario: The next turn clears the cancel
- **WHEN** a new agent turn starts while the `.exit` sidecar holds `{"type":"cancelled"}`
- **THEN** the sidecar is removed, so a later wait does not see a stale cancel

#### Scenario: A completion sidecar survives a turn start
- **WHEN** a new agent turn starts while the `.exit` sidecar holds `done`, `error`, `handoff` or `ping`
- **THEN** the sidecar is left in place

#### Scenario: Aborted turn does not nudge
- **WHEN** the child's turn ends with `stopReason: "aborted"`
- **THEN** no completion nudge is scheduled for that turn
