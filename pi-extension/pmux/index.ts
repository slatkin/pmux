import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Box, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { readdirSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import {
  isTmuxAvailable,
  tmuxSetupHint,
  callerPaneId,
  createSurface,
  pollForExit,
  closeSurface,
  sendEscape,
  readScreen,
  runInPane,
  agentPrompt,
  listPaneTargets,
  readWindowOptions,
  type PaneTargetRow,
} from "./tmux.ts";
import { parseSurfaceDefault, type SurfaceDefault } from "./placement.ts";
import {
  createSupervisor,
  SubagentParams,
  UnknownRoleError,
  borderLine,
  buildLaunchMessagingHint,
  buildPiPromptArgs,
  buildSpawnEnvParts,
  buildSubagentTaskPrompt,
  drainAndRemoveParentMessages,
  formatElapsed,
  getDefaultSessionDirFor,
  getParentMessageFile,
  getShellReadyDelayMs,
  readParentMessages,
  resolveDenyTools,
  resolveEffectiveInteractive,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveResultPresentation,
  type ParentMessage,
  type RunningSubagent,
  type SubagentRoster,
  type Supervisor,
} from "./supervisor.ts";

// Re-exported for the module's test surface (see __test__ below).
export { resolveModeHint } from "./supervisor.ts";
import {
  buildSubagentToolAllowlist,
  getAgentConfigDir,
  getBundledAgentsDir,
  loadAgentDefaults,
  parseAgentDefinition,
  type AgentDefinition,
} from "./agent-defs.ts";

import { decodeChildEnv, isSubagentChild } from "./child-env.ts";
import { loadStatusConfig, loadSurfaceConfig, writeSurfaceConfig } from "./status.ts";
import { createTurnNotifier } from "./turn-notify.ts";
import { createLiveTitleController } from "./live-title.ts";
import { createSidebarEvents } from "./sidebar-events.ts";
import {
  createSidebarPublisher,
  worktreeFromOptions,
  SIDEBAR_BRANCH_OPTION,
  SIDEBAR_WORKTREE_OPTION,
  type SidebarWorktree,
} from "./sidebar.ts";
import { createThinkingFeed } from "./thinking-feed-events.ts";
import {
  createTaskReminders,
  readSidebarTaskStore,
  readSidebarTaskStoreMtime,
} from "./task-reminders.ts";

// Survive /reload: the supervisor owns every timer, poll watcher and event
// wiring this module load started. /reload re-imports this file, so shutting
// down the supervisor stored under one per-URL key stops the previous load's
// closures. See https://github.com/HazAT/pi-interactive-subagents/issues/5
//
// The key is namespaced per module URL: multiple copies of this extension can
// coexist in one process (e.g. a global install plus the project copy), and a
// shared key would let one copy shut down the other's supervisor.
const INSTANCE_KEY = `#${import.meta.url}`;
const SUPERVISOR_KEY = Symbol.for(`pmux/supervisor${INSTANCE_KEY}`);

/** The pi that registration bound last; the supervisor's deps.send targets it. */
let activePi: ExtensionAPI | null = null;

/** Latest ExtensionContext from session_start, used for widget updates. */
let latestCtx: ExtensionContext | null = null;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getSupervisor(): Supervisor | undefined {
  return (globalThis as any)[SUPERVISOR_KEY] as Supervisor | undefined;
}

// ── Sidebar worktree markers (design D7) ──

/** The pane's sidebar worktree, or undefined when the pane has none. */
function readSidebarWorktree(pane: string | undefined): SidebarWorktree | undefined {
  if (!pane) return undefined;
  try {
    const [worktree, branch] = readWindowOptions(pane, [
      SIDEBAR_WORKTREE_OPTION,
      SIDEBAR_BRANCH_OPTION,
    ]);
    return worktreeFromOptions({ worktree, branch });
  } catch {
    // A missing or wedged tmux server must not break the session start.
    return undefined;
  }
}

function createSupervisorInstance(): Supervisor {
  const supervisor = createSupervisor({
    send: (message, options) => {
      activePi?.sendMessage(message, options);
    },
    ui: () => latestCtx,
    pmux: {
      createSurface,
      runInPane,
      closeSurface,
      sendEscape,
      readScreen,
      pollForExit,
      agentPrompt,
    },
    statusConfig,
  });
  (globalThis as any)[SUPERVISOR_KEY] = supervisor;
  return supervisor;
}

/** The live supervisor for this module load, created on first use. */
function currentSupervisor(): Supervisor {
  return getSupervisor() ?? createSupervisorInstance();
}

// The previous module load's supervisor must not outlive the reload.
getSupervisor()?.shutdown();

type AgentSource = "package" | "global" | "project";

interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource;
}

function discoverAgentDefinitions(): ListedAgentDefinition[] {
  const agents = new Map<string, ListedAgentDefinition>();
  const dirs: Array<{ path: string; source: AgentSource }> = [
    { path: getBundledAgentsDir(), source: "package" },
    { path: join(getAgentConfigDir(), "agents"), source: "global" },
    { path: join(process.cwd(), ".pi", "agents"), source: "project" },
  ];

  for (const { path: dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
      const parsed = parseAgentDefinition(
        readFileSync(join(dir, file), "utf8"),
        file.replace(/\.md$/, ""),
      );
      if (!parsed) continue;
      agents.set(parsed.name, { ...parsed, source });
    }
  }

  return [...agents.values()];
}

function muxUnavailableResult() {
  return {
    content: [
      {
        type: "text" as const,
        text: `Subagents require tmux. ${tmuxSetupHint()}`,
      },
    ],
    details: { error: "mux not available" },
  };
}

const statusConfig = loadStatusConfig();

// Subagent surface placement default: "pane" (the dwindle split rule places
// the pane in the caller's window) or "tab" (own workspace tab), never
// "float" — the SurfaceDefault type makes that a compile-time rule. Loaded
// from the extension config (~/.pi/agent/extensions/pmux/config.json) and
// changeable at runtime via /pmux-surface.
let surfaceDefault: SurfaceDefault = loadSurfaceConfig();

export function getSurfaceDefault(): SurfaceDefault {
  return surfaceDefault;
}

export function setSurfaceDefault(value: SurfaceDefault): void {
  surfaceDefault = value;
}

// Test hook: redirect config.json writes away from the extension config dir.
let surfaceConfigPath: string | undefined;
export const __surfaceTest__ = {
  setConfigPath(path: string | undefined) {
    surfaceConfigPath = path;
  },
};

// ── Parent/child messaging (design Decisions 4, 5, 8) ──
//
// Children and siblings are addressed through tmux `send-keys` (tmux.ts).
// `parent` is not: a child appends JSON lines to `<session>.msg`, and the
// parent's existing poll loop injects them as steering messages.

export type SubagentRelation = "parent" | "child" | "sibling" | "pane";

export interface MessageTarget {
  relation: SubagentRelation;
  name: string;
  /** Pane id for child and sibling targets; absent for `parent`. */
  id?: string;
  pane?: string;
}

/** Names the sender can reach right now, for the "no such target" error. */
function reachableTargetNames(params: {
  hasParent: boolean;
  externalParent?: boolean;
  ownChildren: Array<Pick<RunningSubagent, "name">>;
  parentRoster: SubagentRoster | null;
  selfId: string;
}): string[] {
  const names: string[] = [];
  if (params.hasParent && !params.externalParent) names.push("parent");
  for (const child of params.ownChildren) names.push(child.name);
  for (const sibling of params.parentRoster?.children ?? []) {
    if (sibling.id !== params.selfId) names.push(sibling.name);
  }
  return [...new Set(names)];
}

/** The outcome of matching `to` against the server pane listing. */
type PaneResolution = { target: PaneTargetRow } | { error: string } | { none: true };

/** `session:window.pane` labels for ambiguity errors, e.g. `%3 (work:0.1)`. */
function paneMatchLabels(rows: PaneTargetRow[]): string {
  return rows
    .map((row) => `${row.paneId} (${row.sessionName}:${row.windowIndex}.${row.paneIndex})`)
    .join(", ");
}

/** Active pane of the matched windows, or an ambiguity error. */
function activePaneResult(to: string, windowRows: PaneTargetRow[]): PaneResolution | null {
  const active = windowRows.filter((row) => row.active);
  if (active.length === 1) return { target: active[0] };
  if (active.length > 1) {
    return {
      error: `Ambiguous pane target "${to}". Matches: ${paneMatchLabels(active)}.`,
    };
  }
  return null;
}

/**
 * Match tmux target syntax against the listing: `sess:win.pane`, `sess:win`,
 * `sess:`, `win.pane`, `win`, `.pane`, `@N` window id, or a bare token.
 * Session-less forms anchor on the caller pane's session and window, never
 * the server's current window. Returns null when `to` matches no window or
 * pane, so the caller can fall through to pane-title matching.
 */
function matchTargetSyntax(
  to: string,
  panes: PaneTargetRow[],
  callerRow: PaneTargetRow | undefined,
): PaneResolution | null {
  const colon = to.indexOf(":");
  const sessPart = colon >= 0 ? to.slice(0, colon) : "";
  const rest = colon >= 0 ? to.slice(colon + 1) : to;

  let sessionRows = panes;
  if (sessPart) {
    sessionRows = panes.filter((row) => row.sessionName === sessPart || row.sessionId === sessPart);
  } else if (callerRow) {
    sessionRows = panes.filter((row) => row.sessionId === callerRow.sessionId);
  }

  // `@N` addresses a window by id; its active pane is the target.
  if (rest.startsWith("@")) {
    const winRows = sessionRows.filter((row) => row.windowId === rest);
    return winRows.length ? activePaneResult(to, winRows) : null;
  }

  const dot = rest.indexOf(".");

  // A bare token is a pane index in the caller's window first, then a window
  // index, id or name in the anchored session (its active pane is the target).
  if (colon < 0 && dot < 0) {
    if (callerRow) {
      const paneHit = sessionRows.filter(
        (row) => row.windowId === callerRow.windowId && row.paneIndex === rest,
      );
      if (paneHit.length === 1) return { target: paneHit[0] };
    }
    const winRows = sessionRows.filter(
      (row) => row.windowIndex === rest || row.windowId === rest || row.windowName === rest,
    );
    return winRows.length ? activePaneResult(to, winRows) : null;
  }

  // `sess:` alone means the session's active window.
  const windowRows = sessionRows.filter((row) => row.windowActive);
  if (rest === "") {
    return windowRows.length ? activePaneResult(to, windowRows) : null;
  }

  const winPart = dot >= 0 ? rest.slice(0, dot) : rest;
  const panePart = dot >= 0 ? rest.slice(dot + 1) : undefined;

  const winRows = winPart
    ? sessionRows.filter(
        (row) =>
          row.windowId === winPart || row.windowIndex === winPart || row.windowName === winPart,
      )
    : sessionRows.filter((row) => callerRow && row.windowId === callerRow.windowId);
  if (!winRows.length) return null;

  // `win.` or `win` alone means the window's active pane.
  if (panePart === undefined || panePart === "") {
    return activePaneResult(to, winRows);
  }
  const paneRows = winRows.filter((row) => row.paneIndex === panePart || row.paneId === panePart);
  if (paneRows.length === 1) return { target: paneRows[0] };
  if (paneRows.length > 1) {
    return {
      error: `Ambiguous pane target "${to}". Matches: ${paneMatchLabels(paneRows)}.`,
    };
  }
  return null;
}

/**
 * Resolve `to` against the pane listing, after every managed-agent form
 * failed: exact pane id, then tmux target syntax, then exact pane title
 * (design D2).
 */
function matchPaneTarget(
  to: string,
  panes: PaneTargetRow[],
  callerPane: string | undefined,
): PaneResolution {
  const byId = panes.find((row) => row.paneId === to);
  if (byId) return { target: byId };

  const callerRow = callerPane ? panes.find((row) => row.paneId === callerPane) : undefined;
  const syntax = matchTargetSyntax(to, panes, callerRow);
  if (syntax) return syntax;

  const byTitle = panes.filter((row) => row.title === to);
  if (byTitle.length === 1) return { target: byTitle[0] };
  if (byTitle.length > 1) {
    return {
      error: `Ambiguous pane title "${to}". Matches: ${paneMatchLabels(byTitle)}.`,
    };
  }
  return { none: true };
}

/**
 * Resolve a `to` target (design Decision 4): `parent`, one of the sender's own
 * running children, or a running sibling (the parent's other children minus
 * the sender). Exact ids win over names; an ambiguous name reports its matches.
 * When `panes` carries a `list-panes -a` snapshot, a `to` that matches no agent
 * is then tried as a raw tmux target — pane id, target syntax, pane title.
 */
export function resolveMessageTarget(params: {
  hasParent: boolean;
  /** True when the sender's parent is an external orchestrator: no `parent` target. */
  externalParent?: boolean;
  ownChildren: Iterable<Pick<RunningSubagent, "id" | "name" | "surface">>;
  parentRoster: SubagentRoster | null;
  selfId: string;
  to: string;
  /** Server-wide pane listing; enables raw tmux pane targets when present. */
  panes?: PaneTargetRow[];
  /** The sender's own pane id (`TMUX_PANE`), anchoring session-less targets. */
  callerPane?: string;
}): { target: MessageTarget } | { error: string } {
  const to = params.to?.trim();
  // Materialize once: `ownChildren` is often a live Map iterator, and both the
  // candidate search and the reachable-names error would otherwise consume it.
  const ownChildren = Array.from(params.ownChildren);
  const reachable = () => reachableTargetNames({ ...params, ownChildren }).join(", ") || "(none)";

  if (!to) {
    // A sender that cannot reach `parent` (no parent, or an external one)
    // must not be told to use it; derive the hint from reachability.
    const withParent = params.hasParent && !params.externalParent;
    const options = withParent ? "`parent`, a child, or a sibling" : "a child or a sibling";
    return {
      error: `Provide a target: ${options}. Reachable: ${reachable()}.`,
    };
  }
  if (to === "parent") {
    if (params.externalParent) {
      return {
        error:
          "Your parent is an external orchestrator; it does not read subagent messages. " +
          "Report the way the parent-contact footer at the end of your brief says. " +
          "To ask a question, use `caller_ping`.",
      };
    }
    if (!params.hasParent) return { error: "This agent has no parent." };
    return { target: { relation: "parent", name: "parent" } };
  }

  const candidates: MessageTarget[] = [
    ...ownChildren.map((child): MessageTarget => ({
      relation: "child",
      id: child.id,
      name: child.name,
      pane: child.surface,
    })),
    ...(params.parentRoster?.children ?? [])
      .filter((sibling) => sibling.id !== params.selfId)
      .map((sibling): MessageTarget => ({
        relation: "sibling",
        id: sibling.id,
        name: sibling.name,
        pane: sibling.pane,
      })),
  ];

  const byId = candidates.find((candidate) => candidate.id === to);
  if (byId) return { target: byId };

  const byName = candidates.filter((candidate) => candidate.name === to);
  if (byName.length === 1) return { target: byName[0] };
  if (byName.length > 1) {
    const matches = byName.map((candidate) => `${candidate.name} [${candidate.id}]`).join(", ");
    return { error: `Ambiguous subagent name "${to}". Matches: ${matches}` };
  }

  // A managed pane id resolves to its agent, keeping the real relation.
  const bySurface = candidates.find((candidate) => candidate.pane === to);
  if (bySurface) return { target: bySurface };

  if (params.panes) {
    const paneMatch = matchPaneTarget(to, params.panes, params.callerPane);
    if ("target" in paneMatch) {
      return {
        target: { relation: "pane", name: to, pane: paneMatch.target.paneId },
      };
    }
    if ("error" in paneMatch) return { error: paneMatch.error };
    return {
      error:
        `No reachable agent named "${to}". Reachable: ${reachable()}. ` +
        "No tmux pane matched it either (%N, session:window.pane, or an exact pane title).",
    };
  }

  return { error: `No reachable agent named "${to}". Reachable: ${reachable()}.` };
}

/**
 * Header line prepended to every delivered message (design Decision 5). The
 * sender's relation is named for children and siblings, and omitted when the
 * sender is the receiver's parent.
 */
export function formatMessageHeader(params: {
  senderName: string;
  targetRelation: SubagentRelation;
}): string {
  if (params.targetRelation === "parent") {
    return `[subagent message from ${params.senderName} (child)]`;
  }
  if (params.targetRelation === "sibling") {
    return `[subagent message from ${params.senderName} (sibling)]`;
  }
  return `[subagent message from ${params.senderName}]`;
}

/** Append one parent-bound message to a child's `<session>.msg` file. */
export function appendParentMessage(file: string, payload: ParentMessage): void {
  appendFileSync(file, `${JSON.stringify(payload)}\n`, "utf8");
}

/** Read this process's parent roster (path passed to children at spawn). */
function readParentRoster(file: string | undefined): SubagentRoster | null {
  if (!file) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && Array.isArray(parsed.children)) return parsed as SubagentRoster;
  } catch {
    // Missing or half-written roster: sibling lookup is simply unavailable.
  }
  return null;
}

const SubagentMessageParams = Type.Object({
  to: Type.String({
    description:
      "`parent`, the exact id or display name of a running child or sibling, " +
      "or a tmux pane: `%N` pane id, `session:window.pane` target, or exact pane " +
      "title. Shell panes are refused.",
  }),
  message: Type.String({ description: "Message text. Must not be empty." }),
});

/**
 * Commands a pane must not be running when a message is typed into it: in a
 * shell the typed line executes as a command. Checked against
 * `pane_current_command`'s basename (design D4).
 */
const SHELL_COMMANDS = new Set([
  "sh",
  "bash",
  "dash",
  "ash",
  "zsh",
  "fish",
  "ksh",
  "mksh",
  "csh",
  "tcsh",
  "nu",
  "elvish",
  "xonsh",
  "pwsh",
  "powershell",
  "rc",
  "es",
  "osh",
  "yash",
  "login",
]);

/**
 * Validate, resolve and deliver one `pmux_message` call. Exported for unit
 * testing: `deps` lets a test observe whether tmux was used at all.
 */
export function sendSubagentMessage(
  input: { to: string; message: string },
  context: {
    hasParent: boolean;
    externalParent?: boolean;
    ownChildren: Iterable<Pick<RunningSubagent, "id" | "name" | "surface">>;
    parentRoster: SubagentRoster | null;
    selfId: string;
    senderName: string;
    parentMessageFile: string | null;
    /** The sender's own pane id (`TMUX_PANE`); anchors session-less targets. */
    callerPane?: string;
  },
  deps: {
    prompt: (pane: string, text: string) => unknown;
    append: (file: string, payload: ParentMessage) => void;
    /** Server pane listing; a throw disables raw pane targets, not messaging. */
    panes?: () => PaneTargetRow[];
  },
): { ok: true; target: MessageTarget; text: string } | { error: string } {
  if (!input.message?.trim()) {
    return { error: "message must not be empty." };
  }

  // One listing feeds both target resolution and the shell gate below, so a
  // pane can never resolve as safe and deliver as a shell (design D1).
  let panes: PaneTargetRow[] | undefined;
  try {
    panes = deps.panes?.();
  } catch {
    // Lookup unavailable: agent addressing and delivery behave as without it.
  }

  const resolved = resolveMessageTarget({
    hasParent: context.hasParent,
    externalParent: context.externalParent,
    ownChildren: context.ownChildren,
    parentRoster: context.parentRoster,
    selfId: context.selfId,
    to: input.to,
    panes,
    callerPane: context.callerPane,
  });
  if ("error" in resolved) return resolved;

  const target = resolved.target;
  const payload: ParentMessage = {
    header: formatMessageHeader({
      senderName: context.senderName,
      targetRelation: target.relation,
    }),
    message: input.message,
  };

  if (target.relation === "parent") {
    if (!context.parentMessageFile) return { error: "This agent has no parent." };
    try {
      deps.append(context.parentMessageFile, payload);
    } catch (error: any) {
      return {
        error: `Failed to write the parent message file: ${error?.message ?? String(error)}`,
      };
    }
    return {
      ok: true,
      target,
      text: "Message sent to parent. It arrives as a steering message; a reply will come back as a separate message.",
    };
  }

  // Shell gate: typed text executes in a shell pane. Covers foreign panes
  // and managed panes that dropped back to a shell while still registered.
  if (panes) {
    const row = panes.find((pane) => pane.paneId === target.pane);
    const command = row?.command.split("/").pop();
    if (command && SHELL_COMMANDS.has(command)) {
      return {
        error:
          `Refusing to send to "${target.name}" (pane ${target.pane}): ` +
          `it is running a shell (${command}), where the message would execute as a command.`,
      };
    }
  }

  try {
    deps.prompt(target.pane!, `${payload.header}\n${payload.message}`);
  } catch (error: any) {
    return {
      error: `Failed to send to "${target.name}" via tmux: ${error?.message ?? String(error)}`,
    };
  }
  return {
    ok: true,
    target,
    text:
      `Message sent to "${target.name}" (pane ${target.pane}). Delivery is asynchronous; ` +
      "a reply will arrive as a separate message.",
  };
}

export const __test__ = {
  borderLine,
  getShellReadyDelayMs,
  renderSubagentWidgetLines(agents: RunningSubagent[], width: number): string[] {
    return currentSupervisor().renderSubagentWidgetLines(agents, width);
  },
  loadAgentDefaults,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveEffectiveInteractive,
  buildSubagentToolAllowlist,
  buildPiPromptArgs,
  resolveDenyTools,
  resolveResultPresentation,
  buildSpawnEnvParts,
  resolveMessageTarget,
  formatMessageHeader,
  buildLaunchMessagingHint,
  buildSubagentTaskPrompt,
  sendSubagentMessage,
  readParentMessages,
  drainAndRemoveParentMessages(
    running: RunningSubagent,
    pi: { sendMessage: (m: any, o: any) => unknown },
  ) {
    drainAndRemoveParentMessages(running, (message, options) => pi.sendMessage(message, options));
  },
  getCurrentSupervisor(): Supervisor {
    return currentSupervisor();
  },
  getDefaultSessionDirFor,
};

/**
 * True when this pi process is a subagent child: it carries a sidecar session
 * path, and its launch args load `pmux-done.ts`. That extension owns the
 * child's status reporter. A second reporter would keep its own terminal latch,
 * so this registration is skipped here to keep one reporter per child. A plain
 * pane (no child env) registers as before.
 */
export { isSubagentChild };

export default function subagentsExtension(pi: ExtensionAPI) {
  // Decode the child env once: a pi process does not change its own
  // PI_PMUX_* values. Every reader below uses this value.
  const childEnv = decodeChildEnv(process.env);

  // A fresh supervisor for this registration: stop the supervisor that a
  // previous load or registration left behind, then store the new one. Tool
  // handlers resolve the supervisor per call through currentSupervisor(), so
  // they always operate on the one the key holds — including the replacement
  // that session_start installs after a shutdown.
  getSupervisor()?.shutdown();
  createSupervisorInstance();
  activePi = pi;

  // Live sidebar status for this pane. A subagent child does NOT register it:
  // the child's own completion path owns the pane status there (the child
  // marker is decoded in child-env.ts).
  createTurnNotifier(process.env, statusConfig.notifyEnabled).register(pi);

  // First-prompt OSC title for unnamed non-subagent panes. A subagent child
  // sets PI_PMUX_NAME, so it keeps its `<name> — <task>` title.
  createLiveTitleController().register(pi);

  // ── Sidebar publishing (openspec/changes/2026-10-20-sidebar-events) ──
  //
  // Every pi session on this machine loads this extension, so this is where
  // the tmux sidebar's pi producer lives. The publisher is fire and forget
  // and swallows every failure; the event mapping and the run-scoped
  // captures live in sidebar-events.ts; see sidebar.ts.
  const sidebar = createSidebarPublisher();
  createSidebarEvents({
    publisher: sidebar,
    readWorktree: () => readSidebarWorktree(process.env.TMUX_PANE),
  }).register(pi);

  // ── Thinking feed (openspec/changes/archive/2026-10-27-thinking-feed) ──
  //
  // The session's reasoning, one JSONL record per thinking phase, in a
  // private per-user runtime directory for the sidebar's Thought tab. The
  // feed follows the sidebar's two guards — a tmux pane, the switch on —
  // but not its binary lookup: it is written whether or not pmux-explorer
  // is installed, and every feed failure is swallowed.
  createThinkingFeed({ env: process.env }).register(pi);

  // ── Sidebar task reminders (openspec/changes/2026-10-22-sidebar-task-reminders) ──
  //
  // The reminder's wording is owned by the sidebar
  // (pmux-explorer/src/task_reminders.rs); this extension is the pi
  // pane's producer for it: one update-before-finish steer at a `turn_end`
  // whose pane's task store holds open items. The store reader and the steer
  // send are injected; every failure they hit is swallowed, and a session
  // without the sidebar's task store gets nothing at all.
  createTaskReminders(process.env, {
    readStore: readSidebarTaskStore,
    readStoreMtime: readSidebarTaskStoreMtime,
    send: (text, options) => pi.sendUserMessage(text, options),
  }).register(pi);

  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
    // A previous session's shutdown made that supervisor final. Replace it
    // with a fresh one so a spawn in this session is not born with an
    // aborted poll signal or a stopped event loop.
    if (getSupervisor()?.isShutdown) createSupervisorInstance();
  });

  // Clean up on session shutdown
  pi.on("session_shutdown", (_event, _ctx) => {
    getSupervisor()?.shutdown();
  });

  // Tools denied via PI_DENY_TOOLS env var (set by parent agent based on frontmatter)
  const deniedTools = new Set(childEnv.denyTools);

  const shouldRegister = (name: string) => !deniedTools.has(name);

  // ── subagent tool ──
  if (shouldRegister("pmux_spawn"))
    pi.registerTool({
      name: "pmux_spawn",
      label: "Subagent",
      description:
        "Start a subagent. Fire-and-forget: it returns only an acknowledgement, and the result arrives automatically as a steer message when the subagent finishes. Do not poll, sleep, read logs, or call other tools to check status, and do not fabricate or guess the result. After the call, end your turn or do other independent work.",
      promptSnippet: "Start an async subagent; its result arrives later as a steer message.",
      parameters: SubagentParams,

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        // Prevent self-spawning (e.g. a scout spawning another scout)
        const currentAgent = childEnv.agent;
        if (params.agent && currentAgent && params.agent === currentAgent) {
          return {
            content: [
              {
                type: "text",
                text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
              },
            ],
            details: { error: "self-spawn blocked" },
          };
        }

        // Validate prerequisites
        if (!isTmuxAvailable()) {
          return muxUnavailableResult();
        }

        if (!ctx.sessionManager.getSessionFile()) {
          return {
            content: [
              {
                type: "text",
                text: "Error: no session file. Start pi with a persistent session to use subagents.",
              },
            ],
            details: { error: "no session file" },
          };
        }

        // Launch the subagent (creates pane or tab, sends command) and start
        // watching it in the background; the supervisor delivers the result.
        // The schema requires `agent`, and an unresolved role throws from the
        // launch resolution before any pane, record or child exists (design
        // D1): the call is that error, not a crash.
        let running: RunningSubagent;
        try {
          running = await currentSupervisor().spawn(params, ctx, {
            fallback: getSurfaceDefault(),
          });
        } catch (error) {
          if (!(error instanceof UnknownRoleError)) throw error;
          return {
            content: [{ type: "text", text: errorText(error) }],
            details: { error: "unknown role", agent: params.agent },
          };
        }

        // Return immediately
        return {
          content: [
            {
              type: "text",
              text:
                `Sub-agent "${params.name}" launched. Its result arrives automatically as a ` +
                `steer message when it finishes — do not generate or assume a result in the meantime. ` +
                `Do other work or tell the user you are waiting.`,
            },
          ],
          details: {
            id: running.id,
            name: params.name,
            task: params.task,
            agent: params.agent,
            sessionFile: running.sessionFile,
            launchScriptFile: running.launchScriptFile,
            status: "started",
          },
        };
      },

      renderCall(args, theme) {
        const partialArgs = args as Record<string, unknown>;
        const name =
          typeof partialArgs.name === "string" && partialArgs.name ? partialArgs.name : "(unnamed)";
        const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
        const agent =
          typeof partialArgs.agent === "string" && partialArgs.agent
            ? theme.fg("dim", ` (${partialArgs.agent})`)
            : "";
        const cwdHint =
          typeof partialArgs.cwd === "string" && partialArgs.cwd
            ? theme.fg("dim", ` in ${partialArgs.cwd}`)
            : "";
        let text = "▸ " + theme.fg("toolTitle", theme.bold(name)) + agent + cwdHint;

        // Show a one-line task preview. renderCall is called repeatedly as the
        // LLM generates tool arguments, so args.task grows token by token.
        // We keep it compact here — Ctrl+O on renderResult expands the full content.
        if (task) {
          const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
          const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
          if (preview) {
            text += "\n" + theme.fg("toolOutput", preview);
          }
          const totalLines = task.split("\n").length;
          if (totalLines > 1) {
            text += theme.fg("muted", ` (${totalLines} lines)`);
          }
        }

        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "(unnamed)";

        // "Started" result — tool returned immediately
        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — started"),
            0,
            0,
          );
        }

        // Fallback (shouldn't happen)
        const first = result.content[0];
        const text = first?.type === "text" ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── pmux_interrupt tool ──
  if (shouldRegister("pmux_interrupt"))
    pi.registerTool({
      name: "pmux_interrupt",
      label: "Interrupt Subagent",
      description:
        "Send Escape to the current turn of a running pi subagent. The pane and session stay alive. The tool returns an acknowledgement only; it does not cause a subagent result.",
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: "Exact running subagent id." })),
        name: Type.Optional(Type.String({ description: "Exact running subagent display name." })),
      }),

      async execute(
        _toolCallId,
        params,
      ): Promise<AgentToolResult<{ error?: string; id?: string; name?: string; status?: string }>> {
        return currentSupervisor().interrupt(params);
      },

      renderCall(args, theme) {
        const target = args.id ? `${args.id}` : (args.name ?? "(unknown)");
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(target)) +
            theme.fg("dim", " — interrupt turn"),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        if (details?.status === "interrupt_requested") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(details.name ?? details.id ?? "subagent")) +
              theme.fg("dim", " — interrupt requested"),
            0,
            0,
          );
        }

        const first = result.content[0];
        const text = first?.type === "text" ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── pmux_message tool ──
  if (shouldRegister("pmux_message"))
    pi.registerTool({
      name: "pmux_message",
      label: "Message Subagent",
      description:
        "Send a short message to `parent`, one of your running children, a running sibling, or any tmux pane (`%N`, `session:window.pane`, or an exact pane title — shell panes are refused). Your session continues. `parent` is reachable only when a pi parent exists. A reply, if any, arrives later as a separate message. caller_ping and pmux_done END your session; this tool does not.",
      promptSnippet:
        "Message `parent`, a child, a sibling, or a tmux pane without ending your session.",
      parameters: SubagentMessageParams,

      async execute(
        _toolCallId,
        params,
      ): Promise<
        AgentToolResult<{ error?: string; name?: string; pane?: string; relation?: string }>
      > {
        if (!isTmuxAvailable()) return muxUnavailableResult();

        const sessionFile = childEnv.sessionFile ?? null;
        const result = sendSubagentMessage(
          { to: params.to, message: params.message },
          {
            hasParent: !!sessionFile,
            externalParent: childEnv.externalParent === true,
            ownChildren: currentSupervisor().running(),
            parentRoster: readParentRoster(childEnv.parentRosterFile),
            selfId: childEnv.id ?? "",
            senderName: childEnv.name ?? "parent",
            parentMessageFile: sessionFile ? getParentMessageFile(sessionFile) : null,
            callerPane: callerPaneId() || undefined,
          },
          { prompt: agentPrompt, append: appendParentMessage, panes: listPaneTargets },
        );

        if ("error" in result) {
          return {
            content: [{ type: "text" as const, text: result.error }],
            details: { error: result.error },
          };
        }
        return {
          content: [{ type: "text" as const, text: result.text }],
          details: {
            name: result.target.name,
            pane: result.target.pane,
            relation: result.target.relation,
          },
        };
      },

      renderCall(args, theme) {
        const target = typeof args.to === "string" && args.to ? args.to : "(unknown)";
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(target)) +
            theme.fg("dim", " — message"),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        if (details?.error) {
          return new Text(theme.fg("error", `▸ ${details.error}`), 0, 0);
        }
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(details?.name ?? "message")) +
            theme.fg("dim", " — sent"),
          0,
          0,
        );
      },
    });

  // ── pmux_list tool ──
  if (shouldRegister("pmux_list"))
    pi.registerTool({
      name: "pmux_list",
      label: "List Subagents",
      description:
        "List agent definitions for the subagent `agent` parameter. Project .pi/agents/ overrides global ~/.pi/agent/agents/ for the same name.",
      promptSnippet: "List agent definitions for subagent.",
      parameters: Type.Object({}),

      async execute() {
        const list = discoverAgentDefinitions().filter((agent) => !agent.disableModelInvocation);

        if (list.length === 0) {
          return {
            content: [{ type: "text", text: "No subagent definitions found." }],
            details: { agents: [] },
          };
        }

        const lines = list.map((a) => {
          const badge = a.source === "project" ? " (project)" : "";
          const desc = a.description ? ` — ${a.description}` : "";
          const model = a.model ? ` [${a.model}]` : "";
          const fallback = a.modelFallback ? ` (fallback: ${a.modelFallback})` : "";
          return `• ${a.name}${badge}${model}${fallback}${desc}`;
        });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { agents: list },
        };
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const agents = details?.agents ?? [];
        if (agents.length === 0) {
          return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
        }
        const lines = agents.map((a: any) => {
          const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
          const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
          const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
          const fallback = a.modelFallback
            ? theme.fg("dim", ` (fallback: ${a.modelFallback})`)
            : "";
          return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${fallback}${desc}`;
        });
        return new Text(lines.join("\n"), 0, 0);
      },
    });

  // ── pmux_resume tool ──
  if (shouldRegister("pmux_resume"))
    pi.registerTool({
      name: "pmux_resume",
      label: "Resume Subagent",
      description:
        "Resume an earlier subagent session, to continue a cancelled run or give follow-up work. Delivery is the same as subagent: fire-and-forget, the result arrives as a steer message, do not poll or fabricate it.",
      promptSnippet:
        "Resume an earlier subagent session; its result arrives later as a steer message.",
      parameters: Type.Object({
        sessionPath: Type.String({ description: "Path to the session .jsonl file." }),
        message: Type.Optional(
          Type.String({
            description: "Message to send after the resume, for example follow-up instructions.",
          }),
        ),
        autoExit: Type.Optional(
          Type.Boolean({
            description:
              "Exit after the response. Default: the launch record value, or true without a record. Set false for an interactive session.",
          }),
        ),
      }),

      renderCall(_args, theme) {
        const text =
          "▸ " +
          theme.fg("toolTitle", theme.bold("Resume")) +
          theme.fg("dim", " — resuming session");
        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "Resume";

        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — resumed"),
            0,
            0,
          );
        }

        // Fallback
        const first = result.content[0];
        const text = first?.type === "text" ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        if (!isTmuxAvailable()) {
          return muxUnavailableResult();
        }

        // The supervisor owns the resume launch and its watcher. It reads the
        // launch record first, because a Claude Code record resumes without a
        // pi-style session file; without a record, a missing session file is
        // still an error result.
        return currentSupervisor().resume(params, ctx, {
          fallback: getSurfaceDefault(),
        });
      },
    });

  // /pmux-spawn command — spawn a subagent by name
  pi.registerCommand("pmux-spawn", {
    description: "Spawn a subagent: /pmux-spawn <agent> <task>",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /pmux-spawn <agent> [task]", "warning");
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      const defs = loadAgentDefaults(agentName);
      if (!defs) {
        ctx.ui.notify(
          `Agent "${agentName}" not found in ~/.pi/agent/agents/ or .pi/agents/`,
          "error",
        );
        return;
      }

      const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
      const displayName = agentName[0].toUpperCase() + agentName.slice(1);
      const toolCall = `Use pmux_spawn with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
      pi.sendUserMessage(toolCall);
    },
  });

  // /pmux-surface command — show or set the default surface placement
  pi.registerCommand("pmux-surface", {
    description: "Show or set the default subagent surface: /pmux-surface [pane|tab]",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      const placement = parseSurfaceDefault(arg);
      if (placement) {
        setSurfaceDefault(placement);
        try {
          writeSurfaceConfig(placement, surfaceConfigPath);
          ctx.ui.notify(`Subagent surface set to "${placement}" (saved to config.json).`, "info");
        } catch (error) {
          ctx.ui.notify(
            `Subagent surface set to "${placement}" for this session, but saving to config.json failed: ${errorText(error)}`,
            "warning",
          );
        }
      } else if (arg === "") {
        ctx.ui.notify(`Subagent surface: ${getSurfaceDefault()}`, "info");
      } else {
        ctx.ui.notify(`Subagent surface: ${getSurfaceDefault()} (accepted: pane, tab)`, "warning");
      }
    },
  });

  // ── pmux_result message renderer ──
  pi.registerMessageRenderer("pmux_result", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const exitCode = details.exitCode ?? 0;
        const errorMessage = typeof details.errorMessage === "string" ? details.errorMessage : "";
        const failed = exitCode !== 0 || !!errorMessage;
        const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const bgFn = failed
          ? (text: string) => theme.bg("toolErrorBg", text)
          : (text: string) => theme.bg("toolSuccessBg", text);
        const icon = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const status = errorMessage
          ? "failed (provider/agent error)"
          : failed
            ? `failed (exit ${exitCode})`
            : "completed";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";

        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;
        const rawContent = typeof message.content === "string" ? message.content : "";

        // Clean summary (remove session ref and leading label for display)
        const summary = rawContent
          .replace(/\n\nSession: .+\nResume: .+$/, "")
          .replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
          .replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "")
          .replace(
            new RegExp(
              `^Sub-agent "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" failed after ${elapsed} \\(provider/agent error — auto-retry exhausted\\)\\.\\n\\n`,
            ),
            "",
          );

        // Build content for the box
        const contentLines = [header];

        if (options.expanded) {
          // Full view: complete summary + session info
          if (summary) {
            for (const line of summary.split("\n")) {
              contentLines.push(line.slice(0, width - 6));
            }
          }
          if (details.sessionFile) {
            contentLines.push("");
            contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
            contentLines.push(theme.fg("dim", `Resume:  pmux_resume ${details.sessionFile}`));
          }
        } else {
          // Collapsed: preview + expand hint
          if (summary) {
            const previewLines = summary.split("\n").slice(0, 5);
            for (const line of previewLines) {
              contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
            }
            const totalLines = summary.split("\n").length;
            if (totalLines > 5) {
              contentLines.push(theme.fg("muted", `… ${totalLines - 5} more lines`));
            }
          }
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        // Render via Box for background + padding, with blank line above for separation
        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── pmux_status message renderer ──
  pi.registerMessageRenderer("pmux_status", (message, options, theme) => {
    const details = message.details as any;
    const lines = Array.isArray(details?.lines) ? details.lines : [];
    const overflow = typeof details?.overflow === "number" ? details.overflow : 0;
    if (lines.length === 0 && overflow === 0) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const lineWidth = Math.max(0, width - 6);
        const contentLines = [
          `${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}`,
          ...lines.map((line: string) => theme.fg("dim", truncateToWidth(line, lineWidth))),
        ];

        if (overflow > 0) {
          contentLines.push(theme.fg("muted", `+${overflow} more running.`));
        }
        if (!options.expanded) {
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── pmux_handoff message renderer ──
  pi.registerMessageRenderer("pmux_handoff", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const bgFn = (text: string) => theme.bg("toolSuccessBg", text);

        const icon = theme.fg("accent", "→");
        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— handed off")}`;

        const contentLines = [header];

        if (options.expanded) {
          contentLines.push("");
          contentLines.push(details.message ?? "");
          if (details.sessionFile) {
            contentLines.push("");
            contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
          }
        } else {
          const preview = (details.message ?? "").split("\n")[0].slice(0, width - 10);
          contentLines.push(theme.fg("dim", preview));
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── pmux_ping message renderer ──
  pi.registerMessageRenderer("pmux_ping", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const bgFn = (text: string) => theme.bg("toolSuccessBg", text);

        const icon = theme.fg("accent", "?");
        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— needs help")}`;

        const contentLines = [header];

        if (options.expanded) {
          contentLines.push("");
          contentLines.push(details.message ?? "");
          if (details.sessionFile) {
            contentLines.push("");
            contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
          }
        } else {
          const preview = (details.message ?? "").split("\n")[0].slice(0, width - 10);
          contentLines.push(theme.fg("dim", preview));
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });
}
// test
