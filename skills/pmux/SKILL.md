---
name: pmux
description: Delegated subagents for build, review, recon, or doc work across the rust-worker, reviewer, scout, worker, and advisor roles, each running as a pi process in its own tmux pane and reporting back through its session file. Relevant to requests phrased as launching, spinning up, spawning, starting, or delegating to another agent — a review agent for a commit, a worker implementing a task, a scout mapping unfamiliar code, review-fix loops repeating until pass, or mbv-orchestrator campaign work.
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

How you and a child communicate — there is no channel from the child back to
you; plain text printed in its pane is never seen, and it cannot message you:

- **The report** = the child's last assistant message in its session file.
  The footer the launcher appends to the brief tells the child this. You read
  it with `last-message --session <file>` after the wait.
- **The completion signal** = the `<session>.exit` sidecar file, written by
  `pmux_done` when the child ends: `{"type":"done"}`,
  `{"type":"handoff","message":...}`, `{"type":"ping",...}` or
  `{"type":"error",...}`. The pane-side wrapper also writes an `error` sidecar
  when the child exits without one (a crash); that one carries
  `"source":"wrapper"` and the exit code. You read the sidecar after every wait.
  The pane-side wrapper prints `__SUBAGENT_DONE_<exit code>__` when the child
  exits, and closes its own pane only on a `done` or `handoff` sidecar, after a
  grace period (5000 ms by default, set per launch with `--close-grace-ms`).

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
   node <skill-dir>/launch.ts start --name <child> --role <role> --cwd <dir> --brief <file> --parent <me> [--scratch <dir>] [--close-grace-ms <n>] [--surface pane|tab]
   ```
   `<cwd>` is the child's working directory; `--scratch` (default
   `${TMPDIR:-/tmp}/pmux`) holds the generated prompt, role prompt
   and launch spec. Each `start` deletes scratch files older than 7 days,
   so the folder stays bounded; recent sessions stay for resume. To clean
   on demand (add `--dry-run` to only list):
   ```bash
   node <skill-dir>/launch.ts prune [--scratch <dir>] [--max-age-days <n>] [--dry-run]
   ```
   `--surface` places the new pane: `pane` (default) places it
   automatically in your window — it splits your newest living child pane,
   or your own pane when you have none, side by side when that pane is at
   least twice as wide as it is tall and stacked below otherwise — and
   `tab` gives it its own window; the legacy values `right` and `down` are
   still accepted and mean `pane`; when omitted, it comes from the
   extension's `config.json`. On success it prints JSON on stdout:
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
   working — wait again or nudge it), exit 1 is a usage error. When the
   wait ends, read `<session>.exit`:
   - `{"type":"done"}` → clean finish. The pane has closed itself after
     the close grace. `rm` the `.exit` after reading.
   - `{"type":"handoff","message":...}` → the child ended cleanly but the
     task is NOT complete — the handoff text a fresh agent needs is in the
     sidecar. The pane closes itself after the close grace, like a `done`
     pane. `rm` the `.exit` after reading, then start a NEW child with
     `start` and put the handoff text in its brief. Do NOT resume that
     session.
   - `{"type":"error",...}` → provider failure — auto-retry exhausted, no
     report was sent. A sidecar that carries `"source":"wrapper"` means the
     child crashed instead; no report was sent either. The pane stays open
     showing `__SUBAGENT_DONE_<n>__`; read the last assistant message from the
     session file per step 4, `rm` the `.exit`, then retry or resume, and
     close the pane once you are done with it.
   - `{"type":"ping",...}` → the child ignored the footer and used
     `caller_ping`; the question is in the file. `rm` it, write your
     answer to a prompt file, and run `resume` with that prompt. The
     pane stays open until you close it.
   - `.exit` absent + `__SUBAGENT_DONE_<n>__` at the tail of the child's
     pane → the wrapper itself was killed, so it wrote no sidecar (a child
     crash now writes an `error` sidecar). The pane stays open. Read the last
     assistant message from the session file (step 4) and decide whether to
     relaunch, then close the pane once you are done with it.
4. Read the report — the child's last assistant message in the session
   file from the start JSON:
   ```bash
   node <skill-dir>/launch.ts last-message --session <file>
   ```
   It prints the text of the session's last assistant message, or
   `(no assistant message)`.

## While it runs / after

- A follow-up (a recheck, or the answer to the child's question) always
  runs in a **new** pane: `rm` the child's `.exit`, write the follow-up to
  a prompt file, and run:
  ```bash
  node <skill-dir>/launch.ts resume --launch <spec> --prompt <file> [--name <child>] [--surface pane|tab]
  ```
  `<spec>` is the `launch` field from the start JSON; `--name` defaults to
  the child name stored in the spec. `--surface` places the resumed pane the
  same way as `start`. The same session resumes with full
  context and the child re-reports the same way. The old pane is not needed.
  A fresh role or a correction lane → new child via `start`.
- Idle child (you expected a report long ago): type a nudge into the
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
