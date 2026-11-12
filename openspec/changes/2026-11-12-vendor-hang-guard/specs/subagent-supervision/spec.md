# Spec Delta

## ADDED Requirements

### Requirement: Gone means the heartbeat stopped

The supervisor SHALL declare a non-interactive child gone only when the child's liveness timestamp — `aliveAt` in the activity file, falling back to `updatedAt` for a child that does not write `aliveAt` — is stale past the gone bound, or when no valid activity snapshot exists for the bound. Event silence alone SHALL NOT count as gone: a child whose `aliveAt` is fresh is alive, however long its last event is old. An interactive child SHALL never be declared gone.

#### Scenario: Quiet tool call is not gone
- **WHEN** a child's `aliveAt` is 10 seconds old and its last event is a `tool_execution_start` five minutes old
- **THEN** the child is not declared gone and no sidecar is written

#### Scenario: Dead child is gone
- **WHEN** a child's `aliveAt` is stale past the gone bound
- **THEN** the supervisor writes the error sidecar naming the staleness, and the run finishes as before

#### Scenario: Legacy child without heartbeat
- **WHEN** a child's activity file carries no `aliveAt` field
- **THEN** `updatedAt` is measured instead

### Requirement: Hang state is surfaced, not punished

When a child's activity file carries a `hang` block, the supervisor SHALL surface it in the child's status — the command class, the measurement and the level — and SHALL NOT finish the child for it. Interrupting a hung turn remains available through `pmux_interrupt`, which aborts the turn inside the child so the tool's process tree is reaped.

#### Scenario: Hung command shown
- **WHEN** a child's activity file holds `hang` with level 2 and a silent `bash` measurement
- **THEN** the child's status shows the hang detail and the run continues

#### Scenario: Interrupt reaps
- **WHEN** the parent calls `pmux_interrupt` on a hung child
- **THEN** the child's turn is aborted by the child itself, so the detached tool processes are killed with it
