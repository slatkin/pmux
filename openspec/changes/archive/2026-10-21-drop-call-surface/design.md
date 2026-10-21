# Design

## Context

The failure that motivates this change is behavioral, not a crash: an orchestrating agent passed `surface: "pane"` on every `pmux_spawn`, which silently overrode the `surface: float` frontmatter of four reviewer roles. The tool description already said "when absent, the role's surface applies" — the agent read past it, because agents fill in the parameters a schema offers. The fix is to remove the ability, not to document it harder.

## Goals

- An agent cannot name a surface on a spawn or resume call, in any interface.
- Role frontmatter and the configured default remain the only sources, in that order.
- The change is small: parameter removal, signature simplification, docs, tests.

## Decisions

### 1. Drop the per-call surface everywhere, including the CLI

`pmux_spawn`, `pmux_resume` and the CLI `start`/`resume` all lose the surface input. The alternative — keep `--surface` on the bare CLI for "direct human use" and filter it in `skills/pmux/launch.ts` — was rejected for two reasons. First, `launch.ts` is a pure argv passthrough (`main(argv)` hands everything to `cli.main`), so a kept CLI flag keeps the agent-facing skill path open unless the shim grows argument filtering, which adds a second place that knows about surface values. Second, a human who wants a one-off placement already has two deliberate paths: `/pmux-surface` in the TUI, or editing the role file. One rule everywhere is cheaper to spec, test and document than one rule plus an escape hatch.

### 2. Misuse fails loudly on the CLI, is ignored on the tools

With `surface` removed from the CLI's `parseArgs` options, `--surface pane` fails as an unknown option before any role is loaded, so no pane is created. That is the desired gate for a human typo. The tool parameters are schema-validated by the pi host, but the spec still says a stray `surface` value in a call SHALL be ignored rather than fail: a tool call that fails teaches the agent nothing it can act on (it cannot un-pass a parameter), whereas an ignored value still places the child correctly from the role or default. The spec requirement is on the schema ("SHALL NOT declare"), so a host that rejects unknown parameters satisfies it too.

### 3. `resolvePlacement` shrinks to two arguments

Today: `resolvePlacement(call, role, fallback)` with `call` always `undefined` after this change. New signature: `resolvePlacement(role: SurfacePlacement | undefined, fallback: SurfaceDefault)`. The three-tier precedence test collapses to two tiers. `parseSurfacePlacement` stays (frontmatter and CLI-free config reads use it); `parseSurfaceDefault` stays unchanged. `SurfaceOptions` in `supervisor.ts` loses `callSurface`; with only `fallback` left, the spawn and resume call sites pass the config default directly, and the interface may fold into the existing options objects rather than keep a one-field type — whichever reads better at the call sites.

### 4. Persistence needs no change

The launch record stores the role's surface only (`supervisor.ts` deliberately never records the per-call value), and the launch spec does the same on the external path. With the per-call value gone, those rules become trivially true and their "per-call is not recorded" scenarios die with the feature. Resume behavior is unchanged in effect: record/spec surface, then config default.

### 5. Tool descriptions go silent on placement

The shared parameter text ("pane ... tab ... float ... When absent, the role's surface applies") disappears with the parameter. The tool descriptions SHALL NOT mention surface at all: no parameter, no prose, no invitation to think about placement. Role authors own placement through frontmatter; the README's role-frontmatter section already documents `surface:` for them.

### 6. Scenario names survive, content flips

The openspec validator refuses a MODIFIED requirement that drops a scenario the current spec still has, so the deltas keep the old scenario names and reword their WHEN/THEN to assert the new behavior: `Per call beats the role` now asserts the role wins over a stray parameter, and `Per-call surface not recorded` now asserts a surface-less role records no surface. Only whole requirements are REMOVED (`Per-call tool override`, `Surface flag values`, `Float surface flag`).

## Risks

- A user who relied on per-call floats loses the ability. Mitigation: the role file is the right home for a persistent preference, and `/pmux-surface` covers session-level intent. No known user of the per-call path except the failing agent behavior itself.
- Existing role files that set `surface:` keep working unchanged; nothing about frontmatter parsing moves.

## Migration

No data migration. Launch records and specs written by earlier versions may hold a role surface, which this version reads the same way. Specs from earlier versions never held a per-call surface.
