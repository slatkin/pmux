# Design

## Context

The vendored guard escalates inside the child: warning at the class threshold, then at critical the mode acts — `yolo` soft-kills, `guard` aborts. The orchestrator learns of a critical hang through the parent message file (pi parent) or the status file (external), but its only answers are `pmux_interrupt` and inaction. The decision "this silence is legitimate" belongs to the orchestrator; the guard needs an input for it, and time for that input to arrive.

## Decisions

### D1. Marker file is the allow primitive

`<session file>.allow`, siblings with `.interrupt` (`exit-sidecar.ts` holds the path helpers). A file is the right primitive for the same reasons `.interrupt` is: host-independent, works identically for a pi parent and an external orchestrator, consumed by the guard's existing 1 s tick, and leaves an observable filesystem edge for tests.

- Empty file (or unparseable body): exempts every watched execution currently at warning or critical level.
- JSON body `{"toolCallId": "..."}`: exempts only that watched execution, if it is at warning or critical.
- Consume semantics: the tick reads the marker, applies it, and deletes it best-effort. If nothing is at warning/critical — the marker arrived before any hang, or after the action already ran — the file is deleted with no effect. Allow answers a specific notice; it never pre-arms.

### D2. An allowed execution is exempt until the call ends

The engine marks the entry `allowedByParent`. Exempt entries skip measurement and escalation entirely — no levels, no republished hang block, no soft-kill, no abort — until `tool_execution_end` retires the entry. The published `hang` block is retracted (`hangUpdate(undefined)`), so the status and activity files clear and the parent's next poll sees the resolution. The pane gets one notify line ("allowed by parent; the watchdog is ignoring this call").

A later call is guarded fresh, including the same command retried after an abort. This is the user's explicit scope choice: this tool call only.

### D3. Parent-response grace defers the action, not the notification

The critical-level *notification* stays at the threshold — the parent must hear immediately. What defers is the critical-level *action*:

- When `PI_PMUX_SESSION` is set (every pmux child, pi parent and external alike — both can answer through the marker), reaching critical sets `parentAllowDeadline = now + parentAllowGraceSec` (default 90 s, `PI_PMUX_GUARD_ALLOW_GRACE_SEC` override) instead of acting.
- While the deadline is pending, the tick checks for the allow marker each pass. Marker consumed → exempt, no action. Deadline elapsed → perform the mode's action (yolo soft-kill, then the existing soft-kill grace and abort fallback; guard abort).
- Without `PI_PMUX_SESSION` the behavior is exactly today's: the action fires at critical.

Observe mode never acts, so it never defers — nothing changes there. The grace deliberately applies to external children too: their orchestrator learns through the status `hang` field and answers through the same marker file.

### D4. `pmux_allow` mirrors `pmux_interrupt`; the CLI mirrors the file

Parent side: `pmux_allow` takes `id` or `name` like `pmux_interrupt`, resolves the running child through the supervisor, and writes `<child session>.allow` (empty body). It returns a write acknowledgement, not a consumption receipt — the child's tick decides what the marker exempts. The tool description names the use: "let a hung tool call run to completion."

External side: `cli.ts` gains `allow --session <file>`, writing the same empty marker. `skills/pmux/launch.ts` needs no change — it is a shim that forwards argv. The skill doc gains one line under the nudge/interrupt guidance.

### D5. The steering message teaches the move

The critical parent message currently ends "you can pmux_interrupt it or wait." It becomes: name `pmux_allow` to let the call run, `pmux_interrupt` to stop it, or the watchdog acts when the grace elapses. The message should carry the grace duration so the parent knows its deadline.

## Edge cases

- **Allow during the soft-kill fallback window**: once the action has fired, the call is ending; a late marker exempts nothing (D1's no-pre-arm consume drops it).
- **Multiple hung calls**: an empty marker exempts all of them — the notice the parent answered described the session's hang state. A named marker exempts one.
- **Reload**: an in-flight grace survives `/reload` only through the tick's marker poll; the pending deadline is in-memory like every other engine entry. Accepted — a reload mid-grace falls back to the action firing at the next critical re-evaluation, the same exposure any engine state has on reload.
- **Grace and `maxNotificationsPerCall`**: the notification budget is unchanged; deferral adds no extra messages.
