# Spec Delta

## Purpose

Luvus stays a supported terminal host for subagent panes; it is no longer the
only one.

## MODIFIED Requirements

### Requirement: Luvus environment is required

The extension SHALL treat Luvus as available only when `LUVUS_ENV`,
`LUVUS_BIN_PATH` and `LUVUS_PANE_ID` are all set and non-empty. When any of
them is missing, `luvus_spawn` and `luvus_resume` MUST NOT spawn anything
through the Luvus backend.

The extension SHALL accept a supported host when either Luvus is available or
tmux is available. When neither host is available, `luvus_spawn` and
`luvus_resume` MUST NOT spawn anything and MUST return an error result that
tells the user to run pi inside Luvus or inside a tmux pane. No other
terminal backend and no headless fallback SHALL exist.

#### Scenario: Spawn outside Luvus
- **WHEN** `luvus_spawn` is called with `LUVUS_PANE_ID` unset and no tmux pane
- **THEN** the tool returns an error result whose text names both supported hosts, and no pane or process is created

#### Scenario: Spawn inside a tmux pane
- **WHEN** `luvus_spawn` is called with `TMUX` and `TMUX_PANE` set and the Luvus keys unset
- **THEN** the tmux backend opens the pane and the tool reports the new pane id

#### Scenario: Other multiplexer present
- **WHEN** pi runs inside tmux (the `TMUX` variable is set) but the `LUVUS_*` variables are unset
- **THEN** `luvus_spawn` opens the pane through the tmux backend instead of failing
