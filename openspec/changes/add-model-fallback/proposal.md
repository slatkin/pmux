# Proposal

## Why

A role names one model. When that model hits an API limit or returns errors, the parent can only retype a model name by hand through the `model` override, and it does not know which model the user wants as the alternate. Users also ask for "the fallback model" in plain words. The role has no place to record that choice, so the parent cannot honor the request.

## What Changes

- A role gets an optional `model-fallback:` frontmatter key. It names the alternate model for that role, for example `model-fallback: opencode-go/glm-5.3-flash` next to `model: hyper/glm-5.3-flash`. Pmux ships no fallback value. The user defines it.
- `pmux_spawn` gets an optional `fallback` boolean. When it is `true`, the child runs on the role's `model-fallback` instead of its `model`. The parameter description tells the parent when to use it: the primary model hits API limits or errors, or the user asks for the fallback or alternate model.
- `fallback: true` fails before any pane opens or any file is written when the role has no `model-fallback`, or when the same call also sets `model`.
- `pmux_list` shows each role's fallback model next to its primary model, so the parent sees which roles have one.
- `cli.ts start` gets a `--fallback` flag with the same meaning, so an external orchestrator such as Claude Code can use it. The pmux skill documents it. `resume` does not accept the flag.
- Nothing is automatic: pmux never retries a failed child on the fallback model, and it enforces nothing about the model values.
- README and `docs/guide.md` document the key and the parameter.

Out of scope: automatic retry or failover, switching a resumed child to another model, and a fallback value for the parent's own model.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `subagent-supervision`: adds the `model-fallback` role key, the `fallback` parameter of `pmux_spawn`, its two error cases, the fallback display in `pmux_list`, and the rule that a resumed child keeps the model it launched on.
- `external-orchestration`: adds the `start --fallback` flag with the same errors, the rule that `resume` rejects the flag, and the skill text that documents it.

## Impact

- `pi-extension/pmux/agent-defs.ts`: a `modelFallback` field and its parse.
- `pi-extension/pmux/launch-build.ts`: `resolveLaunchRecord` takes a `fallback` override and picks the model from it. The launch record format does not change.
- `pi-extension/pmux/supervisor.ts`: the `fallback` parameter in `SubagentParams`, passed to `resolveLaunchRecord`.
- `pi-extension/pmux/index.ts`: the `pmux_list` text and its TUI line.
- `pi-extension/pmux/cli.ts`: the `--fallback` option, the usage line and the `resume` rejection.
- `skills/pmux/SKILL.md`, `README.md`, `docs/guide.md`.
- Tests: `test/test.ts` (parser), `test/launch-build.test.ts`, `test/supervisor.test.ts`, `test/cli.test.ts`.
- `pmux-done.ts`, the `PI_PMUX_*` variables and the `.exit` format do not change, so the `external-orchestration` contract for them stays as it is.
