# Tasks

## 1. Spawn requires a known role

- [x] 1.1 In `launch-build.ts`, add a `resolveLaunchRecord` option that throws `unknown role '<name>' (searched: ...)` when a given role does not resolve, without the empty-model check of `strict`; verify with tests that an unknown role throws before any file is written and that a role with no `model:` resolves (design D1)
- [x] 1.2 In `supervisor.ts`, make `SubagentParams.agent` a required string and pass the new option from `launchSubagent`; verify with a test that the schema rejects a call without `agent` (spec: Spawn requires a known role, "Missing role")
- [x] 1.3 In `index.ts`, catch the resolution error in `pmux_spawn` and return it as an error result; verify with a test that agent `wroker` returns an error naming `wroker` and the searched paths, splits no pane and writes no launch record, and that a role with no `model:` still launches (spec: "Misspelled role", "Role without a model")
- [x] 1.4 Update the `agent` parameter description, and any README or `docs/guide.md` text that calls `agent` optional; verify that `rg -n -i "agent" README.md docs/guide.md` shows no optional-agent claim

## 2. The skill reads the exit through `wait`

- [ ] 2.1 Rewrite the `last`-mode wait step in `skills/pmux/SKILL.md`: after the status wait, run `wait --session <file> --signal sidecar` and act on its reason; remove every direct read of `<session>.exit` and every `rm` of it; verify that `rg -n '\brm\b|read `<session>\.exit`' skills/pmux/SKILL.md` finds nothing (design D2; spec: The skill waits through the CLI)
- [ ] 2.2 Make the handoff and "pane gone" text in `SKILL.md` read the exit through `wait --signal sidecar`; verify against the "Pane gone after the grace" scenario (spec: Skill documents the handoff sidecar)
- [ ] 2.3 Shorten the send-mode "LEAVE the sidecar" paragraph and its cleanup list to one sentence that says `wait` never deletes the sidecar and the orchestrator must leave it too; verify that the "Packaged orchestration skill" requirement text is still met (design D3)
- [ ] 2.4 Make the `wait` paragraph in `docs/guide.md` match the new `last`-mode recipe, if it reads `.exit` directly; verify that `rg -n '\.exit' docs/guide.md` shows no direct read

## 3. Gates

- [ ] 3.1 Run `pnpm run format:check`, `pnpm run lint`, `pnpm run typecheck` and `pnpm test`; verify that all four pass
- [ ] 3.2 Run `openspec validate productize-orchestrator-guidance --strict`; verify that it passes

## Workflow follow-up

- Archive the change after the project's review requirements are satisfied. If `2026-10-23-report-user-cancel` is archived first, check that its `cancelled` text in `SKILL.md` still uses `wait --signal sidecar`.
- After release, delete the role-omission paragraph ("Every launch passes the role explicitly ...") from `~/Dev/agents/prompts/orchestrator.md`, and keep the sentence that names the role values.
