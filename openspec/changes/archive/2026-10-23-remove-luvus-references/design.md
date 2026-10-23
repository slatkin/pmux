# Design

## Context

See proposal.md (Why). The facts that shape the approach:

- No production code reads a `LUVUS_*` or `PI_LUVUS_*` variable. Only the tests clear them, and only `pmux-host` and one CLI test state that they have no effect.
- `status.ts` tries two legacy config paths after the resolved one: `extensions/pi-luvus/config.json` under the agent dir, then `config.json` at the package root. `writeSurfaceConfig` seeds a new config from the same list. Only the first path names Luvus.
- An OpenSpec delta cannot rename a capability. A delta targets one existing path, and the spec instructions say a delta must not move the capability.
- The active change `2026-10-23-report-user-cancel` has a delta at `specs/luvus-completion/spec.md`. Its archive applies that delta to `openspec/specs/luvus-completion/`.

## Goals / Non-Goals

**Goals:**

- `rg -i luvus` finds nothing outside `openspec/changes/archive/` and the lockfile history.
- The renamed specs keep every requirement and scenario, so the rename changes no contract.

**Non-Goals:**

- Rewriting archived changes. They record history, and the names in them were correct when they were written.
- Changing the package-root `config.json` fallback.
- Reading a renamed config directory. pmux has its own directory already (`extensions/pmux/`).

## Decisions

### D1: The capability rename is a direct move of the main specs, not a delta

The apply step moves each `openspec/specs/luvus-*/` directory to its new name with `git mv` and changes the heading in the file. The text of the requirements does not change, except the `luvus-completion` scenario title "Model forgets to call luvus_done", which becomes "Model forgets to call pmux_done". Alternative considered: a REMOVED delta for each old capability plus an ADDED delta for each new one. That copies about 400 lines into the change, and an archive that removes every requirement can leave an empty old spec behind. The direct move is the same edit that the spec instructions allow for a Purpose, and `git mv` keeps the file history.

### D2: The in-flight delta moves in the same commit

The commit that renames `luvus-completion` also moves `openspec/changes/2026-10-23-report-user-cancel/specs/luvus-completion/` to `specs/subagent-completion/` and changes the capability name in that change's proposal. Then the archive of either change, in any order, targets the new path. If `report-user-cancel` was archived before this step, there is nothing to move.

### D3: Only the Luvus legacy config path goes

`legacyConfigPaths` keeps the package-root path and drops the `pi-luvus` path. The missing-config error message lists the paths from the same function, so it changes automatically. The test that reads the `pi-luvus` directory goes. The test that migrates the package-root config stays.

### D4: The test env guards keep their non-Luvus keys

`host-env.ts` and `turn-notify.test.ts` keep clearing `PI_PMUX_*`, `TMUX` and `TMUX_PANE`, and drop only the two Luvus prefixes. `prune.test.ts` and `cli.test.ts` already import `host-env.ts` first, so their own `LUVUS_` loops go completely. The CLI test "ignores the Luvus variables when tmux is absent" goes. The test before it already checks the tmux error without the Luvus variables. The `bare` option of the CLI test helper stays, with a comment that does not name Luvus.

### D5: `package-lock.json` is deleted

CI and the docs use pnpm with `pnpm-lock.yaml`. The npm lockfile still names the package `pi-luvus`, so it is out of date and nothing reads it.

## Risks / Trade-offs

- [A user with config only in `extensions/pi-luvus/` loses the `surface` and `status` settings, with no warning] → the proposal marks this BREAKING, and the release notes must say to move the file to `extensions/pmux/config.json`. The author's machine has both directories, so the `pmux` file already wins there.
- [A pi or Claude session that still has `LUVUS_*` set runs the test suite] → nothing reads those variables any more, so they cannot reach a real host. The tmux and `PI_PMUX_*` keys, which can reach a real host, are still cleared.
- [Links to the old spec paths break] → `docs/guide.md` links to `luvus-completion`. The apply step updates it, and the final `rg` check finds any other link.
