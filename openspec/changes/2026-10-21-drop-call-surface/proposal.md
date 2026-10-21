# Proposal

## Why

A per-call `surface` parameter lets the calling agent silently defeat the feature that decides placement. This was observed live: a campaign orchestrator passed `surface: "pane"` on every `pmux_spawn`, so every role that declares `surface: float` in its frontmatter opened as a split pane instead of a float. The precedence rule (call beats role beats default) worked as specced; the problem is that the call can name a surface at all. An agent asked to spawn children will fill in whatever parameters the tool schema offers, so a parameter that overrides role functionality is a footgun the extension built, not an agent mistake the extension can tolerate.

Placement has exactly two sources that make sense: the role's frontmatter (per-role preference) and the configured default (user preference). The per-call value adds a third source that only ever harms: an agent that passes it once keeps passing it forever, and the role's declared surface is silently ignored.

## What Changes

- `pmux_spawn` and `pmux_resume` lose their `surface` parameter. The tool schemas and descriptions no longer mention surface at all. A `surface` value that arrives anyway (an unknown parameter) is ignored.
- The CLI loses `--surface` on `start` and `resume`. An invocation with the flag fails before a pane is created.
- The skill path keeps working unchanged: `launch.ts` is a pure argv shim, and with the flag gone from the CLI there is nothing to filter.
- Placement resolution becomes two-source: the role's `surface:` frontmatter when it names `pane`, `tab` or `float`, then the `config.json` default. `resolvePlacement` loses its call parameter.
- Nothing changes about persistence: the launch record and the launch spec already store the role's surface and never stored a per-call value, so resumes keep the role's surface as they do today.
- `/pmux-surface`, the `config.json` default and the role frontmatter key are unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `luvus-surface`: the per-call override requirement is replaced by a no-per-call-parameter requirement; the default and role requirements lose their "without a per-call surface" clauses; the "per call beats the role" scenario dies.
- `subagent-supervision`: `pmux_resume` accepts exactly `sessionPath`, `message` and `autoExit`; the resume surface is the record's surface, else the configured default; the per-call-recorded scenarios die.
- `external-orchestration`: `start` and `resume` no longer accept `--surface`; the surface is the role surface stored in the spec, else the configured default; the flag-value requirements are removed.

## Impact

- `pi-extension/pmux/index.ts`: the shared `surface` tool parameter and its description, and the two `params.surface` parses.
- `pi-extension/pmux/supervisor.ts`: `SurfaceOptions` loses `callSurface`; both `resolvePlacement` call sites simplify.
- `pi-extension/pmux/placement.ts`: `resolvePlacement(call, role, fallback)` becomes `resolvePlacement(role, fallback)`.
- `pi-extension/pmux/cli.ts`: the `--surface` parse, the `surfaceFlag` plumbing and the usage lines.
- Docs: `docs/guide.md` (tool parameter tables, the `--surface` usage lines, the precedence section), `skills/pmux/SKILL.md` (the `--surface` usage lines).
- Tests: `test/test.ts` (resolution precedence), `test/supervisor.test.ts`, `test/cli.test.ts`, tool-schema expectations.
