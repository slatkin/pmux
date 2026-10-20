# Spec Delta

## Purpose

Messages keep their routing and change their delivery: the text is typed into the target pane through tmux.

## REMOVED Requirements

### Requirement: Delivery failures are reported, not retried

**Reason**: It named Luvus error codes such as `agent_not_ready`. tmux does not report whether a target is ready for input. The replacement is "Delivery failure is reported, not retried" below.

**Migration**: A failed delivery is reported with the tmux error text. A target on an approval screen receives the text as typed input.

## RENAMED Requirements

- FROM: `### Requirement: Message delivery through Luvus`
- TO: `### Requirement: Message delivery through the target pane`

## MODIFIED Requirements

### Requirement: Message tool
Every pi agent running this extension inside a tmux pane SHALL have a `pmux_message` tool with parameters `to` (target name) and `message` (non-empty text). The tool MUST validate both parameters and reject an empty `message` without sending anything.

#### Scenario: Empty message
- **WHEN** `pmux_message` is called with `to: "parent"` and `message: ""`
- **THEN** the tool returns an error and nothing is delivered

### Requirement: Reachable targets
A sender SHALL be able to address exactly these targets:
- `parent`: the agent that spawned the sender (only when the sender is a subagent);
- the name of one of the sender's own running children;
- the name of a running sibling (another running child of the sender's parent), excluding the sender itself.

No other agent SHALL be reachable, whether a grandchild, grandparent, finished subagent, or unrelated agent. When `to` matches no reachable target, the tool MUST return an error that lists the currently reachable target names. When a name matches more than one running agent, the tool MUST return an error listing the matches with their ids and send nothing. A target given as an exact subagent id MUST resolve without ambiguity.

#### Scenario: Parent redirects a running child
- **WHEN** a parent with a running child "Scout" calls `pmux_message({to: "Scout", message: "Skip the tests dir"})`
- **THEN** Scout's pane receives the message while Scout keeps running

#### Scenario: Child asks the parent without exiting
- **WHEN** subagent "Worker" calls `pmux_message({to: "parent", message: "Which DB driver?"})`
- **THEN** the parent's pane receives the message and Worker's session stays open

#### Scenario: Sibling handoff
- **WHEN** "Worker" and "Reviewer" are running children of the same parent and Worker sends to "Reviewer"
- **THEN** Reviewer's pane receives the message

#### Scenario: Unknown or finished target
- **WHEN** a child sends to "Scout" after Scout has finished
- **THEN** the tool returns an error listing the reachable targets (for example `parent, Reviewer`) and sends nothing

#### Scenario: Top-level agent addresses parent
- **WHEN** a pi agent that is not a subagent sends to `parent`
- **THEN** the tool returns an error saying this agent has no parent

### Requirement: Message delivery through the target pane

Messages to a child or sibling SHALL be delivered by resolving the target to its tmux pane id and sending the text to that pane as literal input (`send-keys -l`), followed by an Enter keypress, without a shell. The extension MUST NOT address the target by pane title. The tool SHALL return as soon as both keys are sent, and its result MUST state that delivery is asynchronous and any reply will arrive as a separate message. The extension cannot tell whether the target is ready for input, so the text is typed as it is.

#### Scenario: Queued
- **WHEN** tmux accepts the text and the Enter keypress
- **THEN** the tool returns success with the target name and pane id, and does not wait for the target to act

#### Scenario: The message reaches the pane
- **WHEN** a parent sends a message to a running child
- **THEN** the text appears in the child's pane and the child keeps running

### Requirement: Messages to the parent bypass the parent's composer
Messages to `parent` MUST NOT be typed into the parent's pane. The sender SHALL append each one to a message file tied to its own subagent session. The parent SHALL pick it up while it is watching that child and inject it into its own conversation as a steering message that triggers a turn, the way it already surfaces child completions. Before handling a child's completion, the parent SHALL deliver all of that child's pending messages. If the message file cannot be written, the tool MUST return an error.

#### Scenario: Parent has an unsent draft
- **WHEN** the user has typed an unsent draft in the parent's composer and a child sends to `parent`
- **THEN** the draft is left untouched and unsent, and the message appears in the parent's conversation with its sender header

#### Scenario: Message right before exit
- **WHEN** a child sends to `parent` and immediately calls `pmux_done`
- **THEN** the parent receives the message before the child's completion result

### Requirement: Agents are told about messaging
A pi subagent's launch prompt SHALL name the targets it can reach at spawn time (`parent` and the names of currently running siblings) and say that `pmux_message` is for talking without exiting, while `caller_ping` and `pmux_done` end the session. The tool descriptions of `pmux_message`, `caller_ping` and `pmux_done` SHALL state this distinction.

#### Scenario: Launch prompt lists peers
- **WHEN** a parent spawns "Reviewer" while "Worker" is running
- **THEN** Reviewer's launch prompt says it can message `parent` and `Worker` with `pmux_message`

## ADDED Requirements

### Requirement: Delivery failure is reported, not retried

If tmux returns an error, such as an unknown or closed pane, the tool MUST return an error that names the target and holds the tmux error text. It MUST NOT resend automatically.

#### Scenario: The pane is gone
- **WHEN** the target pane no longer exists
- **THEN** the sender is told that the delivery failed, and nothing is retried
