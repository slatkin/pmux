# Spec Delta

## MODIFIED Requirements

### Requirement: Interrupt sends Escape

`pmux_interrupt` SHALL write the interrupt marker `<session>.interrupt` beside the target subagent's session file, then SHALL send Escape to the subagent's pane through tmux. The marker tells the child that the abort came from the parent, so the child stays open (see `subagent-completion` "User cancel is reported"). A failed marker write SHALL NOT stop the Escape. If the tmux call fails, the tool MUST return an error that names the subagent and gives the tmux error.

#### Scenario: Interrupt a running subagent
- **WHEN** `pmux_interrupt` is called for a running subagent
- **THEN** the interrupt marker exists before its pane receives Escape, the child's current turn is aborted, and the subagent keeps running

#### Scenario: Pane already gone
- **WHEN** the tmux call fails because the pane no longer exists
- **THEN** the tool returns an error of the form `Failed to send Escape to subagent "<name>" via tmux: <message>`
