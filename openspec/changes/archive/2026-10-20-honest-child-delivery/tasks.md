# Tasks

## 1. The run wrapper contacts nobody

- [x] 1.1 `pi-extension/pmux/run.ts` — delete the wake-up block under `if (spec.parent)` in `runSpec` (the `sendToParent`/`agentSend` call, its try/catch, and the `childSidecar` read that only fed it), delete the `sendToParent` member and its doc comment from `RunSpecDeps`, and drop `agentSend` from the `./tmux.ts` import; verify with `rg -n "sendToParent|agentSend|childSidecar" pi-extension/pmux/run.ts` returning no matches
- [x] 1.2 `pi-extension/pmux/tmux.ts` — delete the `agentSend` and `findPaneByName` functions and keep `agentPrompt` unchanged; verify with `rg -n "agentSend|findPaneByName" pi-extension/pmux/tmux.ts` returning no matches and `rg -n "export function agentPrompt" pi-extension/pmux/tmux.ts` matching
- [x] 1.3 `pi-extension/pmux/launch.ts` — reword the `LaunchSpec.parent` doc comment from "Parent pane name; the wrapper wakes it if the child exits without reporting" to the parent's name that the brief footer (and the future `pending --parent` listing) uses; verify with `rg -n "wakes" pi-extension/pmux/launch.ts` returning no matches
- [x] 1.4 Confirm no production code addresses a pane by title anymore: `rg -n "agentSend|findPaneByName" pi-extension skills pmux-done.ts` returns no matches

## 2. The external-parent marker in the child env

- [x] 2.1 `pi-extension/pmux/child-env.ts` — add `externalParent?: boolean` to `ChildEnv`, make `encodeChildEnv` write `PI_PMUX_EXTERNAL_PARENT: "1"` when it is true, and make `decodeChildEnv` set it to `env.PI_PMUX_EXTERNAL_PARENT === "1"`; verify with `rg -c "PI_PMUX_EXTERNAL_PARENT" pi-extension/pmux/child-env.ts` printing `2`
- [x] 2.2 `pi-extension/pmux/cli.ts` — in `startCommand`, pass `externalParent: true` in the `encodeChildEnv` call that builds `specEnv`; `resumeCommand` inherits it because it reuses the spec unchanged; verify with `rg -n "externalParent" pi-extension/pmux/cli.ts` matching
- [x] 2.3 `pi-extension/pmux/supervisor.ts` — confirm the pi-parent `encodeChildEnv` call in `buildSpawnEnvParts` stays without `externalParent`, so a pi-parent child does not carry the marker; verify with `rg -n "externalParent" pi-extension/pmux/supervisor.ts` returning no matches

## 3. pmux_message refuses the parent for a marked child

- [x] 3.1 `pi-extension/pmux/index.ts` — give `resolveMessageTarget` an `externalParent` boolean input: when true, `reachableTargetNames` omits `parent` and `to === "parent"` returns an error that says the parent is an external orchestrator that does not read subagent messages, names the sender's last assistant message as the report, and names `caller_ping` as the way to ask a question; verify with `rg -n "externalParent" pi-extension/pmux/index.ts` matching
- [x] 3.2 `pi-extension/pmux/index.ts` — add `externalParent` to the `sendSubagentMessage` context and pass it to `resolveMessageTarget`, and pass `childEnv.externalParent === true` from the `pmux_message` execute; verify with `rg -n "externalParent" pi-extension/pmux/index.ts` matching in both the context type and the execute call
- [x] 3.3 `pi-extension/pmux/index.ts` — extend the `pmux_message` tool `description` string with a sentence stating that `parent` is reachable only when a pi parent exists; verify with `rg -n "pi parent" pi-extension/pmux/index.ts` matching inside the description

## 4. Tests

- [x] 4.1 `test/cli.test.ts` — delete the `wakes the parent when the child exits` case in the `runSpec` describe and add a case `contacts nobody when the child exits`: `runSpec` with `parent` set in the spec and no `sendToParent` dep asserts the sentinel is printed, stderr stays empty, and the wrapper-error sidecar logic is untouched; verify with `node --test --test-name-pattern "contacts nobody" test/cli.test.ts` passing
- [x] 4.2 `test/cli.test.ts` — extend the `start` env assertions around `spec.env.PI_PMUX_NAME` with `assert.equal(spec.env.PI_PMUX_EXTERNAL_PARENT, "1")`, and assert the spec file after a `resume` still carries the key; name the new tests so each test name literally contains the word `external` (the `--test-name-pattern` gate exits 0 when nothing matches, so it only means something when a matching name exists); verify with `node --test --test-name-pattern "external" test/cli.test.ts` passing
- [x] 4.3 `test/tmux.test.ts` — delete the two `agentSend` cases (`sends to the pane that carries the agent name`, `refuses to send to an unknown agent name`) and the `agentSend` import; verify with `rg -n "agentSend" test/tmux.test.ts` returning no matches and `node --test test/tmux.test.ts` passing
- [x] 4.4 `test/child-env.test.ts` — add `externalParent: false` to the full round-trip literal, assert the minimal decode returns `externalParent: false`, and add a round-trip case where `externalParent: true` encodes `PI_PMUX_EXTERNAL_PARENT: "1"` and decodes back to true; verify with `node --test test/child-env.test.ts` passing
- [x] 4.5 `test/test.ts` — in the messaging describe, add cases for `externalParent: true`: `resolveMessageTarget({to: "parent"})` returns the refusal naming the external orchestrator, the report and `caller_ping`; the reachable list for an unknown target omits `parent`; `sendSubagentMessage` with the marked context appends nothing to the message file; name the new tests so each test name literally contains the phrase `external parent` (the `--test-name-pattern` gate exits 0 when nothing matches, so it only means something when a matching name exists); verify with `node --test --test-name-pattern "external parent" test/test.ts` passing

## 5. Documentation

- [x] 5.1 `docs/guide.md` — in the "Messaging other agents" section, state that `parent` is reachable only when a pi parent exists, that a child the skill launcher marked with `PI_PMUX_EXTERNAL_PARENT` gets an error naming the report and `caller_ping`, and that `parent` is not in that child's reachable list; verify with `rg -n "PI_PMUX_EXTERNAL_PARENT" docs/guide.md` matching
- [x] 5.2 `skills/pmux/SKILL.md` — no wording change is needed; confirm the existing sentence stays true now that the wrapper contacts nobody and the tool refuses: `rg -n "no channel from the child back to" skills/pmux/SKILL.md` matches (the phrase wraps across two lines in the file, so the pattern must stop before the line break)

## 6. Repository gates

- [x] 6.1 Run `pnpm run typecheck` and confirm it passes
- [x] 6.2 Run `pnpm run lint` and confirm zero errors (the pre-existing `no-explicit-any` warnings are expected)
- [x] 6.3 Run `pnpm run format:check` and confirm it passes
- [x] 6.4 Run `pnpm test` and confirm the full suite passes

## Workflow follow-up

- Archive the change with the openspec CLI after acceptance (moves it to `openspec/changes/archive/` and merges the deltas into `openspec/specs/`).
- Push the `feat/2026-10-20-honest-child-delivery` branch and open the PR against main; pushing needs explicit user confirmation.
