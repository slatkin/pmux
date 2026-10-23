# Design

## Context

See proposal.md (Why). The facts from the code:

- `SubagentParams.agent` is `Type.Optional` (`supervisor.ts`). `launchSubagent` calls `resolveLaunchRecord` without `strict`, so an unknown role reads as a task-only launch.
- `resolveLaunchRecord`'s `strict` flag does two checks: the role must resolve, and the effective model must not be empty. `cli.ts start` passes it. A user role can have no `model:` (for example `~/.pi/agent/agents/general-purpose.md`), and a pi child then runs on pi's default model.
- `launchSubagent` resolves the role before it creates a pane or writes a record, so a rejection leaves nothing behind. Today a thrown error escapes the `pmux_spawn` tool call.
- The run wrapper (`run.ts`) reads `<session>.exit` after the child exits, to decide the wake-up and close-on-done. `wait --signal sidecar` returns when the file exists and never deletes it.
- The active change `2026-10-23-report-user-cancel` adds a `cancelled` sidecar that `wait --signal sidecar` reports while the child is still alive. It also modifies the "Packaged orchestration skill" requirement.

## Goals / Non-Goals

**Goals:**

- A spawn without a role, or with a role that does not resolve, never starts a child.
- No skill recipe can make an orchestrator read `.exit` before it exists or delete it before the wrapper reads it.

**Non-Goals:**

- The model check of `strict` on the pi path.
- A pseudo-role for "the default agent". A caller that wants a general child names a role for it.
- A change to the `wait` command or to the run wrapper.

## Decisions

### D1: `agent` is required in the schema, and the spawn checks only that the role exists

The schema makes `agent` a required string, so pi rejects a call without it before `execute` runs, and the model sees `agent` as a required field. For a given role, `resolveLaunchRecord` gets a separate option that throws when the role does not resolve, with the message that `strict` uses today (`unknown role '<name>' (searched: ...)`). `pmux_spawn` catches the throw and returns it as an error result. Alternative considered: `strict: true`. Rejected, because it also rejects a role with an empty model, which works on the pi path today. Alternative considered: a runtime check only, with the schema still optional. Rejected, because a required field in the schema is what makes the model fill it in.

### D2: The sidecar fix is in the skill, not in `wait`

Only the skill's own `last`-mode recipe tells an orchestrator to read `.exit` directly and delete it. When both modes read the exit through `wait --signal sidecar`, which waits for the file and never deletes it, no recipe gives a reason to touch the file. Alternative considered: the wrapper writes an exit record after it reads the sidecar, and `wait` returns only after that record exists. Rejected for two reasons. It adds a new file to clear and to prune. Also, `report-user-cancel` needs `wait` to report a `cancelled` sidecar while the child is still alive, and a wait that gates on the child's exit would never report it.

### D3: The "Packaged orchestration skill" requirement does not change

That requirement already says to read the exit after a wait and to leave the sidecar in place. A sidecar wait is such a read, and the one-sentence form still says to leave the file. `report-user-cancel` modifies the same requirement, and a second MODIFIED block would replace one change's text with the other's at archive. So this change modifies only "The skill waits through the CLI" and "Skill documents the handoff sidecar".

## Risks / Trade-offs

- [A spawn with only a `systemPrompt` and no role is no longer possible] → the caller names a role. For a pi child the role body wins over `systemPrompt`, so an ad hoc role prompt needs a role with an empty body. The error message names the searched paths, so the caller can see where to add one.
- [Existing callers that omit `agent` break (BREAKING)] → the orchestrator prompt already passes a role on every launch, and the error is immediate and creates nothing.
- [An orchestrator can still delete `.exit` on its own initiative] → no recipe tells it to, and the one remaining sentence says to leave the file.
