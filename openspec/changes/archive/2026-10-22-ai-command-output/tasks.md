# Tasks

## 1. `send` answers

- [x] 1.1 In `pi-extension/pmux/report-receipt.ts`, make `appendReportReceipt` return whether the line was written. It still never throws.
- [x] 1.2 In `pi-extension/pmux/cli.ts`, make `writeReportReceipt` return the absolute path of the receipt file, or null when there is none (outside a child, or the write failed). It uses `reportReceiptPath` and `resolve`.
- [x] 1.3 In `pi-extension/pmux/cli.ts`, `sendCommand` prints one JSON line on stdout after the delivery: `{"sent":true,"to":<pane>,"bytes":<n>,"receipt":<path or null>}`. The byte count is `Buffer.byteLength(text, "utf8")` of the text as given, before the pane-input encoding. A usage error keeps its shape: stderr message, empty stdout, exit 1.
- [x] 1.4 Verify: in `test/cli.test.ts` (`cli.ts send` block), the successful send parses its stdout as JSON and asserts `sent`, `to`, `bytes` and `receipt: null` outside a child; inside a child the `receipt` is the absolute path of the `<session>.sent` file; a receipt path in a missing directory still delivers, exits 0 and reports `receipt: null`; the usage errors still print nothing on stdout.

## 2. The footer names the confirmation

- [x] 2.1 In `pi-extension/pmux/launch-build.ts`, `sendFooter` gains a sentence after the report-text paragraph: the command prints one confirmation line (the target pane, the size of the text it sent, the receipt file it wrote), that line is the delivery receipt, and the child must not send anything else to the parent to check whether the report arrived. The `last` footer stays byte for byte.
- [x] 2.2 Verify: update the pinned send footer bytes in `test/launch-build.test.ts` and add a test that the footer names the confirmation line and forbids a second message.

## 3. The spec pins the rule

- [x] 3.1 The `external-orchestration` delta modifies the "Send command" requirement (the success line and its fields) and the "Parent-contact footer" requirement (the confirmation sentence), and adds "Every command answers on success".
- [x] 3.2 `openspec validate ai-command-output --strict` passes.

## 4. Docs

- [x] 4.1 `skills/pmux/SKILL.md`: the "External orchestrators (Claude Code)" section says the child's `send` prints its confirmation in the child's own pane, so a child does not come back to ask whether its report arrived.
- [x] 4.2 `docs/guide.md`: the external-orchestrator section names the confirmation line and what it holds.

## 5. Gates

- [x] 5.1 `pnpm run format:check`, `pnpm run lint` (no new errors), `pnpm run typecheck` and `pnpm test` all pass.
