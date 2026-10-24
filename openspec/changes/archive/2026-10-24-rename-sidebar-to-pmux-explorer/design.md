## Context

The explorer repo's `rebrand-pmux-explorer` change (archived `2026-10-24-rebrand-pmux-explorer`, design D7) fixed the contract this change consumes: binary `pmux-explorer`; override env var `PMUX_EXPLORER_BIN` owned by pmux; the off-switch owned by pmux; task store `/tmp/pmux-explorer-tasks*.json`; window options `@pmux-explorer-spawned-*`. The sidebar emits the same event protocol; only names changed.

## Goals / Non-Goals

**Goals:** every pmux lookup that named the old product names the new one, in code, tests, skill text, docs, and live specs.
**Non-Goals:** compat aliases for the old env vars/options/paths; any change to the publish protocol or reminder wording; changes in the explorer repo.

## Decisions

1. **Env var names `PMUX_EXPLORER_BIN` and `PMUX_EXPLORER=0`.** Both are pmux-owned (explorer design D7); `PMUX_EXPLORER_BIN` is the name the contract fixes, `PMUX_EXPLORER` is the matching off-switch name. The explorer never reads either.
2. **Option names `@pmux-explorer-spawned-worktree` / `@pmux-explorer-spawned-branch`.** These are the names `src/worktree/markers.rs` now writes; the constants `SIDEBAR_WORKTREE_OPTION`/`SIDEBAR_BRANCH_OPTION` keep their Rust-side identifier names (they describe the sidebar feature, not the product).
3. **No dual reads.** Users who set the old variables rename them once; silent fallback would keep the old contract alive against the spec's "no compatibility aliases" rule.
4. **Test updates pin the new names.** The four test files' expectations are rewritten to the new names; no test count changes — this is a rename, not new behavior.

## Risks / Trade-offs

- A user running an OLD sidebar binary beside the new pmux publishes nothing (the old binary's events write old `/tmp` files and old options) — accepted; the cut-over removes the old binary.
- `docs/guide.md`'s link target `github.com/slatkin/tmux-agent-sidebar` redirects via GitHub's rename redirect, but the doc still gets the new URL so nothing relies on the redirect.
