# Tasks

## 0. Prerequisite

- [x] 0.1 Confirm that the `pmux-explorer` change `channel-endpoint` is
  merged, and that its endpoint path test vector is
  `79301cf9592f327a-12.sock` for `/tmp/tmux-1000/default,1,0` + `%12`.
  Verify by reading its merged spec and test. Do not start group 1 before
  this is done.

  Verified 2026-10-25: slatkin/pmux-explorer PR #11 MERGED
  (merge commit `4ab2ecd`). Its merged spec
  (`openspec/changes/channel-endpoint/specs/channel-endpoint/spec.md`,
  "Endpoint path" + "Shared test vector") pins the same vector
  (`/run/user/1000/pmux-channel/79301cf9592f327a-12.sock` for
  `TMUX=/tmp/tmux-1000/default,1,0` + `TMUX_PANE=%12`), the same path
  rule (FNV-1a 64 of the first `TMUX` comma field, pane without `%`),
  and the same report request shape
  (`{"v":1,"kind":"report","id","text","bytes","token"}`),
  which is what `channel-endpoint.ts` sends.

## 1. Channel endpoint client

- [x] 1.1 Add `pi-extension/pmux/channel-endpoint.ts` with the path rule
  (`report-channel`, "Channel endpoint path"; D1): the `XDG_RUNTIME_DIR`
  or `/tmp/pmux-channel-<uid>` directory, FNV-1a 64 of the tmux socket
  path, the target pane number. Verify with
  `test/channel-endpoint.test.ts`: the shared vector
  (`/tmp/tmux-1000/default,1,0` + `%12` →
  `79301cf9592f327a-12.sock`), the unset runtime dir, a different caller
  pane, and `TMUX` unset → `no-endpoint`.
- [x] 1.2 Add the socket client (`node:net` only): one request line, one
  reply line, a 2 s overall timeout (injectable through the test seam,
  so the timeout case does not wait 2 real seconds), and the result
  classes (`emitted`;
  `unavailable` with `no-endpoint`, `refused`, `timeout`, `unarmed`,
  `write-failed`, `invalid`, `bad-reply`). Add the test seam
  `__setChannelConnectForTests__`. Verify with tests against a real
  socket in a temp dir (`test/temp-dir.ts`): each reason, and the exact
  request fields.

## 2. Transport routing

- [x] 2.1 Route `submitReportPointer` in `report-delivery.ts` channel first,
  then the verified input (D3). Add `submitChannel` to
  `ReportDeliveryDeps`. The result carries `via` and, after a fallback,
  `channelError`. Verify in `test/report-delivery.test.ts`: `emitted` →
  the tmux submitter is not called; `unavailable` → it is called once
  with the same pointer; both fail → `not-submitted` with
  `channelError`; `emitted` plus an ack timeout → no tmux call and
  `acknowledged:false`.
- [x] 2.2 Check that the existing suites pass with no change: `host-env.ts`
  removes `TMUX`, so every current test gets `no-endpoint` and takes the
  fallback. Verify with `pnpm test`.
- [x] 2.3 Add a `run.test.ts` case: exit re-delivery of an unacknowledged
  report through an injected `submitChannel` that returns `emitted` →
  the same ID, a fresh token, and no pane input. Verify with
  `node --test test/run.test.ts`.

## 3. Records and output

- [x] 3.1 In `report-receipt.ts`, write `via` and `channelError` on the
  `notification` record, and read a record without `via` as `tmux` (D5).
  Verify in `test/report-receipt.test.ts`: both new shapes and an old
  record.
- [x] 3.2 In `cli.ts` `sendMarkedCommand`, add `via` and `channelError` to
  the result line, and `channelError` to the refusal line. Verify in
  `test/cli.test.ts`: the "Report delivered by the channel", "Report
  delivered by the fallback" and "Submission refused" scenarios of the
  `external-orchestration` delta.

## 4. Documentation

- [x] 4.1 `skills/pmux/SKILL.md`: add a "Channel wake-up" section: start
  Claude with
  `--dangerously-load-development-channels plugin:pmux-explorer@slatkin`,
  the requirements (claude.ai or Console auth, org `channelsEnabled`, an
  interactive session), the `via` field, and that `send-keys` stays the
  fallback. Verify by reading it against `report-channel`.
- [x] 4.2 `docs/guide.md` and `AGENTS.md` ("Completion and env contracts"):
  one paragraph each for the channel transport and the `via` field.
  Verify by hand (Prettier skips `*.md`).
- [x] 4.3 Run the four pre-commit checks: `pnpm run format:check`,
  `pnpm run lint`, `pnpm run typecheck`, `pnpm test`. Then run
  `openspec validate channel-report-wake --strict`.

## Workflow follow-up

- Archive the change after its PR merges.
