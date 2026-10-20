# Tasks

## 1. Remove the Luvus host

- [ ] 1.1 Delete `pi-extension/luvus/luvus.ts` and move the surface API it still owes the tree into the tmux backend.
- [ ] 1.2 Delete `pi-extension/luvus/luvus-status.ts` and the reporter calls in `index.ts` and `luvus-done.ts`.
- [ ] 1.3 Delete `pi-extension/luvus/uhp-events.ts` and the event stream from the supervisor's watch path; polling stays.
- [ ] 1.4 Delete `pi-extension/luvus/backend.ts` and point every import site at the tmux backend.
- [ ] 1.5 Drop the Luvus branch from the CLI's environment check, the parent-contact footer and the launch path.

## 2. Status file

- [ ] 2.1 Write the child's status (`working`, `idle`, `done`, `blocked`) next to its session file, replacing the status lease.
- [ ] 2.2 Add a `wait` command to the CLI that polls the status file for wanted statuses with a timeout, and returns the final status.
- [ ] 2.3 Make the status file the source for the parent's own view of a child, so the widget shows the same state.

## 3. External orchestration

- [ ] 3.1 Rewrite the skill's completion wait to use the CLI `wait` command and the `.exit` sidecar.
- [ ] 3.2 Rewrite the skill's report reading to use `cli.ts last-message --session <file>`.
- [ ] 3.3 Replace the Luvus agent commands in the skill and the launcher shim with the pmux equivalents.

## 4. Rename

- [ ] 4.1 Rename the tools: `luvus_spawn`, `luvus_resume`, `luvus_message`, `luvus_list`, `luvus_interrupt`, `luvus_done`.
- [ ] 4.2 Rename the environment variables `PI_LUVUS_*` to `PI_PMUX_*`.
- [ ] 4.3 Move `pi-extension/luvus/` to `pi-extension/pmux/` and update every import.
- [ ] 4.4 Move `skills/pi-luvus/` to `skills/pmux/` and update the launcher shim's paths.
- [ ] 4.5 Update the agent role files, the README, the guide and the repository guidelines.

## 5. Specs

- [ ] 5.1 Remove the `luvus-backend`, `luvus-agent-status` and `luvus-uhp-events` specs and archive the deltas.
- [ ] 5.2 Add the `pmux-host` spec for the single host, the status file and the completion protocol.
- [ ] 5.3 Update `portable-launch`, `external-orchestration`, `luvus-messaging`, `luvus-surface`, `luvus-agent-titles` and `luvus-completion` for the tmux host and the renamed identifiers.

## 6. Checks

- [ ] 6.1 Update the test suite: the Luvus stubs go, the tmux stubs cover the surface, and the status file and `wait` command get their own cases.
- [ ] 6.2 Run the full suite, the type check, the lint and the format check.
