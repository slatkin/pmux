# Spec Delta

## Purpose

The portable launcher starts children in tmux panes.

## MODIFIED Requirements

### Requirement: No shell or Unix tools required
Launching, resuming, running and completing subagents, from a pi parent or through the skill, together with the Claude Code stop hook, SHALL need only `node`, the child CLI (`pi` or `claude`) and the `tmux` binary. None of these paths SHALL execute `bash`, `sh`, `cmd`, `powershell`, `awk`, `grep`, `sed`, `openssl` or `python3`. Git-Bash, WSL or another Unix compatibility layer SHALL NOT be required on Windows. The package SHALL ship no shell scripts outside documentation.

#### Scenario: No bash installed
- **WHEN** `start`, `run`, `resume` and the stop hook run with a `PATH` that holds no `bash`, `sh`, `awk`, `grep`, `sed`, `openssl` or `python3`
- **THEN** each completes with the same results as on a machine that has them

#### Scenario: No shell scripts shipped
- **WHEN** the tracked files are listed
- **THEN** no `.sh` file and no file with a shell shebang exists outside `openspec/` and Markdown code blocks

### Requirement: Processes are spawned with argument arrays
Every child process (tmux, pi, claude) SHALL be started with an executable and an argument array, without a shell. No argument SHALL be built by interpolating values into a command string.

#### Scenario: Metacharacters stay literal
- **WHEN** a child name, task path or working directory contains spaces, quotes, `;`, `&` or `$(...)`
- **THEN** the child receives each value as one argument, unchanged, and no other command runs

### Requirement: Pane command line is shell-neutral
The one command line sent to a pane with tmux `send-keys` SHALL parse the same in bash, zsh, fish, PowerShell and cmd.exe. Its first token SHALL be the bare word `node`. Every later token SHALL be double-quoted, and SHALL NOT contain a double quote, a backtick, `$`, `%`, `!`, a backslash pair or a control character. Otherwise the launch MUST fail before any pane is split, with an error naming the offending path.

#### Scenario: Path with spaces
- **WHEN** the scratch directory is `C:\Users\Jo Smith\scratch` or `/tmp/sc ratch`
- **THEN** the pane command line double-quotes that path, and the launch succeeds

#### Scenario: Unsafe path
- **WHEN** the launch-spec path would contain `$` or `%`
- **THEN** the launch fails before `pane split` with an error naming the path

### Requirement: pi is resolved without a shell
The run wrapper SHALL resolve the pi executable in the pane, in this order: `PI_PMUX_PI_ENTRY` (a pi JavaScript entry file, run with the current `node`); on Windows, the pi package entry next to an npm `pi.cmd` shim found on `PATH`, run with the current `node`; otherwise `pi` found on `PATH`. A Windows `.cmd` or `.bat` shim SHALL NOT be executed directly.

#### Scenario: Windows npm install
- **WHEN** the wrapper runs on Windows and `PATH` holds an npm `pi.cmd` shim next to `node_modules/@earendil-works/pi-coding-agent`
- **THEN** pi starts as `node <package bin entry> ...`, with no shell

#### Scenario: Explicit entry
- **WHEN** `PI_PMUX_PI_ENTRY` names an existing file
- **THEN** pi starts as `node <that file> ...` on any platform

### Requirement: Unit tests need no shell
`npm test` SHALL run the launch, run-wrapper, tmux-backend and hook tests without spawning a shell and without writing a shell stub. tmux calls SHALL be replaced in-process. Stub children SHALL be Node scripts run with the current `node`.

#### Scenario: Test suite on a machine without bash
- **WHEN** `npm test` runs where no `bash` or `sh` is on `PATH`
- **THEN** the launch, run-wrapper, tmux-backend and hook tests run and pass
