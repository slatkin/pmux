# Tasks

## 1. The async read

- [x] 1.1 `tmux.ts`: `readWindowOptionsAsync`, the async counterpart of `readWindowOptions`.
- [x] 1.2 `index.ts`: `readSidebarWorktree` returns a promise, and a failed read still resolves `undefined`.

## 2. The publisher

- [x] 2.1 `sidebar.ts`: `SidebarPublisher.publishAfter` reserves the queue slot synchronously.
- [x] 2.2 `sidebar.ts`: the load and the hook run inside that step, and a failed load publishes nothing without breaking the chain.

## 3. The session-start handler

- [x] 3.1 `sidebar-events.ts`: `readWorktree` returns a promise.
- [x] 3.2 `sidebar-events.ts`: `session_start` publishes through `publishAfter` when the publisher can publish, and immediately (no read) when it cannot.

## 4. Tests

- [x] 4.1 The `session_start` handler returns before the worktree read starts, and the read then runs off the caller's thread.
- [x] 4.2 `session-start` still applies before a `user-prompt-submit` published while its read is outstanding.
- [x] 4.3 `publishAfter` spawns nothing until its payload resolves, then in publish order.
- [x] 4.4 A load that rejects publishes nothing, and the next publish still spawns.
- [x] 4.5 `publishAfter` publishes nothing, and loads nothing, when a guard fails.

## 5. Docs

- [x] 5.1 `docs/guide.md`: the worktree read runs in the background and a busy tmux server cannot freeze the session.
