# Proposal

## Why

The skill path tells a child two things that are not true, and one of them has
been failing silently since the Luvus host was dropped.

The pane-side run wrapper still tries to wake the parent when a child ends. It
types a line into a pane it finds by title (`agentSend` → `findPaneByName`),
but the skill tells the orchestrator to title its own pane
`<name>-orchestrator` while `--parent` carries the bare name, so the titles
never match. The wake throws, the error is printed into the child's own pane,
and the pane then closes on a `done` sidecar and takes the error with it. The
orchestrator never learns that anything failed, and it never got the pointer
either. Even when the title does match, the channel is the wrong one: a typed
line arrives in the orchestrator's composer as a user message, possibly in the
middle of a turn or while the human is typing. The orchestrator already has a
reliable wake — it runs `wait` against the status file and the harness calls it
back when the command exits.

`pmux_message` tells the second lie. For a child that the skill launched, the
tool answers "Message sent to parent. It arrives as a steering message" and
appends to a message file that no pi parent ever reads, because there is no pi
parent. The skill's footer tells the child not to use it, but a tool that
answers "sent" when nobody receives is worse than a tool that refuses.

Both are the defect that pi-luvus issue #8 ("Acknowledged child reports") named
in its Luvus form: a channel that looks like a delivery and is not one. The
part of that issue pmux has not inherited is solved already, by another route.
The report is the child's last assistant message in the session file and the
orchestrator reads it with `last-message`; the wrapper writes the `error`
sidecar for a child that died without one. What is missing is only honesty
about the two channels around the report.

## What Changes

- The run wrapper stops contacting the parent. The wake-up block, the
  `sendToParent` test seam and the `agentSend` and `findPaneByName` helpers go,
  and with them the last place in the package that addresses a pane by title.
  The wrapper keeps printing `__SUBAGENT_DONE_<code>__` and keeps writing the
  `error` sidecar for a child that ended without one. The orchestrator's wake
  is the `wait` command, which polls the status file.
- The launch spec keeps its `parent` field. The footer appended to the brief
  needs it, and so will the `pending --parent` listing that a later change
  adds. Only the wrapper's use of it goes.
- A new child env key, `PI_PMUX_EXTERNAL_PARENT=1`, marks a child that an
  external orchestrator launched. `start` writes it into the launch spec env,
  so a resume keeps it. A pi-parent child does not carry it, because a pi
  parent really does read the child's messages.
- With the marker set, `pmux_message` to `parent` returns an error instead of a
  promise. The error says the parent is an external orchestrator that does not
  read subagent messages, names the child's last assistant message as the
  report, and names `caller_ping` as the way to ask a question, whose text the
  orchestrator reads from the `.exit` sidecar. `parent` is not listed among the
  reachable targets of such a child.
- The `pmux_message` tool description says that `parent` is reachable only when
  a pi parent exists.
- The skill's wording becomes true rather than aspirational. `SKILL.md` already
  says "there is no channel from the child back to you"; after this change the
  wrapper does not type into the orchestrator's pane and `pmux_message` refuses
  the parent, so the sentence is true.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `external-orchestration`: the launch contract carries the external-parent
  marker, and the wrapper's rule states that it contacts nobody and that the
  orchestrator's wake is the `wait` command. The parent-contact footer keeps
  its wording and becomes enforced rather than advisory.
- `luvus-messaging`: `parent` is a reachable target only for a sender that has
  a pi parent. A child with an external parent gets an error that names the
  report and `caller_ping`, and `parent` is not in its reachable list.

## Impact

- `pi-extension/pmux/run.ts`: the wake-up block, the `sendToParent` seam in
  `RunSpecDeps` and the `agentSend` import go.
- `pi-extension/pmux/tmux.ts`: `agentSend` and `findPaneByName` are deleted;
  they have no other caller. `agentPrompt`, which addresses a pane by id, stays.
- `pi-extension/pmux/launch.ts`: the `parent` field's doc comment changes from
  "the wrapper wakes it" to the parent's name as the brief and the future
  pending listing use it.
- `pi-extension/pmux/child-env.ts`: a new `PI_PMUX_EXTERNAL_PARENT` key,
  encoded and decoded like the other `PI_PMUX_*` keys.
- `pi-extension/pmux/cli.ts`: `start` sets the marker in the launch spec env;
  `resume` inherits it from the spec.
- `pi-extension/pmux/index.ts`: `pmux_message` refuses `parent` for a marked
  child, and the reachable-target list omits it.
- `docs/guide.md`: the messaging paragraph says that a `parent` message needs a
  pi parent, and a marked child is refused.
- Tests: `test/cli.test.ts` loses the "wakes the parent when the child exits"
  case and gains one that the wrapper contacts nobody; `test/tmux.test.ts`
  loses the two `agentSend` cases; `test/child-env.test.ts` gains the marker
  round-trip; the messaging tests gain the refusal.
- The `external-orchestration` spec must keep passing: the `PI_PMUX_*` contract
  changes. The `.exit` sidecar format, `pmux-done.ts`, the report contract and
  the `wait` and `last-message` commands do not change.
- Not in this change: the `pending --parent` listing and the acknowledgement
  file, the reload amnesia on the pi-parent path, and the rename of the
  `luvus-*` capabilities. Each is a separate change.
