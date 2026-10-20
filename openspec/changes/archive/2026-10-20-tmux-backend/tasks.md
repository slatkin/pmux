# Tasks

## 1. Shared modules

- [x] 1.1 Extract `placement.ts` (surface placement and split direction) and `exit-sidecar.ts` (the `.exit` payload decoding) from `luvus.ts`, so both backends share one definition.
- [x] 1.2 Add `surface-types.ts` for the prompt delivery result, shared by both backends.
- [x] 1.3 Keep `luvus.ts` exporting the extracted names, so no import site outside the backends changes meaning.

## 2. tmux backend

- [x] 2.1 Add `pi-extension/luvus/tmux.ts`: availability from `TMUX` and `TMUX_PANE`, the caller pane id, and a test seam that replaces every `tmux` call.
- [x] 2.2 Implement pane creation: `split-window -d` anchored on the caller's pane for the `right` and `down` placements, `new-window` plus a focus restore for the `tab` placement.
- [x] 2.3 Implement naming (`select-pane -T`), command delivery (`send-keys -l` then `Enter`), screen reads (`capture-pane`), `Escape`, and close (`kill-pane`, tolerating a pane that is already gone).
- [x] 2.4 Implement prompt delivery to a pane and to a named agent pane (found by its title).
- [x] 2.5 Implement exit polling: the `.exit` sidecar first, the terminal sentinel as the fallback, with a live pane invalidating a sentinel match.

## 3. Host dispatch

- [x] 3.1 Add `pi-extension/luvus/backend.ts`: pick Luvus when its three keys are set, tmux when `TMUX` and `TMUX_PANE` are set, and fall back to the Luvus backend when neither is detected so the refusal keeps its message.
- [x] 3.2 Route every surface call through the dispatcher, and let a caller with an injected environment pass the host explicitly.
- [x] 3.3 Point `index.ts`, `supervisor.ts`, `run.ts` and `turn-notify.ts` at the dispatcher.

## 4. Host-aware CLI and child

- [x] 4.1 Accept a tmux pane as a launch environment in `cli.ts`, and resolve the caller's pane id per host.
- [x] 4.2 Write the parent-contact footer for the host: `luvus agent send` under Luvus, the last assistant message under tmux.
- [x] 4.3 Resolve the pane the wrapper runs in from `LUVUS_PANE_ID` or `TMUX_PANE` in `run.ts`.
- [x] 4.4 Use the UHP event stream only under Luvus; under tmux the supervisor polls.

## 5. Tests

- [x] 5.1 Add `test/tmux.test.ts`: availability, split anchoring, tab placement, naming, command delivery, screen reads, escape, close, prompt delivery, exit polling through the sidecar and through the sentinel.
- [x] 5.2 Add `test/host-env.ts`, which clears the Luvus and tmux host keys for the test process, and import it from the test files that exercise a backend.
- [x] 5.3 Run the full suite, the type check, the lint and the format check.

## 6. Package identity

- [x] 6.1 Rename the package to `pmux` and describe it as the pi extension for subagent panes in Luvus or tmux.
- [x] 6.2 Update the README and the repository guidelines for the second host.
