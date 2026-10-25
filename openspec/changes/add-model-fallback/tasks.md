# Tasks

## 1. Role key and model resolution

- [x] 1.1 In `pi-extension/pmux/agent-defs.ts`, add `modelFallback?: string` to `AgentDefaults` and parse `model-fallback` in `parseAgentDefinition`; a blank value stores `undefined` (design D3). Verify with parser tests in `test/test.ts`: a role with both keys, a blank key, and a CRLF role file.
- [x] 1.2 In `pi-extension/pmux/launch-build.ts`, add `fallback?: boolean` to `LaunchRecordOverrides`. In `resolveLaunchRecord`, throw the two new errors before any write and pick `effectiveModel` from `modelFallback` when `fallback` is set; apply the `strict` empty-model check to the model that applies (design D1, D2). Verify with tests in `test/launch-build.test.ts` for: record holds the fallback model, `fallback` plus `model` throws, a role without `model-fallback` throws with the role name and path, `strict` with only `model-fallback` succeeds, `strict` without the flag and without `model` still throws the empty-model error, `thinking` and tools are unchanged.
- [x] 1.3 Add a test that reads every file in the bundled `agents/` directory and asserts none sets `model-fallback`. Verify `pnpm test` passes.

## 2. pi parent: spawn and list

- [ ] 2.1 In `pi-extension/pmux/supervisor.ts`, add `fallback` to `SubagentParams` with the description from design D4, and pass `params.fallback` in the `overrides` object that `launchSubagent` builds for its `resolveLaunchRecord` call. Verify with tests in `test/supervisor.test.ts`: a spawn with `fallback: true` writes a launch record with the fallback model; the two error cases create no pane and write no record; a spawn without the parameter is unchanged.
- [ ] 2.2 Add a test that `resume` of a session whose record came from a fallback spawn starts the child on the record's model, and that `pmux_resume` accepts no `fallback` parameter. Verify with `node --test test/supervisor.test.ts`.
- [ ] 2.3 In `pi-extension/pmux/index.ts`, add the fallback text to the `pmux_list` text line and to the TUI line (design D5). Verify with a test that lists a role with and a role without `model-fallback` and checks both lines.

## 3. External orchestrator: CLI and skill

- [ ] 3.1 In `pi-extension/pmux/cli.ts`, add `fallback: { type: "boolean" }` to `CLI_OPTIONS` and `fallback?: boolean` to `CliValues`, add `[--fallback]` to the `start` usage line, and pass `fallback: values.fallback === true` in the `overrides` of `startCommand`. Make `resume` reject the flag with exit 1 and a message that points at `start` (design D6). Verify with tests in `test/cli.test.ts`: `start --fallback` writes a launch spec with the fallback model; the missing-fallback case exits non-zero, writes no scratch file and splits no pane; a role with only `model-fallback` starts; `resume --fallback` exits 1 with no pane.
- [ ] 3.2 In `skills/pmux/SKILL.md`, add `--fallback` to the `start` usage lines and a short paragraph for the cases, the failure and the "no automatic switch" rule from the `external-orchestration` delta. Keep `launch.ts` untouched. Verify by reading the section against the delta scenario "The skill teaches the flag", and run `node --test test/skill-install.test.ts` to confirm the skill still installs.

## 4. Documentation

- [ ] 4.1 In `README.md` (the "Bundled Agents" section), document `model-fallback:` and the `fallback` parameter with one example role file that matches the proposal. State that pmux ships no fallback value, that nothing switches automatically, and that a parent that cannot act (a hard limit on its own model) needs the user to start the child. Verify the example parses by running it through the parser test from 1.1.
- [ ] 4.2 In `docs/guide.md`, add `model-fallback` to the Frontmatter Reference table (next to `model`), `fallback` to the `pmux_spawn` parameter table, and `--fallback` to the external-orchestrator `start` text; note in the `pmux_resume` section that a resumed child keeps its launch model. Verify by reading each edited table row against the spec scenarios and against its neighbours for column consistency. Prettier ignores `*.md`, so `format:check` does not cover this.

## 5. Integration

- [ ] 5.1 Run the commit checks in order: `pnpm run format:check`, `pnpm run lint`, `pnpm run typecheck`, `pnpm test`. Verify all four pass, with no new lint errors (the existing `no-explicit-any` warnings are expected).
- [ ] 5.2 Run `openspec validate add-model-fallback --strict` and verify it passes.

## Workflow follow-up

- Archive the change after review, and verify that the two delta specs merge into `openspec/specs/subagent-supervision/spec.md` and `openspec/specs/external-orchestration/spec.md`.
