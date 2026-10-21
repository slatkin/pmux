# Tasks

## 1. Shared builder module

- [x] 1.1 Create `pi-extension/pmux/launch-build.ts` and move `writeRunContextFile`, `buildPiLaunch`, `buildSubagentTaskPrompt`, `buildLaunchMessagingHint`, `resolveModeHint`, `buildPiPromptArgs` and `buildSpawnEnvParts` into it from `supervisor.ts`. Re-export the moved names from `supervisor.ts`. Verify that `pnpm test` passes with no test change.
- [x] 1.2 Change `buildPiLaunch` to return only the `LaunchSpec`, and build `RunningSubagent` in `supervisor.ts` (design D2). Verify that `pnpm test` and `pnpm run typecheck` pass.
- [ ] 1.3 Add the `ParentContact` input (design D3) and move `reportFooter`, `parentFooter` and `sendFooter` from `cli.ts` into the module. The supervisor passes the `pi` kind. Add tests in `test/launch-build.test.ts`. For `last` and `send`, the `external` kind gives `task + "\n" + footer`, pinned to today's bytes. It sets `PI_PMUX_EXTERNAL_PARENT`, `parent`, `report` and `closeOnDone`. It applies the send-mode bash rule. Verify that the new tests pass.
- [ ] 1.4 Add `resolveLaunchRecord` (design D6) and the optional record fields `parentSessionId` and `closeGraceMs` in `launch-record.ts`. Make `launchSubagent` use it. Add tests for the unknown-role and empty-model errors and for the new fields. Verify that `pnpm test` passes.

## 2. Parent session id

- [ ] 2.1 Add a pane-option read to `tmux.ts` (`show -pv -t <pane> @pane_session_id`) through `__setTmuxExecForTests__`. A failure or an empty value returns `null`. Test both cases with the seam. Verify with `node --test test/tmux.test.ts`.

## 3. CLI on the shared builder

- [ ] 3.1 Rewrite `startCommand` to call `resolveLaunchRecord`, write `<session>.launch.json`, compute the artifact directory (design D5) and call `buildPiLaunch` with the `external` kind. Remove the `.prompt.md` and `.role.md` writes and the prompt argument on the pane line. Update `test/cli.test.ts` for the new prompt path, the record file, the `@pane_session_id` path and the fallback path. Verify that the "Task prompt location", "Parent session id" and "Per-child launch spec" scenarios have passing tests.
- [ ] 3.2 Rewrite `resumeCommand` to read the record, rebuild the spec with `resume.message`, write it over `--launch` and run it (design D7). Refuse a spec without a record with exit 1. Remove the `.resume.md` write. Update `test/cli.test.ts` for the resume scenarios, the close grace and the refusal. Verify that `pnpm test` passes.
- [ ] 3.3 Remove the code in `cli.ts` that steps 3.1 and 3.2 left unused. Verify with `pnpm run lint` and `pnpm run typecheck`.

## 4. Documentation

- [ ] 4.1 Update `skills/pmux/SKILL.md` (scratch contents, the resume refusal) and the "Two ways to launch a child" section of `AGENTS.md` to name `launch-build.ts`. Verify by reading the changed text against the spec delta.

## 5. Integration

- [ ] 5.1 Run `pnpm run format:check`, `pnpm run lint`, `pnpm run typecheck`, `pnpm test` and `openspec validate unify-launch-builder --strict`. Verify that all pass.
- [ ] 5.2 Make sure that the prompt path from a `start` test matches the tmux-agent-sidebar `parse_pmux_task` shape: the last four segments are `artifacts/<id>/context/<name>-<19-char timestamp>.md`. Verify with a test assertion on the path.

## Workflow follow-up

- The user runs the live test: a Claude Code orchestrator starts a child, and the sidebar shows the badge, the task name and the parent link.
- Archive the change after review.
