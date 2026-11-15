import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePiCommand } from "./launch.ts";
import { parseSurfacePlacement, type SurfacePlacement } from "./placement.ts";

/** Absolute path to `pi-extension/pmux`. https://github.com/nodejs/node/issues/37845 */
const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

export type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

export interface AgentDefaults {
  model?: string;
  modelFallback?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  denyTools?: string;
  spawning?: boolean;
  autoExit?: boolean;
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  surface?: SurfacePlacement;
  cwd?: string;
  cli?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

export interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  disableModelInvocation: boolean;
}

/**
 * Tools a role without an explicit `tools` frontmatter line runs with.
 *
 * Both launch paths use this list, so such a role no longer receives every pi
 * tool. A role that needs more lists its tools explicitly.
 */
export const DEFAULT_SUBAGENT_TOOLS = "read,bash,edit,write,grep,find,ls";

/** Tools every child keeps, so it can always reach its parent and finish. */
const SUBAGENT_CONTROL_TOOLS = ["caller_ping", "pmux_done", "pmux_message"] as const;

/** Resolve the global agent config directory, respecting PI_CODING_AGENT_DIR. */
export function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function getBundledAgentsDir(): string {
  return join(SUBAGENTS_DIR, "../../agents");
}

function getFrontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"));
  return match ? match[1].trim() : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  return value != null ? value === "true" : undefined;
}

function parseSessionMode(value: string | undefined): SubagentSessionMode | undefined {
  if (value === "standalone" || value === "lineage-only" || value === "fork") {
    return value;
  }
  return undefined;
}

export function parseAgentDefinition(
  content: string,
  fallbackName: string,
): AgentDefinition | null {
  // Role files may use CRLF line endings; normalize so both parse identically.
  const text = content.replace(/\r\n/g, "\n");
  // The closing delimiter is the first later line that is exactly `---`,
  // so an empty frontmatter block (`---\n---`) is still a role file. The
  // `^---` anchor also keeps a mid-line `---` inside a value from ending
  // the block.
  const match = text.startsWith("---\n") ? /^---\n([\s\S]*?)^---/m.exec(text) : null;
  if (!match) return null;

  const frontmatter = match[1];
  const body = text.slice(match[0].length).trim();
  const systemPromptMode = getFrontmatterValue(frontmatter, "system-prompt");

  return {
    name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
    description: getFrontmatterValue(frontmatter, "description"),
    model: getFrontmatterValue(frontmatter, "model"),
    modelFallback: getFrontmatterValue(frontmatter, "model-fallback") || undefined,
    tools: getFrontmatterValue(frontmatter, "tools"),
    systemPromptMode:
      systemPromptMode === "replace"
        ? "replace"
        : systemPromptMode === "append"
          ? "append"
          : undefined,
    skills: getFrontmatterValue(frontmatter, "skill") ?? getFrontmatterValue(frontmatter, "skills"),
    thinking: getFrontmatterValue(frontmatter, "thinking"),
    denyTools: getFrontmatterValue(frontmatter, "deny-tools"),
    spawning: parseOptionalBoolean(getFrontmatterValue(frontmatter, "spawning")),
    autoExit: parseOptionalBoolean(getFrontmatterValue(frontmatter, "auto-exit")),
    interactive: parseOptionalBoolean(getFrontmatterValue(frontmatter, "interactive")),
    sessionMode: parseSessionMode(getFrontmatterValue(frontmatter, "session-mode")),
    surface: parseSurfacePlacement(getFrontmatterValue(frontmatter, "surface")),
    cwd: getFrontmatterValue(frontmatter, "cwd"),
    cli: getFrontmatterValue(frontmatter, "cli"),
    body: body || undefined,
    disableModelInvocation:
      getFrontmatterValue(frontmatter, "disable-model-invocation")?.toLowerCase() === "true",
  };
}

/** Paths searched for a role definition, in precedence order. */
export function agentDefinitionPaths(name: string, cwd = process.cwd()): string[] {
  return [
    join(cwd, ".pi", "agents", `${name}.md`),
    join(getAgentConfigDir(), "agents", `${name}.md`),
    join(getBundledAgentsDir(), `${name}.md`),
  ];
}

export function loadAgentDefaults(agentName: string, cwd = process.cwd()): AgentDefaults | null {
  for (const p of agentDefinitionPaths(agentName, cwd)) {
    if (!existsSync(p)) continue;
    const parsed = parseAgentDefinition(readFileSync(p, "utf8"), agentName);
    if (parsed) return parsed;
  }

  return null;
}

/** Which of the three role directories a role's winning file comes from. */
export type RoleSource = "project" | "user" | "built-in";

/** One row of the role editor's list: the winning file and its values. */
export interface RoleInfo {
  name: string;
  path: string;
  source: RoleSource;
  model?: string;
  modelFallback?: string;
  thinking?: string;
}

/** The thinking values the spec fixes (`pi --help`'s list), in cycle order. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** The keys the role editor may change, in the order a save writes them. */
export const ROLE_KEYS = ["model", "model-fallback", "thinking"] as const;

/** One editable role key. */
export type RoleKey = (typeof ROLE_KEYS)[number];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace, add or delete one `key:` line in a role file's frontmatter.
 *
 * Pure text: an existing `^key:` line is replaced in place, an absent key
 * is appended as the last line before the closing `---`, and `value` null
 * deletes the line. Every other byte stays the same — the line order, the
 * line endings (a changed line keeps its own ending, an added line takes
 * the file's CRLF or LF) and the body. Throws when the file has no
 * frontmatter block.
 */
export function setFrontmatterKey(text: string, key: string, value: string | null): string {
  const eol = text.startsWith("---\r\n") ? "\r\n" : "\n";
  if (!text.startsWith(`---${eol}`)) {
    throw new Error("the role file has no frontmatter block");
  }
  const openEnd = `---${eol}`.length;
  // The closing delimiter is the first later line that is exactly `---`,
  // the same cut parseAgentDefinition makes. The search starts on the
  // opening line's own newline so an empty frontmatter still finds it.
  const closingRe = /(\r?\n)---(?=\r?\n|$)/g;
  closingRe.lastIndex = openEnd - eol.length;
  const closing = closingRe.exec(text);
  if (!closing) {
    throw new Error("the role file has no closing frontmatter delimiter");
  }
  const closeLineStart = closing.index + closing[1]!.length;

  const frontmatter = text.slice(openEnd, closeLineStart);
  const keyRe = new RegExp(`^${escapeRegExp(key)}:[^\\n]*`, "m");
  const line = keyRe.exec(frontmatter);

  let next: string;
  if (line) {
    const lineEnd = line.index + line[0].length;
    if (value === null) {
      // The match stops before `\n`; drop the terminator too.
      const drop = frontmatter[lineEnd] === "\n" ? 1 : 0;
      next = frontmatter.slice(0, line.index) + frontmatter.slice(lineEnd + drop);
    } else {
      // The match carries a trailing `\r` for a CRLF line; keep it.
      const cr = line[0].endsWith("\r") ? "\r" : "";
      next =
        frontmatter.slice(0, line.index) + `${key}: ${value}${cr}` + frontmatter.slice(lineEnd);
    }
  } else {
    if (value === null) return text;
    // The region ends on the last line's terminator, or is empty.
    next = `${frontmatter}${key}: ${value}${eol}`;
  }
  return text.slice(0, openEnd) + next + text.slice(closeLineStart);
}

/**
 * List every role that resolves for `cwd`, once per file name, by the same
 * order `loadAgentDefaults` uses: `<cwd>/.pi/agents/`, then
 * `<agentDir>/agents/`, then the package's `agents/`. A file whose
 * frontmatter the parser rejects falls through to the next source, and a
 * name no source parses is not listed. Reads only; writes nothing.
 */
export function listRoles(cwd: string, agentDir: string): RoleInfo[] {
  const sources: { dir: string; source: RoleSource }[] = [
    { dir: join(cwd, ".pi", "agents"), source: "project" },
    { dir: join(agentDir, "agents"), source: "user" },
    { dir: getBundledAgentsDir(), source: "built-in" },
  ];
  const names = new Set<string>();
  for (const { dir } of sources) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith(".md")) names.add(entry.slice(0, -".md".length));
    }
  }
  const roles: RoleInfo[] = [];
  for (const name of [...names].sort()) {
    for (const { dir, source } of sources) {
      const path = join(dir, `${name}.md`);
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      const parsed = parseAgentDefinition(text, name);
      if (!parsed) continue;
      roles.push({
        name,
        path,
        source,
        model: parsed.model,
        modelFallback: parsed.modelFallback,
        thinking: parsed.thinking,
      });
      break;
    }
  }
  return roles;
}

/** The staged edits of one save: a key's new value, or null to remove it. */
export type RoleChanges = Partial<Record<RoleKey, string | null>>;

/**
 * Apply a set of frontmatter edits to a role's file in one atomic write.
 *
 * The text is read at save time — the built-in package file for a
 * `built-in` role, else the winning file — so an edit made by hand while
 * the panel was open survives. Each staged key is folded onto the text in
 * the fixed order `model`, `model-fallback`, `thinking` with
 * `setFrontmatterKey`. A `built-in` role's target is
 * `<agentDir>/agents/<name>.md`, created with its directory: the package
 * file never changes, and no reader sees a copy without the edits. One
 * temp file in the target's directory plus one rename is the whole write.
 * Returns the path of the file written.
 */
export function writeRoleKeys(
  role: RoleInfo,
  changes: RoleChanges,
  options: { agentDir: string },
): string {
  const builtIn = role.source === "built-in";
  const target = builtIn ? join(options.agentDir, "agents", `${role.name}.md`) : role.path;
  if (builtIn) mkdirSync(dirname(target), { recursive: true });

  let next = readFileSync(role.path, "utf8");
  for (const key of ROLE_KEYS) {
    if (!(key in changes)) continue;
    next = setFrontmatterKey(next, key, changes[key] ?? null);
  }
  const tmp = `${target}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, next, "utf8");
  renameSync(tmp, target);
  return target;
}

/**
 * The `enabledModels` list one settings file sets, or null when the file is
 * missing, unreadable, not valid JSON, or the value is not an array of
 * strings — every such form counts as not setting the key.
 */
function readEnabledModelsFile(path: string): string[] | null {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const value = (data as { enabledModels?: unknown }).enabledModels;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return null;
  return value as string[];
}

/**
 * pi's `enabledModels` setting for a role editor open (design D4):
 * `<cwd>/.pi/settings.json` when that file sets the key, else
 * `<agentDir>/settings.json`, else null.
 */
export function readEnabledModels(cwd: string, agentDir: string): string[] | null {
  return (
    readEnabledModelsFile(join(cwd, ".pi", "settings.json")) ??
    readEnabledModelsFile(join(agentDir, "settings.json"))
  );
}

/** The thinking-level suffix an `enabledModels` entry may carry. */
const THINKING_SUFFIX = new RegExp(`:(${THINKING_LEVELS.join("|")})$`, "i");

/**
 * Translate one `enabledModels` glob: `*` to `.*`, `?` to `.`, a `[...]`
 * class kept as written, and every other character escaped. The result is
 * anchored and case-insensitive.
 */
function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      source += ".*";
    } else if (ch === "?") {
      source += ".";
    } else if (ch === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) {
        source += "\\[";
      } else {
        source += pattern.slice(i, close + 1);
        i = close;
      }
    } else {
      source += escapeRegExp(ch);
    }
  }
  return new RegExp(`^${source}$`, "i");
}

/**
 * The models an `enabledModels` pattern list selects, in pattern order and
 * without repeats (design D4).
 *
 * A trailing `:<thinking level>` is stripped. A pattern with `*`, `?` or
 * `[` is a case-insensitive anchored glob; any other pattern is an exact
 * case-insensitive match. Both test `provider/model` and the model id, the
 * part after the first `/`. An entry that matches no listed model is
 * skipped. pi also matches plain entries fuzzily; this does not, so an
 * entry pi resolves only that way is reachable through the picker's all
 * models scope instead.
 */
export function enabledScope(patterns: readonly string[], models: readonly string[]): string[] {
  const selected: string[] = [];
  const taken = new Set<string>();
  for (const entry of patterns) {
    const pattern = entry.replace(THINKING_SUFFIX, "");
    const glob = /[*?[]/.test(pattern) ? globToRegExp(pattern) : null;
    const exact = pattern.toLowerCase();
    for (const model of models) {
      if (taken.has(model)) continue;
      const slash = model.indexOf("/");
      const id = slash === -1 ? model : model.slice(slash + 1);
      const hit = glob
        ? glob.test(model) || glob.test(id)
        : model.toLowerCase() === exact || id.toLowerCase() === exact;
      if (!hit) continue;
      taken.add(model);
      selected.push(model);
    }
  }
  return selected;
}

/** The shape of a `pi --list-models` run, injectable for tests. */
export interface ListModelsResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/**
 * Parse `pi --list-models` output into `provider/model` strings.
 *
 * The output is a table whose first line is the header row; each later
 * line's first two whitespace-separated columns are the provider and the
 * model id. Lines with fewer than two columns are skipped.
 */
export function parseModelList(output: string): string[] {
  const models: string[] = [];
  for (const line of output.split("\n").slice(1)) {
    const [provider, model] = line.trim().split(/\s+/);
    if (provider && model) models.push(`${provider}/${model}`);
  }
  return models;
}

/**
 * The `provider/model` choices `pi --list-models` offers, resolved through
 * `resolvePiCommand`. Throws when the command cannot start, exits non-zero
 * or lists no models.
 */
export function listModels(
  deps: { env?: NodeJS.ProcessEnv; run?: (command: string[]) => ListModelsResult } = {},
): string[] {
  const command = [...resolvePiCommand({ env: deps.env }), "--list-models"];
  const run =
    deps.run ??
    ((argv: string[]): ListModelsResult => {
      const result = spawnSync(argv[0]!, argv.slice(1), {
        encoding: "utf8",
        env: deps.env,
      });
      return {
        status: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        error: result.error,
      };
    });
  const result = run(command);
  if (result.error) {
    throw new Error(`pi --list-models failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim();
    throw new Error(
      detail ? `pi --list-models failed: ${detail}` : `pi --list-models exited ${result.status}`,
    );
  }
  const models = parseModelList(result.stdout);
  if (models.length === 0) {
    throw new Error("pi --list-models listed no models");
  }
  return models;
}

/**
 * Build the child --tools allowlist.
 *
 * Pi 0.70+ applies --tools to built-in, extension, and custom tools. If a
 * subagent definition restricts tools to e.g. "read,bash,write", the child
 * control tools from pmux-done.ts would otherwise be hidden, leaving a
 * manually resumed or user-touched subagent unable to call pmux_done.
 * A role without a `tools` line falls back to DEFAULT_SUBAGENT_TOOLS.
 */
export function buildSubagentToolAllowlist(
  effectiveTools?: string,
  extraTools: readonly string[] = [],
): string {
  const requested = (effectiveTools ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);

  const allow = new Set(requested.length > 0 ? requested : DEFAULT_SUBAGENT_TOOLS.split(","));
  for (const tool of extraTools) {
    allow.add(tool);
  }
  for (const tool of SUBAGENT_CONTROL_TOOLS) {
    allow.add(tool);
  }

  return [...allow].join(",");
}
