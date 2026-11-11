/**
 * Inline a role's skills into an artifact-backed task.
 *
 * pi joins an `@file` argument with the first positional message and sends
 * every later message as a separate prompt after that first prompt ends. A
 * `/skill:` prompt therefore ran after the whole task, as a second agent run,
 * and that run collided with the child's auto-exit shutdown: the child hung
 * at `agent_end` with no exit sidecar. The launch now reads each skill file
 * itself and puts it in the task artifact, in the block form pi's own
 * `/skill:` expansion uses, so the child gets one prompt.
 *
 * The lookup covers pi's file-based skill locations: `<cwd>/.pi/skills`, the
 * `.agents/skills` directories from the cwd up to its git root, the agent
 * directory's `skills`, and `~/.agents/skills`. A skill it cannot find (for
 * example one a pi package ships) becomes a plain instruction to load it.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface SkillLookup {
  cwd: string;
  /** The coding-agent directory (`PI_CODING_AGENT_DIR` or `~/.pi/agent`). */
  agentDir: string;
  /** The home directory; defaults to `os.homedir()`. */
  homeDir?: string;
}

/** Split a comma-separated skill list into names. */
export function parseSkillNames(skills: string | undefined): string[] {
  return (skills ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** `.agents/skills` from `cwd` up to the git root (or the filesystem root). */
function ancestorAgentsSkillDirs(cwd: string): string[] {
  const dirs: string[] = [];
  let dir = resolve(cwd);
  for (;;) {
    dirs.push(join(dir, ".agents", "skills"));
    if (existsSync(join(dir, ".git"))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

/** The skill directories in lookup order, nearest first. */
export function skillSearchDirs(lookup: SkillLookup): string[] {
  const home = lookup.homeDir ?? homedir();
  return [
    join(lookup.cwd, ".pi", "skills"),
    ...ancestorAgentsSkillDirs(lookup.cwd),
    join(lookup.agentDir, "skills"),
    join(home, ".agents", "skills"),
  ];
}

/** The path of a skill's file, or null when no lookup directory holds it. */
export function findSkillFile(name: string, lookup: SkillLookup): string | null {
  for (const dir of skillSearchDirs(lookup)) {
    const nested = join(dir, name, "SKILL.md");
    if (isFile(nested)) return nested;
    const flat = join(dir, `${name}.md`);
    if (isFile(flat)) return flat;
  }
  return null;
}

/** Remove a leading YAML frontmatter block, as pi does before expansion. */
export function stripFrontmatter(text: string): string {
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  return (match ? text.slice(match[0].length) : text).trim();
}

/** One skill in pi's `/skill:` expansion form. */
export function formatSkillBlock(name: string, path: string, body: string): string {
  return [
    `<skill name="${name}" location="${path}">`,
    `References are relative to ${dirname(path)}.`,
    "",
    body,
    "</skill>",
  ].join("\n");
}

/**
 * The text that goes before the task: one block per skill found, then one
 * load instruction for the skills not found. Empty when there are no skills.
 */
export function buildInlineSkills(skills: string | undefined, lookup: SkillLookup): string {
  const blocks: string[] = [];
  const missing: string[] = [];
  for (const name of parseSkillNames(skills)) {
    const path = findSkillFile(name, lookup);
    let body: string | null = null;
    if (path) {
      try {
        body = stripFrontmatter(readFileSync(path, "utf8"));
      } catch {
        body = null;
      }
    }
    if (path && body !== null) blocks.push(formatSkillBlock(name, path, body));
    else missing.push(name);
  }
  if (missing.length > 0) {
    blocks.push(
      `Before you start, read and follow these skills from your available skills: ${missing.join(", ")}.`,
    );
  }
  return blocks.join("\n\n");
}
