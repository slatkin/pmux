# Spike results

Claude Code version: 2.1.311 (from `claude --version`, run in the user's pane)
Date: 2026-10-28
Session: the Claude pane is a long-running session, not a fresh one. Tasks 1.1 step 4 asks for a fresh session. The result below may need a rerun in a fresh session if idle wake is in doubt.

## 1.1 Idle wake

Result: pass

Setup: Monitor armed with `until [ -f /tmp/inbox-spike/ping1 ]; do sleep 1; done; echo ping` and `timeout_ms` 1800000. Claude was idle at the end of the turn.

Evidence: `/tmp/inbox-spike/ping1` was created at 09:45:59. The monitor printed `ping` and exited with code 0. The turn that handled the event started at about 09:46:07. No user message arrived between arming the monitor and that turn, so the turn started with nobody typing.

## 1.2 Mid-turn arrival

Result: arrived between tool calls, inside the same turn. It did not wait for the turn to end.

Setup: Monitor armed on `/tmp/inbox-spike/ping2`. Then one Bash call that waited 15 seconds with `timeout 15 tail -f /dev/null`, then a second Bash call that read the timestamps. This was a short task with two tool calls, not a long tool-heavy one. It is one sample.

Evidence: `ping2` was created at 09:47:33, while the first Bash call was still running. That call returned at 09:47:36. The monitor notice arrived after that return and before the next tool call. It did not arrive while the Bash call was blocked.

Rendering: a separate system notice, labelled as a background-task event (`<task-notification>`), with the monitor output `ping`. It is not shown as user text.

## 1.3 Permission and flags

Permission prompt: none for the Monitor call in this session. The user's settings files set no `defaultMode`, and no `allow`, `ask` or `deny` rule names `Monitor`, so the call ran in the default mode without a prompt.

`persistent` flag: not available. The Monitor tool schema has no `persistent` parameter. It requires `description` and `timeout_ms`, takes `command` or `ws`, and defaults `timeout_ms` to 300000. The schema allows up to 3600000 but its description says deadlines above 1800000 are capped to 1800000. The design and the spec both assume `persistent: true`, so that part of the design does not match this build.

## 1.4 Lifetime

`timeout_ms` expiry: a monitor armed with `timeout_ms` 60000 on a file nobody touched expired after one minute. The tool sent one notice: `Monitor expired after 1m with no events delivered. Re-arm it if you still need the watch`. No event was delivered and the `until` loop was stopped; a process check afterwards found no leftover loop. The notice reached this session after my next Bash call returned (09:49:14), not at the expiry time (about 09:48:50), so it may be held until the next tool boundary. This matches 1.2. Re-arming is required for any watch that must last longer than `timeout_ms`.

Invalid runs, not counted toward 1.4: the `ping3` and `ping6` monitors were armed after their files already existed, so both fired at once and say nothing about `/compact`. The user touched `ping3` at 09:48:18 and `ping6` at 09:49:43. The `ping4`, `ping5` and `ping7` files were touched at 09:49:39, 09:49:42 and 09:49:44 with no monitor waiting. The `ping5` monitor had already expired, so those touches produced no notice.

Also not counted: `ping8` was armed at about 09:50:50 and touched at 09:51:05 before `/compact` was run, so it does not test compact survival. The monitor fired and the notice reached the session between tool calls. The valid compact run uses `ping9`, armed at about 09:52:05, with `/compact` run before the touch.

`/compact` survival: pass. Monitor `ping9` was armed at about 09:52:05, before `/compact`. The transcript shows `/compact` start at 09:52:12 and finish at 09:52:47 (UTC, the same clock as the file times). The user touched `ping9` at 09:53:24, after the compact finished. The monitor printed `ping` and exited with code 0, and the notice reached the session. One sample.

Quit survival: no. The user chose to exit the background session when quitting Claude. Monitor `ping10` (task `b999v38ma`) stopped with it: the task notice reads `stopped`, and its output file holds only `[killed]`, with no `ping`. The `ping10` touch at 09:56:01 printed nothing. A harness kill gives the follower no chance to remove its `.monitor` marker, so the dead-pid rule in design D2 must cover a stale marker. Not tested: quitting while leaving the background session running.

`--resume` restore: no. After `claude --resume` the monitor task was not restored. The `ping10` touch printed no notice in the resumed session. This matches the expected result.

## 1.5 Re-arm rule

Result: the orchestrator must run `inbox --follow` again:

- at the start of each Claude session that sends a send-mode child,
- after `claude --resume`, because the monitor does not come back (1.4),
- whenever the `Monitor` reports that it expired (1.4, `timeout_ms`).

Use `timeout_ms` 1800000, the most this build allows. The build has no `persistent` parameter, so group 5 must not write `persistent: true`.

`/clear` was not tested. Keep the `/clear` re-arm rule from the design until a test shows it is not needed.
