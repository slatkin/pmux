---
name: pmux
description: "Delegated subagents for build, review, recon and doc work: each role runs as a pi process in its own tmux pane and reports back through its session file. For an external orchestrator such as Claude Code it starts children with `--report send`, so the report reaches the orchestrator's pane as a one-line pointer to a report file. Use it when asked to launch, spawn, start or delegate work to another agent — a review agent for a commit, a worker implementing a task, a scout mapping unfamiliar code, or a review-fix loop until pass."
---

# pi subagents via tmux

You orchestrate; every subagent is a **pi** process in its own tmux pane.
Don't use your harness's built-in subagent tool (e.g. Claude Code's Agent
tool) for these roles. Requires a tmux session (`TMUX` and `TMUX_PANE` set);
outside tmux this skill does not apply. If the user wants the orchestrator to
do the work itself rather than launching a separate agent — a direct review
with no agent requested — do it directly instead. The child runs pi with the
`pmux-done` extension, which gives it the `pmux_done` tool plus auto-exit:
an `auto-exit: true` child whose turn ends normally closes itself (writing the
`.exit` sidecar); any other child that ends a turn without calling
`pmux_done` gets a 5-second completion nudge reminding it until it does.
(A pi orchestrator with the parent extension loaded should use its
`pmux_spawn` tool instead of this skill.)

All launching goes through `launch.ts`, which lives next to this file. Run it
with `node <skill-dir>/launch.ts <command>`. It finds the child extension,
resolves the role, appends the parent-contact footer to your brief, splits and
names the pane, and writes a JSON launch spec that the pane-side run wrapper
executes. Never retype its steps by hand — invoke the script.

How you and a child communicate — in the default `last` mode there is no
channel from the child back to you; plain text printed in its pane is never
seen, and it cannot message you. (A child started with `--report send` can
reach you — see [External orchestrators (Claude Code)](#external-orchestrators-claude-code).)

- **The report** (default `last` mode) = the child's last assistant message
  in its session file.
  The footer the launcher appends to the brief tells the child this. You read
  it with `last-message --session <file>` after the wait.
- **The completion signal** = the `<session>.exit` sidecar file, written by
  `pmux_done` when the child ends: `{"type":"done"}`,
  `{"type":"handoff","message":...}`, `{"type":"ping",...}` or
  `{"type":"error",...}`. A user who stops the child with Escape
  writes `{"type":"cancelled"}` instead: the child exits, its pane closes,
  and no one is woken (see the sidecar wait). The pane-side
  wrapper also writes an `error` sidecar
  when the child exits without one (a crash); that one carries
  `"source":"wrapper"` and the exit code. You read the exit after every wait,
  through the CLI's sidecar wait. The pane-side wrapper prints
  `__SUBAGENT_DONE_<exit code>__` when the child exits, and closes its own
  pane only on a `done` or `handoff` sidecar, after a grace period (5000 ms
  by default, set per launch with `--close-grace-ms`).

Role definitions resolve in this order: the project's `.pi/agents/`, then
the global `~/.pi/agent/agents/`, then the package's own `agents/`.
Current roles: `rust-worker` (code), `reviewer`
(bounded review), `scout` (recon), `worker` (docs / rote), `advisor` (only
with user consent).

## Launch

0. Pick a name for yourself — it becomes the `--parent` value — and title
   your own pane so the user can find you:
   ```bash
   tmux select-pane -t $TMUX_PANE -T '<name>-orchestrator'
   ```
   The launcher takes the pane id from `$TMUX_PANE` itself; you never pass
   one.
1. Write the brief to a file — the task, nothing else. The launcher
   appends the parent-contact footer (your name and pane, the report
   procedure) itself.
2. Start the child:
   ```bash
   node <skill-dir>/launch.ts start --name <child> --role <role> --cwd <dir> --brief <file> --parent <me> [--scratch <dir>] [--close-grace-ms <n>]
   ```
   `<cwd>` is the child's working directory; `--scratch` (default
   `${TMPDIR:-/tmp}/pmux`) holds the generated context files. `start`
   writes the task prompt to
   `<scratch>/artifacts/<parent id>/context/<name>-<timestamp>.md`
   and the role prompt to
   `<scratch>/artifacts/<parent id>/context/<name>-sysprompt-<timestamp>.md`,
   both names carrying a 19-character timestamp, and hands the child the
   task prompt as `@<path>`. The parent id is your own pane's
   `@pane_session_id`, not the `--parent` value; when that read fails or
   comes back empty, your pane id stands in and the launch continues.
   The launch spec, the session file and the launch record stay beside
   each other at `<scratch>/<base>.*`; `<session>.launch.json` is the
   launch record. `resume` rebuilds the spec from that record and writes
   the follow-up prompt to
   `<scratch>/artifacts/<parent id>/pmux-resume/<name>-<timestamp>.md`.
   Each `start` deletes scratch files older than 7 days,
   so the folder stays bounded; recent sessions stay for resume. To clean
   on demand (add `--dry-run` to only list):
   ```bash
   node <skill-dir>/launch.ts prune [--scratch <dir>] [--max-age-days <n>] [--dry-run]
   ```
   Placement comes from the role's `surface:` frontmatter when it names
   `pane`, `tab` or `float`, and then the extension's `config.json`:
   `pane` (the default) places the child automatically in your window —
   it splits your newest living child pane, or your own pane when you
   have none, side by side when that pane is at least twice as wide as
   it is tall and stacked below otherwise — `tab` gives it its own
   window, and `float` opens a floating pane in your window, half the
   window's width and height, at the top right, while you keep the focus
   (successive floats cascade down and left). On success it
   prints JSON on stdout:
   `{"pane":..., "session":..., "launch":...}`. `launch` is the launch-spec
   path a resume needs; `pane` is the child's pane id, which the nudge and
   the close commands below need; a `done` child closes its own pane after
   the close grace, so the pane id matters only while the child is alive.
3. Wait for the child. The wait command blocks until the child's status
   file holds one of the wanted statuses:
   ```bash
   node <skill-dir>/launch.ts wait --session <file> --status done,blocked --timeout <seconds>
   ```
   Exit 0 means the status was reached (the matched status line is
   printed), exit 2 means the timeout passed (a child may simply still be
   working — wait again or nudge it), exit 1 is a usage error. Then run
   the sidecar wait and act on the reason it prints:
   ```bash
   node <skill-dir>/launch.ts wait --session <file> --signal sidecar
   ```
   It blocks until `<session>.exit` appears (default timeout 600 s) and
   prints one JSON line:
   `{"reason":"done","exitCode":0,"sidecar":"/abs/path/<session>.exit"}`.
   `reason` is one of `done`, `handoff`, `ping`, `error`, `cancelled`; the
   JSON also
   carries `handoff.message` or `ping.message` where they apply, and
   `"errorSource":"wrapper"` when the wrapper wrote the sidecar. A timeout
   prints `{"sidecar":null}` and exits 2. The pane may already have closed
   itself after the close grace; the sidecar stays on disk, so the wait
   still reports the exit. Never touch the `<session>.exit` file yourself:
   `wait` never deletes it either, and the pane-side wrapper reads the same
   file after the child exits. Act on the reason:
   - `done` → clean finish. The pane has closed itself after the close
     grace.
   - `handoff` → the task is NOT complete. The handoff text a fresh agent
     needs is in the sidecar; the wait prints it as `handoff.message`. The
     pane closes itself after the close grace, like a `done` pane. Start a
     NEW child with `start` and put the handoff text in its brief. Do NOT
     resume that session.
   - `error` → provider failure — auto-retry exhausted, no report was
     sent. `"errorSource":"wrapper"` in the JSON means the child crashed
     instead; no report was sent either. The pane stays open showing
     `__SUBAGENT_DONE_<n>__`; read the last assistant message from the
     session file per step 4, then retry or resume, and close the pane
     once you are done with it.
   - `ping` → the child ignored the footer and used `caller_ping`; the
     question is `ping.message` in the JSON. Write your answer to a prompt
     file, and run `resume` with that prompt. A spec with no launch record
     beside its session file (one from an older version) cannot be
     resumed — `resume` exits 1 and its message names `start`, so run
     `start` again. The pane stays open until you close it.
   - `cancelled` → the user stopped the child in its pane (Escape). The
     child has exited and its pane closes after the grace period; there is
     no result. A `wait --signal status` returns `done` with the message
     `cancelled`. Do not resume or replace the child unless the user asks.
   - `{"sidecar":null}` (timeout) + `__SUBAGENT_DONE_<n>__` at the tail of
     the child's pane → the wrapper itself was killed, so it wrote no
     sidecar (a child crash writes an `error` sidecar, which the wait
     reports). The pane stays open. Read the last assistant message from
     the session file (step 4) and decide whether to relaunch, then close
     the pane once you are done with it.
4. Read the report (default `last` mode; in `send` mode the report arrives as
   pointer-named report files instead — see
   [External orchestrators (Claude Code)](#external-orchestrators-claude-code)) —
   the child's last assistant message in the session
   file from the start JSON:
   ```bash
   node <skill-dir>/launch.ts last-message --session <file>
   ```
   It prints the text of the session's last assistant message, or
   `(no assistant message)`.

## External orchestrators (Claude Code)

The recipes above describe the default `last` mode: you can block in
`wait`, and the report is the child's last assistant message. This section
is for an orchestrator that cannot poll — Claude Code and any harness where
you end a turn and are woken only by text arriving in your own pane. It
starts the child with `--report send`: the child delivers its report through
the `send` command its footer teaches, which writes the report to a durable
`.report.md` file next to its session file and types only a one-line pointer
into your pane.

0. Your own pane id is `$TMUX_PANE` — it is always set inside a pane, and
   it is what children send their reports to. There is no parent name to
   pick: every child gets `--parent "$TMUX_PANE"`.
1. Write the brief to a file — the task, nothing else. The launcher appends
   the send-mode parent-contact footer (your pane id and the send procedure)
   itself.
2. Start the child:
   ```bash
   node <skill-dir>/launch.ts start --name <child> --role <role> --cwd <dir> --brief <file> --parent "$TMUX_PANE" --report send [--scratch <dir>] [--close-grace-ms <n>]
   ```
   On success it prints JSON on stdout:
   `{"pane":..., "session":..., "launch":...}` — the session file (the
   `.exit` sidecar lives next to it), the launch-spec path a resume needs,
   and the child's pane id, which matters only while the child is alive,
   because a `done` child closes its own pane after the close grace.
3. End the turn. A report arrives as one new prompt line — the pointer the
   child's `send` command typed into your pane. It carries no report body,
   only the report ID, the path of the report file, the `ack` command and a
   visibility-token tail:
   ```text
   pmux report <id>. Read '<report file>', then run: node '<cli>' ack --session '<session>' --id <id>. Acknowledge only after reading. [pmux-eom-<token>]
   ```
   Read the named file, then run the embedded `ack` command — after reading,
   not before, because an unacknowledged report is the one the wrapper
   re-delivers. A repeat delivery keeps the same report ID and mints a fresh
   token, so dedup pointers by the report ID and ignore a pointer you have
   already handled. Never touch the report files or the `<session>.sent`
   event log yourself. Do NOT sit in a polling loop instead of ending your
   turn; the wake-up is the message, not the file.
4. When you are awake again (the report arrived, or you want the child's
   final state), wait for the sidecar and read the JSON the wait prints:
   ```bash
   node <skill-dir>/launch.ts wait --session <session> --signal sidecar [--timeout <seconds>]
   ```
   `wait` blocks until `<session>.exit` appears (default timeout 600 s). On
   success it prints one JSON line and exits 0:
   `{"reason":"done","exitCode":0,"sidecar":"/abs/path/<session>.exit"}`.
   `reason` is one of `done`, `handoff`, `ping`, `error`, `cancelled`; a
   sidecar the
   wrapper wrote itself carries `"source":"wrapper"`, printed in the wait
   JSON as `"errorSource":"wrapper"`. A timeout prints
   `{"sidecar":null}` and exits 2 (a child may simply still be working —
   wait again, or nudge it); a usage error exits 1 and prints nothing on
   stdout. `wait` never deletes the sidecar, and neither may you — read the
   JSON and act on the reason, but leave the sidecar in place. The
   `sidecar` field of the printed JSON is that absolute path.
5. Act on the reason from the wait JSON:
   - `done` → clean finish. The child closed itself; the pane has closed
     after the close grace. Its report arrived while it ran as report files
     named by pointers — or the wrapper woke you that it exited without
     sending one.
   - `handoff` → the child ended cleanly at its context alert, but the task
     is NOT complete. The handoff text a fresh agent needs is in the
     sidecar; the wait prints it as `handoff.message` in the JSON. The pane
     closes itself after the close grace, like a `done` pane. Do NOT resume
     that session: start a NEW child with `start` and put the handoff text
     in its brief.
   - `error` → two causes. The JSON carries `"errorSource":"wrapper"` when
     the wrapper wrote the sidecar: the child crashed. Otherwise it is a
     provider failure — auto-retry exhausted. Either way the child ended
     before it could finish, so count on no report: only a wake-up already
     delivered to your pane tells you that one arrived. The pane stays open
     showing `__SUBAGENT_DONE_<n>__`; read the last assistant message with
     `last-message --session <session>`, then retry or resume, and close
     the pane once you are done with it.
   - `ping` → the child asked a question with `caller_ping` instead of
     sending a report. The question is in the JSON (`ping.message`) and in
     the wake-up text the wrapper sent you. Answer it with a `resume`
     (see [While it runs / after](#while-it-runs--after)). The pane stays
     open until you close it.
   - `cancelled` → the user stopped the child in its pane (Escape). The
     child has exited, its pane closes, no report is coming, and the
     wrapper does not wake you. Do not resume or replace the child unless
     the user asks; to continue it, use a `resume` (see
     [While it runs / after](#while-it-runs--after)).
   - No sidecar at all (timeout) and `__SUBAGENT_DONE_<n>__` at the tail of
     the child's pane → the wrapper itself was killed, so the child wrote
     no sidecar. The pane stays open. Read the last assistant message and
     decide whether to relaunch, then close the pane once you are done with
     it.

The wrapper also contacts you at the child's exit. A run that produced no
report wakes you: the wake text — `<child> <state> without sending a report.
Read its last message: node <cli> last-message --session <session>`, where
`<state>` is the sidecar type, or `exited` or `crashed (code <n>)` when no
sidecar was written, and a `ping` reads `<child> pinged: <message>` — goes
to its own pointer-delivered file, so you read the pointer first. A run that
produced reports re-delivers, in registration order, every one you have not
acknowledged, under the same report ID with a fresh token. That exit pass is
the last attempt: when it also fails to land in your pane, nothing is
re-sent. A `cancelled` child sends no wake-up: the user stopped it and is in
control. A child that ignored its footer therefore still wakes you.

A follow-up (a recheck, or the answer to the child's question) always runs
in a **new** pane — the `resume` command is in
[While it runs / after](#while-it-runs--after). In send mode `resume`
re-appends the send footer, so the resumed child still knows how to reach
you.

## While it runs / after

- A follow-up (a recheck, or the answer to the child's question) always
  runs in a **new** pane: write the follow-up to a prompt file and run
  ```bash
  node <skill-dir>/launch.ts resume --launch <spec> --prompt <file> [--name <child>]
  ```
  `<spec>` is the `launch` field from the start JSON; `--name` defaults to
  the child name stored in the spec. `resume` clears the stale `.exit`
  sidecar of the session it relaunches, rebuilds the launch spec from the
  session's launch record (`<session>.launch.json`) and writes the follow-up
  prompt under `artifacts/<parent id>/pmux-resume/`. A spec with no record
  beside its session file (one from an older version) cannot be resumed —
  `resume` exits 1 and its message names `start`, so run `start` again. A
  resume keeps the role's surface, then the extension's `config.json`
  applies; the same session resumes with full context and the child
  re-reports the same way. The old pane is not needed. A fresh role or a
  correction lane → new child via `start`.
- Idle child (you expected a report long ago; `last` mode — a send-mode
  child reports with the `send` command its footer teaches, see
  [External orchestrators (Claude Code)](#external-orchestrators-claude-code)):
  type a nudge into the
  child's pane and press Enter, using the pane id from the `pane` field of
  the start JSON:
  ```bash
  tmux send-keys -t <pane> -l "status? Write your report as your last assistant message, then call pmux_done"
  tmux send-keys -t <pane> Enter
  ```
  The child extension's own 5-second nudge handles the common
  forgot-to-exit case; this one handles a silent stall.
- Close the pane only for `error`, `ping` and crash panes once you are done
  with them: `tmux kill-pane -t <pane>`. A `done` or `handoff` pane closes
  itself after the close grace — there is nothing to close. Never close
  panes you didn't create.
- One writer per worktree at a time; read-only roles may run in parallel.

## Review-fix loop

For "review this commit, fix the findings, repeat until pass": launch one
`reviewer` child with `node <skill-dir>/launch.ts start`. Each round: assess the
returned findings yourself, apply the fixes (or delegate them to a `worker`
child), commit, then write a `review <SHA>` follow-up prompt and run
`node <skill-dir>/launch.ts resume` with it. The resumed session keeps context
across rounds, so it can verify its earlier findings are actually addressed.
When it reports pass, ship.
