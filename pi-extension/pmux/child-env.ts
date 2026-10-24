import type { AgentDefaults } from "./agent-defs.ts";

/**
 * The parent/child env contract. Producers write it with `encodeChildEnv`,
 * child-side readers parse it with `decodeChildEnv`.
 */
export interface ChildEnv {
  name?: string;
  agent?: string;
  sessionFile?: string;
  id?: string;
  activityFile?: string;
  surface?: string;
  parentRosterFile?: string;
  /** Set only for a skill-launched child: its parent is an external
   * orchestrator, so `pmux_message` must refuse `parent`. */
  externalParent?: boolean;
  autoExit: boolean;
  denyTools: string[];
}

/** Encode the child env. Writes only fields that are set. */
export function encodeChildEnv(env: ChildEnv): Record<string, string> {
  const out: Record<string, string> = {};
  if (env.name !== undefined) out.PI_PMUX_NAME = env.name;
  if (env.agent !== undefined) out.PI_PMUX_AGENT = env.agent;
  if (env.sessionFile !== undefined) out.PI_PMUX_SESSION = env.sessionFile;
  if (env.id !== undefined) out.PI_PMUX_ID = env.id;
  if (env.activityFile !== undefined) out.PI_PMUX_ACTIVITY_FILE = env.activityFile;
  if (env.surface !== undefined) out.PI_PMUX_SURFACE = env.surface;
  if (env.parentRosterFile !== undefined) {
    out.PI_PMUX_PARENT_ROSTER = env.parentRosterFile;
  }
  if (env.externalParent) out.PI_PMUX_EXTERNAL_PARENT = "1";
  if (env.autoExit) out.PI_PMUX_AUTO_EXIT = "1";
  if (env.denyTools.length > 0) out.PI_DENY_TOOLS = env.denyTools.join(",");
  return out;
}

/** Split a comma-separated tool list, trimming entries and dropping empties. */
function parseToolList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
}

/** Decode the child env. An empty string counts as not set. */
export function decodeChildEnv(env: NodeJS.ProcessEnv): ChildEnv {
  const value = (key: string): string | undefined => {
    const raw = env[key];
    return raw ? raw : undefined;
  };

  return {
    name: value("PI_PMUX_NAME"),
    agent: value("PI_PMUX_AGENT"),
    sessionFile: value("PI_PMUX_SESSION"),
    id: value("PI_PMUX_ID"),
    activityFile: value("PI_PMUX_ACTIVITY_FILE"),
    surface: value("PI_PMUX_SURFACE"),
    parentRosterFile: value("PI_PMUX_PARENT_ROSTER"),
    externalParent: env.PI_PMUX_EXTERNAL_PARENT === "1",
    autoExit: env.PI_PMUX_AUTO_EXIT === "1",
    denyTools: parseToolList(env.PI_DENY_TOOLS),
  };
}

/** True when this env belongs to a subagent child (it carries a session file). */
export function isSubagentChild(env: NodeJS.ProcessEnv = process.env): boolean {
  return decodeChildEnv(env).sessionFile !== undefined;
}

/** Child-depth env var honored by pi-blackhole's subagent detector (any
 * integer > 0 marks a subagent) and by depth-aware subagent runners. */
export const SUBAGENT_DEPTH_ENV = "PI_SUBAGENT_DEPTH";

/** pi-blackhole's extra-marker list: env names that identify a subagent. */
export const SUBAGENT_MARKERS_ENV = "PI_BLACKHOLE_SUBAGENT_MARKERS";

/** The pmux-owned env var named in the marker list. Always set on a child. */
export const SUBAGENT_MARKER_NAME = "PI_PMUX_SESSION";

/**
 * The subagent-identity part of the child env: a depth one greater than the
 * parent's, and `PI_PMUX_SESSION` appended to pi-blackhole's marker list.
 * Detected children get observational memory gated off by pi-blackhole's
 * default `subagentMemory: "off"`. Both keys are inert without a reader, and
 * the increment keeps nested pmux children reporting the right depth.
 */
export function subagentMarkerEnv(
  parentEnv: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const raw = parentEnv[SUBAGENT_DEPTH_ENV];
  const depth = raw === undefined ? 0 : Number.parseInt(raw.trim(), 10);
  const childDepth = Number.isInteger(depth) && depth > 0 ? depth + 1 : 1;

  const markers = new Set(
    (parentEnv[SUBAGENT_MARKERS_ENV] ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
  markers.add(SUBAGENT_MARKER_NAME);

  return {
    [SUBAGENT_DEPTH_ENV]: String(childDepth),
    [SUBAGENT_MARKERS_ENV]: [...markers].join(","),
  };
}

/** Tools that are gated by `spawning: false`. */
const SPAWNING_TOOLS = new Set(["pmux_spawn", "pmux_interrupt", "pmux_list", "pmux_resume"]);

/**
 * Resolve the effective set of denied tool names from agent defaults.
 * `spawning: false` expands to all SPAWNING_TOOLS.
 * `deny-tools` adds individual tool names on top.
 */
export function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
  const denied = new Set<string>();
  if (!agentDefs) return denied;

  // spawning: false → deny all spawning tools
  if (agentDefs.spawning === false) {
    for (const t of SPAWNING_TOOLS) denied.add(t);
  }

  // deny-tools: explicit list
  for (const t of parseToolList(agentDefs.denyTools)) denied.add(t);

  return denied;
}
