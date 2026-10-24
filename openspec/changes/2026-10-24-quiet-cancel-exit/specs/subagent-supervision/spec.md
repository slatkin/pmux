# Spec Delta

## ADDED Requirements

### Requirement: A user cancel ends the run quietly
When the exit poll reads a child's `.exit` sidecar with `type` `cancelled`, the poll SHALL complete with the `cancelled` reason. The supervisor SHALL close the child's pane, SHALL unregister the run, and SHALL NOT send the parent any message for it. A quiet cancel is the only behaviour: no configuration wakes the parent on a cancel.

#### Scenario: Cancel ends the run without a message
- **WHEN** a running child's `.exit` sidecar gains `{"type":"cancelled"}`
- **THEN** the poll completes, the pane is closed, the child is no longer registered, and the parent receives no message and no turn

## REMOVED Requirements

### Requirement: A user cancel notifies the parent without ending the run
**Reason**: A user cancel now ends the child, and a quiet cancel wakes no parent.
**Migration**: None. The `pmux_cancel` message no longer exists; a cancelled run ends without a message (see "A user cancel ends the run quietly").
