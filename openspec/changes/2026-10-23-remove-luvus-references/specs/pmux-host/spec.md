# Spec Delta

## ADDED Requirements

### Requirement: tmux is the required host

The extension SHALL run subagent panes in tmux only. `pmux_spawn`,
`pmux_resume`, `start` and `resume` MUST NOT spawn anything when tmux is not
available as `tmux-backend` defines it. Each MUST return an error that names tmux
as the required host. No other terminal backend and no headless fallback SHALL
exist.

#### Scenario: Spawn outside tmux
- **WHEN** `pmux_spawn` is called with `TMUX_PANE` unset
- **THEN** the tool returns an error result that names tmux, and no pane or process is created

### Requirement: Pane operations call tmux directly

Every pane operation (create, name, run a command, read the pane, send Escape,
close the pane, deliver a prompt, check focus, notify and poll for the exit) SHALL
call the tmux backend directly, with no host dispatch in between.

#### Scenario: A spawn drives tmux
- **WHEN** `TMUX` and `TMUX_PANE` are set and a subagent is spawned
- **THEN** the pane is created and driven through tmux commands only

## REMOVED Requirements

### Requirement: tmux is the only host
**Reason**: Its text and its "Luvus variables alone" scenario name the removed Luvus host. The scenario only stated that the `LUVUS_*` variables have no effect, and no code reads them.
**Migration**: The same rule, without the Luvus sentence and scenario, is the ADDED requirement "tmux is the required host".

### Requirement: One surface API
**Reason**: Its only scenario, "Both host environments are present", names the removed Luvus host.
**Migration**: The same rule, with a scenario that names only tmux, is the ADDED requirement "Pane operations call tmux directly".
