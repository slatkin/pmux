# Subagent Completion

## Purpose

Defines how a sub-agent session reliably reaches completion: explicit `pmux_done` / `caller_ping`, restored child-side auto-exit for `auto-exit: true` agents, and a child-side completion nudge for sessions that remain open.

## Requirements

### Requirement: Explicit exit only
A sub-agent session SHALL end its run when the child calls the `pmux_done` tool or the `caller_ping` tool. `pmux_done` writes the `done` `.exit` sidecar, or the `handoff` sidecar when it is called with a `handoff` (see "Handoff exit"). Additionally, when the session runs with auto-exit active (`PI_PMUX_AUTO_EXIT=1`, set from `auto-exit: true` agent frontmatter), the latest assistant message of the ending turn does not carry `stopReason: "aborted"`, and the user has not taken over the session, the child extension SHALL write the `done` `.exit` sidecar from the `agent_end` event so the session exits automatically. The `auto-exit` frontmatter field and the `PI_PMUX_AUTO_EXIT` environment variable SHALL continue to drive the `interactive` default and the task hint wording.

#### Scenario: Auto-exit agent finishes its turn
- **WHEN** a sub-agent with `auto-exit: true` finishes a turn normally without calling `pmux_done`
- **THEN** the child writes the `done` `.exit` sidecar and the session exits, delivering the completion to the parent

#### Scenario: Auto-exit agent aborted mid-turn
- **WHEN** a sub-agent with `auto-exit: true` has its turn end with `stopReason: "aborted"`
- **THEN** the session stays open for inspection or another prompt and no `done` sidecar is written

#### Scenario: Auto-exit agent after user takeover
- **WHEN** the user has sent input to the sub-agent after its first agent run started, and the agent then finishes a turn normally
- **THEN** the session stays open and the completion nudge path applies instead of auto-exit

#### Scenario: Non-auto-exit agent finishes its turn
- **WHEN** a sub-agent without `auto-exit` finishes a turn normally without calling `pmux_done`
- **THEN** the session stays open and the completion nudge is scheduled

#### Scenario: Explicit exit
- **WHEN** the child calls `pmux_done`
- **THEN** the session exits and the parent receives the completion as before

#### Scenario: Explicit exit with handoff
- **WHEN** the child calls `pmux_done` with a `handoff`
- **THEN** the session exits with the `handoff` sidecar instead of the `done` sidecar

### Requirement: Error exit is preserved
When a sub-agent's turn ends with the latest assistant message carrying `stopReason: "error"`, the child extension SHALL still write the error `.exit` sidecar so the parent learns about the provider failure promptly — including auto-exit agents, whose normal-completion exit path does not apply to error turns.

#### Scenario: Provider error ends the turn
- **WHEN** the child's latest assistant message ends with `stopReason: "error"` (e.g. auto-retry exhausted)
- **THEN** the child writes the error `.exit` sidecar and the parent is woken with the failure

### Requirement: Completion nudge after a normal stop
When a sub-agent session remains open after a turn ends normally (the latest assistant message has `stopReason: "stop"`) — a non-auto-exit session, or an auto-exit session the user has taken over — and `pmux_done` has not been called, the child extension SHALL schedule a nudge: a follow-up message reminding the agent to call `pmux_done`, or `caller_ping` if it is spinning in place. The nudge SHALL be delivered after a delay (default 5 seconds, configurable via `PI_PMUX_NUDGE_DELAY_MS` with a 1-second minimum, disable entirely with `PI_PMUX_NUDGE_DISABLE=1`). Provider-error and aborted stops SHALL NOT schedule a nudge. The reminder text SHALL live in one module, `pi-extension/pmux/nudge.ts`, and the parent-side idle watchdog SHALL type that same text, so the two copies cannot drift apart.

#### Scenario: Model forgets to call luvus_done
- **WHEN** a non-auto-exit child finishes a turn normally without calling `pmux_done` and stays idle for the nudge delay
- **THEN** the child receives a follow-up message reminding it to call `pmux_done` (or `caller_ping` when spinning in place)

#### Scenario: Auto-exit session exits before any nudge
- **WHEN** an auto-exit session (not user-taken-over) finishes its turn normally
- **THEN** the session exits with the `done` sidecar and no nudge is scheduled

#### Scenario: Error stop does not nudge
- **WHEN** the child's turn ends with `stopReason: "error"`
- **THEN** no nudge is scheduled

#### Scenario: One reminder text
- **WHEN** the child extension nudges a session and the parent-side idle watchdog types into a stalled child's pane
- **THEN** both send the text held in `pi-extension/pmux/nudge.ts`

### Requirement: Nudge cancellation
A pending nudge SHALL be cancelled when the child calls `pmux_done` or `caller_ping`, when the user sends input, when a new agent generation cycle starts, or when the session shuts down. Input that arrives after the first agent run has started SHALL additionally mark the session as user-taken-over.

#### Scenario: User takes over
- **WHEN** the user types into the sub-agent pane after the first agent run has started and a nudge is pending
- **THEN** the pending nudge is cancelled and the session stays open for the user

#### Scenario: Agent resumes work
- **WHEN** a new agent generation cycle starts while a nudge is pending
- **THEN** the pending nudge is cancelled

### Requirement: Handoff exit
`pmux_done` SHALL accept an optional `handoff` string. When `handoff` is present and holds non-whitespace text, the tool SHALL write the terminal status `done` to the status file, write `{"type":"handoff","message":"<handoff>"}` to the `.exit` sidecar, and shut the session down. When `handoff` is absent, the tool SHALL behave as before and write `{"type":"done"}`. When `handoff` is present but empty or whitespace only, the tool MUST fail with an error and the session MUST stay open.

#### Scenario: Done with handoff
- **WHEN** a child calls `pmux_done` with `handoff` set to `"Goal: X. Done: A. Left: B."`
- **THEN** `<session>.exit` holds `{"type":"handoff","message":"Goal: X. Done: A. Left: B."}`, the status file holds `done`, and the session shuts down

#### Scenario: Done without handoff
- **WHEN** a child calls `pmux_done` with no parameters
- **THEN** `<session>.exit` holds `{"type":"done"}` as before

#### Scenario: Empty handoff
- **WHEN** a child calls `pmux_done` with `handoff` set to `"  "`
- **THEN** the tool returns an error, no sidecar is written, and the session stays open

### Requirement: Pi parent receives a handoff
When a pi parent reads a child's `.exit` sidecar with `type` `handoff`, it SHALL end the child's run with the reason `handoff`, and SHALL deliver one message that triggers a turn. The message SHALL say that the named child handed off, SHALL contain the handoff text and the child's session file, and SHALL tell the parent to start a new subagent and not to resume the session.

#### Scenario: Handoff delivered to the parent
- **WHEN** a pi parent's child exits with a `handoff` sidecar
- **THEN** the parent gets a message that names the child, holds the handoff text and the session file, says to start a new subagent and not to resume, and starts a parent turn

#### Scenario: Handoff without text
- **WHEN** the sidecar is `{"type":"handoff"}` with no `message`, or a `message` that is not a non-empty string
- **THEN** the parent gets the handoff message with a placeholder that says the text is missing
