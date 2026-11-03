# Design

## Context

See proposal.md for the motivation and specs/ for the required behavior.

Current state that shapes the approach:

- All tmux calls go through `tmux()` / `tmuxAsync()` in `tmux.ts`, with a 5-second `TMUX_CALL_TIMEOUT_MS` and the `__setTmuxExecForTests__` seam. A dialog stays open for minutes, so the popup call cannot use that timeout.
- A process in a `display-popup` gets the tmux server's environment, not the caller's. `PI_CODING_AGENT_DIR`, the caller's cwd and `TMUX_PANE` are not inherited. When it runs from a shell, `tmux display-popup` waits until the popup closes. fzf's `--tmux` mode depends on this.
- Roles resolve in `agent-defs.ts` (`agentDefinitionPaths`, `loadAgentDefaults`) from three directories. The frontmatter parser reads one `^key:` line per key.
- pi's `/pmux-spawn` (`index.ts`) sends a user message that asks the agent to call `pmux_spawn`. `pmux_spawn` calls `supervisor.spawn({ name, task, agent }, ctx, { fallback })`.
- The skill path starts a child with `cli.ts start` (`startCommand`), which needs `--name`, `--role`, `--cwd`, `--brief` (a file) and `--parent`. `skills/pmux/launch.ts` forwards any argv to `cli.ts main`.
- Every `file-ack-v1` report, from `send` or from the run wrapper's wake row, passes through `registerReport` in `report-delivery.ts`. The inbox path rule (`inboxDirPath`, `runtimeDirPath`) and `pruneInboxes` live in `report-inbox.ts`.
- `pi --list-models` prints a table with a header row; the first two columns are `provider` and `model`.

## Goals / Non-Goals

**Goals:**

- One dialog implementation for both hosts. A host command only opens the popup and acts on the result.
- The outer process can end while the popup stays open, whether or not `display-popup` waits.
- No new npm dependency, and no dependency on `fzf` or another external picker.
- Every part except the terminal drawing is testable without a live tmux server or a TTY.

**Non-Goals:**

- `display-menu`. A `display-menu` item list cannot hold the model list, and two UI styles cost more than one.
- A general TUI framework. The dialog UI is a filtered list and a confirm line, nothing more.
- Changes to the inbox, the channel, `ack` or the report log format.

## Decisions

### D1. Outer and inner process, joined by a state file

Each dialog command has two sides in `cli.ts`:

```
  host (pi handler / Claude Code skill)
        |
        v
  OUTER: cli.ts <dialog> ...            in the caller's pane, caller's env
        |  1. make a private temp dir, state file path S
        |  2. tmux display-popup -E -t $TMUX_PANE -T <title> -w 80% -h 80%
        |        -d <cwd> -e PMUX_DIALOG_STATE=S -e PI_CODING_AGENT_DIR=<agentDir>
        |        -e PATH=<PATH> [-e VISUAL=… -e EDITOR=… -e PAGER=…]
        |        node cli.ts <dialog> --inner <args>
        |  3. wait until S says done/cancel, or the inner pid in S is dead
        v
  INNER: cli.ts <dialog> --inner         in the popup, server env + explicit args
           writes S = {"state":"open","pid":n} at start
           writes S = {"state":"done", ...result} or {"state":"cancel"} at end
```

The outer side waits on the state file, not on the tmux call. If the tmux call waits for the popup, the state file is already final when it returns. If it returns at once, the outer side polls (every 200 ms) until the state is final or the inner pid is gone. An inner that dies without a final state (Escape, `C-c`, popup closed) counts as a cancel. A state file that never shows `open` within 10 seconds after the tmux call returns counts as a failed popup.

On the Claude Code path, the outer side runs as a skill `!` command, which Claude Code stops after its 2-minute Bash-tool timeout (https://code.claude.com/docs/en/skills, "How injected commands run"). So on that path the outer side stops its wait after 100 seconds, prints `dialog still open; it finishes in the popup` and exits 0. The process must really exit at that point. The skill shim only sets `process.exitCode` (`skills/pmux/launch.ts`), so a live child process keeps Node running. That is why D2 starts the tmux call detached. The dialog continues, and no result is lost, because the inner side does every final action on that path (D6). In pi, the outer side runs in-process and waits with no limit.

Everything the inner side needs from the caller goes in as arguments: `--cwd`, `--agent-dir` (the resolved `getAgentConfigDir()`), `--pane`. The inner side never reads `TMUX_PANE` or `PI_CODING_AGENT_DIR` from its own env. The outer side also passes `-e PI_CODING_AGENT_DIR=<agentDir>` to the popup. Then the processes that the inner side starts resolve the same agent directory as the listing: `pi --list-models` (D5), and the `start` path (D6), whose role resolution reads `getAgentConfigDir()` from `process.env`.

The popup env is the tmux server's env, so the outer side also passes `-e PATH=<caller PATH>`, and `-e VISUAL`, `-e EDITOR` and `-e PAGER` for each one that the caller's env sets. The inner side reads the editor (D6) and the pager (report viewer) from these values. Thus the brief step and the pager use the caller's editor and pager, not the server's.

*Alternatives:* run the whole dialog in the outer process with the popup as a plain display (not possible, the popup owns the TTY); wait on the tmux call alone, because it blocks (the Claude Code path must exit before the popup closes, so it cannot wait on the call).

### D2. Popup call outside the 5-second timeout

`tmux.ts` gets `openPopup(args)`. With the test seam set, it goes through the seam like other calls, so tests assert the exact argv. Without the seam, it starts `tmux` with `spawn`, with no timeout, `detached: true` and stdio `["ignore", "ignore", "pipe"]`. It keeps stderr only until the call ends. When the outer side stops waiting (D1), it calls `unref()` on the child and on its stderr stream, so the tmux client does not keep Node alive and the popup stays open. A non-zero exit becomes an error that carries tmux's stderr (for example, on tmux older than 3.3).

### D3. One small list widget, a pure reducer plus a renderer

`dialog-ui.ts` holds a pure reducer: `(state, key) -> state` over `{ items, filter, selected, outcome }`, covering Up/Down, typed characters (case-insensitive substring filter), Backspace, Enter and Escape. The renderer draws the state with ANSI codes on stdout, reading keys through `node:readline` `emitKeypressEvents` in raw mode. Tests drive the reducer only. The editor and pager steps hand the TTY to a child process (`spawnSync` with `stdio: "inherit"`) and take raw mode back after it.

### D4. Role listing and the frontmatter writer

`agent-defs.ts` gets:

- `listRoles(cwd, agentDir)`: the union of `*.md` names in the three directories, each resolved by the existing order, returning `{ name, path, source, model, modelFallback, thinking }`. It uses `parseAgentDefinition`, so a file the parser rejects is not listed.
- `setFrontmatterKey(text, key, value | null)`: a pure text function. It finds the frontmatter block, keeps the file's line ending (CRLF when the first line ends with CRLF), and replaces, appends or deletes one `^key:` line. It changes no other byte.
- `writeRoleKey(role, key, value, { agentDir })`: for a `built-in` source, it first copies the file whole to `<agentDir>/agents/<name>.md` (creating the directory). Then it writes through a temp file in the same directory and a rename.

The inner role dialog shows "edits create a user copy" on the confirm line for a built-in role, before the first write.

### D5. Model choices from `pi --list-models`

The inner role dialog runs `pi --list-models` (the command found through `resolvePiCommand`) once per dialog, skips the header row, and builds `provider/model` from the first two columns. A non-zero exit or an empty list shows the error, and the model keys are then not editable. The thinking values are the fixed list from `pi --help`.

### D6. Spawn: the inner side collects; the host decides which side starts

The inner side collects `{ role, briefPath }`. The brief is written to `<scratch>/briefs/<role>-<timestamp>.md` with `$VISUAL`, `$EDITOR` or `vi`. Which side starts the child depends on the host:

- pi: the outer side starts the child, because the start needs the supervisor in pi's process. The handler calls `currentSupervisor().spawn({ name, task: <brief text>, agent: role }, ctx, { fallback: getSurfaceDefault() })`, the same call `pmux_spawn` makes. `name` is the capitalized role, as in today's `/pmux-spawn`. With `<role> <task>` arguments, the handler skips the popup and makes the same call. No `sendUserMessage`.
- Claude Code: the inner side starts the child after the brief step, so a start does not depend on the outer side still running (D1). It calls the `start` path with `--report send`, `--name <role>`, `--role <role>`, `--cwd <--cwd>`, `--brief <briefPath>` and `--parent <--pane>`. In send mode, `--parent` is where the child sends its report (`send --to <parent>` in `sendFooter`, and `spec.parent` in the run wrapper), so it must be the caller's pane id, as `skills/pmux/SKILL.md` requires. The env for the start is the popup env with `TMUX_PANE` also set to the `--pane` value, because `start` reads the caller pane from `TMUX_PANE` for placement and the parent session id. The popup's own `TMUX_PANE` is never used. The inner side writes the result line to the state file.

The outer side prints one result line: "started <name> in <pane>", "nothing started", or, on the Claude Code path after its 100-second limit, "dialog still open; it finishes in the popup".

### D7. Claude Code entry points are three skills

`skills/pmux-roles/`, `skills/pmux-spawn/` and `skills/pmux-reports/` each hold a `SKILL.md` with `disable-model-invocation: true` and `allowed-tools` for the one `node` command. The `!` command is one `node` invocation with no shell operator (`&&`, `||`, `;`, `|`), and the `allowed-tools` rule matches its exact text, quotes included. Claude Code allows a compound command only when each subcommand matches a rule. Outside auto mode, a `!` command that is not allowed aborts the invocation (https://code.claude.com/docs/en/permissions, "Compound commands"). The pi manifest does not register these skills: `package.json` `pi.skills` excludes each of the three directories, as it excludes `skills/pmux`. pi uses its own commands (D9). The body runs `node "${CLAUDE_SKILL_DIR}/../pmux/launch.ts" <dialog>` through Claude Code's `!` command injection, so the popup opens while the command expands. It tells the agent to answer with the printed result line and do nothing else. `launch.ts` does not change; it already forwards argv. The `!` injection makes this a prompt, so Claude Code always shows one short agent reply; that is the cost of the host, and the reply carries only the result line.

The `pmux-spawn` skill passes its arguments as one value: `spawn-dialog --args '$ARGUMENTS'`. Claude Code puts the text into the command as typed, so the single quotes keep spaces and shell characters as data, and the outer side splits the text, not the shell. Empty text opens the role list. One word is the role: the outer side checks it with `listRoles` (unknown-role refusal) before it opens the brief step. More than one word is refused with `the pmux-spawn skill takes a role only; write the task in the brief step`. The other two skills pass no arguments.

Host facts, from https://code.claude.com/docs/en/skills:

- `${CLAUDE_SKILL_DIR}` expands in the skill body.
- A `!` command runs through the Bash tool with its 2-minute timeout. At the timeout, the command is moved to the background or killed, and a kill aborts the invocation.
- `$ARGUMENTS` expands to the argument text as typed, with no shell quoting.
- A non-zero exit aborts the invocation and shows the command's output. A refusal therefore reaches the user as that output.

*Alternative:* a Claude Code plugin with `commands/`. The existing plugin (`pi-extension/pmux/plugin`) is for Claude Code children, not for the orchestrator, and skills are how the orchestrator already gets pmux.

### D8. Report history beside the registration

`report-history.ts` mirrors the inbox helpers: `historyDirPath({ env, targetPane })` uses `runtimeDirPath` with the name `pmux-history` and the inbox hash, `writeHistoryRecord`, `listHistory`, `pruneHistory`. `registerReport` takes `from` and `env` and writes the record after the registration succeeds, inside a `try` that drops any error. The `prune` command calls `pruneHistory` next to `pruneInboxes` and adds its counts to the output. The viewer reads the ack state from `readReportLog(session)`.

### D9. pi command shapes

`index.ts` registers `/pmux-roles` and `/pmux-reports`, and changes the `/pmux-spawn` handler. Each handler calls the outer function in-process (no child `node` for the outer side) and shows the result line with `ctx.ui.notify`. The handlers refuse outside tmux with `tmuxSetupHint()`.

## Risks / Trade-offs

- [A skill `!` command is stopped after 2 minutes] → The outer side stops waiting at 100 seconds (D1), and the inner side does the final action (D6). The detached tmux call (D2) lets the process exit at 100 seconds.
- [`npx skills add` installs a dialog skill without the pmux skill beside it, so `../pmux/launch.ts` misses] → The command fails, and Node's error names the missing `pmux/launch.ts` path. The skill body says that the pmux skill must be installed beside it. There is no fallback path, because a second command would make the `!` command compound (D7).
- [The popup runs in the server's env, so `PATH` can lack `node` or `pi`] → The outer side passes `process.execPath` as the node binary, and the inner side resolves `pi` with `resolvePiCommand` and the `PATH` passed through `-e PATH=...` (D1).
- [A `'` in the skill arguments ends the quoting] → A role name holds no quote, so such text is never a role. The user typed it into their own command. Claude Code does not quote the substitution (D7).
- [A popup is modal for its client] → Each dialog is short, and Escape always cancels.
- [Two clients attached to the session] → The popup opens on the client that tmux picks for `-t <pane>`. Accepted.
- [A user copy of a built-in role freezes its body] → Shown at the first edit. No drift detection in this change.
- [`/pmux-spawn` changes behavior in pi (**BREAKING**)] → Noted in the release changelog. The `pmux_spawn` tool does not change.
- [A history write adds a file write to every report] → It is after the registration and drops errors, so delivery cannot fail because of it.

## Migration Plan

No data migration. Existing role files are read as before. Rollback is a revert: history directories are left behind and `prune` (old version) ignores them; they live in the runtime directory and go away at logout.
