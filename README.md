# pmux

pi integration for [tmux](https://github.com/tmux/tmux).

Subagent panes open next to their parent in tmux. The split anchors on the
caller's own pane (`$TMUX_PANE`), so a subagent opens beside its parent even
when another client is attached to another window of the same server.

- Reports live status per pane. Each child writes `working` or `idle` (and `done` or `blocked` at exit) to a status file next to its session file, and an unfocused parent pane pushes a tmux status-line notification when its turn ends.

- Adopts the subagent system from [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents) — with the completion nudge from [maplezzk's port](https://github.com/maplezzk) — and implements it for tmux panes. On top of it, this package adds: messages between running agents (`pmux_message`), a skill and launcher that let a non-pi orchestrator such as Claude Code drive pi children, context alert with handoff to a fresh agent, pane placement (right, down, or tab), live pane titles, spawn-time role records so a resume restores the role as it was at spawn, and a parent-side watchdog that finishes a stuck child instead of waiting forever.

## Install

```bash
pi install git:github.com/slatkin/pmux
# or from a local checkout:
pi install /path/to/pmux
```

## External orchestrators (Claude Code)

If the orchestrator is not a pi session (for example Claude Code), drive pi subagents through the packaged `pmux` skill. Install it from GitHub or from a local checkout:

```bash
npx skills add slatkin/pmux -g -a claude-code
# or from a local checkout:
npx skills add /path/to/pmux -g -a claude-code
```

The skill launches each child in its own pane, waits for the child's status file to reach a terminal status, and then reads the `.exit` sidecar, which says whether the child finished, handed off, pinged or failed. For the launcher commands, the completion signal, and close-on-done behavior, read [External orchestrators](docs/guide.md#external-orchestrators-claude-code).

## Configuration

The extension reads `config.json` from `~/.pi/agent/extensions/pmux/` (under `$PI_CODING_AGENT_DIR` when that variable is set). It still reads the pre-rename `~/.pi/agent/extensions/pi-luvus/` directory when the new one has no config. Seed it from `config.json.example`.

## Bundled Agents

| Agent           | Default model                             | Role                                                                              |
| --------------- | ----------------------------------------- | --------------------------------------------------------------------------------- |
| `claude-code`   | Claude Code CLI, model `opus`             | Self-driving Claude Code session for deep investigation and hands-on experiments. |
| `scout`         | `openrouter/qwen/qwen3.8-flash`           | Fast codebase reconnaissance. Maps files, patterns, and conventions.              |
| `worker`        | `openrouter/z-ai/glm-5.3-flash`           | Implements tasks from todos. Writes code, runs tests, makes commits.              |
| `reviewer`      | `openrouter/deepseek/deepseek-v4.1-flash` | Reviews code for bugs, security issues, and correctness.                          |
| `visual-tester` | `openrouter/deepseek/deepseek-v4.1-flash` | Visual QA through Chrome CDP. Screenshots, responsive checks, interaction tests.  |

Agent discovery uses this order: project-local (`.pi/agents/`), global (`~/.pi/agent/agents/`, or `$PI_CODING_AGENT_DIR/agents/` when that variable is set), package-bundled. To override a bundled agent, place a file with the same name in a higher-priority location. These models are defaults from each agent frontmatter. Pi resolves the name through its provider configuration. Override one spawn with the `model` parameter on the `pmux_spawn` tool, or permanently in frontmatter.

## Documentation

The [guide](docs/guide.md) holds the full reference:

- [Async subagent flow](docs/guide.md#async-subagent-flow): the decision model, status labels, and configuration.
- [Spawning subagents](docs/guide.md#spawning-subagents): the `pmux_spawn` tool parameters.
- [Resuming a subagent](docs/guide.md#resuming-a-subagent): the launch record, the `pmux_resume` parameters, and the fallback without a record.
- [Interrupting](docs/guide.md#interrupting-a-running-subagent), [messaging](docs/guide.md#messaging-other-agents), and [`caller_ping`](docs/guide.md#caller_ping-child-to-parent-help-request).
- [Custom agents](docs/guide.md#custom-agents): frontmatter, `session-mode`, `auto-exit`, the completion nudge, and `interactive`.
- [Tool access control](docs/guide.md#tool-access-control), [role folders](docs/guide.md#role-folders), and the [tools widget](docs/guide.md#tools-widget).

---

## License

Released under the [MIT License](LICENSE). The LICENSE file carries HazAT's copyright from the upstream code this package descends from.
