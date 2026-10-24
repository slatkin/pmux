# Spec Delta

## MODIFIED Requirements

### Requirement: Packaged orchestration skill
The package SHALL ship a `pmux` skill at `skills/pmux/` with its `SKILL.md` and a TypeScript launcher shim, `launch.ts`, which runs under `node`. The skill directory MUST NOT contain shell scripts. The skill MUST be installable with the `npx skills` CLI from the GitHub repository or a local checkout, and MUST work when the CLI copies the directory instead of linking it. It MUST be listed in the package manifest `files`, so a packaged install carries it. The pi manifest MUST NOT register the skill. `SKILL.md` SHALL document the tmux protocol: the launch commands, the `wait` command, the completion signal, the close-on-done behaviour and the report lookup. It SHALL tell the orchestrator to read `<session>.exit` after a wait, because the sidecar says whether the child finished, handed off, pinged, failed or was cancelled by the user. It SHALL say that a `cancelled` sidecar means the session is still open, that the child removes the cancelled sidecar when a new turn starts, and that a wait issued after that waits for the next sidecar. It SHALL say that a `wait --signal status` does not return on a cancel, because the cancel writes no status-file entry and the session stays open. The statement that there is no channel from the child back to the orchestrator, and the bullet that the report is the child's last assistant message, SHALL be scoped to the default `last` mode and SHALL point at the new section, so that neither reads as false in `send` mode. The shared recipes that assume a last-mode child SHALL say that they apply to `last` mode only: the idle-child nudge text in `SKILL.md`, the `wait` paragraph in `docs/guide.md`, and the external-orchestrator paragraph in `README.md`. `SKILL.md` SHALL have a section named "External orchestrators (Claude Code)" that documents the `send` mode: start with `--report send` and `--parent "$TMUX_PANE"`; the report arrives as text typed into the orchestrator's pane; wait with `--signal sidecar`; leave the sidecar in place, because the wrapper reads it after the child exits, `start` and `resume` clear it on relaunch, and `prune` reclaims it; and `resume --launch <spec> --prompt <file>` appends the footer again. The skill's frontmatter description SHALL say that the skill serves external orchestrators such as Claude Code. A recipe SHALL be stated once in `SKILL.md`: the follow-up `resume` recipe lives in "While it runs / after", and the "External orchestrators (Claude Code)" section points at it, keeping only the send-mode fact that `resume` re-appends the send footer.

#### Scenario: Install from GitHub
- **WHEN** a user runs `npx skills add slatkin/pmux -g -a claude-code`
- **THEN** the `pmux` skill, with `launch.ts`, is installed for Claude Code

#### Scenario: Copied install still launches
- **WHEN** the skill directory is a copy outside any checkout and the extension is installed through pi's git install
- **THEN** `node <skill-dir>/launch.ts start ...` finds the extension and launches the child

#### Scenario: Pi does not load the skill
- **WHEN** the package is installed into pi with `pi install`
- **THEN** pi's skill list does not include `pmux`

#### Scenario: The skill teaches send mode
- **WHEN** an external orchestrator follows the "External orchestrators (Claude Code)" section
- **THEN** it starts the child with `--report send --parent "$TMUX_PANE"`, ends its turn, waits with `--signal sidecar` when it is woken, and does not delete the sidecar

#### Scenario: The last-mode claims are scoped
- **WHEN** a reader reads the skill's intro, the "The report" bullet, or the idle-child nudge recipe
- **THEN** each says that it describes the default `last` mode, and the intro points at the "External orchestrators (Claude Code)" section

#### Scenario: The follow-up recipe is stated once
- **WHEN** a reader reads the "External orchestrators (Claude Code)" section and then "While it runs / after"
- **THEN** the `resume` command, the `<spec>` field and the "no launch record" rule appear once, in "While it runs / after", and the external-orchestrator section points at it and says that `resume` re-appends the send footer

#### Scenario: The skill explains a cancel
- **WHEN** a reader reads how to interpret `<session>.exit` after a wait
- **THEN** the text says that `{"type":"cancelled"}` means the user aborted the child's turn, that the session is still open, that the child removes the cancelled sidecar when a new turn starts, and that a `wait --signal status` does not return on a cancel
