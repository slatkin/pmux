# spawn-dialog Specification

## Purpose
Lets the user start a subagent from a popup, with a role and a brief, without asking the orchestrator agent first. The child reports to the orchestrator pane the same way a child the agent started does.

## Requirements

### Requirement: Spawn commands
pi SHALL provide `/pmux-spawn [<role> [<task>]]` and the package SHALL provide a Claude Code skill `pmux-spawn`. The skill SHALL NOT be invoked by the model on its own. With no role, the command SHALL open the spawn dialog at the role list. With a role and no task, it SHALL open the dialog at the brief step for that role. In pi, with a role and a task, it SHALL start the child with that task and open no popup. The Claude Code skill SHALL take only a role. With text after the role, it SHALL refuse with a message that says the task goes in the brief step, and SHALL open no popup and start nothing.

#### Scenario: No arguments
- **WHEN** the user runs `/pmux-spawn` in pi
- **THEN** the spawn dialog opens at the role list

#### Scenario: Role given
- **WHEN** the user runs `/pmux-spawn scout` in pi
- **THEN** the spawn dialog opens at the brief step for `scout`

#### Scenario: Role and task given
- **WHEN** the user runs `/pmux-spawn scout map the auth module` in pi
- **THEN** a `scout` child starts with the task `map the auth module`, and no popup opens

#### Scenario: Role given in Claude Code
- **WHEN** the user runs `/pmux-spawn scout` in Claude Code
- **THEN** the spawn dialog opens at the brief step for `scout`

#### Scenario: Task text in Claude Code
- **WHEN** the user runs `/pmux-spawn scout map the auth module` in Claude Code
- **THEN** the command refuses with a message that says the task goes in the brief step, and no popup opens and no child starts

### Requirement: Role step
The role step SHALL list the same roles, sources and models as the role editor. A role name given to the command that resolves to no role SHALL be refused with the existing unknown-role message, and nothing SHALL start.

#### Scenario: Unknown role
- **WHEN** the user runs `/pmux-spawn nosuchrole`
- **THEN** the command reports the unknown role, and no popup opens and no child starts

### Requirement: Brief step
The brief step SHALL open the user's editor (`$VISUAL`, else `$EDITOR`, else `vi`) on an empty brief file inside the popup. When the editor exits with a brief that holds only whitespace, or exits with an error, the dialog SHALL cancel and nothing SHALL start.

#### Scenario: Empty brief
- **WHEN** the user saves an empty brief and closes the editor
- **THEN** the dialog cancels, and no child starts

### Requirement: Child starts without the agent
On a completed dialog, the command SHALL start the child itself, in the caller's cwd, with the chosen role and the brief as its task. It SHALL NOT send any message to the orchestrator agent to ask it to start the child, and SHALL NOT tell the agent at launch. In pi the child SHALL start through the same path as `pmux_spawn`. In Claude Code it SHALL start through the same path as the skill's `start` command with `--report send`, with the caller's pane as the parent pane.

#### Scenario: pi start
- **WHEN** the dialog completes with role `scout` in pi
- **THEN** a `scout` child starts through the `pmux_spawn` path, and the pi conversation gets no user message from the command

#### Scenario: Claude Code start
- **WHEN** the dialog completes with role `scout` in a Claude Code pane `%3`
- **THEN** a `scout` child starts in send mode with `%3` as its parent pane

### Requirement: Report goes to the orchestrator
A child started by the spawn command SHALL report to the orchestrator in the caller's pane through the existing delivery for that host: the supervisor's result delivery in pi, and the `file-ack-v1` report protocol in Claude Code.

#### Scenario: Claude Code report
- **WHEN** a `scout` started from the spawn dialog in Claude Code pane `%3` calls `send`
- **THEN** the report is registered and delivered to `%3` exactly as for a child that the agent started

### Requirement: Spawn result line
After a start, the command SHALL show one line that names the child and its pane. After a cancel, it SHALL show that nothing started. When the command stopped waiting before the dialog ended (popup-dialogs, "Dialog outlives a host time limit"), it SHALL show that the dialog is still open, and the child SHALL still start when the dialog completes.

#### Scenario: Started line
- **WHEN** the dialog completes and the child starts in pane `%9`
- **THEN** the command shows one line that names the child and `%9`
