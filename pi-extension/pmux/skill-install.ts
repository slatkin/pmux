/**
 * Installing the packaged sidebar-tasks skill for the agents outside pi.
 *
 * pi loads the skill straight from the package (the manifest's `skills`
 * list), but an agent that is not a pi session — Claude Code, or anything
 * that reads the shared agent-skills root — never sees the package. On
 * every extension load this module installs the skill for them: the copy
 * lives in `~/.agent/skills/sidebar-tasks`, refreshed whenever the packaged
 * files change, and `~/.claude/skills/sidebar-tasks` is a symlink to it.
 * The work is one tree compare and one lstat, so a steady-state load pays
 * nothing; every failure is swallowed, because a skill install is never
 * worth disturbing the session it loads in.
 */
import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The packaged skill's directory name, in the package and at both destinations. */
const SKILL_DIR_NAME = "sidebar-tasks";

/**
 * The packaged source directory for an extension file's module URL: the
 * manifest ships the skills at the package root (`"skills": ["./skills"]`)
 * while the extension sits two directories deep (`pi-extension/pmux`), so
 * the packaged tree is two levels up from the extension file. The URL walk
 * here is that exact resolution, and the production call passes the
 * registered extension's `import.meta.url`.
 */
export function packagedSidebarTasksSource(extensionModuleUrl: string): string {
  const packageRoot = fileURLToPath(new URL("../..", extensionModuleUrl));
  return join(packageRoot, "skills", SKILL_DIR_NAME);
}

/**
 * The three paths the install works on, injected so tests drive real
 * directories: the packaged source and the two destination roots.
 */
export interface AgentSkillDirs {
  /** The packaged skill directory, the source of truth that moves with the install. */
  source: string;
  /** The shared agent-skills root; the copy lands at `<agentSkillsDir>/sidebar-tasks`. */
  agentSkillsDir: string;
  /** The Claude Code skills root; `<claudeSkillsDir>/sidebar-tasks` symlinks to the copy. */
  claudeSkillsDir: string;
}

/** One filesystem entry the tree compare understands. */
interface TreeEntry {
  name: string;
  kind: "file" | "dir";
}

/** The understood entries of one directory, sorted so compares pair the same names. */
function listEntries(dir: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) entries.push({ name: entry.name, kind: "file" });
    else if (entry.isDirectory()) entries.push({ name: entry.name, kind: "dir" });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
}

/** True when both trees hold the same relative paths with the same contents. */
function sameTree(a: string, b: string): boolean {
  let aList: TreeEntry[];
  let bList: TreeEntry[];
  try {
    aList = listEntries(a);
    bList = listEntries(b);
  } catch {
    // A missing directory, or a file where the tree expects one — the
    // trees differ and a compare must read as false, never throw.
    return false;
  }
  if (aList.length !== bList.length) return false;
  for (const [i, entry] of aList.entries()) {
    const other = bList[i];
    if (!other || other.name !== entry.name || other.kind !== entry.kind) return false;
    const thisPath = join(a, entry.name);
    const otherPath = join(b, entry.name);
    if (entry.kind === "dir") {
      if (!sameTree(thisPath, otherPath)) return false;
    } else if (!readFileSync(thisPath).equals(readFileSync(otherPath))) {
      return false;
    }
  }
  return true;
}

/** Copy the source's files over the destination, exactly: a stale file is removed. */
function mirror(source: string, target: string): void {
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
}

/**
 * Point the Claude Code location at the shared copy. A missing or
 * wrong-target symlink is created or repaired; a real directory there is
 * left alone, because it is not this install's file to replace.
 */
function linkClaudeToCopy(linkPath: string, copyPath: string): void {
  let existing: Stats | undefined;
  try {
    existing = lstatSync(linkPath);
  } catch {
    symlinkSync(copyPath, linkPath);
    return;
  }
  if (!existing.isSymbolicLink()) return;
  if (readlinkSync(linkPath) !== copyPath) {
    rmSync(linkPath);
    symlinkSync(copyPath, linkPath);
  }
}

/**
 * Make the packaged skill available to the agents outside pi: copy it into
 * the shared agent-skills root when that copy is missing or stale, and keep
 * the Claude Code location symlinked to it. Every failure is swallowed: a
 * failed install leaves the session exactly as it would load without it.
 */
export function ensureSidebarTasksSkill(dirs: AgentSkillDirs): void {
  try {
    mkdirSync(dirs.agentSkillsDir, { recursive: true });
    const copyPath = join(dirs.agentSkillsDir, SKILL_DIR_NAME);
    if (!sameTree(dirs.source, copyPath)) mirror(dirs.source, copyPath);
    mkdirSync(dirs.claudeSkillsDir, { recursive: true });
    linkClaudeToCopy(join(dirs.claudeSkillsDir, SKILL_DIR_NAME), copyPath);
  } catch {
    // Best effort: a failed skill install never disturbs the session.
  }
}
