# Spec Delta

## MODIFIED Requirements

### Requirement: User cancel is reported

When a sub-agent's turn ends because it was aborted (the latest assistant message carries `stopReason: "aborted"`, or the run settles with its abort flag set and no sidecar exists), and no interrupt marker `<session>.interrupt` exists, the child extension SHALL write `{"type":"cancelled"}` to the `.exit` sidecar, SHALL write status `done` with the message `cancelled`, and SHALL shut the session down. When the interrupt marker exists when that aborted run ends, the child extension SHALL remove the marker, SHALL NOT write a sidecar, and the session SHALL stay open. The child extension SHALL remove the interrupt marker on every agent start and every agent end. When a new agent turn starts and the sidecar holds `{"type":"cancelled"}`, the child extension SHALL remove it, and SHALL NOT remove a sidecar holding any other payload on turn start.

When the session shuts down with reason `quit` — Ctrl-C twice, Ctrl-D, `/quit`, or a signal pi handles as a shutdown — the child extension SHALL treat it as the same user cancel, so that the run wrapper never reports it as a crash:

- with no `.exit` sidecar on disk and no terminal payload written by the session, it SHALL write `{"type":"cancelled"}` and status `done` with the message `cancelled`;
- with a terminal payload the session wrote, it SHALL leave that payload's meaning intact, and SHALL write nothing — except for `cancelled`, which it SHALL rewrite, so a notice the parent's poll already consumed is restored;
- with a sidecar on disk that it did not write, it SHALL NOT overwrite it.

A shutdown with reason `reload`, `new`, `resume` or `fork` SHALL write no sidecar: the run continues on the new session file.

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

#### Scenario: A user quit reports the cancel
- **WHEN** the child's session shuts down with reason `quit` and the session wrote no terminal payload
- **THEN** the `.exit` sidecar holds `{"type":"cancelled"}` and the status file holds `done` with message `cancelled`, so the run wrapper writes no crash sidecar

#### Scenario: A completed run is not relabelled by a quit
- **WHEN** the child called `pmux_done`, the parent's poll consumed the `done` sidecar, and the session then shuts down with reason `quit`
- **THEN** no `.exit` sidecar is written

#### Scenario: An existing completion sidecar survives a quit
- **WHEN** the `.exit` sidecar holds `done`, `handoff`, `ping` or `error` when the session shuts down with reason `quit`
- **THEN** the sidecar is left in place

#### Scenario: A session switch writes nothing
- **WHEN** the session shuts down with reason `reload`, `new`, `resume` or `fork`
- **THEN** no `.exit` sidecar is written
