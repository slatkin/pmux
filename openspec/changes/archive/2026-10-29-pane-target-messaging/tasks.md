# Tasks

## 1. Pane listing primitive

- [x] 1.1 In `pi-extension/pmux/tmux.ts`, add `PaneTargetRow` (pane_id,
  title, command, pane_index, pane_active, session_id, session_name,
  window_id, window_index, window_name) and `listPaneTargets()`, which
  runs `tmux list-panes -a -F` with `pane_title` as the last `|`-separated
  field (design D3) and parses each row, rejoining title overflow. Verify
  with `pnpm run typecheck`.
- [x] 1.2 Add a `test/tmux.test.ts` case faking `__setTmuxExecForTests__`
  that asserts the `list-panes -a` argv and the row parsing, including a
  title containing `|`. Verify with `node --test test/tmux.test.ts`.

## 2. Resolution and the shell gate

- [x] 2.1 In `pi-extension/pmux/index.ts`, extend `SubagentRelation` with
  `"pane"`, and `resolveMessageTarget` with optional `panes`/`callerPane`
  params plus candidate-pane-id matching and the tmux precedence
  (pane id → target syntax → pane title, design D2): session-less forms
  anchor on the caller pane's session row, a window without a pane part
  resolves to its `pane_active` row, ambiguity errors list pane ids, and
  the no-match error appends a pane note when a listing was attempted.
- [x] 2.2 In `sendSubagentMessage`, take one `deps.panes` snapshot
  (guarded: a throw leaves it undefined), pass it with `context.callerPane`
  to `resolveMessageTarget`, and refuse before `deps.prompt` when the
  resolved pane's `pane_current_command` basename is in the shell
  denylist (design D4). Wire `listPaneTargets` and `callerPaneId()` at the
  tool registration. Verify with `pnpm run typecheck`.
- [x] 2.3 Update `SubagentMessageParams.to`'s description, the
  `pmux_message` tool description, and the empty-target/unknown-target
  error texts to name the pane forms and the shell refusal. Update the
  launch messaging hint in `launch-build.ts` to mention pane addressing
  in one clause.
- [x] 2.4 Add `test/test.ts` cases: foreign `%N` delivery with relation
  `pane`; managed pane id keeps its relation; `sess:win.pane`, `win.pane`,
  `win` → active pane and bare pane index, all anchored on the caller's
  session; exact-title match; ambiguous window and title errors; shell
  refusal for a foreign pane and for a managed pane that dropped to a
  shell; failed listing leaves agent delivery working. Verify with
  `node --test test/test.ts`.

## 3. Docs

- [x] 3.1 Update the "Messaging other agents" section of `docs/guide.md`
  (reachable targets, the pane forms and the shell refusal) and the
  `pmux_message` description anywhere else it names reachable targets.
  Verify with `pnpm run format:check` (prose reviewed by hand; Prettier
  ignores `*.md`).

## 4. Gates

- [x] 4.1 Run `pnpm run format:check`, `pnpm run lint`,
  `pnpm run typecheck` and `pnpm test`; all four must pass. Then commit.
