# pmux

pi integration for [tmux](https://github.com/tmux/tmux).

pmux runs pi subagents as child pi processes in tmux panes beside their
parent, in the caller's own window, where you can watch them work. Each child
reports back through files next to its session: a status file with live state
(`working`, `idle`, `done`, `blocked`), a final report, and an exit sidecar the
parent polls. The parent supervises the whole life of a child — spawn, message,
interrupt, resume — and a watchdog finishes a stuck child instead of waiting
forever. A pane outlives its child, so nothing is lost to inspection.

Children get roles: the package bundles a scout, a worker, a reviewer, a
visual tester and a self-driving Claude Code session. A role is just a
frontmatter file, so a project or the user can add or override any of them,
including where its pane opens: a split, a tab, or a floating pane. An
external orchestrator that is not a pi session — Claude Code, for example —
drives the same children through a packaged skill.

pmux adopts the subagent system from
[HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents)
— with the completion nudge from [maplezzk's port](https://github.com/maplezzk) —
and implements it for tmux panes, with pane placement, live pane titles,
messages between running agents, context handoff to a fresh agent, spawn-time
role records, and the parent-side watchdog on top.

## Install

```bash
pi install git:github.com/slatkin/pmux
# or from a local checkout:
pi install /path/to/pmux
```

## External orchestrators (Claude Code)

If the orchestrator is not a pi session, drive the same children through the
packaged `pmux` skill:

```bash
npx skills add slatkin/pmux -g -a claude-code
# or from a local checkout:
npx skills add /path/to/pmux -g -a claude-code
```

The skill waits for a child to finish and reads back its report; a child
started with `--report send` instead types the report into the orchestrator's
pane. The [guide](docs/guide.md#external-orchestrators-claude-code) covers the
launcher commands, the completion signal and close-on-done behavior.

## Configuration

The extension reads `config.json` from `~/.pi/agent/extensions/pmux/` (under
`$PI_CODING_AGENT_DIR` when that variable is set). Seed it from
`config.json.example`.

## Bundled Agents

| Agent           | Default model                             | Role                                                                              |
| --------------- | ----------------------------------------- | --------------------------------------------------------------------------------- |
| `claude-code`   | Claude Code CLI, model `opus`             | Self-driving Claude Code session for deep investigation and hands-on experiments. |
| `scout`         | `openrouter/qwen/qwen3.8-flash`           | Fast codebase reconnaissance. Maps files, patterns, and conventions.              |
| `worker`        | `openrouter/z-ai/glm-5.3-flash`           | Implements tasks from todos. Writes code, runs tests, makes commits.              |
| `reviewer`      | `openrouter/deepseek/deepseek-v4.1-flash` | Reviews code for bugs, security issues, and correctness.                          |
| `visual-tester` | `openrouter/deepseek/deepseek-v4.1-flash` | Visual QA through Chrome CDP. Screenshots, responsive checks, interaction tests.  |

Agent discovery uses this order: project-local (`.pi/agents/`), global
(`~/.pi/agent/agents/`, or `$PI_CODING_AGENT_DIR/agents/` when that variable
is set), package-bundled. To override a bundled agent, place a file with the
same name in a higher-priority location. These models are defaults from each
agent frontmatter. Pi resolves the name through its provider configuration.
Override one spawn with the `model` parameter on the `pmux_spawn` tool, or
permanently in frontmatter.

## Documentation

The [guide](docs/guide.md) is the full reference: the async subagent flow and
its decision model, spawning and resuming subagents, interrupting, messaging
and `caller_ping`, custom agent frontmatter (`session-mode`, `surface`,
`auto-exit`, the completion nudge, `interactive`), tool access control, role
folders, and the tools widget.

---

## License

Released under the [MIT License](LICENSE). The LICENSE file carries HazAT's
copyright from the upstream code this package descends from.