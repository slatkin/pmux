# Spec Delta

## ADDED Requirements

### Requirement: A user cancel notifies the parent without ending the run
When the exit poll reads a child's `.exit` sidecar with `type` `cancelled`, the poll SHALL NOT complete. The poll consumes the sidecar it reports, so each cancel notifies exactly once. The parent SHALL receive one cancel message per cancel that triggers a turn, carries the child's session file, and carries the child's name, task and agent in its details. The child SHALL remain registered.

#### Scenario: Cancel notifies and keeps watching
- **WHEN** a running child's `.exit` sidecar gains `{"type":"cancelled"}`
- **THEN** the parent gets one cancel message that triggers a turn, the message says the child was cancelled in its pane and that the session is still open, tells the parent to ask the user how to proceed before resuming with `pmux_resume` or spawning a replacement, the child stays registered, and the exit poll continues

#### Scenario: Each cancel notifies once
- **WHEN** the poll has reported a `cancelled` sidecar
- **THEN** that file is consumed and produces no further message, and a later abort writes a new sidecar that notifies again

#### Scenario: Completion after a cancel
- **WHEN** a child whose cancel was reported later writes a `done`, `error`, `handoff` or `ping` sidecar
- **THEN** the run completes exactly as if no cancel had happened
