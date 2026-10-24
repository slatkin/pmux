# Design

## Context

See proposal.md - Why. The delivery side reuses what report-user-cancel
already built: `pollForExit` consumes a `cancelled` sidecar and calls
`onCancel`, and `deliverSubagentCancel` sends a `pmux_cancel` message with
`{ triggerTurn: true, deliverAs: "steer" }`. The `triggerTurn` flag is the
whole of the wake: pi's `sendCustomMessage` appends a custom message to
the session without starting a turn when `triggerTurn` is false (and, for
a parent that is mid-turn, defers the append to the end of that turn), so
the quiet delivery needs no new mechanism — the same message with a
different option.

The watchdog side is the subtler half. `runIdleWatchdog` has two arms:
`decideGoneAction`, which finishes a child that stopped reporting
entirely, and `decideIdleAction`, which nudges a `waiting` child after
`IDLE_STEP_MS` and finishes it after `IDLE_MAX_NUDGES` unanswered nudges.
A cancelled child sits in `waiting` forever with a live activity file, so
the idle arm fires: the nudge is real text typed into the child's pane,
which starts a new turn — destroying the cancelled state the user
deliberately created — and a `finish` writes a `done` sidecar that
completes the run with a fabricated result. The cancel notification
itself is the natural place to carry the mark: `onCancel` already runs
exactly once per cancel.

Note on code comments: this change numbers its decisions D1-D5. Comments
in the code cite them as `quiet-cancel D<n>` so they cannot be confused
with the D-numbers of other designs referenced in the same files.

## Goals / Non-Goals

**Goals:**

- A user who cancels a child to keep driving is not interrupted by a
  parent turn, an in-pane nudge that restarts the child, or a fabricated
  completion.
- The cancel signal is not lost in quiet mode: it stays in the parent's
  session, visible and in context for the next turn.
- A cancelled child that the user or the parent later resumes returns to
  normal supervision: watchdog included.
- A cancelled child whose pane dies is still reported through the gone
  path.

**Non-Goals:**

- Changing the child side: the `cancelled` sidecar write and its
  self-clear on turn start are untouched.
- Changing the skill path: `wait --signal sidecar` returns a `cancelled`
  sidecar exactly as today; the setting is pi-parent-side only.
- A runtime toggle. The setting is read once at module load, like
  `status.enabled` and `notify.enabled`; changing it takes a `/reload`.
- Distinguishing who cancelled (report-user-cancel D5 stands:
  `pmux_interrupt` and a manual Escape take the same path).

## Decisions

**D1: `notify.quietCancel`, a boolean defaulting to `false`.**
`parseStatusConfig` accepts it inside the existing `notify` block and
`StatusConfig` carries it as `quietCancel`. `false` (or absent) keeps the
current behavior. The block's unknown-key rejection already covers typos;
a non-boolean value is a config error like every other key in the file.
`config.json.example` gains the key so a seeded config shows it.

**D2: Quiet mode sends the same message with `triggerTurn: false`.**
`deliverSubagentCancel` sends the identical `pmux_cancel` message —
same wording, same details — with `{ triggerTurn: false }` when the
setting is on. pi appends it to the session with no turn: the message is
displayed in the transcript immediately and is in context for the
parent's next turn, which for this user is the instruction they are
already typing. Two alternatives were rejected: dropping the message
entirely loses the signal (the parent would have no record that the
child's current state is user-cancelled rather than still-working), and
`deliverAs: "nextTurn"` holds the message in a pending queue instead of
appending it, which delays the transcript display for no benefit.

**D3: `onCancel` marks the run; a fresh active phase clears the mark.**
`RunningSubagent` gains a `userCancelled` flag the poll's `onCancel` sets.
The watch tick clears it when `running.activity.phase === "active"`: a
new turn started, so whoever restarted the child — the user typing in the
pane, a `pmux_message`, or a `pmux_resume` (which is a new run anyway) —
owns its supervision again and the watchdog owes it normal duty. The flag
is memory-only; `/reload` retires every watcher anyway, and the launch
records that would survive a reload carry no per-run state by design.

**D4: The mark suppresses the watchdog's idle arm, not its gone arm.**
While `userCancelled` stands, `runIdleWatchdog` skips `decideIdleAction`
entirely — no nudge, no finish — and still runs `decideGoneAction`. A
cancelled child is alive and deliberately parked, so the reminder and the
fabricated `done` are both wrong; a cancelled child whose pane then dies
is a real failure the parent should still hear about. The suppression
applies whether `quietCancel` is on or off: in wake mode the parent was
just told "ask the user how to proceed", and a watchdog that restarts the
aborted turn 30 s later — or finishes it 90 s later — contradicts that
contract in exactly the way quiet mode exists to prevent.

**D5: `pmux_interrupt` inherits the suppression.**
An interrupt sends Escape to the child, so the same `cancelled` sidecar,
the same mark and the same quiet-or-wake delivery apply. No special
casing, per report-user-cancel D5.

## Risks / Trade-offs

- [A cancelled run can stay registered indefinitely] With the idle arm
  suppressed, a parked child sits in `runningSubagents` until the user
  resumes it, the parent acts, or the pane dies (the gone arm still
  finishes that case with an error). Before this change the watchdog
  forced a `done` within ~90 s. Accepted: a user cancel is deliberate, so
  parking is the honest state; the widget keeps showing the run.
- [The flag does not survive `/reload`] Consistent with the rest of the
  per-run state: a reload retires the watchers, and the launch records
  deliberately carry no per-run values. A reloaded parent does not
  re-adopt children today at all.
- [In quiet mode the parent may act on the recorded cancel during its
  next turn] The message wording still says to ask the user how to
  proceed, which is also the correct move mid-conversation.
- [The wake-mode parent loses the watchdog's cleanup of a cancelled
  child] Intentional: that cleanup restarted or fabricated-finished a
  turn the user aborted on purpose. A parent that wants the child ended
  can resume it and let it finish, or leave the pane parked.
