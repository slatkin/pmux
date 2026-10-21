# Tasks

Precondition: `2026-10-20-role-surface-float` is applied and archived. Start from a tree where `SurfacePlacement` is `"pane" | "tab" | "float"`, the role frontmatter holds `surface:`, and `resolvePlacement(call, role, fallback)` takes three arguments.

## 1. Resolution shrinks to two sources

- [x] 1.1 In `pi-extension/pmux/placement.ts`, change `resolvePlacement(call, role, fallback)` to `resolvePlacement(role: SurfacePlacement | undefined, fallback: SurfaceDefault)`. Keep `parseSurfacePlacement` and `parseSurfaceDefault` unchanged. Update the doc comment: the role's surface wins over the configured default; there is no per-call value.
- [x] 1.2 In `pi-extension/pmux/supervisor.ts`, drop `callSurface` from `SurfaceOptions` (fold the type away if only `fallback` remains), and simplify both `resolvePlacement` call sites (spawn and resume) to pass the role surface and the configured default.
- [x] 1.3 In `pi-extension/pmux/index.ts`, remove the `surface` entry from the shared tool-parameter schema and its description text, remove both `params.surface` parses and the `callSurface` values built from them, and drop now-unused imports. Verify with `pnpm run typecheck`.

## 2. CLI loses --surface

- [x] 2.1 In `pi-extension/pmux/cli.ts`, remove `surface` from the `parseArgs` options, the `--surface` validation block in `main`, the `surfaceFlag` parameters of `startCommand` and `resumeCommand`, and the two `[--surface pane|tab|float]` usage lines. Both commands resolve placement from the role surface (definition or spec) and `loadSurfaceConfig` alone. Verify with `pnpm run typecheck`.

## 3. Tests

- [x] 3.1 In `test/test.ts`, replace the three-tier `resolvePlacement` precedence cases with two-tier cases: role `float` over default `pane`, role `pane` over default `tab`, no role uses the default, invalid role value falls back to the default.
- [x] 3.2 In `test/supervisor.test.ts` and `test/cli.test.ts`, remove or rewrite the tests that pass `callSurface` / `--surface`: a call carrying a stray `surface` parameter must still place the child by role or default; `start --surface pane` must exit non-zero with no pane created.
- [x] 3.3 Add a test that asserts the `pmux_spawn` and `pmux_resume` tool schemas declare no `surface` parameter and that their descriptions do not name `pane`, `tab` or `float`.
- [x] 3.4 Run the full gates: `pnpm run format:check`, `pnpm run lint`, `pnpm run typecheck`, `pnpm test`.

## 4. Docs

- [x] 4.1 In `docs/guide.md`, remove the `surface` rows from the `pmux_spawn` and `pmux_resume` parameter tables, remove `[--surface ...]` from the skill usage lines and the `--surface` explanation paragraph, and rewrite the precedence section to the two sources (role frontmatter, then `config.json`).
- [x] 4.2 In `skills/pmux/SKILL.md`, remove `[--surface pane|tab|float]` from the `start` and `resume` command lines and the `--surface` explanation sentences.
- [x] 4.3 Check `README.md` and `agents/*.md` for per-call surface wording; the README mentions only the role `surface:` preference and needs no change unless the wording implies a call-level override.
- [x] 4.4 Run `openspec validate 2026-10-21-drop-call-surface --strict`.
