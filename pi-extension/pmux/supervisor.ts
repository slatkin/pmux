import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "@sinclair/typebox";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  agentPrompt,
  closeSurface,
  createSurface,
  pollForExit,
  readScreen,
  runInPane,
  sendEscape,
} from "./tmux.ts";
import { exitSidecarPath, removeExitSidecar, type PollResult } from "./exit-sidecar.ts";
import { removeChildStatus } from "./status-file.ts";
import { resolvePlacement, type SurfaceDefault } from "./placement.ts";
import { type AgentDefaults, type SubagentSessionMode } from "./agent-defs.ts";
import {
  LAUNCH_SPEC_VERSION,
  buildPaneTitle,
  paneCommandLine,
  writeLaunchSpec,
  type LaunchSpec,
} from "./launch.ts";
import {
  LAUNCH_RECORD_VERSION,
  getLaunchRecordFile,
  readLaunchRecord,
  writeJsonAtomic,
  writeLaunchRecord,
  type LaunchBackendName,
  type LaunchRecord,
} from "./launch-record.ts";
import {
  SUBAGENTS_CLI_PATH,
  SUBAGENTS_DIR,
  buildPiLaunch,
  resolveInteractiveDefault,
  resolveLaunchRecord,
  type PiLaunchRequest,
} from "./launch-build.ts";
import { findLastAssistantMessage, getNewEntries, seedSubagentSessionFile } from "./session.ts";
import { slugifyName } from "./slug.ts";
import {
  type StatusConfig,
  type StatusSnapshot,
  type SubagentStatusState,
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  displayActivityLabel,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatTransitionLine,
  observeStatus,
  toStatusObservation,
} from "./status.ts";
import {
  getSubagentActivityFile,
  readSubagentActivityFile,
  type ActivityReadResult,
  type SubagentActivityState,
} from "./activity.ts";
import { decodeChildEnv } from "./child-env.ts";
import { capSummary, SCREEN_SUMMARY_CHARS } from "./report-cap.ts";
import {
  IDLE_NUDGE_TEXT,
  decideGoneAction,
  decideIdleAction,
  type IdleWatchState,
} from "./idle-watchdog.ts";

/** Pane-side entry point every pi-parent launch spec runs through. */
// The shared launch builder lives in launch-build.ts (design D1); the moved
// names are re-exported so the tests and the extension keep their import path.
export {
  buildLaunchMessagingHint,
  buildPiPromptArgs,
  buildSpawnEnvParts,
  buildSubagentTaskPrompt,
  resolveModeHint,
  writeRunContextFile,
} from "./launch-build.ts";
export { UnknownRoleError } from "./launch-build.ts";

export const SubagentParams = Type.Object({
  name: Type.String({ description: "Display name." }),
  task: Type.String({ description: "Task prompt for the subagent." }),
  agent: Type.String({
    description: "Agent definition that supplies defaults (model, tools, skills). See pmux_list.",
  }),
  systemPrompt: Type.Optional(
    Type.String({ description: "Role instructions to append to the system prompt." }),
  ),
  model: Type.Optional(Type.String({ description: "Model. Overrides the agent default." })),
  skills: Type.Optional(
    Type.String({ description: "Comma-separated skills. Overrides the agent default." }),
  ),
  tools: Type.Optional(
    Type.String({ description: "Comma-separated tools. Overrides the agent default." }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Start directory. The subagent loads the local .pi/ config, CLAUDE.md, skills and extensions.",
    }),
  ),
  fork: Type.Optional(
    Type.Boolean({
      description:
        "true: the subagent gets a copy of this conversation. Overrides the agent session-mode.",
    }),
  ),
  interactive: Type.Optional(
    Type.Boolean({
      description:
        "true: the user drives the subagent, and stall events do not wake you. Default: the agent `interactive` value, else the inverse of `auto-exit`.",
    }),
  ),
});

/** One steer message delivered to the parent session through `deps.send`. */
export interface SteerMessage {
  customType: string;
  content: string;
  display: boolean;
  details?: Record<string, unknown>;
}

/** Delivery options for an injected message: always a steering message today. */
export interface SendOptions {
  triggerTurn?: boolean;
  deliverAs?: "steer" | "followUp" | "nextTurn";
}

/** How the supervisor injects messages into the parent session (pi.sendMessage). */
export type SendFn = (message: SteerMessage, options: SendOptions) => void;

/** Options of a launch call that name the surface. */
export interface SurfaceOptions {
  /** Configured default, used when the role names no surface. */
  fallback?: SurfaceDefault;
}

/** Session context the supervisor needs from the tool call that starts a run. */
export interface SupervisorContext {
  sessionManager: {
    getSessionFile(): string | null;
    getSessionId(): string;
    getSessionDir(): string;
  };
  cwd: string;
}

/** Parameters of the `pmux_resume` tool. */
export interface ResumeParams {
  sessionPath: string;
  message?: string;
  autoExit?: boolean;
}

/** Tool-result shape `supervisor.resume` returns to the `pmux_resume` handler. */
export interface ResumeToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

/**
 * Result from running a single subagent.
 */
export interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  claudeSessionId?: string;
  exitCode: number;
  elapsed: number;
  error?: string;
  /** Provider/agent error message when auto-retry exhausted (overload, rate limit, etc.). */
  errorMessage?: string;
  /** Who wrote the error sidecar: the child's own error path, or the wrapper. */
  errorSource?: string;
  ping?: { name: string; message: string };
  /** Handoff text when the child ended with a `handoff` sidecar (D5) */
  handoff?: { message: string };
}

/**
 * State for a launched (but not yet completed) subagent.
 */
export interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  agent?: string;
  surface: string;
  startTime: number;
  sessionFile: string;
  /** Session entries this run starts after: 0 for a spawn, N for a resume. */
  entryCountBefore: number;
  /** Launch-spec path written under `<artifactDir>/pmux-scripts/`. */
  launchScriptFile?: string;
  activityFile?: string;
  activity?: SubagentActivityState;
  activityRead?: {
    ok: boolean;
    reason?: "missing" | "invalid" | "wrong-id";
    error?: string;
  };
  abortController?: AbortController;
  cli?: string;
  sentinelFile?: string;
  /** Byte offset of the parent's next unread line in this child's `.msg` file. */
  messageOffset?: number;
  statusState: SubagentStatusState;
  /**
   * When true, status transitions (stalled/recovered) do not wake the parent
   * session via a steer message. The widget still updates locally. Used for
   * long-running agents where the user drives the conversation in the
   * subagent's pane (e.g. an interactive child).
   */
  interactive: boolean;
  /** Parent-side idle watchdog progress (see idle-watchdog.ts). */
  idleWatch?: IdleWatchState;
}

export interface SubagentRosterChild {
  id: string;
  name: string;
  pane: string;
  cli: string;
}

export interface SubagentRoster {
  parentPane: string;
  parentName: string;
  children: SubagentRosterChild[];
}

export interface ParentMessage {
  header: string;
  message: string;
}

/** Dependencies injected into `createSupervisor` (design D1). */
export interface SupervisorDeps {
  /** Deliver a steer message to the parent session (pi.sendMessage). */
  send: SendFn;
  /** Latest ExtensionContext for widget updates, or null before session_start. */
  ui: () => ExtensionContext | null;
  /** Surface operations for the pane host (tmux). */
  pmux: {
    createSurface: typeof createSurface;
    runInPane: typeof runInPane;
    closeSurface: typeof closeSurface;
    sendEscape: typeof sendEscape;
    readScreen: typeof readScreen;
    pollForExit: typeof pollForExit;
    agentPrompt: typeof agentPrompt;
  };
  /** Loaded status configuration (widget labels and transition messages). */
  statusConfig: StatusConfig;
}

/** Everything the supervisor exposes to the extension and its tests. */
export interface Supervisor {
  /** Launch a child and start its watcher, widget and status refresh. */
  spawn(
    params: Static<typeof SubagentParams>,
    ctx: SupervisorContext,
    options?: SurfaceOptions,
  ): Promise<RunningSubagent>;
  /** Resume a session (today's inline `pmux_resume` launch path). */
  resume(
    params: ResumeParams,
    ctx: SupervisorContext,
    options?: SurfaceOptions,
  ): Promise<ResumeToolResult>;
  /** Send Escape to a running child's current turn. */
  interrupt(
    params: { id?: string; name?: string },
    sendEscapeKey?: (surface: string) => void,
  ): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };
  /** The running children, for the widget and `pmux_message`. */
  running(): readonly RunningSubagent[];
  /** Stop every watcher, both refresh intervals and the event stream. Final. */
  shutdown(): void;
  readonly isShutdown: boolean;
  /** The poll signal shared by this supervisor's watchers (tests prove it is live). */
  getAbortController(): AbortController;
  renderSubagentWidgetLines(agents: RunningSubagent[], width: number): string[];
}

export { resolveDenyTools } from "./child-env.ts";

function sessionDirSlugFor(cwd: string): string {
  return cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
}

function getDefaultSessionDirNameFor(cwd: string): string {
  // The plain slug is not injective: `/a/b-c` and `/a-b/c` both become
  // `--a-b-c--`, so distinct cwds would share one session dir. Append a short
  // hash of the raw path to give each cwd its own directory.
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 8);
  return `--${sessionDirSlugFor(cwd)}-${hash}--`;
}

function migrateLegacySessionDir(sessionsRoot: string, cwd: string, sessionDir: string): void {
  if (existsSync(sessionDir)) return;
  // Before the hashed name, session dirs were `--<slug>--`. That slug is not
  // injective, so the first cwd to launch claims the legacy dir; later cwds
  // just create fresh dirs. Best-effort: ENOENT/EEXIST/ENOTEMPTY races and a
  // failed rename all leave the old dir in place rather than losing data.
  try {
    renameSync(join(sessionsRoot, `--${sessionDirSlugFor(cwd)}--`), sessionDir);
  } catch {
    // Nothing to migrate, or another process got there first.
  }
}

export function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  const sessionsRoot = join(agentDir, "sessions");
  const sessionDir = join(sessionsRoot, getDefaultSessionDirNameFor(cwd));
  if (!existsSync(sessionDir)) {
    migrateLegacySessionDir(sessionsRoot, cwd, sessionDir);
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

export function resolveEffectiveSessionMode(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  if (params.fork) return "fork";
  return agentDefs?.sessionMode ?? "standalone";
}

/** The launch modes resolved once for a spawn or resume. */
export interface LaunchBehavior {
  sessionMode: SubagentSessionMode;
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
}

export function resolveLaunchBehavior(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): LaunchBehavior {
  const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? "direct" : "artifact",
  };
}

/**
 * Decide whether a subagent is interactive (user-driven, long-running).
 *
 * Resolution order:
 *   1. Explicit `interactive` tool parameter wins.
 *   2. Explicit `interactive` frontmatter field on the agent.
 *   3. Default: the inverse of `auto-exit`. Agents that auto-exit are
 *      autonomous (scout, worker, reviewer) and the parent session should be
 *      woken on stall/recovery transitions. Agents that don't auto-exit are
 *      driven by the user in their own pane (a forked child) and
 *      stall pings are noise.
 *
 * When no agent defs exist at all (bare `pmux_spawn({ name, task })` call,
 * typical for a bare forked spawn), `autoExit` is undefined and the
 * subagent is treated as interactive.
 */
export function resolveEffectiveInteractive(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): boolean {
  if (params.interactive != null) return params.interactive;
  return resolveInteractiveDefault(agentDefs);
}

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

/**
 * Wait long enough for a freshly created pane to finish shell startup.
 *
 * Some environments do extra shell-init work before the prompt is ready
 * (for example direnv/devenv), so the delay is configurable for users who hit
 * dropped commands. Keep the historical default at 500ms.
 */
export function getShellReadyDelayMs(): number {
  const raw = process.env.PI_PMUX_SHELL_READY_DELAY_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

/**
 * Build the internal artifact directory path for the current session.
 * Used by the subagents extension to stash task files, system prompts, and
 * launch scripts for sub-agents. Path convention:
 *   <sessionDir>/artifacts/<session-id>/
 */
export function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}

/** Where this process publishes its roster: `<artifactDir>/pmux-roster.json`. */
export function getRosterFile(artifactDir: string): string {
  return join(artifactDir, "pmux-roster.json");
}

/** The file a child appends parent-bound messages to. */
export function getParentMessageFile(sessionFile: string): string {
  return `${sessionFile}.msg`;
}

/**
 * Read complete JSON lines from a child's message file, starting at byte
 * `offset`. A trailing line without its newline is left for the next call.
 */
export function readParentMessages(
  file: string,
  offset: number,
): { messages: ParentMessage[]; offset: number } {
  let raw: Buffer;
  try {
    // Most ticks find no new bytes; checking the size first skips the read.
    if (statSync(file).size === offset) return { messages: [], offset };
    raw = readFileSync(file);
  } catch {
    return { messages: [], offset };
  }
  const start = offset > raw.length ? 0 : offset;
  const chunk = raw.subarray(start);
  const lastNewline = chunk.lastIndexOf(0x0a);
  if (lastNewline < 0) return { messages: [], offset: start };

  const messages: ParentMessage[] = [];
  for (const line of chunk.subarray(0, lastNewline).toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed?.header === "string" && typeof parsed?.message === "string") {
        messages.push({ header: parsed.header, message: parsed.message });
      }
    } catch {
      // Skip a malformed line rather than stalling the file on it.
    }
  }
  return { messages, offset: start + lastNewline + 1 };
}

/** Inject any newly written parent-bound messages into this session. */
export function deliverParentMessages(running: RunningSubagent, send: SendFn): void {
  const { messages, offset } = readParentMessages(
    getParentMessageFile(running.sessionFile),
    running.messageOffset ?? 0,
  );
  running.messageOffset = offset;
  for (const message of messages) {
    send(
      {
        customType: "pmux_message",
        content: `${message.header}\n${message.message}`,
        display: true,
        details: { from: running.name, id: running.id },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  }
}

/** Deliver a finished child's last messages, then drop its file. */
export function drainAndRemoveParentMessages(running: RunningSubagent, send: SendFn): void {
  deliverParentMessages(running, send);
  try {
    rmSync(getParentMessageFile(running.sessionFile), { force: true });
  } catch {
    // Best effort — a stale file only delays the next child's messages.
  }
}

/** Pure mirror of a running map as published for children. */
export function buildRosterPayload(params: {
  parentPane: string;
  parentName: string;
  children: Iterable<Pick<RunningSubagent, "id" | "name" | "surface" | "cli">>;
}): SubagentRoster {
  return {
    parentPane: params.parentPane,
    parentName: params.parentName,
    children: Array.from(params.children, (child) => ({
      id: child.id,
      name: child.name,
      pane: child.surface,
      cli: child.cli ?? "pi",
    })),
  };
}

function formatElapsedMMSS(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";

/**
 * Build a bordered content line: │left          right│
 * Left content is truncated if needed, right is preserved, padded to fill width.
 */
export function borderLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}│${RST}`;

  // width = total visible chars for the whole line including │ and │
  const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
  const rightVis = visibleWidth(right);

  // If the status chunk alone is too wide, prefer preserving it in compact form
  // rather than overflowing the terminal.
  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return `${ACCENT}│${RST}${truncRight}${" ".repeat(rightPad)}${ACCENT}│${RST}`;
  }

  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${ACCENT}│${RST}${truncLeft}${" ".repeat(pad)}${right}${ACCENT}│${RST}`;
}

/**
 * Build the bordered top line: ╭─ Title ──── info ─╮
 * All chars are accounted for within `width`.
 */
export function borderTop(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╭${RST}`;

  // ╭─ Title ───...─── info ─╮
  // overhead: ╭─ (2) + space around title (2) + space around info (2) + ─╮ (2) = but we simplify
  const inner = Math.max(0, width - 2); // inside ╭ and ╮
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const fill = "─".repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
  return `${ACCENT}╭${content}╮${RST}`;
}

/**
 * Build the bordered bottom line: ╰──────────────────╯
 */
export function borderBottom(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╰${RST}`;

  const inner = Math.max(0, width - 2);
  return `${ACCENT}╰${"─".repeat(inner)}╯${RST}`;
}

export function formatWidgetRightLabel(snapshot: StatusSnapshot): string {
  if (snapshot.kind === "starting") return " starting… ";
  if (snapshot.kind === "running") return ` running ${snapshot.elapsedText} `;
  if (snapshot.kind === "active") {
    const label = displayActivityLabel(snapshot);
    const duration = snapshot.activeDurationText ? ` ${snapshot.activeDurationText}` : "";
    return label ? ` active · ${label}${duration} ` : " active ";
  }
  if (snapshot.kind === "waiting") {
    const duration = snapshot.waitingDurationText ? ` ${snapshot.waitingDurationText}` : "";
    const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
    return ` waiting${duration}${detail} `;
  }

  const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
  const duration = snapshot.snapshotProblemText ? ` ${snapshot.snapshotProblemText}` : "";
  return ` stalled${detail}${duration} `;
}

export function resolveResultPresentation(
  result: Pick<
    SubagentResult,
    "exitCode" | "elapsed" | "summary" | "sessionFile" | "errorMessage" | "errorSource"
  >,
  name: string,
): string {
  const sessionRef = result.sessionFile
    ? `\n\nSession: ${result.sessionFile}\nResume: pmux_resume ${result.sessionFile}`
    : "";
  const summary = capSummary(result.summary, result.sessionFile);

  if (result.errorMessage) {
    // Auto-retry exhausted or other agent-loop error. The subagent did not
    // produce a usable result — surface the underlying provider/network
    // failure so the orchestrator can decide whether to retry, resume, or
    // change approach instead of silently treating the run as completed.
    // A crash carries the same message but a different source, so the heading
    // says which one it was.
    const heading =
      result.errorSource === "wrapper"
        ? `Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} (the child crashed).`
        : `Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} (provider/agent error — auto-retry exhausted).`;
    return (
      `${heading}\n\n` +
      `Error: ${result.errorMessage}\n\n` +
      `The subagent did not produce a result. You can retry by spawning a new ` +
      `subagent or resume the session with pmux_resume.${sessionRef}`
    );
  }

  return result.exitCode !== 0
    ? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${summary}${sessionRef}`
    : `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${summary}${sessionRef}`;
}

export function observeRunningSubagent(running: RunningSubagent, observedAt = Date.now()) {
  // A backend without an activity snapshot has nothing to observe.
  if (!backendFor(running).observes) return;

  const activityFile = running.activityFile;
  const read: ActivityReadResult = activityFile
    ? readSubagentActivityFile(activityFile, running.id)
    : { ok: false, reason: "missing" };

  running.activityRead =
    read.ok === true ? { ok: true } : { ok: false, reason: read.reason, error: read.error };

  if (read.ok === true) running.activity = read.activity;

  running.statusState = observeStatus(running.statusState, toStatusObservation(read), observedAt);
}

/** Resolved per call so a test can point HOME at a temporary directory. */
function getClaudeSessionsDir(): string {
  return join(homedir(), ".pi", "agent", "sessions", "claude-code");
}

/**
 * Copy the Claude Code transcript beside the other Claude sessions and return
 * its session id: the transcript file name without the `.jsonl` extension,
 * which is what `claude --resume` takes.
 */
function copyClaudeSession(sentinelFile: string): string | null {
  try {
    const transcriptFile = sentinelFile + ".transcript";
    if (!existsSync(transcriptFile)) return null;
    const transcriptPath = readFileSync(transcriptFile, "utf-8").trim();
    if (!transcriptPath || !existsSync(transcriptPath)) return null;
    const sessionsDir = getClaudeSessionsDir();
    mkdirSync(sessionsDir, { recursive: true });
    const filename = basename(transcriptPath);
    copyFileSync(transcriptPath, join(sessionsDir, filename));
    return filename.replace(/\.jsonl$/, "");
  } catch {
    return null;
  }
}

/**
 * Remind, then finish, a non-interactive child that ended its turn but never
 * exited. Finishing writes the same `done` sidecar `pmux_done` would, so
 * pollForExit completes the normal way (summary from the session, pane closed).
 *
 * A child that stopped reporting entirely (killed mid-turn, or reloaded — its
 * activity writer disables on reload) never writes a sidecar; the parent
 * would poll its pane once a second for the rest of the session. After
 * `IDLE_GONE_MS` of silence, finish it with an error sidecar instead.
 */
function runIdleWatchdog(
  running: RunningSubagent,
  promptPane: (surface: string, text: string) => unknown,
  now = Date.now(),
): void {
  // Without activity snapshots the watchdog cannot tell a quiet child from a
  // gone one, so it only runs for an observing backend.
  if (!backendFor(running).observes) return;
  const state = (running.idleWatch ??= { nudges: 0 });

  const goneAction = decideGoneAction({
    interactive: running.interactive,
    readOk: running.activityRead?.ok === true,
    activity: running.activity ? { updatedAt: running.activity.updatedAt } : undefined,
    now,
    state,
  });
  if (goneAction === "gone") {
    const detail =
      running.activity != null && running.activityRead?.ok === true
        ? `last snapshot ${Math.round((now - running.activity.updatedAt) / 1000)}s old ` +
          `(phase ${running.activity.phase}, last event ${running.activity.latestEvent})`
        : `no valid snapshot for ${Math.round((now - (state.failedReadSince ?? now)) / 1000)}s ` +
          `(${running.activityRead?.reason ?? "missing"}${running.activityRead?.error ? ": " + running.activityRead.error : ""})`;
    try {
      writeFileSync(
        exitSidecarPath(running.sessionFile),
        JSON.stringify({
          type: "error",
          errorMessage: `Subagent child stopped reporting: ${detail}. Finish with an error instead of polling forever.`,
        }),
      );
    } catch {
      // Best effort — a transient failure (ENOSPC/EACCES) must not latch the
      // gone decision, so un-latch and let the next tick retry the write.
      state.gone = false;
    }
    return;
  }

  const action = decideIdleAction({
    interactive: running.interactive,
    phase: running.activity?.phase,
    waitingSince: running.activity?.waitingSince,
    now,
    state,
  });
  if (action === "nudge") {
    state.nudges += 1;
    state.lastNudgeAt = now;
    try {
      promptPane(running.surface, IDLE_NUDGE_TEXT);
    } catch {
      // Pane blocked or gone; the nudge still counts so the child is finished.
    }
  } else if (action === "finish") {
    try {
      writeFileSync(exitSidecarPath(running.sessionFile), JSON.stringify({ type: "done" }));
    } catch {
      // Best effort — the next tick retries.
    }
  }
}

export function requestSubagentInterrupt(
  running: RunningSubagent,
  sendEscapeKey: (surface: string) => void,
): { ok: true } | { error: string } {
  try {
    sendEscapeKey(running.surface);
    return { ok: true };
  } catch (error: any) {
    return {
      error:
        `Failed to send Escape to subagent "${running.name}" via tmux: ` +
        `${error?.message ?? String(error)}`,
    };
  }
}

/** One spawn resolution plus its per-run binding, so a backend builds one run. */
export interface BackendLaunchRequest extends PiLaunchRequest {
  /** Spawn-only: how the task reaches the child. */
  launchBehavior?: LaunchBehavior;
  /** The pane the child starts in. Kept at the request level beside the
   * parent contact's own `surface` because `startRun` and both backends read
   * it: the contact is the builder's input, this is the run's (design D2). */
  surface: string;
  /** Values that change for every run; the record does not keep them (design D3). */
  run: {
    id: string;
    startTime: number;
    /** Child session file (pi), or the record-adjacent path (Claude Code). */
    sessionFile: string;
    launchScriptFile: string;
    activityFile: string;
    /** Session entries the run starts after: 0 for a spawn, N for a resume. */
    entryCountBefore: number;
  };
}
/** What a backend builds for one run: its launch spec and its running entry. */
export interface BackendLaunch {
  spec: LaunchSpec;
  running: RunningSubagent;
}

/** A backend's refusal of an interrupt: the tool result to return instead. */
interface BackendInterruptRefusal {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

/** The parts of a run's result that the backend's exit path decides. */
interface BackendExtractedResult {
  summary: string;
  /** Pi's session file; a Claude Code run has none. */
  sessionFile?: string;
  ping?: PollResult["ping"];
  handoff?: PollResult["handoff"];
  errorMessage?: string;
  errorSource?: string;
}

/** What a backend does before its pane closes; pi has nothing to do. */
type BackendAfterExit = (running: RunningSubagent) => Pick<SubagentResult, "claudeSessionId">;

/** One backend's behavior. The supervisor reads this table, not the backend name. */
interface SubagentBackend {
  /** The record backend name this entry builds (design D3). */
  name: LaunchBackendName;
  /** True when the backend publishes an activity snapshot that status reads. */
  observes: boolean;
  buildLaunch(request: BackendLaunchRequest): BackendLaunch;
  /** Null when Escape interrupts this backend; otherwise the refusal result. */
  interrupt(running: RunningSubagent): BackendInterruptRefusal | null;
  extractResult(
    running: RunningSubagent,
    poll: Pick<PollResult, "exitCode" | "errorMessage" | "ping" | "handoff">,
    readScreen: (surface: string, lines: number) => string,
  ): BackendExtractedResult;
  afterExit: BackendAfterExit;
}

function buildPiBackendLaunch(request: BackendLaunchRequest): BackendLaunch {
  const { run } = request;
  return {
    spec: buildPiLaunch(request),
    running: {
      id: run.id,
      name: request.record.name,
      task: request.task,
      agent: request.record.agent,
      surface: request.surface,
      startTime: run.startTime,
      sessionFile: run.sessionFile,
      launchScriptFile: run.launchScriptFile,
      activityFile: run.activityFile,
      entryCountBefore: run.entryCountBefore,
      interactive: request.record.interactive,
      statusState: createStatusState({
        source: "pi",
        startTimeMs: run.startTime,
      }),
    },
  };
}

function buildClaudeLaunch(request: BackendLaunchRequest): BackendLaunch {
  const { record, run } = request;
  const sentinelFile = join(tmpdir(), `pi-claude-${run.id}-done`);
  const pluginDir = join(SUBAGENTS_DIR, "plugin");

  const claudeArgs: string[] = ["--dangerously-skip-permissions"];

  if (existsSync(pluginDir)) {
    claudeArgs.push("--plugin-dir", pluginDir);
  }

  if (record.model) {
    claudeArgs.push("--model", record.model);
  }

  if (record.rolePrompt) {
    claudeArgs.push("--append-system-prompt", record.rolePrompt);
  }

  if (request.resume) {
    // `claude --resume` takes the stored session id, then the follow-up prompt.
    if (!record.claudeSessionId) {
      throw new Error("A Claude Code resume needs a stored session id");
    }
    claudeArgs.push("--resume", record.claudeSessionId);
    if (request.resume.message) claudeArgs.push(request.resume.message);
  } else {
    // A spawn passes the task as the prompt.
    claudeArgs.push(request.task);
  }

  return {
    spec: {
      version: LAUNCH_SPEC_VERSION,
      name: record.name,
      ...(record.cwd ? { cwd: record.cwd } : {}),
      env: { PI_CLAUDE_SENTINEL: sentinelFile },
      command: "claude",
      args: claudeArgs,
      sessionFile: run.sessionFile,
      title: buildPaneTitle(record.name, request.resume?.message ?? request.task),
    },
    running: {
      id: run.id,
      name: record.name,
      task: request.task,
      agent: record.agent,
      surface: request.surface,
      startTime: run.startTime,
      sessionFile: run.sessionFile,
      launchScriptFile: run.launchScriptFile,
      cli: "claude",
      sentinelFile,
      entryCountBefore: run.entryCountBefore,
      interactive: record.interactive,
      statusState: createStatusState({
        source: "claude",
        startTimeMs: run.startTime,
      }),
    },
  };
}

function extractPiResult(
  running: RunningSubagent,
  poll: Pick<PollResult, "exitCode" | "errorMessage" | "errorSource" | "ping" | "handoff">,
): BackendExtractedResult {
  const fallback = poll.errorMessage
    ? `Subagent error: ${poll.errorMessage}`
    : poll.exitCode !== 0
      ? `Sub-agent exited with code ${poll.exitCode}`
      : "Sub-agent exited without output";
  const summary = existsSync(running.sessionFile)
    ? (findLastAssistantMessage(getNewEntries(running.sessionFile, running.entryCountBefore)) ??
      fallback)
    : fallback;
  return {
    summary,
    sessionFile: running.sessionFile,
    ping: poll.ping,
    handoff: poll.handoff,
    ...(poll.errorMessage ? { errorMessage: poll.errorMessage } : {}),
    ...(poll.errorSource ? { errorSource: poll.errorSource } : {}),
  };
}

function extractClaudeResult(
  running: RunningSubagent,
  poll: Pick<PollResult, "exitCode" | "errorMessage" | "errorSource">,
  readScreen: (surface: string, lines: number) => string,
): BackendExtractedResult {
  let summary = "";

  if (running.sentinelFile) {
    try {
      summary = readFileSync(running.sentinelFile, "utf-8").trim();
    } catch {
      // Fall through to the screen read below.
    }
  }

  if (!summary) {
    summary = readScreen(running.surface, 200)
      .replace(/__SUBAGENT_DONE_\d+__/, "")
      .trimEnd()
      .slice(-SCREEN_SUMMARY_CHARS);
  }

  if (!summary) {
    summary =
      poll.exitCode !== 0
        ? `Claude Code exited with code ${poll.exitCode}`
        : "Claude Code exited without output";
  }

  // The child has no pi-style session file; the record sits beside the path a
  // later `pmux_resume` uses, so that path is the session reference.
  return {
    summary,
    sessionFile: running.sessionFile,
    ...(poll.errorMessage ? { errorMessage: poll.errorMessage } : {}),
    ...(poll.errorSource ? { errorSource: poll.errorSource } : {}),
  };
}

function copyClaudeTranscript(running: RunningSubagent): Pick<SubagentResult, "claudeSessionId"> {
  if (!running.sentinelFile) return {};
  const sessionId = copyClaudeSession(running.sentinelFile);
  try {
    unlinkSync(running.sentinelFile);
  } catch {
    // Best effort: the sentinel may already be gone.
  }
  try {
    unlinkSync(running.sentinelFile + ".transcript");
  } catch {
    // Best effort: the transcript may already be gone.
  }
  if (!sessionId) return {};

  // Store the id beside the role values, keeping every other record field so a
  // later `pmux_resume` finds the same role configuration.
  const recordFile = getLaunchRecordFile(running.sessionFile);
  const record = readLaunchRecord(recordFile);
  if (record) writeLaunchRecord(recordFile, { ...record, claudeSessionId: sessionId });
  return { claudeSessionId: sessionId };
}

function refuseClaudeInterrupt(running: RunningSubagent): BackendInterruptRefusal {
  return {
    content: [
      {
        type: "text",
        text: "Turn-only Escape interrupt is currently supported only for Pi-backed subagents. Claude-backed semantics have not been verified yet.",
      },
    ],
    details: { error: "claude interrupt unsupported", id: running.id, name: running.name },
  };
}

/** The backend table (design D4): one place decides each backend's differences. */
const BACKENDS: Record<LaunchBackendName, SubagentBackend> = {
  pi: {
    name: "pi",
    observes: true,
    buildLaunch: buildPiBackendLaunch,
    interrupt: () => null,
    extractResult: extractPiResult,
    afterExit: () => ({}),
  },
  claude: {
    name: "claude",
    observes: false,
    buildLaunch: buildClaudeLaunch,
    interrupt: refuseClaudeInterrupt,
    extractResult: extractClaudeResult,
    afterExit: copyClaudeTranscript,
  },
};

/** The table lookup every backend check in the supervisor goes through. */
function backendFor(owner: { cli?: string } | null | undefined): SubagentBackend {
  return owner?.cli === "claude" ? BACKENDS.claude : BACKENDS.pi;
}

/**
 * Create the parent-side subagent supervisor (design D1). It owns the running
 * map, the roster, the widget and status intervals, and its own poll abort
 * controller. `send`, `ui` and the tmux operations are injected, so tests can
 * run without a real pi or tmux.
 */
export function createSupervisor(deps: SupervisorDeps): Supervisor {
  let shutdownDone = false;

  /** All currently running subagents, keyed by id. */
  const runningSubagents = new Map<string, RunningSubagent>();

  /** Where this process publishes its roster, set on the first spawn or resume. */
  let rosterContext: { file: string; parentPane: string; parentName: string } | null = null;

  /** Interval timer for widget re-renders. */
  let widgetInterval: ReturnType<typeof setInterval> | null = null;

  /** Interval timer for status transition checks. */
  let statusInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Abort signal shared by every poll watcher this supervisor starts. Session
   * teardown aborts it; a fresh supervisor (session start, reload) starts a
   * new one. A watcher must never inherit an already-aborted signal:
   * `pollForExit` would fail it instantly with an empty result while the
   * child it just launched is still starting.
   */
  const abortController = new AbortController();

  /** Record where this process's roster lives (idempotent). */
  function ensureRosterContext(ctx: {
    sessionManager: { getSessionDir(): string; getSessionId(): string };
  }): void {
    if (rosterContext) return;
    rosterContext = {
      file: getRosterFile(
        getArtifactDir(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId()),
      ),
      parentPane: process.env.TMUX_PANE ?? "",
      parentName: decodeChildEnv(process.env).name ?? "parent",
    };
  }

  /**
   * Rewrite the roster file to mirror `runningSubagents`, atomically. Called on
   * every spawn, resume and exit so children can resolve siblings. Best effort:
   * without it the sender just loses the sibling lookup.
   */
  function writeRoster(): void {
    if (!rosterContext) return;
    try {
      const payload = buildRosterPayload({
        parentPane: rosterContext.parentPane,
        parentName: rosterContext.parentName,
        children: runningSubagents.values(),
      });
      writeJsonAtomic(rosterContext.file, payload);
    } catch {
      // Best effort — see the doc comment.
    }
  }

  function updateWidget(): void {
    // Stop the refresh timer once nothing runs, with or without a UI.
    if (runningSubagents.size === 0 && widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
    }

    const ctx = deps.ui();
    if (!ctx?.hasUI) return;

    if (runningSubagents.size === 0) {
      ctx.ui.setWidget("pmux-status", undefined);
      return;
    }

    ctx.ui.setWidget(
      "pmux-status",
      (_tui, _theme) => {
        return {
          invalidate() {},
          render(width: number) {
            return renderSubagentWidgetLines(Array.from(runningSubagents.values()), width);
          },
        };
      },
      { placement: "aboveEditor" },
    );
  }

  function renderSubagentWidgetLines(agents: RunningSubagent[], width: number): string[] {
    const count = agents.length;
    const title = "Subagents";
    const info = `${count} running`;

    const lines: string[] = [borderTop(title, info, width)];

    for (const agent of agents) {
      const elapsed = formatElapsedMMSS(agent.startTime);
      const agentTag = agent.agent ? ` (${agent.agent})` : "";
      const left = ` ${elapsed}  ${agent.name}${agentTag} `;
      const snapshot = classifyStatus(agent.statusState, Date.now());
      // A backend without a status feed has no starting phase to report.
      const right = deps.statusConfig.enabled
        ? formatWidgetRightLabel(snapshot)
        : backendFor(agent).observes
          ? " starting… "
          : " running… ";

      lines.push(borderLine(left, right, width));
    }

    lines.push(borderBottom(width));
    return lines;
  }

  function startWidgetRefresh(): void {
    if (widgetInterval) return;
    updateWidget(); // immediate first render
    widgetInterval = setInterval(() => {
      updateWidget();
    }, 1000);
  }

  function startStatusRefresh(): void {
    if (!deps.statusConfig.enabled || statusInterval) return;

    statusInterval = setInterval(() => {
      if (runningSubagents.size === 0) {
        if (statusInterval) {
          clearInterval(statusInterval);
          statusInterval = null;
        }
        return;
      }

      const transitionLines: string[] = [];
      const now = Date.now();
      let shouldRefreshWidget = false;

      for (const running of runningSubagents.values()) {
        observeRunningSubagent(running, now);
        const { nextState, snapshot, transition } = advanceStatusState(running.statusState, now);
        if (nextState.currentKind !== running.statusState.currentKind) {
          shouldRefreshWidget = true;
        }
        running.statusState = nextState;

        // Interactive subagents (long-running, user-driven) intentionally don't
        // wake the parent session on stalled/recovered transitions — the user is
        // working in the subagent's pane, and a steer message here would burn an
        // orchestrator turn on a no-op "still waiting" ping. Widget still updates.
        if (transition && !running.interactive) {
          transitionLines.push(formatTransitionLine(running.name, snapshot, transition));
        }
      }

      if (shouldRefreshWidget) updateWidget();

      if (transitionLines.length > 0) {
        const capped = capStatusLines(transitionLines, deps.statusConfig.lineLimit);
        deps.send(
          {
            customType: "pmux_status",
            content: formatStatusAggregate(transitionLines, deps.statusConfig.lineLimit),
            display: true,
            details: { lines: capped.visibleLines, overflow: capped.overflow },
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
      }
    }, 1000);
  }

  function resolveInterruptTarget(params: {
    id?: string;
    name?: string;
  }): { running: RunningSubagent } | { error: string } {
    const requestedId = params.id?.trim();
    if (requestedId) {
      const running = runningSubagents.get(requestedId);
      return running ? { running } : { error: `No running subagent with id "${requestedId}".` };
    }

    const requestedName = params.name?.trim();
    if (!requestedName) {
      return { error: "Provide a running subagent id or exact display name." };
    }

    const matches = Array.from(runningSubagents.values()).filter(
      (running) => running.name === requestedName,
    );
    if (matches.length === 1) return { running: matches[0] };
    if (matches.length === 0) {
      return { error: `No running subagent named "${requestedName}".` };
    }

    const candidates = matches.map((running) => `${running.name} [${running.id}]`).join(", ");
    return { error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}` };
  }

  function handleSubagentInterrupt(
    params: { id?: string; name?: string },
    sendEscapeKey?: (surface: string) => void,
  ) {
    const resolved = resolveInterruptTarget(params);
    if ("error" in resolved) {
      return {
        content: [{ type: "text" as const, text: resolved.error }],
        details: { error: resolved.error },
      };
    }

    const running = resolved.running;
    const refusal = backendFor(running).interrupt(running);
    if (refusal) return refusal;

    const now = Date.now();
    observeRunningSubagent(running, now);

    const interruption = requestSubagentInterrupt(running, sendEscapeKey ?? deps.pmux.sendEscape);
    if ("error" in interruption) {
      return {
        content: [{ type: "text" as const, text: interruption.error }],
        details: { error: interruption.error, id: running.id, name: running.name },
      };
    }

    running.statusState = forceStatusAfterInterrupt(running.statusState, now);
    updateWidget();

    return {
      content: [
        { type: "text" as const, text: `Interrupt requested for subagent "${running.name}".` },
      ],
      details: { id: running.id, name: running.name, status: "interrupt_requested" },
    };
  }

  /**
   * Build a run's launch spec, write it beside the pane, start the pane command
   * and register the run. Spawn and resume both end here.
   */
  function startRun(
    backend: SubagentBackend,
    request: BackendLaunchRequest,
    paneLine: string,
  ): RunningSubagent {
    const { spec, running } = backend.buildLaunch(request);
    writeLaunchSpec(request.run.launchScriptFile, spec);
    // A new run must not read the status of an earlier run, nor its exit.
    removeChildStatus(request.run.sessionFile);
    removeExitSidecar(request.run.sessionFile);
    deps.pmux.runInPane(request.surface, paneLine);

    runningSubagents.set(running.id, running);
    writeRoster();
    return running;
  }

  /**
   * Launch a subagent: creates the multiplexer pane, builds the command, and
   * sends it. Returns a RunningSubagent — does NOT poll.
   *
   * Call watchSubagent() on the returned object to observe completion.
   */
  async function launchSubagent(
    params: Static<typeof SubagentParams>,
    ctx: SupervisorContext,
    options?: SurfaceOptions,
  ): Promise<RunningSubagent> {
    const startTime = Date.now();
    const id = Math.random().toString(16).slice(2, 10);

    // The role resolves once (design D6); the launch records what it resolved
    // and the pane opens after that, so nothing is written on a thrown error.
    const {
      record,
      definition: agentDefs,
      skills: effectiveSkills,
      paths,
    } = resolveLaunchRecord({
      role: params.agent,
      // The pi parent resolves roles and relative cwds against the process
      // cwd, exactly pre-change. The context type names a `cwd` field, but
      // setting it is not a guarantee: `pmux_resume` accepts a session file
      // of another cwd, and the tool context does not verify it.
      anchor: process.cwd(),
      // The schema requires `agent`, so the role must exist (design D1); a
      // role with no `model:` still launches on pi's default model.
      requireRole: true,
      overrides: {
        name: params.name,
        model: params.model,
        tools: params.tools,
        skills: params.skills,
        cwd: params.cwd,
        interactive: params.interactive ?? null,
        systemPrompt: params.systemPrompt,
      },
    });

    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) throw new Error("No session file");
    const sessionId = ctx.sessionManager.getSessionId();
    const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);
    ensureRosterContext(ctx);

    const { localAgentDir, effectiveAgentDir, effectiveCwd } = paths;

    const targetCwdForSession = effectiveCwd ?? ctx.cwd;
    const sessionDir = getDefaultSessionDirFor(targetCwdForSession, effectiveAgentDir);

    // Generate a deterministic session file path for this subagent.
    // This eliminates race conditions when multiple agents launch simultaneously —
    // each agent knows exactly which file is theirs.
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
    const uuid = [
      id,
      Math.random().toString(16).slice(2, 10),
      Math.random().toString(16).slice(2, 10),
      Math.random().toString(16).slice(2, 6),
    ].join("-");
    const subagentSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);

    // Compute the launch-spec path and its pane line before any pane exists, so
    // an unsafe path fails without leaving an empty pane behind.
    const launchBase = slugifyName(params.name || "subagent", { hyphenate: false });
    const launchScriptFile = join(artifactDir, "pmux-scripts", `${launchBase}-${id}.json`);
    const paneLine = paneCommandLine(SUBAGENTS_CLI_PATH, launchScriptFile);

    const launchBehavior = resolveLaunchBehavior(params, agentDefs);
    // The record names the backend, so the table lookup reads one source.
    const backend = BACKENDS[record.backend];

    // Resolve the placement after the role is loaded: the role's `surface:`
    // wins over the configured default; there is no per-call value.
    const placement = resolvePlacement(record.surface, options?.fallback);

    writeLaunchRecord(getLaunchRecordFile(subagentSessionFile), record);

    // Create the surface, then pause briefly so the shell is ready before
    // sending the command.
    const surface = deps.pmux.createSurface(params.name, placement);
    await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));

    // A Claude Code child has no pi-style session file; seeding one would make
    // a resume path that no backend reads. The record still sits beside it.
    if (launchBehavior.seededSessionMode && backend.name === "pi") {
      seedSubagentSessionFile({
        mode: launchBehavior.seededSessionMode,
        parentSessionFile: sessionFile,
        childSessionFile: subagentSessionFile,
        childCwd: targetCwdForSession,
      });
    }

    const activityFile = getSubagentActivityFile(artifactDir, id);
    mkdirSync(dirname(activityFile), { recursive: true });

    return startRun(
      backend,
      {
        record,
        task: params.task,
        skills: effectiveSkills,
        launchBehavior,
        localAgentDir,
        artifactDir,
        parentContact: {
          kind: "pi",
          siblingNames: Array.from(runningSubagents.values(), (agent) => agent.name),
          parentRosterFile: rosterContext?.file,
        },
        surface,
        run: {
          id,
          startTime,
          sessionFile: subagentSessionFile,
          launchScriptFile,
          activityFile,
          entryCountBefore: 0,
        },
      },
      paneLine,
    );
  }

  /** Close a finished run's pane, drop its entry and refresh the roster. */
  function releaseRun(running: RunningSubagent): void {
    try {
      deps.pmux.closeSurface(running.surface);
    } catch {
      // The pane may already be gone (closed by hand); the run's result stands.
    }
    runningSubagents.delete(running.id);
    writeRoster();
  }

  /**
   * Watch a launched subagent until it exits. Polls for completion, extracts
   * the summary from the session file, cleans up the surface,
   * and removes the entry from runningSubagents.
   */
  async function watchSubagent(
    running: RunningSubagent,
    signal: AbortSignal,
    send: SendFn,
  ): Promise<SubagentResult> {
    const { name, task, surface, startTime, sessionFile } = running;
    // Either the per-agent watcher or the supervisor's teardown (reload,
    // session shutdown) can end the wait. Keep the combined signal so the
    // catch below reports a cancellation instead of a bogus subagent failure.
    const pollSignal = AbortSignal.any([signal, abortController.signal]);

    try {
      // Watch the pane: the sidecar file is the primary signal, the terminal
      // sentinel the fallback for a child that died without writing one.
      const result = await deps.pmux.pollForExit(surface, pollSignal, {
        interval: 1000,
        sessionFile,
        sentinelFile: running.sentinelFile,
        // The screen read is only the crash fallback; while the child's activity
        // snapshot is demonstrably fresh, skip the per-second process spawn.
        // Claude-backed runs have no snapshots, so they keep scanning.
        maySkipScreenScan: running.activityFile
          ? () => {
              const activity = running.activity;
              return activity != null && Date.now() - activity.updatedAt < 10_000;
            }
          : undefined,
        onTick() {
          observeRunningSubagent(running);
          deliverParentMessages(running, send);
          runIdleWatchdog(running, deps.pmux.agentPrompt);
        },
      });
      // A child can write its last message just before exiting; deliver it before
      // the completion result so ordering matches what the child observed.
      drainAndRemoveParentMessages(running, send);

      const elapsed = Math.floor((Date.now() - startTime) / 1000);

      const backend = backendFor(running);
      const extracted = backend.extractResult(running, result, deps.pmux.readScreen);
      const afterExit = backend.afterExit(running);

      releaseRun(running);

      return {
        name,
        task,
        exitCode: result.exitCode,
        elapsed,
        ...extracted,
        ...(afterExit.claudeSessionId ? { claudeSessionId: afterExit.claudeSessionId } : {}),
      };
    } catch (err: any) {
      releaseRun(running);
      try {
        rmSync(getParentMessageFile(sessionFile), { force: true });
      } catch {
        // Best effort — we are unwinding, so nothing is injected.
      }

      if (pollSignal.aborted) {
        return {
          name,
          task,
          summary: "Subagent cancelled.",
          exitCode: 1,
          elapsed: Math.floor((Date.now() - startTime) / 1000),
          error: "cancelled",
          sessionFile,
        };
      }
      return {
        name,
        task,
        summary: `Subagent error: ${err?.message ?? String(err)}`,
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        error: err?.message ?? String(err),
      };
    }
  }

  /**
   * Steer the parent with a finished subagent run: a ping when the child asked
   * for help, otherwise the result. Shared by spawned and resumed children.
   */
  function deliverSubagentCompletion(
    running: RunningSubagent,
    result: SubagentResult,
    send: SendFn,
  ): void {
    updateWidget(); // reflect removal from the Map immediately

    const sessionRef = `\n\nSession: ${result.sessionFile}\nResume: pmux_resume ${result.sessionFile}`;
    if (result.ping) {
      send(
        {
          customType: "pmux_ping",
          content: `Sub-agent "${result.ping.name}" needs help (${formatElapsed(result.elapsed)}):\n\n${result.ping.message}${sessionRef}`,
          display: true,
          details: {
            name: running.name,
            task: running.task,
            agent: running.agent,
            message: result.ping.message,
            sessionFile: result.sessionFile,
          },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
      return;
    }

    if (result.handoff) {
      // No `sessionRef` here: its `Resume: pmux_resume` line tells the parent
      // to do the opposite of what a handoff needs. The session file still goes
      // in the content, and the instruction line says to start a new subagent.
      send(
        {
          customType: "pmux_handoff",
          content:
            `Sub-agent "${running.name}" handed off at the context alert (${formatElapsed(result.elapsed)}). The task is not complete.\n\n` +
            `${result.handoff.message}\n\n` +
            `Start a new subagent with this handoff in its task. Do not resume this session.\n\n` +
            `Session: ${result.sessionFile}`,
          display: true,
          details: {
            name: running.name,
            task: running.task,
            agent: running.agent,
            message: result.handoff.message,
            sessionFile: result.sessionFile,
          },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
      return;
    }

    send(
      {
        customType: "pmux_result",
        content: resolveResultPresentation(result, running.name),
        display: true,
        details: {
          name: running.name,
          task: running.task,
          agent: running.agent,
          exitCode: result.exitCode,
          elapsed: result.elapsed,
          sessionFile: result.sessionFile,
          ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
          ...(result.claudeSessionId ? { claudeSessionId: result.claudeSessionId } : {}),
        },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  }

  /** Report a watcher failure to the parent; see deliverSubagentCompletion. */
  function deliverSubagentError(running: RunningSubagent, err: unknown, send: SendFn): void {
    const message = (err as { message?: string } | undefined)?.message;
    updateWidget();
    send(
      {
        customType: "pmux_result",
        content: `Sub-agent "${running.name}" error: ${message ?? String(err)}`,
        display: true,
        details: {
          name: running.name,
          task: running.task,
          agent: running.agent,
          error: message,
        },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  }

  /** Start a launched child's watcher and deliver its outcome to the parent. */
  function startWatcher(running: RunningSubagent): void {
    // Create a separate AbortController for the watcher
    // (the tool's signal completes when we return)
    const watcherAbort = new AbortController();
    running.abortController = watcherAbort;

    // Start widget refresh and status supervision when the first agent launches
    startWidgetRefresh();
    startStatusRefresh();

    // Fire-and-forget: start watching in background
    watchSubagent(running, watcherAbort.signal, deps.send)
      .then((result) => {
        deliverSubagentCompletion(running, result, deps.send);
      })
      .catch((err) => {
        deliverSubagentError(running, err, deps.send);
      });
  }

  return {
    get isShutdown() {
      return shutdownDone;
    },
    async spawn(params, ctx, options) {
      const running = await launchSubagent(params, ctx, options);
      startWatcher(running);
      return running;
    },

    async resume(params, ctx, options) {
      const startTime = Date.now();
      const id = Math.random().toString(16).slice(2, 10);

      const sessionId = ctx.sessionManager.getSessionId();
      const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);
      const activityFile = getSubagentActivityFile(artifactDir, id);
      mkdirSync(dirname(activityFile), { recursive: true });
      ensureRosterContext(ctx);

      // Read the record before the session file: a Claude Code record resumes
      // without a pi-style session file, and the record sits beside that path.
      const storedRecord = readLaunchRecord(getLaunchRecordFile(params.sessionPath));
      if (!storedRecord && !existsSync(params.sessionPath)) {
        return {
          content: [{ type: "text", text: `Error: session file not found: ${params.sessionPath}` }],
          details: { error: "session not found" },
        };
      }
      if (storedRecord?.backend === "claude" && !storedRecord.claudeSessionId) {
        return {
          content: [
            {
              type: "text",
              text:
                `Error: the launch record for ${params.sessionPath} has no Claude Code ` +
                "session id. The run did not store its transcript; start a new subagent instead.",
            },
          ],
          details: { error: "claude session id missing", sessionPath: params.sessionPath },
        };
      }

      const autoExit = params.autoExit ?? storedRecord?.autoExit ?? true;
      // An explicit autoExit makes the run interactive exactly when it is false.
      const interactive =
        params.autoExit !== undefined ? !params.autoExit : (storedRecord?.interactive ?? !autoExit);
      const effectiveRecord: LaunchRecord = storedRecord
        ? { ...storedRecord, autoExit, interactive }
        : {
            version: LAUNCH_RECORD_VERSION,
            backend: "pi",
            name: "Resume",
            denyTools: [],
            autoExit,
            interactive,
          };
      const name = effectiveRecord.name;
      const backend = BACKENDS[effectiveRecord.backend];

      // Record the entry count before the resume so its delivery only reads the
      // entries the resumed run writes. A Claude Code run has no pi-style
      // session file, so its summary comes from the sentinel and the screen.
      const entryCountBefore =
        effectiveRecord.backend === "claude" || !existsSync(params.sessionPath)
          ? 0
          : getNewEntries(params.sessionPath, 0).length;

      // Compute the launch-spec path and its pane line before any pane
      // exists, so an unsafe path fails without leaving an empty pane behind.
      const launchScriptFile = join(
        artifactDir,
        "pmux-scripts",
        `${slugifyName(name, { fallback: "resume", hyphenate: false })}-resume-${Date.now()}.json`,
      );
      const paneLine = paneCommandLine(SUBAGENTS_CLI_PATH, launchScriptFile);

      const placement = resolvePlacement(storedRecord?.surface, options?.fallback);
      const surface = deps.pmux.createSurface(name, placement);
      await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));

      // Mirror the spawn's cwd lookup: only a record that names a cwd can have
      // its own `.pi/agent` configuration.
      const localAgentDir = effectiveRecord.cwd ? join(effectiveRecord.cwd, ".pi", "agent") : null;
      const running = startRun(
        backend,
        {
          record: effectiveRecord,
          task: params.message ?? "resumed session",
          localAgentDir,
          artifactDir,
          parentContact: {
            kind: "pi",
            siblingNames: Array.from(runningSubagents.values(), (agent) => agent.name),
            parentRosterFile: rosterContext?.file,
          },
          surface,
          resume: { message: params.message },
          run: {
            id,
            startTime,
            sessionFile: params.sessionPath,
            launchScriptFile,
            activityFile,
            entryCountBefore,
          },
        },
        paneLine,
      );

      startWatcher(running);

      return {
        content: [
          {
            type: "text",
            text: storedRecord
              ? `Session "${name}" resumed.`
              : `Session "${name}" resumed. No launch record was found, so the role configuration was not restored.`,
          },
        ],
        details: {
          id,
          name,
          sessionPath: params.sessionPath,
          launchScriptFile,
          status: "started",
        },
      };
    },

    interrupt: handleSubagentInterrupt,

    running(): readonly RunningSubagent[] {
      return Array.from(runningSubagents.values());
    },

    shutdown(): void {
      if (shutdownDone) return;
      shutdownDone = true;
      if (widgetInterval) {
        clearInterval(widgetInterval);
        widgetInterval = null;
      }
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
      }
      abortController.abort();
      for (const [_id, agent] of runningSubagents) {
        agent.abortController?.abort();
      }
      runningSubagents.clear();
      rosterContext = null;
    },

    getAbortController(): AbortController {
      return abortController;
    },
    renderSubagentWidgetLines,
  };
}
