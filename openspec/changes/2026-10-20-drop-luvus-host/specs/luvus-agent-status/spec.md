# Spec Delta

## Purpose

The leased live status is removed; a status file replaces it.

## REMOVED Requirements

### Requirement: Agent status is leased on the pane

**Reason**: The lease is a Luvus daemon feature. The `pmux-host` spec
replaces it with a status file next to the child's session file, which the
CLI can wait on.

**Migration**: An observer that waited for a terminal status with
`luvus wait agent-status` waits with the CLI's `wait` command instead. The
states it observes are the same: `working`, `idle`, `done` and `blocked`.

### Requirement: Pi sessions bind to their pane

**Reason**: The binding is part of the Luvus daemon and its resumable
sessions. tmux has no equivalent, and the package does not need one: a
session is resumable by its own session file.

**Migration**: A resume uses the session file path, not a pane binding.
