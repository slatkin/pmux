# Spec Delta

## MODIFIED Requirements

### Requirement: Reachable targets
A sender SHALL be able to address exactly these targets:
- `parent`: the agent that spawned the sender (only when the sender is a subagent whose parent is a pi session);
- the name of one of the sender's own running children;
- the name of a running sibling (another running child of the sender's parent), excluding the sender itself.

No other agent SHALL be reachable, whether a grandchild, grandparent, finished subagent, or unrelated agent. A subagent whose parent is an external orchestrator — its launch env carries `PI_PMUX_EXTERNAL_PARENT` — has no `parent` target, because no pi parent reads its message file. When such a sender sends to `parent`, the tool MUST return an error that says the parent is an external orchestrator that does not read subagent messages, names the sender's last assistant message as the report, and names `caller_ping` as the way to ask a question; `parent` MUST NOT appear in the reachable target names the tool lists. When `to` matches no reachable target, the tool MUST return an error that lists the currently reachable target names. When a name matches more than one running agent, the tool MUST return an error listing the matches with their ids and send nothing. A target given as an exact subagent id MUST resolve without ambiguity.

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

#### Scenario: A child with an external parent cannot message the parent
- **WHEN** a subagent whose env carries `PI_PMUX_EXTERNAL_PARENT=1` sends `pmux_message` to `parent`
- **THEN** the tool returns an error naming the external orchestrator, the sender's last assistant message as the report, and `caller_ping` as the way to ask a question, and nothing is appended to any message file

#### Scenario: The reachable list omits parent for a marked child
- **WHEN** a subagent whose env carries `PI_PMUX_EXTERNAL_PARENT=1` sends to a target that matches nothing reachable
- **THEN** the reachable list in the error omits `parent`

### Requirement: Agents are told about messaging
A pi subagent's launch prompt SHALL name the targets it can reach at spawn time (`parent` and the names of currently running siblings) and say that `pmux_message` is for talking without exiting, while `caller_ping` and `pmux_done` end the session. The tool descriptions of `pmux_message`, `caller_ping` and `pmux_done` SHALL state this distinction. The `pmux_message` tool description SHALL state that `parent` is reachable only when the sender has a pi parent.

#### Scenario: Launch prompt lists peers
- **WHEN** a parent spawns "Reviewer" while "Worker" is running
- **THEN** Reviewer's launch prompt says it can message `parent` and `Worker` with `pmux_message`

#### Scenario: The tool description states the parent condition
- **WHEN** an agent reads the `pmux_message` tool description
- **THEN** the description says `parent` is reachable only when a pi parent exists
