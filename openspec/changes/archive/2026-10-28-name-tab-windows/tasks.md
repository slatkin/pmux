# Tasks

## 1. Name the window on tab spawns

- [x] 1.1 In `pi-extension/pmux/tmux.ts`, add `-n <name>` to the
  `new-window` call in `createSurface`'s `tab` branch, omitting `-n` when
  `name` is empty; extend the branch comment to say tmux disables
  `automatic-rename` for an explicitly named window. Update the "renames
  the pane only" comment at `cli.ts:438` to cover the window. Verify with
  `pnpm run typecheck`.
- [x] 1.2 Extend the `tab` test in `test/tmux.test.ts` ("opens a window and
  restores focus for the tab placement") to assert the recorded
  `new-window` argv carries `-n` and the subagent's name. Verify with
  `node --test test/tmux.test.ts`.
- [x] 1.3 Extend the `tab` case in `test/cli.test.ts` ("opens a tab role in
  its own window and restores the caller's focus") to assert the recorded
  `new-window` command names the window after the child. Verify with
  `node --test test/cli.test.ts`.

## 2. Docs

- [x] 2.1 Where `README.md` and `docs/guide.md` describe the `tab`
  placement, add that the window is named after the subagent — only where
  the surrounding text invites it. Verify with `pnpm run format:check`
  (prose reviewed by hand; Prettier ignores `*.md`).

## 3. Gates

- [x] 3.1 Run `pnpm run format:check`, `pnpm run lint`,
  `pnpm run typecheck` and `pnpm test`; all four must pass. Then commit
  with a conventional scoped message.
