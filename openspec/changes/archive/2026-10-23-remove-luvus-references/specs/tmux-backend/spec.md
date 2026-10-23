# Spec Delta

## MODIFIED Requirements

### Requirement: tmux availability

The extension SHALL treat tmux as available only when `TMUX` and `TMUX_PANE` are both set and non-empty. The caller's own pane id SHALL be `TMUX_PANE`.

#### Scenario: Spawn inside a tmux pane
- **WHEN** `TMUX` and `TMUX_PANE` are set
- **THEN** the extension accepts the host and the caller's pane id is `TMUX_PANE`

#### Scenario: tmux keys are incomplete
- **WHEN** `TMUX_PANE` is unset
- **THEN** tmux is not available and no pane is created
