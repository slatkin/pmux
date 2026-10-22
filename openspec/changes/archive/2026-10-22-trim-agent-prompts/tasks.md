# Tasks

## 1. One home for the completion reminder

- [x] 1.1 Add `pi-extension/pmux/nudge.ts` with `COMPLETION_NUDGE_TEXT`: the reminder, trimmed of "and need input from the caller" (the `caller_ping` description says when to use it) and with its last two lines merged.
- [x] 1.2 `pmux-done.ts` delivers `COMPLETION_NUDGE_TEXT` instead of its own copy.
- [x] 1.3 `idle-watchdog.ts` types `COMPLETION_NUDGE_TEXT` instead of its own copy; `IDLE_NUDGE_TEXT` names it.
- [x] 1.4 Verify: `test/idle-watchdog.test.ts` asserts the two are the same string; `test/test.ts` asserts the child extension delivers exactly `COMPLETION_NUDGE_TEXT`.

## 2. The launch prompt carries each instruction once

- [x] 2.1 `launch-build.ts`: one report instruction for both launch shapes. The interactive variant's parenthetical goes; the `pmux_done` description already states it.
- [x] 2.2 `launch-build.ts`: the task hint keeps its two shapes and says `pmux_done` once.
- [x] 2.3 Verify: `test/launch-build.test.ts` pins the auto-exit spawn prompt and the interactive spawn prompt, both with the same report instruction.

## 3. The footers keep their rules and lose their filler

- [x] 3.1 `parentFooter`: trimmed. It still gives the parent's name and pane, says the last assistant message is the report, says to call `pmux_done` afterwards, and says not to reach the parent with `caller_ping` or `pmux_message`.
- [x] 3.2 `sendFooter`: trimmed. It still names the parent's pane, teaches the `send` command as the report step followed by `pmux_done`, says a blocked child sends its question with the same command and stops, names the confirmation line as the delivery receipt, and says to ignore the reminder's "already delivered" claim.
- [x] 3.3 Verify: the pinned footer bytes in `test/launch-build.test.ts` and `test/cli.test.ts` are updated to the trimmed text.

## 4. The context-alert messages

- [x] 4.1 `alertText`: the last two lines merge into one.
- [x] 4.2 `handoffNudgeText`: the alert comes first, and the last two lines merge.

## 5. The skill prompt

- [x] 5.1 `SKILL.md`: the `resume` recipe is stated once, in "While it runs / after"; the external-orchestrator section points at it and keeps the send-mode fact that `resume` re-appends the send footer. The `ping` bullet's "below" points at the same section.
- [x] 5.2 `SKILL.md`: the frontmatter description keeps the external-orchestrator sentence and the trigger words, and drops the role list (the body lists the roles) and the long trigger list.
- [x] 5.3 `docs/guide.md`: the quoted completion reminder and the quoted task hint match the new text; the guide names `nudge.ts` as the reminder's home.

## 6. The spawn acknowledgement

- [x] 6.1 `index.ts`: the `pmux_spawn` acknowledgement keeps the guardrail (do not generate or assume a result) and drops the restatement of the tool description.
- [x] 6.2 `index.ts`: the `pmux_spawn` tool description keeps every rule and loses the words around them.

## 7. The specs

- [x] 7.1 `external-orchestration`: the "Parent-contact footer" requirement drops the byte-stability pin and names the rules the footer carries; the "Packaged orchestration skill" requirement gains the "one recipe, one place" rule.
- [x] 7.2 `luvus-completion`: the "Completion nudge after a normal stop" requirement names the shared text.
- [x] 7.3 `context-alert`: the "Nudge after the alert" requirement no longer pins the reminder text to "the same as before this change".
- [x] 7.4 `openspec validate trim-agent-prompts --strict` passes.

## 8. Gates

- [x] 8.1 `pnpm run format:check`, `pnpm run lint` (no new errors), `pnpm run typecheck` and `pnpm test` all pass.
