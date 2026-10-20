# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

pmux is a pi extension. pi is the coding agent from `@earendil-works/pi-coding-agent`. The extension runs subagents in terminal panes. Each subagent is a pi child process in its own pane. Two hosts provide the panes: Luvus and tmux.

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

Both paths end in the same pane command: `node pi-extension/luvus/cli.ts run <spec>`.

- **pi parent.** The `luvus_spawn`, `luvus_resume`, `luvus_message`, `luvus_interrupt` and `luvus_list` tools in `index.ts` call `supervisor.ts`. The supervisor resolves the role, writes a launch spec, creates and names the pane, runs the pane command, and polls for exit. It also owns the status widget, the idle watchdog and message delivery.
- **External orchestrator (Claude Code).** `skills/pi-luvus/launch.ts` finds the package and passes its argv to `cli.ts start` or `cli.ts resume`. The CLI does the same steps: role resolution, parent footer, pane split, launch spec.

The pane runs `cli.ts run`. It starts the child from the spec with no shell, reports the exit code, and, for skill launches only, closes the pane after a `done` or `handoff` sidecar.

### Host dispatch

- `backend.ts` is the only module the rest of the extension calls for pane work. It picks Luvus when `LUVUS_ENV`, `LUVUS_BIN_PATH` and `LUVUS_PANE_ID` are all set. It picks tmux when `TMUX` and `TMUX_PANE` are set. With neither, it falls back to Luvus, so the refusal message does not change.
- `luvus.ts` and `tmux.ts` implement the same surface API. `placement.ts`, `exit-sidecar.ts` and `surface-types.ts` hold the parts that both hosts share.
- Code with an injected environment (`cli.ts`) passes the host explicitly. Its `hostOf` applies the same Luvus check.
- Every split anchors on the caller's own pane: `LUVUS_PANE_ID` or `TMUX_PANE`. Never use a "current" pane. tmux resolves an untargeted command against the server's most recently used window, so another client can move the split.
- A pane starts empty, and the launch command goes in afterwards. The pane therefore outlives the child, so the parent can read it and close it.

### Completion and env contracts

- A child writes `<session file>.exit` when it finishes: `done`, `ping`, `handoff` or `error`. The parent polls that file on both hosts. The terminal sentinel is only a fallback. Decoding lives in `exit-sidecar.ts`.
- The parent writes the child's env with `encodeChildEnv` (`child-env.ts`), and the child reads it with `decodeChildEnv`. The keys are `PI_LUVUS_*` and `PI_DENY_TOOLS`.
- The child loads `luvus-done.ts` (`pi -e`). That file provides `luvus_done`, `caller_ping`, the completion nudge, auto-exit and the sidecar writes. The role's `tools` list does not remove the control tools, and `luvus_done` is never denied.

### Status and events by host

- Luvus: live status is published as leases through `luvus-status.ts`. The UHP event stream (`uhp-events.ts`) is Luvus-only.
- tmux: there are no leases and no event stream. The supervisor polls the sidecar and the pane.

### Reload safety

`index.ts` keeps the supervisor and the stream runtime on `globalThis`, under `Symbol.for` keys namespaced by `import.meta.url`. `/reload` re-imports the module, and the new load retires what the old one started: timers, watchers, panes and sockets. Keep any new long-lived resource in the same pattern, or it leaks across `/reload`.

### Stream panes

`/stream` opens follower panes. `stream-state.ts` runs a unix socket per session, with a replay ring for each stream (`thinking`, `tools`). `stream-tail.mjs` is the viewer that runs in the pane. `stream-projection.ts` changes the live transcript through the TUI that a zero-height widget factory captures. It fails open when the layout does not match.

### Agent roles

`agents/*.md` define roles: frontmatter, then a system prompt body. `agent-defs.ts` resolves a role in this order: `.pi/agents/` in the child's cwd, then `$PI_CODING_AGENT_DIR` (or `~/.pi/agent`) plus `/agents/`, then the package's `agents/`. `spawning: false` and `deny-tools` become `PI_DENY_TOOLS`.

### Files with extra constraints

- `skills/pi-luvus/launch.ts`: `npx skills add` copies this file. It must stay self-contained, using Node built-ins only. The skill directory holds no shell scripts.
- `pi-extension/luvus/plugin/hooks/on-stop.js`: runs under the orchestrator's `node`, whose floor is Node 18. Keep it free of TypeScript syntax.
- `luvus-done.ts`, the `PI_LUVUS_*` variables and the `.exit` format: a change here must keep the `external-orchestration` spec passing.

## Naming: keep the old names

The package and repo are `pmux`. Other names are the external contract, so keep them: `pi-extension/luvus/`, the `luvus_*` tool names, the `PI_LUVUS_*` variables and `skills/pi-luvus/`. A rename is a separate, explicit change.

## Luvus is third-party

Luvus changes between releases. No file in this repo is an authority for Luvus behavior. That includes `docs/`, `openspec/` and the skill text. Do not write Luvus behavior into comments, docs or specs. Describe only what this code does. To check a Luvus flag, run `luvus help <topic>` on the installed binary, and do not rely on any other source.

## Tests

- Use `node:test` with `node:assert/strict`. Name files `test/<thing>.test.ts`. `test/test.ts` is one large suite.
- The `test/*.ts` glob also matches helpers: `host-env.ts`, `stream-fakes.ts` and `stream-harness.ts`. They hold no tests.
- Import `./host-env.ts` first in any test that reaches a backend. It removes `LUVUS_*`, `PI_LUVUS_*`, `TMUX` and `TMUX_PANE` from the process env. Without it, a run inside a pane drives the real host.
- Fake the host with the test seams: `__setLuvusExecForTests__` in `luvus.ts` and `__setTmuxExecForTests__` in `tmux.ts`. Reset them to `null` afterwards.
- Tests never need a live Luvus or tmux server, and never open many panes. The user runs the live checks, so do not ask for live timings or pane counts in a plan.

## OpenSpec

- `openspec/specs/<capability>/spec.md`: current behavior.
- `openspec/changes/<date>-<name>/`: an active change, with `proposal.md`, `design.md`, `tasks.md` and `specs/` deltas. Finished changes move to `openspec/changes/archive/`.

## Commits and releases

- Commit messages use conventional commits with a scope, for example `feat(release): ...` or `docs(readme): ...`.
- A release is a `v<VERSION>` tag. `.github/workflows/release.yml` runs on the tag, then publishes to npm through trusted publishing. Use the `release` skill.
