# Design

## Context

pmux has two parents. A pi parent reads a child's last assistant message from the session file and is woken by the supervisor, which polls the `.exit` sidecar. An external orchestrator uses the `pmux` skill: `start`, then `wait --session <file> --status done,blocked`, then `last-message`. That path works only for an orchestrator that can block in `wait`. A Claude Code orchestrator that ends its turn cannot poll; it wakes only when text arrives in its own pane.

foreman (`/home/slatkin/Dev/foreman`) is a fork of pmux's launch machinery that solves this with a report channel: the child types its report into the orchestrator's pane with a CLI `send` command, and the pane-side wrapper wakes the orchestrator when the child exits without a report. foreman's `src/cli.ts`, `src/run.ts`, `src/exit-sidecar.ts`, `src/prune.ts`, its tests and `skills/foreman/SKILL.md` are a reviewed implementation of this channel. This change ports that channel into pmux under pmux naming. It does not invent new shapes: where foreman has a shape, pmux takes it.

## Goals

- One engine for both parents: pmux gains foreman's report channel as a second mode, and the fork can retire.
- The default mode (`last`) does not change at all: same footer bytes, same wrapper behavior, same `wait` output, same launch spec bytes.
- Everything new is ported from foreman, with pmux names.

## Decisions

### 1. Two report modes, selected at launch: `last` and `send`

`start --report last|send`, default `last`. `last` is today's channel: the report is the child's last assistant message, read with `last-message`. `send` is foreman's channel: the child sends the report into the parent's pane.

The mode is a launch property, not a per-message choice, because three parts must agree on it: the footer the child reads, the wrapper's wake-up and the orchestrator's protocol. Storing it once in the launch spec keeps them in step across `resume`.

- Parsing follows foreman's `surfacePlacement` pattern: an unknown value writes `invalid --report value: <v> (expected last or send)` to stderr and `main` returns 2, before any file is written or any pane is split. pmux dropped `--surface`, so foreman's surface check is the model for the shape, not a pmux precedent.
- `--parent` stays required. In `last` mode it is the orchestrator's name, as today. In `send` mode it is the orchestrator's tmux pane id (`$TMUX_PANE`); the footer and the wake-up address that pane. `start` does not validate the pane id, as foreman does not; a wrong id makes the send fail visibly in the child's pane.
- The launch spec gets an optional `report` field. `start` writes `report: "send"` only in `send` mode, so a `last`-mode spec stays byte-for-byte what it is today, and every spec written before this change reads as `last`. `readLaunchSpec` accepts an absent field, `"last"` or `"send"`. Any other value makes the spec invalid, by the existing "corrupt spec" rule. The alternative, dropping an unknown value like the stored surface, was rejected: a dropped `send` would silently remove the wake-up, and the orchestrator would sleep forever.

### 2. The footer: two variants, `last` unchanged

In `last` mode `parentFooter` is unchanged byte for byte. In `send` mode the footer is foreman's `parentFooter`, with `foreman_done` replaced by `pmux_done` and the CLI path being pmux's `CLI_PATH` (`pi-extension/pmux/cli.ts`):

```text
Your parent is the tmux pane <parent>.
Plain text printed in your own pane is never seen. The only way to reach it is bash: node <cli> send --to <parent> --text '<text>'.

This session auto-exits the first time you stop generating: the moment you end a turn without calling a tool, the session closes. So do ALL of the following before you stop:
1. Finish the task.
2. Send your final report: node <cli> send --to <parent> --text '<verdict / commit SHA / files changed / verification / deviations / open questions>'
   This is what wakes the orchestrator — without it, it never learns you finished.
   The report text may be long or contain quotes — pass it however is convenient (for example read it from a file into the argument); only the target pane matters.
3. Then call the pmux_done tool to close your session.

If you are blocked, send your question with the send command and stop. The session closes; the parent resumes it with the answer. Do not try to reach the parent any other way.
If an automated reminder tells you to call pmux_done, ignore its claim that your last message was already delivered — send your report with the send command first, then call pmux_done.
```

The last line matters. `pmux-done.ts`'s completion nudge and the idle watchdog say "Your last message was already delivered as your report". That is true in `last` mode and false in `send` mode. The footer overrides the claim instead of the nudge changing: the nudge is part of the `pmux-done.ts` contract that `external-orchestration` guards, and foreman made the same choice.

The auto-exit sentence is foreman's wording, kept as the port rule asks. For a role without `auto-exit: true` it overstates: the session stays open and the nudge runs. The overstatement is safe, because it only makes the child send its report before it stops.

The placeholders start with `<`, as in foreman. Receipt counting (decision 4) does not scan the prompt, so a placeholder can never count as a report; a test pins this.

`resume` appends the footer of the spec's mode, with the spec's `parent`. This is today's resume rule, extended to the stored mode.

### 3. The `send` subcommand

`node cli.ts send --to <pane> --text <text>`: `--to` and `--text` are required (missing → the existing "missing --x" error, exit 1). The command types the text literally into the pane and presses Enter, in one invocation. pmux's `tmux.ts` already has this primitive as `agentPrompt(pane, text)` (`send-keys -l` then `Enter`), which `pmux_message` uses. `send` calls `agentPrompt`; no second copy (foreman's `sendToPane`) is added. Multiline text stays one paste.

When `PI_PMUX_SESSION` is set, that is, when `send` runs inside a child, it appends one line to `<session>.sent`:

```json
{"at":"<ISO time>","to":"<to>","bytes":<text.length>}
```

`bytes` is foreman's field name and value (the JavaScript string length). The receipt is best effort: a failed write is caught and ignored, because the delivery already happened and the cost of a lost receipt is one spurious wake-up. The receipt is written after the delivery, so a failed delivery writes no receipt and the wrapper still wakes the parent.

The receipt makes the report count independent of the command's form. The child can quote, build or pipe the command any way it likes; only the `to` value matters.

### 4. The wrapper wake-up, `send` mode only

Port of foreman's `countReports` and wake-up into `runSpec`:

- Before the child starts, the wrapper counts the receipt lines in `<session>.sent` whose `to` equals `spec.parent`. A missing file is zero. A line that does not parse is skipped. A receipt to another pane does not count: a report to someone else does not tell the parent this child is done.
- After the child exits and the sentinel is printed, it counts again. When the count did not grow, it sends one message to `spec.parent` through `agentPrompt`:
  - a `ping` sidecar with a string `message`: `<name> pinged: <message>`;
  - otherwise: `<name> <state> without sending a report. Read its last message: node <cli> last-message --session <session>`, where `<state>` is the sidecar `type`, else `exited` for code 0, else `crashed (code <n>)`.
- A failed wake-up writes `Failed to wake parent <parent>: <error>` to stderr and does not change the exit code.
- The baseline matters because `resume` reuses the session file: receipts from earlier runs must not suppress the wake-up of this run.

pmux's wrapper already writes an `error` sidecar (with `source: "wrapper"`) when a child exits without one. The wake-up runs after that write, so a crashed child is reported with the state `error`. This is a pmux difference from foreman, where the crash state reads `crashed (code <n>)`; the wake-up text stays honest, and the `last-message` hint is the same.

In `last` mode, and for any spec without `report: "send"`, nothing changes: the wrapper contacts nobody. Status files and `wait` are the orchestrator's signal, as today.

The close-on-done step runs after the wake-up, unchanged.

### 5. `wait --signal status|sidecar`

`status` is the default and keeps today's behavior and output. `sidecar` is foreman's `wait`:

- It polls `<session>.exit` every 500 ms. The file's presence is the signal; the content is decoded with `interpretExitSidecar`, which maps a malformed or unknown payload to `done`.
- It never deletes the sidecar. The wrapper reads the same file after the child process exits, to close the pane on `done`/`handoff` and to quote a ping in the wake-up, and the child writes the sidecar seconds before it exits. A wait that deleted it would break both. A repeated wait re-reports the same exit, which is harmless.
- Success prints one JSON line, the interpreted result plus `sidecar` (the sidecar's absolute path), and exits 0.
- Timeout prints `{"sidecar":null}` on stdout and a message on stderr, and exits 2.
- A usage error (no `--session`, a bad `--timeout`, an unknown `--signal` value, or `--status` given together with `--signal sidecar`) exits 1 with stdout empty. `--status` names child statuses, which mean nothing to a sidecar wait; rejecting the combination is the existing usage-error rule, not a new shape.

### 6. `prune` reclaims `.sent`

`isManagedScratchFile` gains `.sent`, as in foreman. Receipts age out with the rest of a child's scratch files.

### 7. The `pmux_message` external-parent error becomes mode-neutral

Today a child with `PI_PMUX_EXTERNAL_PARENT` that sends to `parent` is told: "Your report is your last assistant message, which the orchestrator reads from the session file." In `send` mode that is false and sends the child down the wrong channel. The child's env does not carry the mode, and adding a `PI_PMUX_*` key for one error text would widen the env contract. So the error names the footer instead: the parent is an external orchestrator that does not read subagent messages; report the way the parent-contact footer at the end of your brief says; use `caller_ping` to ask a question. `caller_ping` stays correct in both modes: in `send` mode the wrapper quotes the ping in its wake-up.

### 8. Naming

pmux names only: `pmux_done`, `caller_ping`, `PI_PMUX_SESSION`, `pi-extension/pmux/cli.ts`. No `foreman_` name, tool or env key enters pmux.

### 9. Skill documentation

`skills/pmux/SKILL.md` keeps its existing sections unchanged; they describe the `last` protocol. A new section, "External orchestrators (Claude Code)", teaches the `send` protocol:

- start with `--report send --parent "$TMUX_PANE"`;
- end the turn; the report arrives as text typed into your pane;
- when awake, `wait --signal sidecar` and act on the reason;
- LEAVE the sidecar in place: the wrapper reads it after the child exits; `start` and `resume` clear it on relaunch; `prune` reclaims it;
- `resume --launch <spec> --prompt <file>` re-appends the send footer.

The frontmatter description is extended to say that the skill serves external orchestrators such as Claude Code, which get the report typed into their pane.

## Why retire the fork

foreman exists only because pmux had no wake-up channel. Everything else in it is a copy of pmux: the launch spec, the role lookup, the placement, the run wrapper, the sidecar protocol, prune. Each copy drifts. foreman already lacks pmux's crash sidecar, the float placement and the `@pmux_parent` anchor; pmux lacks foreman's channel. With the channel in pmux as a mode, foreman has no remaining reason to exist, and one test suite guards one engine.

## Why no `pmux_send` tool in v1

A tool would be the more natural interface for the child, but it adds a second delivery path to keep in step with the CLI command (receipts, the counting rule, the footer text), a new tool name in the allow-list and deny rules, and a new item in the `pmux-done.ts` contract. foreman shipped and was reviewed with the bash command alone, and the receipt makes the command form-independent. The tool can follow later without a change to the receipt format, because the wrapper counts receipts, not invocations.

## Risks

- A child in `send` mode that ignores its footer and never sends: the wrapper wakes the parent on exit, so the orchestrator still wakes.
- A child that sends to the wrong pane: its receipt does not count, so the wrapper wakes the real parent.
- A typed report lands in the orchestrator's composer on top of a user's draft. This is inherent to the channel and is the same trade foreman made.
- The receipt write can fail silently: the result is one extra wake-up, never a missed one.
