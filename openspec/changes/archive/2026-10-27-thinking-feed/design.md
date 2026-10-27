# Design

## Context

See proposal.md for the motivation and `specs/thinking-feed` for the requirements.

- johnny-cant-read's producer is two small modules in its git history: `thinking-feed.ts` (the coalescing producer, injected `append`/`timer`/`now`, 142 lines) and `thinking-feed-file.ts` (path, `ensureThinkingFeed`, `appendThinkingFeedRecord`, 68 lines). johnny's `main` carried both from `31591ed` (2026-10-26) until `91d4e48` (2026-10-27) removed them, so read them from that commit: `git -C ~/Dev/johnny-cant-read show 31591ed:src/stream/thinking-feed.ts` and `31591ed:src/stream/thinking-feed-file.ts`. The wiring is in `31591ed:src/index.ts`: `session_start` (build), `message_update` (`assistantMessageEvent.type` = `thinking_start` / `thinking_delta` / `thinking_end`) and `session_shutdown` (close).
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

### D4. Write only in a directory this uid owns

`ensureThinkingFeed` stats the feed directory after the mkdir and the chmod, and refuses to write when the owner is not this process's uid — a silent refusal, like every other feed failure. The check closes the `/tmp` fallback's pre-creation hole: a directory another account created first still passes the mode steps (the `chmod` fails and is swallowed), and its owner could then swap the session's file for a readable one, or plant a symlink, because the entries of a directory belong to the directory's owner. One ownership check closes both, and only the owner or root can change a directory's owner. The uid is the one the path rule already names (D2).

`appendThinkingFeedRecord` runs the same check before it writes. The ensure happens once, at the session's start, but the directory outlives it, and a foreign directory can be writable (0777), so a mode that lets the write stand proves nothing: a planted file or symlink for the session's feed would receive records through the append entry alone.

*Alternative:* verify the modes instead of the owner. Rejected: the owner of a directory chooses its mode, so a foreign 0700 directory passes a mode check.

## Risks / Trade-offs

- [Model reasoning on disk] → 0700 directory and 0600 file, re-chmod on every ensure, and D4's ownership check before any write; the guards keep it off when the sidebar is off.
- [Feed files are never removed; the `/tmp` fallback keeps them until reboot] → Accepted for now, as in johnny-cant-read. `XDG_RUNTIME_DIR` is cleared at logout.
- [Who removes the `/tmp` fallback's files] → Settled 2026-10-27: pmux-explorer owns deletion, and its `reasoning-tab` change implements it. This change's non-goal on removal therefore stands as it is, and the two no longer contradict each other.
- [Both extensions write thinking at once] → No overlap remains: johnny-cant-read's `remove-stream-panes` change merged to its `main` as `91d4e48` (2026-10-27), before pmux ships, and removed the producer and its wiring.
- [pi changes the `message_update` event shape] → The wiring test drives the three types through a fake `pi`, so a rename shows up as a failing test.

## Migration Plan

No data migration. Old johnny-cant-read feeds are not read by anything new. Ship this before or with pmux-explorer `reasoning-tab`; either order is safe. Rollback: remove the `register` call.
