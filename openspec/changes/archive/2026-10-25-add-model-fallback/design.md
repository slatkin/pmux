# Design

## Context

See `proposal.md` for the motivation. Today one function picks a child's model: `resolveLaunchRecord` in `launch-build.ts` sets `effectiveModel = overrides.model ?? definition?.model` and writes it into the launch record. Both launch paths call it: the pi parent from `supervisor.ts` (`requireRole`) and `cli.ts start` (`strict`). Every later step reads the record: the pane launch spec (`--model <model>[:thinking]`), the Claude Code backend (`--model`), and `resume` (it rebuilds the spec from the record). The role parser, `parseAgentDefinition` in `agent-defs.ts`, reads one frontmatter key per field with `getFrontmatterValue`.

The `pmux_spawn` schema is `SubagentParams` in `supervisor.ts`. `cli.ts` parses flags with `node:util` `parseArgs` and a fixed option table, and `resume` already rejects a `--report` flag because the launch spec owns that value.

## Goals / Non-Goals

**Goals:**
- One place decides the fallback: `resolveLaunchRecord`. Both launch paths get the same behavior and the same errors from it.
- The launch record format stays as it is. A resume needs no new code.
- The user defines the fallback model. Pmux ships and checks nothing about it.

**Non-Goals:**
- Automatic failover. A child that ends with an `error` sidecar is not retried.
- A `fallback` value on `pmux_resume`, or a way to move an existing child to another model.
- A fallback for the parent's own model. The parent uses the role's fallback only for the children it starts.
- Validation that a model name exists. Pi resolves the name, as it does for `model`.

## Decisions

### D1: The record holds the chosen model, not a "fallback" marker

`resolveLaunchRecord` takes `overrides.fallback?: boolean`. When it is true, the effective model is `definition.modelFallback`. The record gets that string in its existing `model` field.

Why: `resume`, the launch spec builder, the Claude backend and the pane title all read `record.model`. A marker would need every reader to learn it. With the model in place, a resumed child stays on the model it launched on (spec: "Resume keeps the launch model").

Alternative: a `fallback: true` field in the record that resume re-applies. Rejected: it adds a record field and a version question, and it gives a resumed child two sources for its model.

### D2: Errors are thrown from `resolveLaunchRecord`, before any write

The function already throws `UnknownRoleError` and the empty-model error before a pane or file exists. The two new errors join them. Both are plain `Error` values, like the empty-model error. `UnknownRoleError` stays for roles that do not resolve, so its name remains true. The `pmux_spawn` handler in `index.ts` converts only `UnknownRoleError` to a structured result and rethrows anything else, and pi turns the rethrown error into an error tool result with the same message. So the handler's catch does not change:
- `fallback` and `overrides.model` both set: `"fallback conflicts with model: pass one"`.
- `fallback` set and the definition has no `modelFallback`: `"role '<name>' has no model-fallback (<role path>)"`.

The empty-model check in `strict` mode (the CLI) moves to the model that applies: with `fallback`, it checks `modelFallback`, and a role with only `model-fallback` starts. The pi path (`requireRole`) never checks emptiness, so only the "no `model-fallback`" error applies to it.

Alternative: check in `supervisor.ts` and `cli.ts` separately. Rejected: two copies of the message and of the order of checks.

### D3: The key is trimmed to absent when blank

`getFrontmatterValue` returns `""` for `model-fallback:` with no value. The parser stores `modelFallback: value || undefined`, so a blank key reads as absent and takes the "no model-fallback" path. `model` keeps its present behavior (the strict empty-model error depends on the empty string).

### D4: `fallback` is a boolean parameter, and the description carries the "when"

`SubagentParams` gets `fallback: Type.Optional(Type.Boolean(...))`. The description is the only instruction the parent gets at the moment it picks parameters: "true: run the role on its `model-fallback`. Use it when your model hits API limits or errors, or when the user asks for the fallback or alternate model." `pmux_list` shows the value so the parent can see whether the role has one before it calls.

Alternative: a `model-fallback` string the parent copies into `model`. Rejected in the exploration: the parent copies a string it may mistype, nothing tells it when to do so, and the external path has no model override at all.

### D5: `pmux_list` format

The line becomes `• <name>[ (project)] [<model>] (fallback: <model-fallback>) — <description>`. The fallback part appears only when the role sets the key. The TUI line in `index.ts` gets the same part in the dim style that the model already uses.

### D6: CLI flag and resume

`--fallback` is a `boolean` entry in `CLI_OPTIONS`, so `parseArgs` takes no value for it. `startCommand` passes `overrides.fallback = values.fallback === true`. `resume` rejects the flag with exit 1 and a message that points at `start`, the same way it rejects `--report`. The usage text lists `[--fallback]` on `start`. `launch.ts` forwards argv, so it needs no change.

### D7: Thinking level and other role values

The role's `thinking:` applies to either model, because the record carries one `thinking` value. A fallback model that does not support the level is the user's choice, and pi reports it. Tools, denied tools, surface and the role body do not depend on the model.

## Risks / Trade-offs

- [The parent forgets the fallback exists] → The `fallback` parameter description and the `pmux_list` line both state it. Pmux cannot force the parent to use it, and the proposal asks for nothing automatic.
- [A hard rate limit on the parent's own model stops the parent from calling anything] → Out of scope. The feature works when the parent can still act: a partial failure, a child that errored, or a user request. The README says so.
- [A typo in `model-fallback` shows only when the fallback is used] → Pi reports the unknown model at child start. A launch-time check would need pi's provider list, which pmux does not read.
- [`fallback: true` on a role with `cli: claude`] → It works through the same record: the Claude backend reads `record.model`. The README example uses a pi role.
- [The `model` and `fallback` conflict error could surprise a parent that sets both] → The message names both parameters, and the call starts nothing, so the parent corrects the call at once.

## Migration Plan

No migration. Roles without the key behave as before. Existing launch records stay valid, because the format does not change. Rollback is a revert of the change.
