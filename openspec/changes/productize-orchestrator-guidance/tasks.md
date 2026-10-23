# Tasks

## 1. Strict role resolution and effective-role surfacing (pi path)

- [ ] 1.1 In `supervisor.ts` `launchSubagent`, pass `strict: true` to `resolveLaunchRecord` and wrap a resolution failure in an error tool result (no pane, no launch record); verify with a test that a spawn with an unknown `agent` returns an error naming the role and the searched paths and splits no pane (design D1)
- [ ] 1.2 In `index.ts`, make the `pmux_spawn` acknowledgement text and result details name the effective role (resolved name, or "default agent" when `agent` was omitted); verify with tests for both the role-given and role-omitted acknowledgements (design D2, spec: Spawn result names the effective role)

## 2. Nudge and close commands with pane ownership

- [ ] 2.1 In `tmux.ts`, mark every pane the shared surface-creation path creates with the `@pmux_owned` pane option; verify with a test that the creation helper issues the marker call (design D6)
- [ ] 2.2 Add `nudge --pane <pane> --text <text>` to `cli.ts`, reusing the `pane-input.ts` encode-and-type path (no receipt), printing `{"nudged":true,...}`; verify with tests for delivery, the JSON answer, and the missing-flag usage error (design D5)
- [ ] 2.3 Add `close --pane <pane>` to `cli.ts`, killing only panes that carry `@pmux_owned` and printing one confirmation line; verify with tests for closing an owned pane, refusing an unowned pane (non-zero exit, pane left alone), and the missing-flag usage error (design D6)

## 3. Sidecar wait hint

- [ ] 3.1 Add `hintForExit(reason)` beside `interpretExitSidecar` in `exit-sidecar.ts`, with one hint text per reason (`done`, `handoff`, `ping`, `error`) naming the next CLI action; verify with a pinned test per reason (design D4)
- [ ] 3.2 Make `wait --signal sidecar` add `hint` to the success JSON and to the timeout JSON (`{"sidecar":null,"hint":...}`, naming waiting again or `nudge`); verify with tests for the success line and the timeout line (spec: Sidecar wait names the next action, Sidecar wait failures)

## 4. Orchestrator pane titling

- [ ] 4.1 Add a `tmux.ts` helper that titles a pane `<window-name>-orchestrator` once, guarded by the `@pmux_orchestrator_titled` pane option, swallowing tmux failures; verify with tests for the first call (title set, marker set) and a marked pane (no title call) (design D3)
- [ ] 4.2 Call the helper from the supervisor's spawn path (parent's own pane) and from `cli.ts start` (`TMUX_PANE`); verify with tests that both call sites invoke it and that a tmux failure does not fail the launch (design D3)

## 5. Skill documentation

- [ ] 5.1 Update `skills/pmux/SKILL.md`: replace the `send-keys` nudge recipe with `nudge`, the `kill-pane` cleanup with `close`, document the wait JSON `hint` field, and drop the manual `select-pane -T` step; verify the file contains no `send-keys` or `kill-pane` recipe and names `nudge`, `close` and `hint` (spec: Skill recipes use the CLI)

## 6. Gates

- [ ] 6.1 Run `pnpm run format:check`, `pnpm run lint`, `pnpm run typecheck` and `pnpm test`; verify all four pass
- [ ] 6.2 Run `openspec validate productize-orchestrator-guidance --strict`; verify it passes

## Workflow follow-up

- Archive the change after the project's review requirements are satisfied.
- After release, slim the two orchestrator prompts in user config (`~/.pi/agent/prompts/orchestrator.md`, `~/.claude/commands/pi-orchestrator.md`): drop the finish instruction, the role-omission warning, the sidecar-lifecycle prose, and the manual pane-titling step.
