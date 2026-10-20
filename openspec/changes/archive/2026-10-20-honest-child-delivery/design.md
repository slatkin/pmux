# Design

## Context

See proposal.md — Why. The code facts behind the two lies:

- `run.ts` ends `runSpec` with a wake block: when `spec.parent` is set it calls
  `agentSend(spec.parent, ...)`, which resolves the pane by title through
  `findPaneByName`. The skill titles the orchestrator's pane
  `<name>-orchestrator` while `--parent` carries the bare name, so the lookup
  fails, the error is printed into the child's own pane, and a `done` pane
  closes and takes the error with it.
- `index.ts` (`sendSubagentMessage`) answers a `pmux_message` to `parent` with
  "Message sent to parent. It arrives as a steering message" and appends to
  `<session>.msg` — a file no pi parent reads on the skill path.

The report channel already works without either lie: the report is the child's
last assistant message (`last-message`), the wrapper writes the `error`
sidecar for a child that died without one, and the orchestrator's wake is the
CLI `wait` command polling `<session>.status`.

## Goals / Non-Goals

Goals: the wrapper contacts nobody; a skill-launched child is marked in its
env; `pmux_message` refuses `parent` for a marked child with an honest error;
the tool description states the condition.

Non-Goals: the `pending --parent` listing and the acknowledgement file; the
reload amnesia on the pi-parent path; the `luvus-*` capability renames; any
change to `.exit` sidecar format, `pmux-done.ts`, `wait` or `last-message`.

## Decisions

1. **Delete the wake; do not fix the title match.** Even with a corrected
   `<name>-orchestrator` lookup the channel is wrong: a typed line lands in
   the orchestrator's composer as a user message, possibly mid-turn or while
   the human types. The orchestrator already has a reliable wake — `wait`
   polls the status file and the harness calls it back when the command
   exits. So the wake block, the `childSidecar` read only it used, the
   `sendToParent` seam in `RunSpecDeps`, and `agentSend` +
   `findPaneByName` in `tmux.ts` are deleted. `agentPrompt`, which addresses
   a pane by id, stays; this removes the last place in the package that
   addresses a pane by title. The wrapper keeps the sentinel and the
   wrapper-written `error` sidecar. The `LaunchSpec.parent` doc comment
   changes to the parent's name as the brief footer — and the later
   `pending --parent` listing — use it.

2. **The marker is an env key, not a flag or a file.** `PI_PMUX_EXTERNAL_PARENT=1`
   joins the `PI_PMUX_*` contract `child-env.ts` already governs.
   `start` writes it into the launch spec env: every `start` is a skill
   launch, and the pi-parent supervisor never sets the field. `resume`
   inherits it for free because it reuses the launch spec unchanged.
   Rejected: a `run --external` flag (the wrapper would have to thread it,
   and a resume could lose it) and a roster/sidecar file (a second channel
   where one env key suffices).

3. **One refusal at target resolution.** `resolveMessageTarget` gains an
   `externalParent` input; for a marked sender it drops `parent` from
   `reachableTargetNames` and returns the refusal for `to: "parent"` — an
   error that says the parent is an external orchestrator that does not read
   subagent messages, names the child's last assistant message as the report,
   and names `caller_ping` as the way to ask a question (its text reaches the
   orchestrator through the `.exit` sidecar). Reachable list and error then
   come from one place, and `sendSubagentMessage` passes the marker through
   from `childEnv`. Rejected: computing `hasParent: false` for marked
   children in the tool execute — the resulting "This agent has no parent"
   would be a third lie.

4. **A static tool description.** The `pmux_message` description states that
   `parent` is reachable only when a pi parent exists. A registered tool
   cannot branch its description per process; the launch prompt already lists
   each child's reachable targets at spawn, and the skill footer tells
   skill children not to use the tool — wording that this change makes
   enforced rather than advisory.

## Risks / Trade-offs

- [A launch spec written before this change and resumed afterwards lacks the
  marker, so that resumed child could still "send" to `parent`] → Scratch
  specs are pruned after 7 days and the wake is gone for every child
  regardless of the marker, so no false wake survives; the stale-refusal
  window is short and self-healing.
- [The refusal text must not overpromise either] → It names only channels
  that exist: the report in the session file (`last-message`) and
  `caller_ping` (`.exit` sidecar). The delta scenarios pin both.
- [The static description is also read by pi-parent children, where `parent`
  does work] → The sentence states the condition ("only when a pi parent
  exists"), not a prohibition; the launch prompt lists the actual targets.

## Migration Plan

One commit, no data migration. The only persisted contract change is one more
`PI_PMUX_*` env key; specs and sessions written earlier keep launching.
External-orchestration stays passing throughout. Rollback is reverting the
commit.

## Open Questions

None.
