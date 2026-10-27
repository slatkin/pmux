# Design

## Context

`file-ack-v1` (archived change `2026-10-24-report-file-ack`) made a
report durable and its reading observable: an artifact, a `report`
registration, a one-line pointer, and an explicit `ack`. One function,
`submitReportPointer` in `report-delivery.ts`, types the pointer through
`verifiedAgentPrompt`. Both `send` (`cli.ts`) and the wrapper's exit
re-delivery (`run.ts`, through `deliverReport`) call it. That function
is the one place where a new transport fits.

The Claude Code Channels contract (code.claude.com/docs/en/channels and
channels-reference, read 2026-10-25) sets these constraints:

- A channel is an MCP server that Claude Code spawns over stdio. It
  declares `capabilities.experimental["claude/channel"]` and emits
  `notifications/claude/channel` with `content` and `meta`.
- Claude Code does not acknowledge an event. If the session did not
  register the server as a channel (no `--channels` or
  `--dangerously-load-development-channels`, org policy, provider), it
  **drops the event silently**.
- On the v2 MCP client runtime, a channel server that negotiates
  protocol revision `2026-07-28` is not registered.
- Events that arrive while Claude is busy queue for the next turn.
  Events arrive only while the session is open.
- No command can inject into a Claude session by session ID. The only
  route into a session is a server that the session spawned.

The server side lives in `pmux-explorer` (Rust), in its own change,
`channel-endpoint`. This design covers the pmux side and the contract
between the two.

## Goals / Non-Goals

**Goals:**
- A marked report reaches an open Claude parent with no TTY input when
  the parent has an armed channel.
- With no armed channel, behavior is the same as today.
- The `ack` stays the only read receipt.

**Non-Goals:**
- Delivery to a closed session. Channels cannot do it, and neither can
  `send-keys`.
- A two-way channel for the `ack`. The `ack` stays a CLI command, so
  the event log keeps one writer protocol.

## Decisions

### D1. Route by parent pane, not by Claude session

The endpoint is a Unix socket whose path comes from the tmux socket path
and the parent pane id (`report-channel`, "Channel endpoint path").
`send --to <pane>` already names the parent pane. The MCP server gets
`TMUX` and `TMUX_PANE` from the Claude process that spawned it, so both
sides compute the same path with no registry and no lookup.

- Alternative: an outbox directory that the server watches. It does not
  give the sender a synchronous answer, so the sender cannot tell
  "emitted" from "nobody is there" and cannot choose the fallback. Rejected.
- Alternative: loopback TCP with a port file. A port needs a discovery
  file and is reachable by every local user. A socket in a 0700
  directory is reachable only by the owner. Rejected.
- The hash (FNV-1a 64) keeps the path below the 108-byte socket path
  limit, and it keeps two tmux servers apart. Both repositories pin one
  shared test vector, so the two implementations cannot drift.

### D2. The endpoint accepts reports only after an arm probe

Because Claude Code drops events silently in a session without the
channel flag, "the socket accepted the request" proves nothing. The
server therefore emits a probe event on connect (and again on a report
while unarmed, at most once per 60 s; see `pmux-explorer`
`channel-endpoint`) and asks Claude to run
`pmux-explorer channel-ready --nonce <n>`, which sends the nonce back
over the socket. The server exposes no MCP tools and no `instructions`,
so it adds no tokens to a turn. Until that call
arrives, the endpoint replies `unarmed`, and pmux takes the tmux
fallback. The probe proves the full path once per server process:
registration, policy, provider, and that the model reads the events.

- Alternative: trust the socket and fall back on a missing `ack`. The
  request forbids this, because a busy parent is not a transport
  failure, and a duplicate pointer would follow every slow read.
  Rejected.
- Alternative: read Claude Code's client capabilities in `initialize`.
  The docs do not say that the client advertises channel registration,
  and the result would not cover org policy. Rejected.
- Cost: one short model turn when a flagged session starts.

### D3. Channel first, fallback only on transport failure

`submitReportPointer` calls the channel client first. `emitted` ends the
attempt. Every `unavailable` reason (`report-channel`, "Channel result
classes") runs the existing verified input unchanged. The `ack` wait
(`awaitReportAck`) and the wrapper's same-ID re-delivery do not change.
A re-delivery tries the channel again, because the endpoint can be armed
by then.

The channel client is injected beside the tmux submitter
(`ReportDeliveryDeps.submitChannel`), and it has a test seam in the style
of `__setTmuxExecForTests__`. Tests never open a real socket in the
tmux-backend suites.

### D4. The pointer text does not change

The channel content is the exact pointer that the verified input would
type, with its `pmux-eom-<token>` token. The token has no job on the
channel path, but the `notification` record keys on it, and one pointer
shape keeps the `report-artifact.ts` builder and the server's shape
check in one form. The server checks the shape (`pmux report <id>. `,
one line, at most 1 KiB). It does not rebuild the text.

### D5. The records say which transport ran

`notification` gains `via` and, after a fallback, `channelError`. The
`send` result line carries `via` and, after a fallback, `channelError`;
the refusal line carries `channelError`, because a refusal can follow
only a fallback. The fields
are additive: the reader in `report-receipt.ts` already skips unknown
fields, and it reads a record without `via` as `tmux`. No new record
kind is added, so the wrapper's `ack` and re-delivery logic does not
change.

## Risks / Trade-offs

- [The endpoint emits, then its reply is lost (a 2 s timeout after the
  write)] → pmux falls back and the pointer arrives twice. The parent
  reads the same artifact twice, and the second `ack` appends nothing
  (the report-ID dedupe). Accepted limit.
- [Channels is a research preview: the flag syntax and the protocol can
  change] → with no armed endpoint, every report takes the tmux path, so
  a broken channel falls back to today's behavior, not to a loss.
- [The arm probe costs one turn when a flagged session starts] → only
  sessions started with the flag get the probe. Other sessions drop it.
- [Same-uid injection: any process of the user can write to the socket]
  → the same process can already type into the pane with `send-keys`.
  The server checks the peer uid and the pointer shape, so the socket
  adds no new reach.
- [The fallback types into a parent pane that now runs a shell] →
  current behavior, not changed here. A separate change refuses a shell
  pane.

## Migration Plan

- No data migration. Old `notification` records read as `via:"tmux"`.
- Order: `pmux-explorer` `channel-endpoint` is a prerequisite and lands
  first. This change implements its client side against that contract
  (the path rule, the request and reply line, the arm state).
- Rollback: revert this change. Old readers skip the new fields.
- Live proof (the user runs it, outside `tasks.md`). Setup: in pane P, start `claude
  --dangerously-load-development-channels plugin:pmux-explorer@slatkin`,
  accept the dialog, and wait for the probe turn. From a second pane in
  the same tmux server, send with a stand-in child:
  `S=$(mktemp -d)/child.jsonl; touch "$S"; PI_PMUX_REPORT_PROTOCOL=file-ack-v1 PI_PMUX_SESSION="$S" node pi-extension/pmux/cli.ts send --to %P --text "channel proof" --ack-timeout 120`.
  - Case A, parent idle: `send` prints `via:"channel"` and
    `acknowledged:true`. P starts a turn with no keyboard input and runs
    the `ack`. `$S.sent` holds one `report`, one `notification` with
    `via:"channel"`, and exactly one `ack` (`grep -c '"kind":"ack"'`
    prints `1`). `tmux capture-pane -p -t %P` shows no typed pointer.
  - Case B, parent closed: exit Claude in P (B1), or kill P (B2). Send
    with `--ack-timeout 10`. `channelError` is `no-endpoint` or
    `refused`, and `acknowledged` is `false`. B2 exits 2 with the
    refusal line. `$S.sent` holds the `report` record and zero `ack`
    records. The artifact holds the full text.
