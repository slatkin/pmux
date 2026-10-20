# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

pmux is a pi extension. pi is the coding agent from `@earendil-works/pi-coding-agent`. The extension runs subagents in terminal panes. Each subagent is a pi child process in its own pane. tmux provides the panes.

There is no build step. pi and Node load the `.ts` files directly. The Node floor is 22.18, which first strips types by default. CI runs Node 22.

## Commands

Use pnpm. CI runs `pnpm install --frozen-lockfile`.

- `pnpm install`: installs dependencies. The `prepare` script sets `core.hooksPath` to `.githooks`.
- `pnpm test`: runs the full suite (`node --test "test/*.ts"`, about 500 tests, about 10 seconds).
- `node --test test/tmux.test.ts`: runs one file.
- `node --test --test-name-pattern "fall back" test/tmux.test.ts`: runs the tests whose names match a pattern.
- `pnpm run typecheck`: `tsc --noEmit`.
- `pnpm run lint`: ESLint. The existing `no-explicit-any` warnings are expected. Only errors fail the run.
- `pnpm run format:check` and `pnpm run format`: Prettier. It ignores `*.md`, so review prose by hand.
- `pi install /path/to/pmux`: loads a local checkout into pi for manual testing.

The pre-commit hook (`.githooks/pre-commit`) runs format:check, lint, typecheck and test, in that order. Run the same four before you commit.

## Architecture

### Two ways to launch a child

Both paths end in the same pane command: `node pi-extension/pmux/cli.ts run <spec>`.

- **pi parent.** The `pmux_spawn`, `pmux_resume`, `pmux_message`, `pmux_interrupt` and `pmux_list` tools in `index.ts` call `supervisor.ts`. The supervisor resolves the role, writes a launch spec, creates and names the pane, runs the pane command, and polls for exit. It also owns the status widget, the idle watchdog and message delivery.
- **External orchestrator (Claude Code).** `skills/pmux/launch.ts` finds the package and passes its argv to `cli.ts start` or `cli.ts resume`. The CLI does the same steps: role resolution, parent footer, pane split, launch spec.

The pane runs `cli.ts run`. It starts the child from the spec with no shell, reports the exit code, and, for skill launches only, closes the pane after a `done` or `handoff` sidecar.

### tmux backend

- `tmux.ts` is the only pane backend. It requires `TMUX` and `TMUX_PANE`; without them the tools refuse with a message that names tmux. `placement.ts`, `exit-sidecar.ts`, `status-file.ts` and `surface-types.ts` hold the host-independent parts.
- Every split anchors on the caller's own pane: `TMUX_PANE`. Never use a "current" pane. tmux resolves an untargeted command against the server's most recently used window, so another client can move the split.
- A pane starts empty, and the launch command goes in afterwards. The pane therefore outlives the child, so the parent can read it and close it.

### Completion and env contracts

- A child writes `<session file>.exit` when it finishes: `done`, `ping`, `handoff` or `error`. The parent polls that file. The terminal sentinel is only a fallback. Decoding lives in `exit-sidecar.ts`.
- The parent writes the child's env with `encodeChildEnv` (`child-env.ts`), and the child reads it with `decodeChildEnv`. The keys are `PI_PMUX_*` and `PI_DENY_TOOLS`.
- The child loads `pmux-done.ts` (`pi -e`). That file provides `pmux_done`, `caller_ping`, the completion nudge, auto-exit and the sidecar writes. The role's `tools` list does not remove the control tools, and `pmux_done` is never denied.

### Status

- A child writes its live status to `<session file>.status` (`status-file.ts`): one JSON object with `status` (`working`, `idle`, `done`, `blocked`), `at` and an optional `message`. The supervisor polls the sidecar and the pane; the skill's `launch.ts wait` command polls the status file.

### Reload safety

`index.ts` keeps the supervisor on `globalThis`, under `Symbol.for` keys namespaced by `import.meta.url`. `/reload` re-imports the module, and the new load retires what the old one started: timers and watchers. Keep any new long-lived resource in the same pattern, or it leaks across `/reload`.

### Agent roles

`agents/*.md` define roles: frontmatter, then a system prompt body. `agent-defs.ts` resolves a role in this order: `.pi/agents/` in the child's cwd, then `$PI_CODING_AGENT_DIR` (or `~/.pi/agent`) plus `/agents/`, then the package's `agents/`. `spawning: false` and `deny-tools` become `PI_DENY_TOOLS`.

### Files with extra constraints

- `skills/pmux/launch.ts`: `npx skills add` copies this file. It must stay self-contained, using Node built-ins only. The skill directory holds no shell scripts.
- `pi-extension/pmux/plugin/hooks/on-stop.js`: runs under the orchestrator's `node`, whose floor is Node 18. Keep it free of TypeScript syntax.
- `pmux-done.ts`, the `PI_PMUX_*` variables and the `.exit` format: a change here must keep the `external-orchestration` spec passing.

## Repository path

The GitHub repository is `slatkin/pmux`. The install commands and the launcher's git-install lookup use that path; the launcher finds the package where pi's git install of this repository lands.

## Tests

- Use `node:test` with `node:assert/strict`. Name files `test/<thing>.test.ts`. `test/test.ts` is one large suite.
- The `test/*.ts` glob also matches helpers: `host-env.ts` and `temp-dir.ts`. They hold no tests.
- Import `./host-env.ts` first in any test that reaches a backend. It removes `LUVUS_*`, `PI_LUVUS_*`, `PI_PMUX_*`, `TMUX` and `TMUX_PANE` from the process env. Without it, a run inside a pane drives the real host.
- Fake the host with the test seam: `__setTmuxExecForTests__` in `tmux.ts`. Reset it to `null` afterwards.
- Tests never need a live tmux server, and never open many panes. The user runs the live checks, so do not ask for live timings or pane counts in a plan.

## OpenSpec

- `openspec/specs/<capability>/spec.md`: current behavior.
- `openspec/changes/<date>-<name>/`: an active change, with `proposal.md`, `design.md`, `tasks.md` and `specs/` deltas. Finished changes move to `openspec/changes/archive/`.

## Commits and releases

- Commit messages use conventional commits with a scope, for example `feat(release): ...` or `docs(readme): ...`.
- A release is a `v<VERSION>` tag. `.github/workflows/release.yml` runs on the tag, then publishes to npm through trusted publishing. Use the `release` skill.
