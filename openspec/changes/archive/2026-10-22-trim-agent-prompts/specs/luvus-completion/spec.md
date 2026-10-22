# Spec Delta

## MODIFIED Requirements

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
