# Design

## The audit

Every prompt the extension sends, and where it goes.

### To a child, at launch

| Prompt | Where | Sent by |
| --- | --- | --- |
| The launch brief | the child's first user message | `buildPiLaunch` |
| The role body | the child's system prompt (as a file) | `buildPiLaunch` |
| The parent-contact footer | the tail of the brief | `parentFooter`, `sendFooter` |

The brief is the task plus a fixed set of instructions:

- the role block (only when the role body did not go to the system prompt),
- the task hint (`resolveModeHint`),
- the messaging hint (`buildLaunchMessagingHint`),
- the report instruction,
- and, on the external path, the parent-contact footer instead of the
  hints.

### To a child, during its run

| Prompt | Where | Sent by |
| --- | --- | --- |
| The completion reminder | a follow-up message in the child's own session | `pmux-done.ts` |
| The idle reminder | typed into the child's pane | `idle-watchdog.ts` |
| The context alert | a steer message in the child's own session | `context-alert.ts` |
| The handoff reminder | a follow-up message after the alert | `context-alert.ts` |
| A peer's message | typed into the child's pane | `pmux_message` |

### To a parent, during its run

| Prompt | Where | Sent by |
| --- | --- | --- |
| The spawn acknowledgement | the `pmux_spawn` tool result | `index.ts` |
| The result, ping, handoff or error | a steer message | `supervisor.ts` |
| A status transition | a steer message | `supervisor.ts` |
| A tool error | the tool result | `index.ts`, `supervisor.ts` |

### To an orchestrator, once

| Prompt | Where | Sent by |
| --- | --- | --- |
| The skill prompt | `skills/pmux/SKILL.md` | the package |

### Always resident

The tool schemas (`pmux_spawn`, `pmux_resume`, `pmux_message`, `pmux_list`,
`pmux_interrupt`, and, in a child, `pmux_done` and `caller_ping`) sit in
every turn of the session that owns them. They were left alone apart from
the `pmux_spawn` description: each one states a rule the agent would
otherwise break, and they are the cheapest part of the whole surface.

## The rules used when trimming

1. **Every rule survives.** A sentence is only cut when the rule it
   carries appears elsewhere in the same prompt, or in the tool schema the
   agent already has.
2. **One wording per rule.** Two variants of the same instruction become
   one, and the shorter one wins unless the longer one carries a rule the
   shorter one drops.
3. **One home per text.** A prompt that two modules send is defined in
   one module and imported by the other.
4. **One statement per recipe in the skill.** The skill states a recipe
   once and points at it from the other mode's section.

## What changed, and what did not

The parent-contact footers are pinned by byte in `external-orchestration`,
so their trimming needed a spec delta. Every rule the spec names is still
named:

- the `last` footer still gives the parent's name and pane, says the last
  assistant message is the report, says to call `pmux_done` afterwards, and
  says not to reach the parent with `caller_ping` or `pmux_message`;
- the `send` footer still names the parent's pane, teaches
  `node <cli> send --to <pane> --text '<report>'` as the report step
  followed by `pmux_done`, says a blocked child sends its question with
  the same command and stops, and says to ignore the reminder's "already
  delivered" claim and send the report first.

What was cut is the wording around them: "So do ALL of the following before
you stop" became "Before you stop, do ALL of this"; the report-content
list keeps its items and loses "and"; "The report text may be long, may
contain quotes and may span several lines" became "The text may be long,
contain quotes or span lines".

Two rules were dropped because they are stated by the tool schema the
child already carries:

- the interactive launch prompt's report instruction lost the parenthetical
  "(before calling pmux_done or before the user exits)" — the `pmux_done`
  description already says the last assistant message before the call is
  the summary that goes to the caller;
- the task hint lost "Call pmux_done when finished." as a separate
  sentence and kept it inside one sentence.

The completion reminder lost "and need input from the caller" (the
`caller_ping` description says when to use it) and merged its last two
lines. The context alert merged its last two lines. The handoff reminder
merged its last two lines.

The `SKILL.md` frontmatter description lost the role list (the body lists
the roles) and the trigger list (the triggers are the same four words in
the same sentence). It keeps the external-orchestrator sentence, which the
spec names.

## Left alone, on purpose

- **The role bodies** (`agents/*.md`) are content, not boilerplate. They
  are long, but the length is the rubric the role runs on.
- **The duplicate reminder delivery.** A child whose turn ends but whose
  session stays open can read the completion reminder twice: once from its
  own extension after five seconds, once from the parent's watchdog after
  thirty. The two are now the same string, so the second read is a repeat
  rather than a contradiction. Cutting the second delivery would leave a
  child whose turn ended abnormally with no reminder at all, because the
  child-side nudge only fires on a normal stop. The repeat is the price of
  the backstop.
- **The brief restating the tool schema.** The launch prompt still says
  "call the pmux_done tool" even though the `pmux_done` description says
  it. The brief is the child's first message and the instruction is worth
  its 23 tokens there.
