# Design

## Context

See proposal.md for the motivation. These are the duplicated parts today:

| Concern | pi parent (`supervisor.ts`) | external (`cli.ts`) |
| --- | --- | --- |
| Role resolution | `launchSubagent` builds a `LaunchRecord` | `startCommand` reads `loadAgentDefaults` directly |
| pi argv and spec | `buildPiLaunch` | inline in `startCommand` |
| Role prompt file | `writeRunContextFile(artifactDir, "context", …-sysprompt)` | `<base>.role.md` |
| Task prompt file | `writeRunContextFile(artifactDir, "context", …)` | `<base>.prompt.md` |
| Resume | rebuild from the record, `pmux-resume/` | reuse the spec, `<prompt>.resume.md` |
| Prompt text | role block, mode hint, messaging hint, task, summary | brief, footer |

The pi parent has a pi session, so it has `getArtifactDir(sessionDir, sessionId)`. The external path has only `--scratch` and the caller pane.

## Goals / Non-Goals

**Goals:**

- One function builds every pi launch spec. One function resolves every role into a launch record.
- Both paths write prompts with the same writer, in the same folder shape.

**Non-Goals:**

- The Claude Code child backend (`buildClaudeLaunch`) stays in `supervisor.ts`. It has no external caller.
- No change to the run wrapper (`run.ts`), the footer texts, the pi-parent prompt text or the sidebar.
- The external path gets no roster and no supervisor watch loop.

## Decisions

### D1. New module `pi-extension/pmux/launch-build.ts`

The module holds `resolveLaunchRecord`, `buildPiLaunch`, `writeRunContextFile`, `buildSubagentTaskPrompt`, `buildLaunchMessagingHint`, `resolveModeHint`, `buildPiPromptArgs` and `buildSpawnEnvParts`. These move from `supervisor.ts` without a text change. `supervisor.ts` re-exports the names that tests import, so supervisor tests do not change. `launch.ts` stays the low-level spec format. The alternative was to put the builder in `launch.ts`. That file is the spec format that the pane side reads. The builder pulls in `agent-defs.ts` and `child-env.ts`. A separate module keeps the pane side small.

### D2. `buildPiLaunch` returns only the spec

Today it returns `{ spec, running }`. The `RunningSubagent` part is supervisor-only. The supervisor builds `running` itself from the request after the call. The builder input loses `run.surface`, `run.startTime`, `run.launchScriptFile` and `run.entryCountBefore`, because only `running` uses them.

### D3. The parent contact is one tagged input

```ts
type ParentContact =
  | { kind: "pi"; siblingNames: string[]; parentRosterFile?: string; surface: string }
  | { kind: "external"; parent: string; callerPane: string; report: ReportMode; closeGraceMs: number };
```

For a spawn, the `pi` kind keeps today's prompt: role block, mode hint, messaging hint, task and summary instruction. The `external` kind makes the prompt `task + "\n" + reportFooter(...)`, which is today's external bytes. The footer replaces the hints and the summary because the `last` footer forbids `pmux_message`, and the pi messaging hint recommends it. On a resume, the `pi` kind puts the messaging hint before the message. The `external` kind puts the footer after the message. The `external` kind adds `externalParent: true`, `parent`, `report` (send mode only) and `closeOnDone`. It also applies the send-mode bash rule: `bash` goes into the allowlist and out of the denied set. The `pi` kind adds `surface`, `parentRosterFile` and `PI_CODING_AGENT_DIR`. `reportFooter`, `parentFooter` and `sendFooter` move from `cli.ts` into the module.

### D4. External launches use `taskDelivery: "artifact"` and append mode

The external path always writes the task to a context file, as today. The role body goes to `--append-system-prompt` through `writeRunContextFile(..., "context", "<name>-sysprompt", body)`, which is the pi-parent rule for `systemPromptMode: append`. An empty role body writes no file and passes no flag. Today `start` passes an empty `.role.md` file. Both forms give pi no extra system prompt.

### D5. Artifact directory for an external launch

`artifactDir = join(scratch, "artifacts", parentId)`. `parentId` is the `@pane_session_id` of `callerPaneId(env)`, read with `tmux show -pv -t <pane> @pane_session_id` through the existing tmux exec seam. If the value is empty or the read fails, `parentId` is the caller pane id. The id goes in the launch record, field `parentSessionId`, so `resume` uses the same directory. The pane id holds `%`. This is safe in a path. The prompt path goes inside the spec args, not on the pane command line, so the pane token rule does not see `%`. The `.launch.json` record and the session file stay at `<scratch>/<base>.*`, so `prune` and the `{pane, session, launch}` output do not change.

`paneCommandLine` no longer receives a prompt path from `start` or `resume`. The prompt goes into `spec.args` as `@<path>`, the same as the supervisor. The `run <spec> [<prompt>]` form stays for compatibility.

### D6. `resolveLaunchRecord` is the one role resolution

Input: role name, cwd, and the pi-parent overrides (`model`, `tools`, `skills`, `interactive`, `systemPromptMode`). Output: `{ record, definition }`. The external path calls it with no overrides and keeps its two checks: an unknown role and an empty model are errors before any file is written. The record gains two optional fields, `parentSessionId` and `closeGraceMs`. Both are external-only, and `validateLaunchRecord` accepts their absence.

### D7. Resume rebuilds from the record

`resume` reads the spec for `sessionFile`, `parent` and `report`, then reads `<sessionFile>.launch.json`. A missing or invalid record is a usage error (exit 1). The builder makes a new spec with `resume.message` from `--prompt` and writes it over `--launch`. `--name` renames the pane only, as today.

## Risks / Trade-offs

- [The move can change how the footer joins the brief.] → A test pins the prompt file content for `last` and `send` to today's strings.
- [Specs from the old version cannot resume.] → A clear message names `start`. Scratch prunes old files after 7 days.
- [`@pane_session_id` is set by tmux-agent-sidebar, not by pmux.] → Without the sidebar, the fallback id keeps the launch working.
- [The supervisor's resume path keeps reading the record that the spawn wrote.] → The new record fields are optional, so old supervisor records stay valid.

## Migration Plan

No data migration. Rollback is a revert of the change. Old launch specs stop resuming, as stated in the spec delta.
