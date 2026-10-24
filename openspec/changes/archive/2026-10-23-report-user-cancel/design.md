# Design

## Context

See proposal.md - Why. Today the abort path is designed for silence:
`shouldAutoExitOnAgentEnd` returns false for `stopReason: "aborted"` so
the session stays open for inspection or another prompt, and nothing is
written anywhere the parent polls. The error path right next to it shows
the mechanism this change reuses: `stopReason: "error"` writes an `error`
sidecar, the parent's `pollForExit` decodes it, and the parent is woken
with the failure.

The one subtlety the error path does not have: an errored child has
exited, so its sidecar is terminal. A cancelled child is still alive and
resumable, so its sidecar is a notification, not a completion. The user
chose "notify, keep watching": the parent learns of the cancel, and a
user who then types in the pane to resume can still deliver a report
later.

Note on code comments: this change numbers its decisions D1-D6. Comments
in the code cite them as `report-user-cancel D<n>` so they cannot be
confused with the D-numbers of other designs referenced in the same
files.

## Goals / Non-Goals

**Goals:**

- The calling agent learns promptly that the user cancelled the child's
  turn, as a signal distinct from failure.
- The message wording steers the caller toward asking the user how to
  proceed, not toward recovery.
- The cancelled session stays open and resumable; a later resume and
  completion still report normally.
- The skill path (external orchestrator) observes the same signal through
  the sidecar it already polls.

**Non-Goals:**

- Changing the abort semantics themselves: the session stays open, no
  nudge is scheduled, no auto-exit. Only the notification is new.
- Distinguishing *who* cancelled (user Escape vs `pmux_interrupt`). See
  D5.
- Closing the pane or ending the run on cancel.
- Any change to the status-file reporter (`working`/`idle`/`done`/
  `blocked`). The sidecar is the channel.

## Decisions

**D1: The child writes `{"type":"cancelled"}` on an aborted turn end.**
In `pmux-done.ts`, the `agent_end` handling that today ignores aborted
turns writes the `cancelled` sidecar instead, for every session —
auto-exit or not. The session-stays-open logic
(`shouldAutoExitOnAgentEnd`) is untouched: writing the sidecar is a
report, not an exit. The write uses the existing `writeExitSidecar`
helper, which never throws.

**D2: The child clears the `cancelled` sidecar when a new turn starts.**
On `agent_start`, if the sidecar holds `{"type":"cancelled"}`, the child
removes it. This keeps the signal honest for the skill path: its
`wait --signal sidecar` treats file presence as the signal and never
removes the file, so a stale cancel would otherwise satisfy every later
wait instantly. (The pi-parent poll needs no help here — it consumes the
sidecar it reads, see D4.) Clearing only the `cancelled` payload — never
`done`/`error`/`handoff`/`ping` — means a real completion sidecar is
never eaten. Run start already clears all sidecars, so relaunches are
covered.

**D3: `ExitResult.reason` gains `"cancelled"`, decoded from
`{"type":"cancelled"}`.** `interpretExitSidecar` maps the payload to
`{ reason: "cancelled", exitCode: 0 }`. The exit code is 0 because
nothing failed; the reason carries the meaning. Every consumer that
switches on the reason gains a `cancelled` arm — the poll (D4) and the
wrapper's close-on-done check (which already keeps the pane open for any
non-`done`/`handoff` payload, so no change is needed there beyond what
the spec already states).

**D4: `pollForExit` reports a cancel through a new `onCancel` option and
keeps polling.** The poll gains an optional
`onCancel?: (result: PollResult) => void`. When the decoded sidecar
reason is `cancelled`, the poll calls `onCancel` instead of completing.
No de-duplication state is needed: the poll already deletes every
sidecar it reads, so each `cancelled` file is seen exactly once — one
file, one notice. A later abort writes a new sidecar and notifies again.
The supervisor wires `onCancel` to a steer that triggers a parent turn:

> Sub-agent "\<name\>" was cancelled in its pane (Escape) after \<elapsed\>.
> The session is still open and the child is still registered. The user
> interrupted it deliberately — ask the user how to proceed before
> resuming with `pmux_resume` or spawning a replacement.

The message carries the session file like the other completion messages.
The run stays in `runningSubagents`, the widget keeps showing it, and
the completion poll continues; a later `done`/`error`/`handoff`/`ping`
sidecar completes the run exactly as today.

**D5: A parent-initiated `pmux_interrupt` produces the same signal.**
Escape is Escape: the child's turn ends `aborted` whether the key came
from the user's hand or from `pmux_interrupt`. Suppressing the notice
for parent-initiated interrupts would need a parent-to-child marker
round-trip for no real gain — the parent has the context of its own
interrupt call, and the wording covers both cases. Accepted as-is.

**D6: No new state survives reload.** The poll's reported-payload memory
is a local in the `pollForExit` loop, and the child side holds nothing
new. `/reload` safety is unchanged.

## Risks / Trade-offs

- [A cancel notice can be followed by a completion] The user aborts, the
  parent is told, the user resumes in the pane, the child finishes: the
  parent gets the cancel steer and later the result. This is the intent
  of "notify, keep watching"; the wording tells the parent the child is
  still registered so the later result is not a surprise.
- [A cancel notice can arrive for a child the parent interrupted itself]
  D5. Mildly redundant, never wrong.
- [A cancel and an immediate in-pane resume inside one poll interval are
  missed] The poll reads the sidecar once a second; a user who aborts
  and restarts the child within that window leaves no file to read. This
  is accepted best-effort: the user has already given the next step by
  resuming, so the missed notice costs nothing.
- [A last-mode skill wait surfaces a cancel only at its timeout] A
  cancel writes no status-file entry (the session is alive and idle), so
  an orchestrator waiting with `--signal status` on the terminal
  statuses keeps waiting until its timeout and only then reads the
  `cancelled` sidecar. This is intended: the cancel is not terminal, the
  user may resume and finish, and `wait --signal sidecar` exists for
  orchestrators that want the prompt signal. SKILL.md points send-mode
  orchestrators at the sidecar wait already.
- [The skill path can read a cancel as a wait result and stop watching]
  That is the orchestrator's choice; SKILL.md documents that a
  `cancelled` sidecar means the session is still open and that the child
  clears it on the next turn, so a re-issued `wait` waits for real
  completion.
