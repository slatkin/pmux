# Spec Delta

## Purpose

Messages keep their routing and change their delivery: the text is typed
into the target pane.

## MODIFIED Requirements

### Requirement: Message delivery through the target pane

A message SHALL be delivered by sending the text to the target pane as
literal input and submitting it. A delivery that fails SHALL be reported to
the sender and SHALL NOT be retried.

#### Scenario: The message reaches the pane
- **WHEN** a parent sends a message to a running child
- **THEN** the text appears in the child's pane and the child keeps running

#### Scenario: The pane is gone
- **WHEN** the target pane no longer exists
- **THEN** the sender is told that the delivery failed, and nothing is retried

### Requirement: Agents are told about messaging

The extension SHALL tell the agents that they can message their parent, their
children and their siblings, and it SHALL name the tool that does it.

#### Scenario: The child is told about the tool
- **WHEN** a subagent starts
- **THEN** its instructions mention the message tool and the reachable targets
