# Tasks

## 1. Report artifacts

- [x] 1.1 Add `pi-extension/pmux/report-artifact.ts`: 32-hex report IDs,
  `<session>.<id>.report.md` naming, the atomic tmp+rename write whose
  temporary name also ends in `.report.md`, and pointer construction
  with shell-quoted paths and the `pmux-eom-<token>` tail (D2, D3).
  Verify with tests: UTF-8 and multiline bodies are stored unencoded,
  concurrent sends mint distinct IDs, a write failure refuses before
  any pane call.

## 2. Event log

- [x] 2.1 Extend `pi-extension/pmux/report-receipt.ts` into the event
  log: the `report`, `notification` and `ack` record writers and a
  state reader that returns report registrations, notifications and
  acked IDs per session (D5). Kindless lines parse as legacy
  notifications; malformed lines and unknown kinds are skipped.
- [x] 2.2 Keep `countReportsTo` counting kindless lines only, so a new
  `report` registration can never pass as a legacy delivery (D5).
  Verify with tests.

## 3. Verified submission

- [x] 3.1 Add `verifiedAgentPrompt` to `pi-extension/pmux/tmux.ts`
  beside `agentPrompt` (D4): `pane_in_mode` refusal, baseline visible
  capture with the token absent, one `send-keys -l`, the 100 ms/2 s
  token poll, the final recheck, exactly one Enter, `not-submitted` /
  `unknown` outcomes, and an injectable sleep. Assert no failure path
  ever sends Escape or Ctrl-U.
- [x] 3.2 Add `pi-extension/pmux/report-delivery.ts`: the shared
  submit-then-await-ack flow used by `send` and the wrapper (D6, D8).

## 4. CLI

- [x] 4.1 Make `sendCommand` async and protocol-aware (D1, D6): marker
  absent keeps the legacy path and JSON; marker present requires
  `PI_PMUX_SESSION`; `--ack-timeout` (default 15 s, poll 250 ms, `0`
  allowed, invalid in legacy mode); the exit-0/exit-2/exit-1 JSON
  shapes.
- [x] 4.2 Add `ack --session <file> --id <id>` (D7): ID validation,
  artifact-exists check, idempotent append, `alreadyAcknowledged`,
  exit 2 on missing artifact or failed append. Add both commands to
  the usage text.
- [x] 4.3 In `launch-build.ts`, set `PI_PMUX_REPORT_PROTOCOL` for
  send-mode specs and write the new send footer (D1, D6): pointer
  semantics, `sent` vs `acknowledged`, no child retry after timeout,
  `sent:false` means call `pmux_done`.

## 5. Wrapper

- [x] 5.1 In `run.ts`, branch on the spec-env marker (D1, D8): marked
  specs snapshot current-run report IDs and legacy counts before
  spawn; after the sentinel, re-deliver each unacknowledged parent
  report in registration order — same ID, fresh token, no ack wait,
  ack recheck before each retry; `cancelled` stays quiet.
- [x] 5.2 Make the no-report wake-up durable (D8): write the wake text
  (exit state, or `<name> pinged: <message>`) to its own artifact and
  deliver its pointer through the verified path instead of typing the
  raw message. Replace `sendToParent` with an injectable async
  `deliverReport` seam.
- [x] 5.3 Verify with tests: acked suppression, unacknowledged retry,
  retry after `not-submitted`, multiple reports, other-pane reports
  ignored, baselines on resume, durable ping/no-report/crash wakes,
  stderr-only retry failure, close-after-retry ordering.

## 6. Pinned tests and docs

- [x] 6.0 Migrate the tests the new footer and protocol break: the
  `sendFooterBytes` golden text in `test/launch-build.test.ts` (asserted
  near lines 158, 240, 410, 419) and the `.sent` receipt and
  `sendSpecWithReceipt` fixtures in `test/cli.test.ts` (near lines
  511-538, 1150, 1168, 1750). Keep the legacy assertions where they
  describe unmarked behaviour.

- [x] 6.1 Update `skills/pmux/SKILL.md`: the send-mode section teaches
  the pointer workflow — read the named file, run the embedded `ack`
  command, dedup repeat pointers by report ID, do not touch report
  files or `.sent`; the wrapper paragraph describes same-ID
  re-delivery; remove every claim that the confirmation line proves
  arrival.
- [x] 6.2 Update `docs/guide.md` and `README.md` send-mode prose to
  match.

## 7. Gates

- [x] 7.1 Run `pnpm run format`, `pnpm run lint`,
  `pnpm run typecheck` and `pnpm test`.
