# Spec Delta

## ADDED Requirements

### Requirement: Spawn requires a known role
`pmux_spawn` SHALL require an `agent` value. When the value is missing, or no role definition of that name resolves, the call SHALL fail with an error that names `agent` or the role and the searched paths, and SHALL create no pane, write no launch record and start no child. Only the role's existence SHALL be checked: a role with no `model:` SHALL still launch, on pi's default model.

#### Scenario: Missing role
- **WHEN** `pmux_spawn` is called without an `agent` value
- **THEN** the call fails with an error that names `agent`, and no pane is created

#### Scenario: Misspelled role
- **WHEN** `pmux_spawn` is called with agent `wroker` and no role file named `wroker` exists
- **THEN** the tool result is an error that names `wroker` and the searched paths, no pane is created, and no launch record is written

#### Scenario: Role without a model
- **WHEN** `pmux_spawn` is called with an agent whose definition sets no `model:`
- **THEN** the child launches, and pi chooses its default model
