# Proposal

## Why

pmux started as a Luvus extension (`pi-luvus`). The Luvus host was removed in `2026-10-20-drop-luvus-host`, but the repo still names Luvus in five spec capabilities, in comments and test names, in a stray npm lockfile, in env guards, and in a config fallback that reads the old `extensions/pi-luvus/` directory. These names make a reader think that Luvus is still a host. The user decided to remove all of them, the compatibility parts included.

## What Changes

- **Rename the five `luvus-*` spec capabilities** to names that describe the behavior. The requirement text does not change, except one scenario title that names `luvus_done`:
  - `luvus-backend` → `pane-lifecycle`
  - `luvus-surface` → `surface-placement`
  - `luvus-messaging` → `subagent-messaging`
  - `luvus-completion` → `subagent-completion`
  - `luvus-agent-titles` → `pane-titles`
- **Remove the `LUVUS_*` rule from the host spec.** `pmux-host` no longer states that the `LUVUS_*` variables have no effect, and `tmux-backend` no longer mentions "the Luvus keys". The code reads no `LUVUS_*` variable, so the behavior stays the same.
- **Remove the `LUVUS_*` and `PI_LUVUS_*` env guards from the tests** (`host-env.ts`, `turn-notify.test.ts`, `prune.test.ts`, `cli.test.ts`), and remove the CLI test that sets the Luvus variables.
- **BREAKING: remove the `extensions/pi-luvus/config.json` fallback** from `status.ts`. An install that keeps its config only in that directory loses its `surface` and `status` settings and falls back to the defaults. The package-root `config.json` fallback is not a Luvus reference and stays.
- **Delete the stray `package-lock.json`.** Its package name is `pi-luvus`, and the project uses pnpm (`pnpm-lock.yaml`).
- **Update the old comments, the test names and the docs** (`test/test.ts`, `context-alert.test.ts`, `eslint.config.js`, `README.md`, `docs/guide.md`, `AGENTS.md`), and remove a dead Luvus fixture comment in `test/test.ts`.

## Capabilities

### New Capabilities

(none: the five renamed capabilities keep their requirements. See design D1.)

### Modified Capabilities

- `pmux-host`: "tmux is the only host" and "One surface API" are replaced by "tmux is the required host" and "Pane operations call tmux directly". The rules stay the same, without the `LUVUS_*` sentence and the two Luvus scenarios. OpenSpec does not let a MODIFIED block drop a scenario, so the delta removes the requirements and adds them again with new names.
- `tmux-backend`: the "tmux availability" scenario no longer names the Luvus keys.

## Impact

- `openspec/specs/luvus-*/` → five renamed directories. The in-flight change `2026-10-23-report-user-cancel` holds a `luvus-completion` delta that must move with the rename.
- `pi-extension/pmux/status.ts`: the legacy extension-directory path goes.
- Tests: `test/host-env.ts`, `test/test.ts`, `test/cli.test.ts`, `test/prune.test.ts`, `test/turn-notify.test.ts`, `test/context-alert.test.ts`.
- `eslint.config.js`, `README.md`, `docs/guide.md`, `AGENTS.md`, `package-lock.json`.
- Not in scope: archived changes under `openspec/changes/archive/` (they are history), and files outside this repo. The prompts and roles in user config already use `pmux_done`.
