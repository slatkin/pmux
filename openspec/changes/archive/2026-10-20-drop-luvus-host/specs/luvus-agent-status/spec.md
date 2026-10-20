# Spec Delta

## Purpose

The leased live status is removed. The status file in `pmux-host` replaces it.

## REMOVED Requirements

### Requirement: Status follows the pi session state

**Reason**: The lease is a Luvus daemon feature. The `pmux-host` spec replaces it with a status file next to the child's session file, which the CLI can wait on.

**Migration**: An observer that waited for a terminal status with the Luvus wait command waits with the CLI `wait` command instead. The terminal statuses are `done` and `blocked`, as before. The `working` message that named the running tool is dropped.

### Requirement: Status lease stays alive while pi runs

**Reason**: The lease is a Luvus daemon feature. The `pmux-host` spec replaces it with a status file next to the child's session file, which the CLI can wait on.

**Migration**: An observer that waited for a terminal status with the Luvus wait command waits with the CLI `wait` command instead. The terminal statuses are `done` and `blocked`, as before. The `working` message that named the running tool is dropped.

### Requirement: Working status names the running tool

**Reason**: The lease is a Luvus daemon feature. The `pmux-host` spec replaces it with a status file next to the child's session file, which the CLI can wait on.

**Migration**: An observer that waited for a terminal status with the Luvus wait command waits with the CLI `wait` command instead. The terminal statuses are `done` and `blocked`, as before. The `working` message that named the running tool is dropped.

### Requirement: Non-terminal reports do not block pi

**Reason**: The lease is a Luvus daemon feature. The `pmux-host` spec replaces it with a status file next to the child's session file, which the CLI can wait on.

**Migration**: An observer that waited for a terminal status with the Luvus wait command waits with the CLI `wait` command instead. The terminal statuses are `done` and `blocked`, as before. The `working` message that named the running tool is dropped.

### Requirement: Session id is bound to the pane

**Reason**: The lease is a Luvus daemon feature. The `pmux-host` spec replaces it with a status file next to the child's session file, which the CLI can wait on.

**Migration**: A resume uses the session file path, not a pane binding.
