# Spec Delta

## ADDED Requirements

### Requirement: External allow marker

An external orchestrator SHALL be able to allow a child's hung execution by writing `<session file>.allow` next to the session file; the child's watchdog consumes it under the command-hang-guard parent-allow rule. The CLI SHALL expose `allow --session <file>` writing that marker, so the skill can document one command for the move.

#### Scenario: Orchestrator allows through the CLI
- **WHEN** an external orchestrator runs `allow --session <file>` while the child sits in the parent-response grace
- **THEN** `<session>.allow` is written and the child's hung execution is exempted

#### Scenario: Orchestrator writes the file directly
- **WHEN** anything writes `<session file>.allow` while an execution is at warning or critical
- **THEN** the watchdog treats it identically to a CLI-written marker
