# Proposal

## Why

pmux-explorer gets a `Thought` tab that shows the last thought of the focused pi pane (pmux-explorer change `reasoning-tab`). The sidebar needs a file of the session's thinking to read. Today only the johnny-cant-read extension writes such a feed (on its `main` line), and its `remove-stream-panes` change deletes that producer. pmux already publishes the pi session's other activity to the sidebar, so the thinking producer moves here.

## What Changes

- The pmux pi extension writes a thinking feed for its session: one JSONL record per phase of a thinking block (`start`, `delta`, `end`), with deltas coalesced to at most one append per 50 ms. The producer is lifted from johnny-cant-read (`src/stream/thinking-feed.ts`, `src/stream/thinking-feed-file.ts`) with its record shape and timing unchanged.
- The feed lives at `$XDG_RUNTIME_DIR/pmux-thinking/<session id>.jsonl`, or `/tmp/pmux-thinking-<uid>/<session id>.jsonl` when `XDG_RUNTIME_DIR` is unset or empty, in a 0700 directory as a 0600 file. This is a new path; johnny-cant-read's `johnny-cant-read/streams/<session>/thinking.jsonl` is not used.
- The feed is written under the sidebar's two guards: only in a tmux pane (`$TMUX_PANE` set) and not when `PMUX_EXPLORER=0`. The sidebar's binary lookup is not one of them: the feed is written whether or not pmux-explorer is installed.
- No follower pane, no `/stream` command, no tool feed: those stay in johnny-cant-read until its own change removes them.

## Capabilities

### New Capabilities
- `thinking-feed`: the file of a pi session's thinking that the extension writes for the sidebar — its path, record shape, write timing, guards and file modes.

### Modified Capabilities
- (none)

## Impact

- Code: new `pi-extension/pmux/thinking-feed.ts`, `pi-extension/pmux/thinking-feed-file.ts` and `pi-extension/pmux/thinking-feed-events.ts`; `index.ts` registers the events module next to the sidebar events, and the module wires `session_start`, `message_update` and `session_shutdown`.
- Tests: new `test/thinking-feed.test.ts` (lifted from johnny-cant-read's producer tests) plus path and wiring tests.
- Contract: the path and record shape are shared with pmux-explorer and written down in its `docs/agent-protocol.md`. Both repositories pin the same path vector.
- Privacy: model reasoning is written to disk in a user-private directory.
- Follow-up outside this repository: johnny-cant-read's `remove-stream-panes` change drops the thinking producer (already implemented on its branch; only that change's merge remains).
