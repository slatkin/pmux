# Tasks

## 1. Buffer logic

- [x] 1.1 Add the five-minute mtime quiet period and three-turn count to `pi-extension/pmux/task-reminders.ts`, and verify the new scenarios in `test/task-reminders.test.ts` pass.
- [x] 1.2 Update the existing test cases in `test/task-reminders.test.ts` to account for the buffer, and verify the full test file passes.
- [x] 1.3 Run `pnpm run typecheck`, `pnpm run lint`, and `pnpm test` and verify all pass.

## 2. Documentation

- [x] 2.1 Update `skills/sidebar-tasks/SKILL.md` to mention the reminder is buffered, and verify the file's wording is consistent with the new behavior.
- [x] 2.2 Update `docs/guide.md` if it mentions the reminder timing, and verify the guide stays accurate.

## 3. Integration check

- [x] 3.1 Run the full suite (`pnpm test`, `pnpm run typecheck`, `pnpm run lint`, `pnpm run format:check`) against the merged result and verify all pass.

## Workflow follow-up

- Archive the change after the project's review requirements are satisfied.
- Verify the archived result.
