# Design

## Context

See proposal.md for the motivation and `specs/thinking-feed` for the requirements.

- johnny-cant-read's producer is two small modules in its git history — its `feat/remove-stream-panes` branch deletes them, so take them from `git -C ~/Dev/johnny-cant-read show main:src/stream/thinking-feed.ts` and `main:src/stream/thinking-feed-file.ts`: `thinking-feed.ts` (the coalescing producer, injected `append`/`timer`/`now`, 142 lines) and `thinking-feed-file.ts` (path, `ensureThinkingFeed`, `appendThinkingFeedRecord`, 68 lines). It was wired in johnny's `index.ts` (also on `main`) from `session_start` (build), `message_update` (`assistantMessageEvent.type` = `thinking_start` / `thinking_delta` / `thinking_end`) and `session_shutdown` (close).
- pmux's sidebar publisher (`pi-extension/pmux/sidebar.ts`) already holds the guards this feed needs: `sidebarSwitchEnabled(env)` and a `TMUX_PANE` check.
- `pi-extension/pmux/channel-endpoint.ts` holds the runtime-dir rule (`$XDG_RUNTIME_DIR/<name>`, else `/tmp/<name>-<uid>`) that pmux-explorer mirrors.
- The reader is pmux-explorer's `Thought` tab (its change `reasoning-tab`). It reads only the newest block, so the record shape must stay exactly johnny's.

## Goals / Non-Goals

**Goals:**
- Lift the producer with its behavior unchanged, so johnny's producer tests port with only path and style edits.
- A path both repositories derive with no registry and pin with the same test vector.

**Non-Goals:**
- The follower panes, the `/stream` command, the tool feed, FIFOs and liveness from johnny-cant-read.
- Rotation or deletion of feed files.
- Any change to the sidebar hook events.

## Decisions

### D1. Lift the two modules as they are

`thinking-feed.ts` moves with no logic change: the `ThinkingFeedRecord` shape, `THINKING_FLUSH_MS = 50`, the per-producer `randomUUID()` token, flush-before-start, flush-before-end, the empty-end rule and `close()`. Only the code style changes to pmux's (two-space indent, pmux lint config). `thinking-feed-file.ts` keeps `ensureThinkingFeed` and `appendThinkingFeedRecord`, and gets a new path function (D2).

*Alternative:* write a new, smaller producer. Rejected: the user asked for a lift, and the timing and empty-end rules already have tests.

### D2. A flat per-user directory with the session id as file name

`thinkingFeedPath({ env, sessionId, uid })` returns `<dir>/<session id>.jsonl` with `<dir>` from the same rule as `channelEndpointPath`, under the name `pmux-thinking`. johnny's layout (`johnny-cant-read/streams/<session>/thinking.jsonl`) existed to sit beside its FIFOs and tool feed; pmux has neither, so one directory with one file per session is enough. The function returns `null` for a session id that is empty, `.`, `..` or contains `/`, so a strange id cannot write outside the directory. A test pins `XDG_RUNTIME_DIR=/run/user/1000`, `abc` → `/run/user/1000/pmux-thinking/abc.jsonl` and the `/tmp` fallback, the same vector pmux-explorer pins.

### D3. Wire it in its own module

A `createThinkingFeed(deps).register(pi)` module, in the shape of `createSidebarEvents`, owns the session's producer:

- `session_start`: close the previous producer (flush), then, if the guards pass and the path is not `null`, `ensureThinkingFeed` and build a new producer for `ctx.sessionManager.getSessionId()`.
- `message_update`: map the three `assistantMessageEvent` thinking types onto `started` / `delta` / `ended`; ignore every other type.
- `session_shutdown`: `close()` and drop the producer.

Guards reuse `sidebarSwitchEnabled` and a `TMUX_PANE` check from `sidebar.ts`, with the env injected, so tests need neither tmux nor pi. The publisher's `canPublish` and its binary lookup are not reused: a missing pmux-explorer binary must not silence the feed.

## Risks / Trade-offs

- [Model reasoning on disk] → 0700 directory and 0600 file, re-chmod on every ensure; the guards keep it off when the sidebar is off.
- [Feed files are never removed; the `/tmp` fallback keeps them until reboot] → Accepted for now, as in johnny-cant-read. `XDG_RUNTIME_DIR` is cleared at logout.
- [On johnny's `main`, both johnny-cant-read and pmux write thinking] → They write to different paths, so neither breaks; the cost doubles only for users on `main` until johnny's `remove-stream-panes` change (already implemented there) merges.
- [pi changes the `message_update` event shape] → The wiring test drives the three types through a fake `pi`, so a rename shows up as a failing test.

## Migration Plan

No data migration. Old johnny-cant-read feeds are not read by anything new. Ship this before or with pmux-explorer `reasoning-tab`; either order is safe. Rollback: remove the `register` call.
