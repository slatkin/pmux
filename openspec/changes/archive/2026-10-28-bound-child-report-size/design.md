# Design

## Context

See proposal.md, Why. Two functions in `pi-extension/pmux/launch-build.ts` build the parent-contact footer: `parentFooter` (`last` mode) and `sendFooter` (`send` mode). `reportFooter` selects one of the two. Only the external-orchestrator path appends a footer. The pi-parent path (`pmux_spawn`) uses `SUMMARY_INSTRUCTION`, which already says "Keep it short". Today each footer gives the report fields as one list: verdict, commit SHA, files changed, verification, deviations, open questions.

Three roles already write their full output to a file and give the path in the report: `reviewer`, `scout` and `visual-tester` (each `agents/*.md` has a "Report the exact path back" rule). The details-file rule in the footer agrees with these roles.

Tests pin the two footers byte for byte: `lastFooterBytes` and `sendFooterBytes` in `test/launch-build.test.ts`, and the golden block in `test/cli.test.ts` (around line 1140). The comment above that golden block says the spec requires the `last` footer bytes to stay as they were before `--report` existed. The spec does not require this. "Report mode selection" says only "as before" about the report source, not about the footer bytes.

## Goals / Non-Goals

**Goals:**

- One report-shape text, used in both footers.
- Footer tests that pin the new bytes and also check each new rule by pattern, so a later wording change cannot silently drop a rule.

**Non-Goals:**

- No enforcement in code. `send` does not count lines and does not refuse or truncate a long report. A truncated report could lose the verdict or an open question, and that costs more than the bytes it saves.
- No change to `SUMMARY_INSTRUCTION` or to the pi-parent path.
- No change to `agents/*.md`.
- No change to the pointer, the ack or the channel transport. The measured overhead of these is about 1.5k tokens for each campaign of 6 children.

## Decisions

**D1. Both footers get the rule.** The two footers list the same fields today, and an orchestrator in `last` mode also reads the report into its context. Alternative: `send` mode only. Rejected, because the two footers would then give different report shapes for the same role.

**D2. A fixed number, 15 lines.** The pi-parent `SUMMARY_INSTRUCTION` already says "Keep it short", and the measured reports were still 2–5.4 KB. A number gives the model a limit that it can check. Fifteen lines hold a verdict, a SHA, about 5 checks, and a few deviations and open questions. Alternative: a byte limit. Rejected, because a model counts lines more reliably than bytes.

**D3. No "files changed" field.** The commit SHA identifies the changes, and the orchestrator runs `git` on it anyway. The measured A2 report used about 40% of its size on this list.

**D4. A report format in the brief wins.** The orchestrator knows what it needs. For example, the A2 brief asked for a "log-event leftover report". The override sentence is in the footer, because the footer comes after the brief in the prompt. Without the sentence, the footer would seem to override the brief.

**D5. The details file is optional.** Most reports fit in 15 lines. A required file adds a write step for the child and a read step for the parent. In `send` mode the report text can also tell the parent to read a file.

**D6. Shape of the footer text.** In both footers, step 2 stays the report step. Step 2 then gives the shape as short indented lines, after the existing first line of step 2:

```
   At most 15 lines: the verdict first, then the commit SHA; one line per verification check, PASS or FAIL, no command output; one line per deviation and per open question.
   Do not list the files changed: the parent reads them from the commit SHA.
   Put longer details in a file and name its path in the report.
   A report format in your brief overrides this shape and limit.
```

In `send` mode the placeholder in the command becomes `'<report>'`, so the field list appears only once in the footer, as the footer requirement demands. The `last` step 2 sentence drops its inline field list for the same reason.

## Risks / Trade-offs

- [A report on a large change cannot fit in 15 lines] → The details-file rule gives the overflow a place, and the brief can set a different limit.
- [The child obeys the limit but leaves out a FAIL] → The rule asks for one line per check, so a FAIL keeps its line. The orchestrator checks the SHA as it does today.
- [The `test/cli.test.ts` comment about byte stability can mislead a later reader] → Task 2.2 corrects the comment so it says that the test pins the current bytes.

## Migration Plan

None. The footer goes into each prompt at `start` and `resume`. A running child keeps its old footer. A resumed child gets the new footer appended to its follow-up prompt. Both shapes are valid reports for the parent.
