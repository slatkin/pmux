# pmux

pi integration for [tmux](https://github.com/tmux/tmux) in order to allow for pi 
orchestration of interactive subagents in tmux panes and tabs in other pi instances
as well as Claude orchestration of pi workers in the same manner. 

pmux allows for tmux pane placement, live pane titles,messages between running agents, 
context handoff to a fresh agent, spawn-time role records, and the parent-side watchdog on top.

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

The skill waits for a child to finish and reads back its report — the
default `last` mode, where the report is the child's last assistant message;
a child started with `--report send` instead writes its report to a durable
file and types a one-line pointer into the orchestrator's pane, which the
orchestrator acknowledges with an `ack` command after reading the file. The
[guide](docs/guide.md#external-orchestrators-claude-code) covers the launcher
commands, the completion signal and close-on-done behavior.

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

A role can name an alternate model in its frontmatter with a `model-fallback:`
key. Pmux ships no fallback value; the user defines it:

```markdown
---
name: glm-worker
description: Implements tasks from todos. Writes code, runs tests, makes commits.
model: hyper/glm-5.3-flash
model-fallback: opencode-go/glm-5.3-flash
---

# GLM Worker

You implement tasks from todos, run the tests and commit the result.
```

A `pmux_spawn` call with `fallback: true` runs that role on its
`model-fallback` instead of its `model`. Use it when the role's primary model
hits API limits or errors, or when the user asks for the fallback or alternate
model. The call fails at once, before any pane opens or any file is written,
when the role sets no `model-fallback` or when the same call also sets
`model`. Nothing switches models automatically: pmux never retries a child
that failed on its model, so running the role again on its fallback is the
parent's decision. `pmux_list` shows a role's fallback model next to its
primary one, and the skill launcher's `start` command takes the same choice as
a `--fallback` flag. The fallback covers only failures the parent can still
act on: a partial failure, a child that errored on its model, or a user
request. A parent whose own model is hard-limited cannot call anything at
all, so it cannot start the child; the user starts it.

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
