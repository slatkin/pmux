# Tasks

## 1. Rename the spec capabilities

- [x] 1.1 `git mv` the five main spec directories (`luvus-backend` → `pane-lifecycle`, `luvus-surface` → `surface-placement`, `luvus-messaging` → `subagent-messaging`, `luvus-completion` → `subagent-completion`, `luvus-agent-titles` → `pane-titles`), change each file heading that names the old capability, and change the scenario title "Model forgets to call luvus_done" to "Model forgets to call pmux_done"; verify that `openspec list --specs` shows the five new names and no `luvus-*` name, and that `git diff -M --stat` shows renames with only the heading and scenario lines changed (design D1)
- [x] 1.2 If `openspec/changes/2026-10-23-report-user-cancel/` is still active, move its `specs/luvus-completion/` directory to `specs/subagent-completion/` and change `luvus-completion` to `subagent-completion` in its `proposal.md`, in the same commit as 1.1; verify that `openspec validate 2026-10-23-report-user-cancel --strict` passes (design D2)
- [x] 1.3 Change the spec link in `docs/guide.md` from `luvus-completion` to `subagent-completion`; verify that the linked file exists

## 2. Host spec and env guards

- [ ] 2.1 Remove the `LUVUS_*` and `PI_LUVUS_*` prefixes from `test/host-env.ts` and `test/turn-notify.test.ts`, keeping the `PI_PMUX_*`, `TMUX` and `TMUX_PANE` keys, and change the `host-env.ts` header comment so it does not name Luvus; verify with `node --test test/turn-notify.test.ts` (design D4)
- [ ] 2.2 Remove the `LUVUS_` loops and their comments from `test/prune.test.ts` and `test/cli.test.ts`, remove the CLI test "ignores the Luvus variables when tmux is absent", and change the `bare` option comment; verify with `node --test test/prune.test.ts test/cli.test.ts` (design D4; spec: pmux-host "tmux is the only host")
- [ ] 2.3 Change `pi-luvus` in the `isSentinelFile` negative case of `test/prune.test.ts` to a name with no Luvus reference; verify with `node --test test/prune.test.ts`
- [ ] 2.4 Change the `AGENTS.md` line that lists the keys `host-env.ts` removes; verify that it names the same keys as the file

## 3. Legacy config fallback

- [ ] 3.1 In `pi-extension/pmux/status.ts`, remove the `pi-luvus` extension-directory path from `legacyConfigPaths`, and keep the package-root path; verify with a test that a config only in `extensions/pi-luvus/` is not read and the default `surface` applies, and that the package-root migration test still passes (design D3)
- [ ] 3.2 Remove the test "falls back to the pre-rename extensions dir config when the pmux config is absent" from `test/test.ts`, keeping its "new directory wins, `down` reads as `pane`" check in a test that does not create `pi-luvus`; verify with `node --test test/test.ts`
- [ ] 3.3 Remove the `pi-luvus` sentence from `README.md` (Configuration) and from `docs/guide.md`, and keep the package-root fallback sentence in `docs/guide.md`; verify that `rg -i luvus README.md docs` finds nothing

## 4. Comments, names and stray files

- [ ] 4.1 In `test/test.ts`, rewrite the header comment without the Luvus backend, delete the dead Luvus fixture comment under `// --- Fixture ---`, and rename the test "delivers child and sibling messages through Luvus with the header" to name tmux; verify with `node --test test/test.ts`
- [ ] 4.2 Remove the two `luvusSession` assertions and their comment from `test/context-alert.test.ts`; verify with `node --test test/context-alert.test.ts`
- [ ] 4.3 Remove "and the Luvus CLI" from the comment in `eslint.config.js`; verify with `pnpm run lint`
- [ ] 4.4 Delete `package-lock.json`; verify that `pnpm install --frozen-lockfile` still succeeds (design D5)

## 5. Gates

- [ ] 5.1 Run `rg -i luvus --glob '!openspec/changes/archive/**'`; verify that it finds nothing, or only the `productize-orchestrator-guidance` proposal sentence that quotes the old tool name
- [ ] 5.2 Run `pnpm run format:check`, `pnpm run lint`, `pnpm run typecheck` and `pnpm test`; verify that all four pass
- [ ] 5.3 Run `openspec validate 2026-10-23-remove-luvus-references --strict`; verify that it passes

## Workflow follow-up

- Archive the change after the project's review requirements are satisfied.
- The release notes must say that `extensions/pi-luvus/config.json` is no longer read, and that the user must move it to `extensions/pmux/config.json`.
