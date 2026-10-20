# Tasks

The publisher is tested without pi, without tmux and without a sidebar: the
payload builders are pure functions, the binary lookup takes its environment
and its file check as arguments, and the spawner is injected.

## 1. The publisher module

- [ ] 1.1 Add `pi-extension/pmux/sidebar.ts` with `resolveSidebarBinary(env, exists)`, a pure function that returns the path of the sidebar binary or `null`. The order is the environment override `TMUX_AGENT_SIDEBAR_BIN`, then `~/.tmux/plugins/tmux-agent-sidebar/bin/tmux-agent-sidebar`, then `~/.tmux/plugins/tmux-agent-sidebar/target/release/tmux-agent-sidebar`, then `tmux-agent-sidebar` on `PATH`. The function takes the home directory and the file check as arguments, so that the test needs no real home. Verify: `pnpm test` passes, and a test covers the override, both plugin paths, the `PATH` fallback and the case where nothing is found.
- [ ] 1.2 In the same module, add the payload builders as pure functions: `buildSessionStart`, `buildUserPromptSubmit`, `buildActivityLog`, `buildStop`, `buildStopFailure`, `buildNotification` and `buildSessionEnd`. Each takes the pi event it maps from and returns the JSON object of the protocol, as the design's table says. Verify: `pnpm test` passes, and a test asserts one exact payload per builder.
- [ ] 1.3 In the same module, add the publisher: `publishSidebarEvent(eventName, payload)`. It SHALL spawn `<binary> hook pi <eventName>`, write the payload as JSON to the child's stdin, ignore the child's output, and swallow a failure to start. It SHALL do nothing when the binary is `null`, when `$TMUX_PANE` is unset, or when the environment sets the sidebar switch to `0`. The binary lookup SHALL be done once and kept. Verify: `pnpm test` passes, and a test with a fake spawner asserts the command line, the stdin JSON and that a throwing spawner is swallowed.
- [ ] 1.4 Add the switch: the environment variable `TMUX_AGENT_SIDEBAR=0` turns the publishing off. Any other value, and the absence of the variable, leaves it on. Verify: `pnpm test` passes, and a test asserts that the switch off produces no spawn.

## 2. The pi subscriptions

- [ ] 2.1 In `pi-extension/pmux/index.ts`, register the subscriptions of the design's table: `session_start`, `input`, `tool_execution_start`, `tool_execution_end`, `agent_settled`, `ui_prompt_start`, `ui_prompt_end` and `session_shutdown`. Each handler builds its payload with the builder of task 1.2 and calls the publisher. Verify: `pnpm run typecheck` passes and the existing tests pass unchanged.
- [ ] 2.2 Keep the text of the run's last assistant message. `agent_settled` carries the outcome but not the messages, so the text is taken from `agent_end`, which carries the run's messages, and is kept until the run settles. A run that settles with the outcome `error` publishes `stop-failure` with the error text that pi reports; a run that settles with `completed` or `aborted` publishes `stop` with the last assistant message. Verify: `pnpm test` passes, and a test asserts both publishes and their payloads.
- [ ] 2.3 Read the sidebar's worktree markers from the pane's own window, `@agent-sidebar-spawned-worktree` and `@agent-sidebar-spawned-branch`, and put them in the session-start payload as the worktree. When the options are absent, the payload carries no worktree. Verify: `pnpm test` passes, and a test asserts the payload with and without the options.
- [ ] 2.4 The `ui_prompt_start` handler publishes `notification` with a wait reason that names the kind of prompt, and the `ui_prompt_end` handler publishes `user-prompt-submit` with an empty prompt. Verify: `pnpm test` passes, and a test asserts that the end of the wait publishes an empty prompt and no prompt text of its own.

## 3. Tests

- [ ] 3.1 Add `test/sidebar.test.ts` with a fake spawner that records the command line and the stdin JSON, and a fake file check for the binary lookup. Cover every requirement scenario of the spec delta: the prompt, the tool start, the tool end, the settled run, the failed run, the wait, the end of the wait, the session start, the session end, the missing binary, the failing spawn, the session outside tmux, the worktree, and the switch. Verify: `pnpm test` passes.
- [ ] 3.2 Add a test that the publisher does not write to the session's output and does not raise when the binary is missing. Verify: `pnpm test` passes.

## 4. Docs

- [ ] 4.1 In `docs/guide.md`, add a section on the sidebar: what a pi pane shows, that the publisher needs the sidebar binary, and that `TMUX_AGENT_SIDEBAR=0` turns it off. Verify: the section names the switch and the binary lookup order.

## 5. Gates

- [ ] 5.1 Run `pnpm run typecheck`, `pnpm test`, `pnpm run lint` and `pnpm run format:check`. Verify: all four succeed.
- [ ] 5.2 Run the release build of the sidebar fork and check the two sides against each other: a pi session in a tmux pane publishes its prompt, and the sidebar shows the pane with the `pi` colour, the prompt text and the tool activity. Verify: the pane appears in the sidebar, the prompt matches, and a tool call shows an entry in the activity log with a label.
