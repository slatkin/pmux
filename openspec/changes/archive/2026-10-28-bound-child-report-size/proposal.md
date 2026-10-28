# Proposal

## Why

An external orchestrator (Claude Code) reads each child report into its context. A measured campaign (`emby-session-output-followups`, 2026-10-27, 6 children) had one report per child, but each report was 2–5.4 KB. About 40% of the largest report was a "files changed" list. The orchestrator then got the same facts again from `git diff --stat`. The parent-contact footer asks for that list, so every child writes it.

## What Changes

- The parent-contact footer (both `last` mode and `send` mode) sets a size limit on the report: at most 15 lines.
- The footer gives a fixed report shape: the verdict first, then the commit SHA, then one line for each verification check (PASS or FAIL, with no command output), then one line for each deviation and each open question.
- The footer stops asking for the files changed. It tells the child that the parent gets them from the commit SHA.
- The footer tells the child to put longer details in a file and to give the file's path in the report. The file is optional.
- The footer tells the child that a report format in the brief overrides the footer's report shape and limit.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `external-orchestration`: the "Parent-contact footer" requirement adds the report shape, the 15-line limit, the optional details file and the brief override, in both footers.

## Impact

- `pi-extension/pmux/launch-build.ts`: `parentFooter` and `sendFooter` text.
- `test/launch-build.test.ts` and `test/cli.test.ts`: the pinned footer text.
- No change to the pi-parent path (`pmux_spawn`, `SUMMARY_INSTRUCTION`), the `send` command, the report artifact, the pointer, the ack or the channel transport.
- No change to the role files in `agents/`.
