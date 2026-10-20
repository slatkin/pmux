# Spec Delta

## Purpose

The portable launcher starts children in tmux panes.

## MODIFIED Requirements

### Requirement: No shell or Unix tools required

Launching, resuming, running and completing subagents, from a pi parent or
through the skill, together with the Claude Code stop hook, SHALL need only
`node`, the child CLI (`pi` or `claude`) and the `tmux` binary. None of these
paths SHALL execute `bash`, `sh`, `cmd`, `powershell`, `awk`, `grep`, `sed`,
`openssl` or `python3`. Git-Bash, WSL or another Unix compatibility layer
SHALL NOT be required on Windows. The package SHALL ship no shell scripts
outside documentation.

#### Scenario: No bash installed
- **WHEN** `start`, `run`, `resume` and the stop hook run with a `PATH` that holds no `bash`, `sh`, `awk`, `grep`, `sed`, `openssl` or `python3`
- **THEN** each completes with the same results as on a machine that has them

#### Scenario: No shell scripts shipped
- **WHEN** the tracked files are listed
- **THEN** no `.sh` file and no file with a shell shebang exists outside `openspec/` and Markdown code blocks

### Requirement: Processes are spawned with argument arrays

Every child process (tmux, pi, claude) SHALL be started with an executable
and an argument array, without a shell. No argument SHALL be built by
interpolating values into a command string.

#### Scenario: Metacharacters stay literal
- **WHEN** a child name, task path or working directory contains spaces, quotes, `;`, `&` or `$(...)`
- **THEN** the child receives each value as one argument, unchanged, and no other command runs
