# Design

## D1. The env marker is the compatibility boundary

`buildPiLaunch` puts `PI_PMUX_REPORT_PROTOCOL=file-ack-v1` into the
launch spec env for send-mode launches only. `send` and the run wrapper
each select their behaviour from that marker: `send` reads it from the
child's environment, the wrapper from the spec env. An already-running
pre-change child has no marker, so it keeps raw text, kindless receipts
and count-based suppression even if the package's CLI changes under it.
A resume rebuilds the env from the launch record, so a resumed child
gets the new protocol, footer and wrapper together. Marked without
`PI_PMUX_SESSION` is a configuration error, not a silent legacy
fallback.

## D2. The report file exists before any pane input

A report ID is 16 random bytes as 32 lowercase hex characters. The
artifact is `<session>.<id>.report.md`, written to
`<session>.<id>.tmp-<random>.report.md` with `wx` and renamed. The
temporary name keeps the `.report.md` suffix so prune reclaims
abandoned writes. The file holds the report exactly as received — no
pane-input encoding — and is immutable. Each `send` mints a fresh ID,
so concurrent and repeated reports cannot overwrite one another. A
failed write or a failed registration event refuses the send before
the pane is touched; the registration event is what lets the wrapper
recover the artifact, so it is required, while the post-Enter
notification event stays best-effort.

## D3. The pointer is short, self-teaching and token-terminated

The typed line is one input:

```text
pmux report <id>. Read <report-path>, then run: node <cli> ack --session <session> --id <id>. Acknowledge only after reading. [pmux-eom-<token>]
```

Paths in the embedded command are shell-quoted. The pointer carries no
report body and no newline; it still goes through `encodePaneText`.
Each notification attempt mints a fresh 32-hex visibility token while
the report ID stays stable, so a retry can prove the new attempt
appeared even when an earlier pointer is still on screen. Dedup is by
report ID. An ack means the orchestrator read the artifact — nothing
more.

## D4. Submission is verified, never edited

`verifiedAgentPrompt` in `tmux.ts` runs beside `agentPrompt`, which is
unchanged. Its sequence: refuse when `#{pane_in_mode}` is `1`; capture
the visible pane (no `-S`) and require the token absent; type the
pointer; poll mode and visible screen every 100 ms for up to 2 s until
the token appears; recheck both once; issue exactly one Enter. It never
sends Escape, Ctrl-U or any editing key — it does not change the user's
pane state. A refusal or a token timeout leaves unsubmitted text
alone and returns `not-submitted`; a tmux exception on the Enter call
returns `unknown`, because tmux may still have accepted it. No
post-Enter capture affects the result — it cannot tell a dropped Enter
from an accepted input still visible in a composer, so an Enter retry
would risk a duplicate.

## D5. `.sent` is an append-only event log

Three record kinds share the file. `report` registers the artifact
before transport (`id`, `to`, `bytes`, `report` path). `notification`
records a submitted pointer (`id`, `token`, `to`, `bytes`, `report`)
and means only that tmux accepted the Enter. `ack` (`id`) is the only
read receipt and carries no `to`, so it can never be mistaken for a
report. Readers skip malformed lines and unknown kinds; kindless lines
stay valid legacy notifications with no ID or ack semantics.
`countReportsTo` keeps counting kindless lines only.

## D6. `send` waits for the ack, and timeout is not failure

`send` polls the event log every 250 ms for an ack of its ID, for
`--ack-timeout` seconds (default 15; `0` means one immediate check).
Any successful submission exits 0, whether acked or not, and prints
`{"sent":true,"notification":"submitted","acknowledged":<bool>,...}`.
`acknowledged:false` means the parent is busy, and the footer forbids
the child from resending or sending a check message — the wrapper
re-delivers at exit. A transport refusal exits 2 with structured JSON
(`sent:false`, `notification` `not-submitted` or `unknown`,
`enterAttempted`, `error`). Usage errors stay exit 1, stderr only,
nothing sent.

## D7. `ack` is small and must persist

`ack --session <file> --id <id>` validates the ID shape, requires the
matching report file to exist, and appends the ack record. A repeat
returns `acked:true` with `alreadyAcknowledged:true` without appending;
concurrent acks may duplicate a line and readers use set semantics, so
no locking is warranted. Unlike notification bookkeeping, a failed
ack append is operational failure — exit 2, never `acked:true`.

## D8. The wrapper re-delivers, it does not wake generically

For a marked spec, the wrapper snapshots report IDs (and legacy
notification counts) before spawning. After the sentinel it re-delivers
every current-run report addressed to its parent that lacks an ack, in
registration order, same ID, fresh token, no ack wait — rechecking the
ack immediately before each retry. A `cancelled` sidecar stays quiet.
When there is no current-run report at all, the wake-up itself becomes
a durable artifact holding the existing wake text (`<name> <state>
without sending a report…` or `<name> pinged: <message>`), delivered
through the same verified pointer. Reports to another pane are ignored.
Retry failure goes to stderr and does not change the child's exit
code. Baselines make resume semantics run-scoped: old IDs and old
receipts neither flood a later run nor suppress its wake.

## D9. The scope stops at send mode

`pmux_message`, `runInPane` and the idle watchdog keep the fire-and-
forget primitive: `subagent-messaging` promises queued asynchronous
delivery and forbids retry, and the watchdog is deliberately
best-effort. Only `send` and the send-mode wrapper path move to the
verified protocol.

## D10. Residual limits are accepted, not hidden

The design does not promise absolute delivery: the exit re-delivery
can also vanish, the last screen check and the Enter are not atomic,
and ack depends on the orchestrator running the command the pointer
names. The guarantees are narrower and real: the report survives
independent of the pane, a silent success can no longer be claimed,
non-consumption is detected while the wrapper lives, and every
unacknowledged report gets one same-ID retry.
