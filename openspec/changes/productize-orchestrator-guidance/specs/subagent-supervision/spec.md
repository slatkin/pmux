# Spec Delta

## ADDED Requirements

### Requirement: Unknown role is rejected
When `pmux_spawn` is called with an `agent` value and no role definition of that name resolves, the tool SHALL return an error result naming the role and the paths searched, and SHALL create no pane, write no launch record and start no child. A call without an `agent` value SHALL still launch, as the default agent.

#### Scenario: Misspelled role
- **WHEN** `pmux_spawn` is called with agent `wroker` and no role file named `wroker` exists
- **THEN** the tool result is an error naming `wroker` and the searched paths, and no pane is created

#### Scenario: Omitted role still launches
- **WHEN** `pmux_spawn` is called without an `agent` value
- **THEN** a child launches as the default agent

### Requirement: Spawn result names the effective role
The `pmux_spawn` acknowledgement text and result details SHALL name the role the child runs with: the resolved agent name when `agent` was given, or an explicit statement that the child runs as the default agent when it was not.

#### Scenario: Role given
- **WHEN** `pmux_spawn` starts agent `scout`
- **THEN** the acknowledgement names `scout` as the child's role

#### Scenario: No role given
- **WHEN** `pmux_spawn` starts a child without an `agent` value
- **THEN** the acknowledgement states that the child runs as the default agent

### Requirement: Orchestrator pane titled once
When the extension creates a child's surface, it SHALL title the parent's own pane `<window-name>-orchestrator`, unless the pane already carries the extension's titled marker. The extension SHALL set that marker on the pane when it sets the title, so later launches and a user's own retitle are left alone.

#### Scenario: First launch titles the parent pane
- **WHEN** a parent in a window named `mychange` spawns its first child
- **THEN** the parent's pane is titled `mychange-orchestrator` and carries the titled marker

#### Scenario: Marked pane keeps its title
- **WHEN** a child is launched from a pane that already carries the titled marker
- **THEN** the pane's title is not changed
