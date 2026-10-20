# Tasks

## 1. Extension modules

- [x] 1.1 Delete `pi-extension/pmux/stream-state.ts`, `pi-extension/pmux/stream-projection.ts` and `pi-extension/pmux/stream-tail.mjs`, and verify `ls pi-extension/pmux/` no longer lists them
- [x] 1.2 Strip the stream code from `pi-extension/pmux/index.ts`: the `stream-state.ts` and `stream-projection.ts` imports, the `StreamRuntime` interface, `STREAM_KEY`, `retireStreamRuntime`, the hub and attach-state helpers, `warnStreamProjection`, `syncStreamProjection`, `captureStreamTui`, the `StreamCommandDeps` interface, `handleStreamCommand`, `streamOpenGate`, `openStreamPanes`, `closeStreamPanes`, `registerStreamEventHandlers`, the `pi.registerCommand("stream", …)` registration, the `pmux-streams` widget, the stream hooks in `session_start` and `session_shutdown`, the `registerStreamEventHandlers(pi, streamHub)` call, and the `__test__` stream hooks; verify `rg -n -i "stream" pi-extension/pmux/index.ts` returns no hit
- [x] 1.3 Remove the now-unused `splitPane` and `namePane` imports from `pi-extension/pmux/index.ts` and verify `pnpm run lint` reports no unused-import error
- [x] 1.4 Remove `streamTailScriptPath` and `tailerCommandLine` from `pi-extension/pmux/launch.ts` and its `StreamName` import, keeping `assertPaneToken` and `paneCommandLine`; verify `rg -n "tailer|StreamName" pi-extension/pmux/launch.ts` returns no hit
- [x] 1.5 Verify the extension still loads and the subagent tools still work: run `pnpm run typecheck` and confirm it passes with the stream modules gone

## 2. Tests

- [x] 2.1 Delete `test/stream-state.test.ts`, `test/stream-runtime.test.ts`, `test/stream-command.test.ts`, `test/stream-projection.test.ts`, `test/stream-projection-wiring.test.ts` and `test/stream-tail.test.ts`, and verify `ls test/` shows no stream test file
- [x] 2.2 Delete the helpers `test/stream-fakes.ts` and `test/stream-harness.ts`, and verify `rg -n "stream-fakes|stream-harness" test/` returns no hit
- [x] 2.3 Verify the remaining suite still passes: run `pnpm test` and confirm every remaining test passes

## 3. Documentation and spec bookkeeping

- [x] 3.1 Remove the "Stream panes" section from `docs/guide.md` and verify `rg -n -i "stream" docs/guide.md` shows only the `streaming` activity word in the status section
- [x] 3.2 Update `AGENTS.md`: drop the "Stream panes" section, drop the stream runtime from the `/reload` globalThis sentence, and drop `stream-fakes.ts` and `stream-harness.ts` from the test-helper list; verify `rg -n -i "stream" AGENTS.md` returns no hit
- [x] 3.3 Run `pnpm run format:check` and `pnpm run lint` and verify both pass with the stream code gone

## Workflow follow-up

- Archive the change once the tasks above are done.
- After the archive, check `openspec list --specs`: the delta removes every requirement of `stream-panes`, so the capability is empty. Delete `openspec/specs/stream-panes/spec.md` if the archive left it in place, and verify `openspec list --specs` no longer lists `stream-panes`.
- Verify the archived result: `openspec validate --strict` passes and `rg -n -i "stream" pi-extension test docs AGENTS.md` finds no stream-pane code left in the package.
