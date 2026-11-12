# Spec Delta

## MODIFIED Requirements

### Requirement: Escalation modes

The watchdog SHALL run in one of three modes: `observe` only reports, `guard` aborts the turn at the critical threshold and delivers a structured report to the agent (bounded automatic resumes), and `yolo` first tries to kill the session's tracked tool child processes so the turn survives with a non-zero exit, falling back to the `guard` abort when the soft kill is unavailable or the grace period elapses.

In a session that is a pmux child (`PI_PMUX_SESSION` set), the critical-level action SHALL be deferred by the parent-response grace — a guard setting, default 90 seconds, overridable through `PI_PMUX_GUARD_ALLOW_GRACE_SEC` — so the orchestrator can answer the critical notification with an allow marker or an interrupt. The notification itself SHALL NOT be deferred. When the grace elapses unanswered, the mode's action fires as above; a consumed allow marker ends the wait with no action. A session without `PI_PMUX_SESSION` SHALL act at the critical threshold with no deferral.

#### Scenario: Observe never interrupts
- **WHEN** an execution crosses the critical threshold in `observe` mode
- **THEN** a warning is reported and the turn continues

#### Scenario: Guard aborts
- **WHEN** an execution crosses the critical threshold in `guard` mode in a session with no pmux parent
- **THEN** the turn is aborted and a structured report naming the command and the measurement is delivered to the agent

#### Scenario: Yolo soft kill
- **WHEN** an execution crosses the critical threshold in `yolo` mode in a session with no pmux parent and the tracked-children kill succeeds
- **THEN** the tool call ends with a non-zero exit, the turn is not aborted, and the agent continues

#### Scenario: Yolo falls back to abort
- **WHEN** the tracked-children kill is unavailable or the command still runs after the grace period
- **THEN** the turn is aborted as in `guard` mode

#### Scenario: Pmux child defers the action
- **WHEN** an execution crosses the critical threshold in a session with `PI_PMUX_SESSION` set
- **THEN** the critical notification is sent at once, and no soft kill or abort runs until the parent-response grace elapses or an allow marker is consumed

#### Scenario: Grace elapses unanswered
- **WHEN** the parent-response grace has elapsed and no allow marker was consumed
- **THEN** the mode's action fires — soft kill in `yolo`, abort in `guard`

## ADDED Requirements

### Requirement: Parent allow

The watchdog SHALL consume an allow marker at `<session file>.allow`, checked on each tick. An empty or unparseable marker SHALL exempt every watched execution currently at warning or critical level; a marker whose JSON body names a `toolCallId` SHALL exempt only that execution. An exempt execution SHALL be ignored — no measurement, level, soft kill or abort — until the tool call ends, and a later execution is watched fresh.

#### Scenario: Allow saves a legitimate long command
- **WHEN** a `yolo` child is in the parent-response grace for a `cargo bench` execution and the parent writes `<session>.allow`
- **THEN** the execution is exempted and no soft kill runs

#### Scenario: Named marker exempts one call
- **WHEN** two executions hang and the marker names one `toolCallId`
- **THEN** only the named execution is exempted

#### Scenario: Retry is watched fresh
- **WHEN** an exempted execution ends and the agent runs the same command again
- **THEN** the new execution is measured and escalated normally

### Requirement: Allow consumption

On consuming a marker the watchdog SHALL delete it (best-effort), retract the exempted executions' `hang` blocks, and report the exemption in the pane. A marker consumed while nothing is at warning or critical SHALL be deleted with no effect: an allow never pre-arms.

#### Scenario: Consumed marker clears the hang state
- **WHEN** an allow marker is consumed
- **THEN** it is deleted, the exempted executions' `hang` blocks clear, and the pane notes the watchdog is ignoring them

#### Scenario: Late marker does nothing
- **WHEN** the marker arrives after the action already fired
- **THEN** it is deleted with no effect

### Requirement: Allow-aware steering message

The critical-level orchestrator message SHALL name the allow move alongside the interrupt and wait options, and SHALL carry the parent-response grace duration so the orchestrator knows its deadline.

#### Scenario: Message names the options
- **WHEN** a pmux child crosses the critical threshold
- **THEN** the parent message offers the allow action, `pmux_interrupt`, and the grace the watchdog waits before acting
