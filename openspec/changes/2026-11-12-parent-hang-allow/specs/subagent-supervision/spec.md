# Spec Delta

## ADDED Requirements

### Requirement: Parent can allow a hung execution

The supervisor SHALL expose a `pmux_allow` tool, taking the running child's `id` or `name` like `pmux_interrupt`. It SHALL write an allow marker at `<child session file>.allow` and return a write acknowledgement only — whether the marker exempts anything is the child's watchdog's call, reported through the child's own surfaces.

#### Scenario: Allow a hung child
- **WHEN** the parent calls `pmux_allow` on a running child whose tool call sits at critical
- **THEN** `<session>.allow` appears next to the child's session file and the tool acknowledges the write

#### Scenario: Unknown child
- **WHEN** `pmux_allow` names no running child
- **THEN** it fails the same way `pmux_interrupt` does
