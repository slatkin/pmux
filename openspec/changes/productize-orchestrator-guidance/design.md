# Design

## Context

See proposal.md — Why. The load-bearing facts from the code: `resolveLaunchRecord` already takes a `strict` flag that only fires when a role was given (`params.strict && params.role`), and `cli.ts start` passes `strict: true` while the supervisor's `launchSubagent` omits it. `launchSubagent` resolves the role before any pane or launch record is written, so a thrown resolution error leaves nothing behind. The `wait` sidecar JSON is decoded by `interpretExitSidecar` in `exit-sidecar.ts`. The `send` command's typing half lives in `pane-input.ts`. Child panes are already tracked through tmux pane options (`@pmux_parent`), so a new marker option follows an existing pattern.

## Goals / Non-Goals

**Goals:**

- The pi path and the external path reject an unknown role the same way.
- A launch result makes the effective role visible without a prompt paragraph.
- The sidecar-wait JSON tells the orchestrator the next action, per reason.
- The external orchestrator never needs a raw tmux recipe from `SKILL.md`.
- The orchestrator's pane titles itself, once, on both launch paths.

**Non-Goals:**

- Editing the two orchestrator prompt files (they live in user config, outside this repo).
- Generating prompts from a pmux-owned template; deferred to its own change.
- Changing the status-signal `wait` output (the `last`-mode path); the hint serves the sidecar wait that a woken send-mode orchestrator runs.
- A receipt for `nudge` (it is parent input, not a child report).

## Decisions

### D1: Strictness is one flag flip on the pi path

The supervisor passes `strict: true` to `resolveLaunchRecord`. Because the flag only fires when a role was given, a bare `pmux_spawn` (no `agent`) keeps launching the default agent; a given-but-unresolvable role throws before any pane or record exists. The tool call wraps that throw in an error result instead of letting it escape. Alternative considered: a warning that launches the default agent anyway — rejected, because a misrouted child that commits work is worse than a refused launch.

### D2: The ack names the effective role; the record does not change

The spawn acknowledgement text appends the effective role (`Role: scout.` / `Role: default agent (no agent specified).`), and the result details gain a `role` field with the resolved name or `default`. The launch record keeps omitting `agent` for a bare spawn, because resume semantics read the record. Alternative considered: recording the default agent into the record — rejected; it would pin a resolution the next launch should redo.

### D3: Pane titling is a best-effort helper keyed on a marker option

One helper (in `tmux.ts`, beside the other pane helpers) titles a pane `<window-name>-orchestrator`: it reads the pane's window name, checks the `@pmux_orchestrator_titled` pane option, and when unset runs `select-pane -T` plus `set-option -p @pmux_orchestrator_titled 1`. The supervisor calls it for the parent's own pane at launch; `cli.ts start` calls it for `TMUX_PANE`. A tmux failure is swallowed (stderr note at most) — titling must never break a launch. Alternative considered: only title when the current title is the tmux default (host name) — rejected; the default depends on user config, while the marker is explicit and idempotent. Known residual: a user who titled the pane before the first-ever launch has that title replaced once.

### D4: The hint is derived from the decoded sidecar, next to the decoder

One `hintForExit(reason)` function lives in `exit-sidecar.ts`, beside `interpretExitSidecar`, so the decoding and the guidance cannot drift. `wait` adds its result as `hint` to the success JSON and to the timeout JSON. The hint texts name CLI commands (`resume --launch <spec> --prompt <file>`, `start`, `last-message --session <session>`, `nudge --pane <pane>`), each covered by a pinned test per reason.

### D5: `nudge` is the typing half of `send`, without the receipt

`nudge --pane --text` reuses the `pane-input.ts` encode-and-type path exactly as `send` does, minus the receipt write, and prints `{"nudged":true,"pane":<pane>,"bytes":<n>}`. Alternative considered: a `--no-receipt` flag on `send` — rejected; `send` is the child's report channel with its own contract, and one flag would make one command serve two directions of the conversation.

### D6: `close` is guarded by an ownership marker set at surface creation

The shared surface-creation path in `tmux.ts` marks every pane it creates with `@pmux_owned 1`, so both launch paths (and `resume`) produce owned panes. `close --pane` reads the option and refuses without it; the refusal names the marker so a stale pane from an older pmux can still be killed by hand. Alternative considered: a state file of owned panes — rejected; pane options already travel with the pane and need no bookkeeping or cleanup.

### D7: Only `SKILL.md` shrinks in this change

`SKILL.md` swaps its `send-keys`/`kill-pane` recipes for `nudge`/`close`, documents the `hint` field, and drops the manual `select-pane -T` step. The orchestrator prompts in user config are slimmed by the user after release; pmux only needs to stop requiring their paragraphs.

## Risks / Trade-offs

- [Strict role resolution rejects inputs that used to launch (the BREAKING note)] → the error names the role and the searched paths, and only fires when a role was explicitly given, so casual bare spawns are untouched.
- [First-launch titling replaces a pre-existing pane title once] → the marker makes it exactly once per pane; a retitle afterwards sticks.
- [The hint text is new prose that can go stale] → it lives beside the sidecar decoder and is pinned per reason by tests; it names commands, not policy.
- [Panes created by older pmux versions carry no ownership marker, so `close` refuses them] → the refusal message says why, and the pane can still be closed with tmux directly.
