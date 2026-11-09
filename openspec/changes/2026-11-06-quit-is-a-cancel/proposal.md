# Proposal

## Why

A parent cannot tell a crash from a cancel when the user quits the child.

A child the user stops with Escape writes `{"type":"cancelled"}` and ends.
That path is covered (quiet-cancel-exit). A child the user *quits* — Ctrl-C
twice, Ctrl-D, `/quit`, or a signal — writes nothing. Pi exits with code 0,
the run wrapper finds no sidecar, and it writes its own `error` sidecar with
`source: "wrapper"`. Both parents then read that as a crash:

- the pi parent gets `Sub-agent "<name>" failed after 3s (the child
  crashed).` and is told to retry or resume a child the user stopped on
  purpose;
- the skill path's `wait --signal sidecar` prints `reason: "error"` with
  `errorSource: "wrapper"`, which the skill text defines as a crash.

The user's intent of a quit is the intent of an Escape: stop the child, tell
no one. The crash wording is wrong, and it sends the parent hunting for a
failure that never happened.

## What Changes

- The child extension ends a `quit` session shutdown as a cancel: it writes
  `{"type":"cancelled"}` and status `done` with the message `cancelled` when
  the session wrote no terminal payload of its own.
- A terminal payload the session did write keeps its meaning (`done`,
  `handoff`, `ping`, `error`, `cancelled`), so a completed run that is then
  quit is not relabelled.
- A `cancelled` payload is rewritten on quit, because the parent's poll may
  already have consumed it and the wrapper would then report a crash.
- A session switch (`reload`, `new`, `resume`, `fork`) writes nothing: the
  run continues on the new session file.
- The quiet-cancel rule holds: no parent is woken for a quit.
- Docs: the skill and the guide say a `cancelled` sidecar covers Escape and
  a quit.

## Capabilities

### Modified Capabilities

- `subagent-completion`: a quit ends the session as cancelled.

## Impact

- `pi-extension/pmux/pmux-done.ts`: terminal-payload tracking and the
  `session_shutdown` rule.
- `pi-extension/pmux/exit-sidecar.ts`, `docs/guide.md`,
  `skills/pmux/SKILL.md`: cancel wording.
- Tests in `test/test.ts`.
