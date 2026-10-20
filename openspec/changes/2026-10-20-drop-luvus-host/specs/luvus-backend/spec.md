# Spec Delta

## Purpose

The Luvus host is removed; tmux is the only host.

## REMOVED Requirements

### Requirement: Luvus environment is required

**Reason**: The package no longer supports Luvus, so the requirement that a
process run inside a Luvus pane is obsolete. The `pmux-host` spec replaces it
with the tmux requirement.

**Migration**: A process that runs inside a Luvus pane but not inside a tmux
pane can no longer spawn subagents. Luvus runs on tmux, so a Luvus pane that
is a tmux pane keeps working; a Luvus pane that is not one does not.

### Requirement: Luvus binary is invoked by exact path

**Reason**: The Luvus CLI is not invoked any more.

**Migration**: None. The tmux backend runs the `tmux` binary.

### Requirement: Subagent pane creation

**Reason**: The pane creation rules move to the `pmux-host` spec, which
describes the same behaviour for tmux.

**Migration**: The Luvus pane id is replaced by a tmux pane id (`%3`), and
the caller's pane comes from `TMUX_PANE` instead of `LUVUS_PANE_ID`.

### Requirement: Tab placement

**Reason**: The placement rules are host-neutral and stay in `luvus-surface`,
now described for tmux.

**Migration**: A tmux tab is a window; the placement opens a new window in the
caller's session and restores the focus to the caller's window.
