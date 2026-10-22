# Design

## Context

The sidebar repo's `tasks-tab` change (spec `agent-tasks`, "Reminders are
conditional with common wording") defines the reminder wording in
`src/task_reminders.rs`: update-before-finish, fired when a turn ends with
open items. Its `docs/agent-protocol.md` section "The task reminders"
documents it verbatim. Tasks reach the store only through the sidebar's
task commands; this extension never writes the store.

This change delivers that one reminder only. The record-first reminder is
deliberately not delivered: recording tasks is a human-prompted action,
not a default tag, so a pane that has recorded nothing must stay quiet.

This extension already sits at the settlement boundary the reminder hangs
off: it ends work per run. The delivery mechanism precedent is the context
alert (`pmux-done.ts`): a `turn_end` check runs
`pi.sendUserMessage(text, { deliverAs: "steer" })` — a steer message the
model reads, with no `triggerTurn`, so delivery never spawns a run of its
own.

## Goals / Non-Goals

**Goals:**

- The reminder fires exactly in its condition and only then, for a pi pane
  that already holds tasks.
- The wording is the sidebar's, byte-for-byte, with the source named.
- Delivery never disturbs the session (the `sidebar-events` rule).

**Non-Goals:**

- Changing or owning the wording; no edits to `pmux-done.ts` or any
  existing module beyond the registration in `index.ts`.
- Writing the store; only the sidebar's task command writes it.
- Reminders for agents with their own producers (Claude, Codex, OpenCode):
  their hook path is the sidebar's business; this extension runs in pi.

## Decisions

**D1: The wording is copied once, and the source is named.** A new module
holds the reminder text as a constant, byte-identical to the sidebar's
`UPDATE_BEFORE_FINISH_REMINDER`, with a comment naming
`src/task_reminders.rs` in the tmux-agent-sidebar repository as its single
source. A wording test asserts the copy against a literal, so an unsynced
wording edit fails CI. The modules are
cross-repo, so they cannot import; a byte-identical copy with a named
source is the smallest honest mechanism. (The alternative — a build step
reading the other checkout — needs a second repository on disk and fails
CI when it is absent.)

**D2: The store is read directly from the pane's environment.** The store
is `/tmp/tmux-agent-tasks<PANE>.json`, the file the sidebar's
`task_store.rs` defines, with the pane id encoded the way the sidebar
encodes both its log and store filenames (`%` becomes `_`). One
`readFileSync` of a small file needs no tmux call and no subprocess; a
missing or unreadable file is the empty condition, which matches the
sidebar semantics that a fresh pane starts empty.

**D3: There is no record-first reminder, and an empty store is silent.**
The extension registers no `before_agent_start` anchor at all. Recording
is a human-prompted action: an agent that has recorded nothing gets no
nudge to record, so the extension never argues for a task list the human
did not ask for. The absence also removes the only steer-vs-user-turn
ambiguity in the design, because no reminder is injected at a turn start.

**D4: pmux children never get reminders.** A subagent child's attention is
owned by its parent — the `turn-notify.ts` rule ("Subagent children stay
quiet"). Its turn ends reach the parent through the exit sidecar and
`pmux_done`, and a reminder steer into a campaigning child costs a token
read the parent did not ask for. The child predicate is the one
`isSubagentChild` (`child-env.ts`) already answers. A pane that turns out
to be a child despite the check keeps an empty Tasks tab instead of an
interrupted turn — the cheaper failure.

**D5: Update-before-finish fires at `turn_end`, guarded against repeat.**
The anchor is the exact one `checkContextAlert` fires at. When the store
already holds tasks and at least one of them is open (non-completed),
after a run that is neither `error` nor `aborted` (the context alert's own
skip rule: a failed turn gets no steer, which would only land on the next
prompt), the update-before-finish text is injected. The guard follows the context
alert's `alertFired` shape: one flag per process, set when the reminder is
injected, reset when the store's open set changes — the agent's
`task-update` calls that the reminder asks for are the reset.

**D6: Delivery rides the steer channel and never spawns a turn.** One
primitive delivers the reminder: `pi.sendUserMessage(text, {
deliverAs: "steer" })`, without `triggerTurn` — the exact call the
context alert makes. Delivery therefore never costs a run while the agent
is idle: a steer injected after a settled turn is read as leading context
of the turn the agent next runs, which is also why the reminder's cost
stays zero when the pane goes quiet.

**D7: The module registers once in `index.ts`.** The module exports one
`createTaskReminders(deps)` factory in the `sidebar-events.ts` shape —
the store reader and the injection call injected — and `index.ts` calls it
once. Per registration there are no timers and no global state beyond the
guard, so the `/reload`-safety invariant holds. Every failure of the read
or the injection is swallowed; a reminder is never worth a turn's
interruption, the same rule the sidebar publisher and the turn notifier
follow.

## Risks / Trade-offs

- [Wording drift] The copy is byte-identical today, but the two
  repositories change independently. Mitigation: the wording test pins the
  copy against literals and the comment names the source file; an unsynced
  wording edit fails `pnpm test` on the next CI run.
- [Reminder loops] A reminder read in the next turn must not re-fire at
  that turn's end while the open set is unchanged. Mitigation: D5's flag
  keeps a settled state from re-reminding until the store's open set
  changes.
- [The file race] A store written mid-turn is only seen at the next
  boundary. Mitigation: the checks run only at turn boundaries, so what
  they see is by definition the state at the boundary, which is the
  firing condition the spec names — the reminder is not asked to be live
  during a turn.
- [Payload cost] One short single-line string, shown at most once
  per state change; the wording's own brevity cap (120 characters) is
  owned by the sidebar's source-of-truth module.

## Migration Plan

No migration. Additive module, additive registration. Rollback removes
the single registration and the module. The wording carries on unchanged
in the sidebar repo; this extension's copy follows it.

## Open Questions

- The store-shape parser: the sidebar's `task_store.rs` defines the JSON
  object (`tasks: [{id, subject, status}]`, statuses `pending`,
  `in_progress`, `completed`); implement the narrowest reader for it and
  treat every deviation as the empty condition.
- Whether the D5 guard should fire again a second settlement after the
  open set changed but before the agent acted, if the first reminder did
  not stick — a pmux-style capped retry is an option the implementation
  can decide under the spec's "only in its condition" ceiling.
