# Proposal

## Why

Every prompt this extension sends carries boilerplate, and some of it is
carried twice. The extension writes a launch brief for each child, a
completion reminder for a child that forgot to close its session, an
acknowledgement for each spawn, and a 4,000-token skill prompt for an
external orchestrator. Each of those is read by a model on every run, so
every redundant sentence is paid for on every run.

Four kinds of waste were found:

- **The same reminder, in two files.** The child extension nudges itself
  after a normal turn (`pmux-done.ts`) and the parent-side idle watchdog
  types a reminder into a stalled child's pane (`idle-watchdog.ts`). The two
  were byte-identical copies of the same 394-character string. A copy in
  two files drifts, and the child that ignores the first reminder reads the
  same text twice.
- **The same instruction, in two wordings.** The launch prompt carried two
  variants of the report instruction — one for auto-exit children, one for
  interactive children — that differed only by a parenthetical the
  `pmux_done` tool description already states.
- **The same recipe, twice in the skill.** The `resume` recipe appeared
  twice in `SKILL.md`: once in "External orchestrators (Claude Code)" and
  once in "While it runs / after", with the same command, the same
  `<spec>` explanation and the same "no launch record" rule. The skill is
  the largest prompt the extension ships (4,437 tokens), and it was paying
  twice for one recipe.
- **The spawn acknowledgement, restating the tool description.** The
  `pmux_spawn` tool description already says the call is fire-and-forget
  and the result arrives as a steer message; the acknowledgement repeated
  both, in full.

## What Changes

- The completion reminder moves to one module, `pi-extension/pmux/nudge.ts`.
  The child extension and the parent-side watchdog use it, so the two
  cannot drift and the wording is trimmed once.
- The launch prompt carries one report instruction and one task hint, in
  the shorter of the two wordings.
- The parent-contact footers keep every rule they carry and lose the
  words that say a rule twice.
- `SKILL.md` states the `resume` recipe once, in "While it runs / after",
  and the external-orchestrator section points at it. Its frontmatter
  description keeps the trigger words and the external-orchestrator
  sentence and drops the rest.
- The `pmux_spawn` acknowledgement keeps the guardrail (do not assume a
  result) and drops the restatement of the tool description.

## Impact

- Affected specs: `external-orchestration` (the parent-contact footer, the
  skill prompt), `luvus-completion` (the completion reminder), `context-alert`
  (the nudge after the alert).
- Affected code: `pi-extension/pmux/nudge.ts` (new), `pmux-done.ts`,
  `idle-watchdog.ts`, `launch-build.ts`, `context-alert.ts`, `index.ts`,
  `skills/pmux/SKILL.md`, `docs/guide.md`.
- No behaviour changes. Every rule the trimmed prompts carried is still
  carried; only the words around them changed.
