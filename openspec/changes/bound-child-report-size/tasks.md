# Tasks

## 1. Footer text

- [x] 1.1 In `pi-extension/pmux/launch-build.ts`, change `parentFooter` step 2 to drop its inline field list and add the four report-shape lines of design D6 (15-line limit and order, no files changed, optional details file, brief override); update `lastFooterBytes` in `test/launch-build.test.ts` and the golden block in `test/cli.test.ts` to the new bytes, and verify both pass with `node --test test/launch-build.test.ts test/cli.test.ts`
- [x] 1.2 In `sendFooter`, change the command placeholder to `'<report>'` and add the same four report-shape lines under step 2; update `sendFooterBytes` and verify the send-mode start and resume tests pass with `node --test test/launch-build.test.ts`
- [x] 1.3 Add one test that checks both footers (`parentFooter` and `sendFooter`) by pattern for each new rule: `15 lines`, verdict before commit SHA, `PASS or FAIL`, no `files changed` request and the commit-SHA sentence, the details-file sentence, and the brief-override sentence; also verify that each rule appears once in each footer (scenario "The footer states each rule once"); run `node --test test/launch-build.test.ts`

## 2. Comments and docs

- [x] 2.1 Update the doc comments of `parentFooter` and `sendFooter` so that they name the report-shape rule; verify by reading the diff
- [x] 2.2 Correct the comment above the golden block in `test/cli.test.ts`: it says the spec requires the `last` footer bytes to stay as they were before `--report`; change it to say that the test pins the current `last` footer bytes; verify by reading the diff

## 3. Integration

- [x] 3.1 Run `pnpm run format:check`, `pnpm run lint`, `pnpm run typecheck` and `pnpm test`; verify all four pass, then run `openspec validate bound-child-report-size --strict` and verify it passes

## Workflow follow-up

- The user runs a short live campaign with an external orchestrator and compares the report sizes with the 2026-10-27 baseline (2–5.4 KB for each report).
- Archive the change after review.
