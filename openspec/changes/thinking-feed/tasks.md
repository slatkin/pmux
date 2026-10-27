# Tasks

## 1. Lift the producer

- [x] 1.1 Copy `src/stream/thinking-feed.ts` from johnny-cant-read's `main` (`git -C ~/Dev/johnny-cant-read show main:src/stream/thinking-feed.ts`; the `feat/remove-stream-panes` checkout has deleted it) to `pi-extension/pmux/thinking-feed.ts` with no logic change, in pmux style; port its tests from `main:test/stream-thinking-feed.test.ts` to `test/thinking-feed.test.ts` and verify they pass with `pnpm test` (coalescing within 50 ms, flush before `start` and `end`, empty-end without `text`, `close()` flush, empty delta writes nothing)
- [x] 1.2 Copy `src/stream/thinking-feed-file.ts` from `main:src/stream/thinking-feed-file.ts` to `pi-extension/pmux/thinking-feed-file.ts`, replacing its path function with `thinkingFeedPath({ env, sessionId, uid })` (design D2); verify with tests for the `XDG_RUNTIME_DIR` vector, the `/tmp/pmux-thinking-<uid>` fallback, a rejected session id (`../x` as in the spec, and one representative of the rest, e.g. empty), and the 0700/0600 modes on a fresh and on a pre-existing directory

## 2. Wire it into the extension

- [x] 2.1 Add `pi-extension/pmux/thinking-feed-events.ts` with `createThinkingFeed(deps).register(pi)` (design D3) and register it in `index.ts`; verify with fake-`pi` tests that a session in tmux writes `start`/`delta`/`end` records, a new `session_start` switches to the new id's file, `session_shutdown` flushes pending text, and no file is created with no `TMUX_PANE` or with `PMUX_EXPLORER=0`, while the feed is still written when no pmux-explorer binary is found
- [x] 2.2 Verify that a failing append or an unwritable directory raises nothing into pi, with a test that injects a throwing `append` and a directory that cannot be created

## 3. Documentation

- [x] 3.1 Describe the thinking feed in `docs/guide.md` (what it holds, where it lives, that it is private and follows `PMUX_EXPLORER=0`) and point to pmux-explorer's `docs/agent-protocol.md` (written by its `reasoning-tab` change) for the record contract; verify the path and field names match `specs/thinking-feed`

## 4. Integration

- [x] 4.1 Run `pnpm test`, `pnpm typecheck` and `pnpm lint`; verify all pass, then run pi in a tmux pane with a thinking model and verify `$XDG_RUNTIME_DIR/pmux-thinking/<session id>.jsonl` gets `start`, `delta` and `end` records with modes 0700/0600

## Workflow follow-up

- johnny-cant-read's `remove-stream-panes` change removes the thinking producer (implemented on its branch); nothing to do in that repository from here.
