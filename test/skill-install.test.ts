/**
 * The sidebar-tasks skill installer, driven against real directories: the
 * packaged source is faked with a scratch directory, and the two
 * destination roots are temp directories, so the copy, the skip, the
 * refresh, the symlink and the leave-alone rule are all pinned without a
 * home directory or a pi session.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tempDirHelpers } from "./temp-dir.ts";
import {
  ensureSidebarTasksSkill,
  packagedSidebarTasksSource,
  type AgentSkillDirs,
} from "../pi-extension/pmux/skill-install.ts";

const { withTempDir } = tempDirHelpers("pmux-skill-install-");

/** A fake packaged source: the skill directory the package ships. */
function makeSource(root: string, body = "skill body v1"): string {
  const source = join(root, "packaged", "skills", "sidebar-tasks");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "SKILL.md"), body);
  writeFileSync(join(source, "reference.md"), "extra shipped page");
  return source;
}

function dirsFor(root: string, source: string): AgentSkillDirs {
  return {
    source,
    agentSkillsDir: join(root, "agent-skills"),
    claudeSkillsDir: join(root, "claude-skills"),
  };
}

const copyPath = (root: string) => join(root, "agent-skills", "sidebar-tasks");
const linkPath = (root: string) => join(root, "claude-skills", "sidebar-tasks");

/** The copy's files in one collation, so both sides sort the same way. */
const listed = (dir: string): string[] => readdirSync(dir).sort((a, b) => a.localeCompare(b, "en"));
const shipped = ["SKILL.md", "reference.md"].sort((a, b) => a.localeCompare(b, "en"));

describe("the skill installer", () => {
  it("copies the packaged skill into the shared root and symlinks it for Claude Code", () => {
    withTempDir((root) => {
      const source = makeSource(root);
      ensureSidebarTasksSkill(dirsFor(root, source));
      assert.deepEqual(listed(copyPath(root)), shipped);
      assert.equal(readFileSync(join(copyPath(root), "SKILL.md"), "utf8"), "skill body v1");
      const link = lstatSync(linkPath(root));
      assert.equal(link.isSymbolicLink(), true, "the claude entry is a symlink");
      assert.equal(readFileSync(join(linkPath(root), "SKILL.md"), "utf8"), "skill body v1");
    });
  });

  it("skips the rewrite when the copy already matches", () => {
    withTempDir((root) => {
      const source = makeSource(root);
      ensureSidebarTasksSkill(dirsFor(root, source));
      const before = statSync(join(copyPath(root), "SKILL.md"));
      ensureSidebarTasksSkill(dirsFor(root, source));
      const after = statSync(join(copyPath(root), "SKILL.md"));
      assert.equal(after.ino, before.ino, "an equal copy is left untouched");
    });
  });

  it("refreshes a stale copy, stale files included", () => {
    withTempDir((root) => {
      const source = makeSource(root);
      ensureSidebarTasksSkill(dirsFor(root, source));
      writeFileSync(join(copyPath(root), "SKILL.md"), "hand-edited");
      writeFileSync(join(copyPath(root), "stale.md"), "no longer shipped");
      ensureSidebarTasksSkill(dirsFor(root, source));
      assert.equal(readFileSync(join(copyPath(root), "SKILL.md"), "utf8"), "skill body v1");
      assert.deepEqual(listed(copyPath(root)), shipped, "the stale file is gone");
    });
  });

  it("repairs a symlink that points elsewhere", () => {
    withTempDir((root) => {
      const source = makeSource(root);
      const stray = join(root, "stray");
      mkdirSync(stray, { recursive: true });
      mkdirSync(join(root, "claude-skills"), { recursive: true });
      symlinkSync(stray, linkPath(root));
      ensureSidebarTasksSkill(dirsFor(root, source));
      assert.equal(readFileSync(join(linkPath(root), "SKILL.md"), "utf8"), "skill body v1");
      assert.notEqual(realLinkTarget(linkPath(root)), stray);
    });
  });

  it("leaves a real directory at the claude location alone", () => {
    withTempDir((root) => {
      const source = makeSource(root);
      mkdirSync(linkPath(root), { recursive: true });
      writeFileSync(join(linkPath(root), "user-own.md"), "not mine");
      ensureSidebarTasksSkill(dirsFor(root, source));
      assert.equal(lstatSync(linkPath(root)).isSymbolicLink(), false);
      assert.equal(readFileSync(join(linkPath(root), "user-own.md"), "utf8"), "not mine");
      assert.equal(
        readFileSync(join(copyPath(root), "SKILL.md"), "utf8"),
        "skill body v1",
        "the copy side still installs",
      );
    });
  });

  it("a failed install is swallowed, and what succeeded stays", () => {
    withTempDir((root) => {
      const source = makeSource(root);
      writeFileSync(join(root, "agent-skills"), "a file where a directory must go");
      assert.doesNotThrow(() => ensureSidebarTasksSkill(dirsFor(root, source)));
      assert.throws(() => readdirSync(copyPath(root)));
    });
  });

  // The production call passes the registered extension's own module URL;
  // these tests only ever see injected directories, so without this pin a
  // wrong source resolution would fail nowhere — the installer would copy
  // from a path that does not exist and swallow its own error.
  it("resolves the packaged source the manifest ships, from the extension's real location", () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    const extensionEntry: string = manifest.pi.extensions[0];
    const extensionUrl = pathToFileURL(join(repoRoot, extensionEntry)).href;

    assert.equal(
      packagedSidebarTasksSource(extensionUrl),
      join(repoRoot, "skills", "sidebar-tasks"),
    );
    assert.equal(statSync(join(repoRoot, "skills", "sidebar-tasks", "SKILL.md")).isFile(), true);
    assert.ok(
      manifest.pi.skills.some((entry: string) => entry.replace(/^\./, "") === "/skills"),
      "the manifest must keep shipping the skills at the package root",
    );
  });
});

/** The symlink's own target, as stored. */
function realLinkTarget(path: string): string {
  return readlinkSync(path);
}
