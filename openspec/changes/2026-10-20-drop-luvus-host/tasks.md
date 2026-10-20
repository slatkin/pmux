# Tasks

## 0. Prerequisite

- [x] 0.1 Archive `2026-10-20-tmux-backend` before this change is applied or archived (design: Prerequisite).

## 1. Remove the Luvus host (D1, D8)

- [x] 1.1 Delete `pi-extension/luvus/luvus.ts`. Point `status.ts` at `placement.ts` for `DEFAULT_SURFACE_PLACEMENT`, `parseSurfacePlacement` and `SurfacePlacement`. Add `tmuxSetupHint` to `tmux.ts`.
- [x] 1.2 Delete `pi-extension/luvus/luvus-status.ts` and the reporter calls in `index.ts` and `luvus-done.ts`. Task 2.1 replaces them.
- [x] 1.3 Delete `pi-extension/luvus/uhp-events.ts`, the `events` dependency in `index.ts` and `supervisor.ts`, the event watch at `supervisor.ts` (`releaseEventWatch`) and the event stream shutdown. Polling stays.
- [x] 1.4 Delete `pi-extension/luvus/backend.ts`. Point `cli.ts`, `run.ts`, `turn-notify.ts`, `supervisor.ts` and `index.ts` at `tmux.ts`, `placement.ts`, `exit-sidecar.ts` and `surface-types.ts`. Use `isTmuxAvailable` and `tmuxSetupHint`. Delete `activeHost`, `Host` and the `target` parameters.
- [x] 1.5 Drop the Luvus branch from the CLI: `hostOf`, the host argument of `parentFooter`, and the launch path. The footer states that the last assistant message is the report and names the parent and its `%` pane id.
- [x] 1.6 Remove `listLuvusSessionsAsync`, `matchLuvusSession`, the cached lookup and the `luvusSession` field from the handoff log in `luvus-done.ts` and `context-alert.ts`.
- [x] 1.7 Change the interrupt error text to `via tmux`.

## 2. Status file (D2, D3, D9)

- [x] 2.1 In the child extension, write `<session file>.status` (whole-file replace) for `working`, `idle`, and the terminal `done` and `blocked` writes before the sidecar write. Latch after a terminal write. Write nothing without `PI_PMUX_SESSION`. A failed write must not block a turn, the sidecar or shutdown.
- [x] 2.2 Remove `<session file>.status` in `pmux_spawn`, `pmux_resume`, `start` and `resume`, before the child starts.
- [x] 2.3 In `cli.ts run`, write `blocked` with the exit code when the child exits with no sidecar and no terminal status.
- [x] 2.4 Add `wait --session <file> [--status <list>] [--timeout <s>]` to the CLI, with the exit codes and output of the `pmux-host` spec. Add it to the CLI help text.

## 3. External orchestration (D2, D3, D4)

- [x] 3.1 Rewrite the skill's completion wait to use `launch.ts wait` and a read of `<session>.exit` after it.
- [x] 3.2 Rewrite the skill's report reading to use `last-message --session <file>`.
- [x] 3.3 Replace the Luvus agent commands and the Luvus text in the skill and the launcher shim. Keep `launch.ts` self-contained (Node built-ins only).

## 4. Rename (D6)

- [x] 4.1 Rename the tools: `luvus_spawn`, `luvus_resume`, `luvus_message`, `luvus_list`, `luvus_interrupt`, `luvus_done` become `pmux_*`.
- [x] 4.2 Rename the slash commands `/luvus-spawn` and `/luvus-surface` to `/pmux-spawn` and `/pmux-surface`. Keep `/stream`.
- [x] 4.3 Rename the environment variables `PI_LUVUS_*` to `PI_PMUX_*`, including `PI_LUVUS_DIR` and `PI_LUVUS_PI_ENTRY`. Rename the widget key `luvus-status`.
- [x] 4.4 Move `pi-extension/luvus/` to `pi-extension/pmux/`, rename `luvus-done.ts` to `pmux-done.ts`, and update every import, `package.json` (`pi.extensions`) and the test imports.
- [x] 4.5 Move `skills/pi-luvus/` to `skills/pmux/` and update the launcher shim's paths and the install text. The GitHub path is `slatkin/pmux`.
- [x] 4.6 Move the config directory to `extensions/pmux/` with a read fallback to the old directory, write new settings to the new directory, and move the scratch directory to `<tmp>/pmux`. `handoffs.jsonl` starts new in the new directory.
- [x] 4.7 Update the agent role files, the README, the guide and `AGENTS.md` (the Luvus-host and naming sections).

## 5. Specs

- [ ] 5.1 Archive the change. If the archive leaves `luvus-agent-status` and `luvus-uhp-events` with no requirement, remove the two directories.
- [ ] 5.2 Edit by hand the `Purpose` lines that still say Luvus: `luvus-backend`, `luvus-surface`, `luvus-agent-titles`, `luvus-completion`, `luvus-messaging`, `external-orchestration`, `portable-launch`, `stream-panes` and `tmux-backend`.

## 6. Checks

- [x] 6.1 Delete `test/luvus-status.test.ts` and `test/uhp-events.test.ts`. Remove the `__setLuvusExecForTests__` stubs and the Luvus host cases from the other tests; the tmux stubs (`__setTmuxExecForTests__`) cover the surface. Keep `test/host-env.ts` clearing the old variables.
- [x] 6.2 Add focused tests for the status file (the writes and the latch), the removal at start, the crash write, and `wait` (success, timeout, usage error). Do not add one test per scenario.
- [ ] 6.3 Run the full suite, the type check, the lint and the format check.
