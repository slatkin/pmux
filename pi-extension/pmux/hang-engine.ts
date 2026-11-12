/*!
 * pi-hang-guard — vendored into pmux.
 *
 * Copyright (c) 2026 ducaoya
 *
 * MIT License. Ported from https://github.com/ducaoya/pi-hang-guard
 * (engine.ts) and customised for pmux subagents: the config file and i18n
 * are gone (fixed plain-English strings, settings injected by the host) and
 * the status widget is dropped (a subagent's pane carries no footer). The
 * detection core — per-tool-call entries, the tick, the idle-vs-runtime
 * measure, and the observe/guard/yolo escalation ladder with bounded
 * auto-resume — is upstream's, and the upstream license above covers it.
 *
 * The guard engine.
 *
 * Pure state machine: it never creates timers and never touches the clock
 * directly. The host (`hang-guard.ts`) calls `tick()` on an interval and
 * supplies `now()` plus a `notify` sink, which makes every behaviour
 * deterministic and unit testable without a pi runtime.
 *
 * Detection model
 * ---------------
 * - Streaming tools (built-in `bash`) emit `tool_execution_update` while they
 *   produce output, so "seconds since the last output" is a true stuck signal.
 * - Tools that never stream cannot be measured that way, so they fall back to
 *   wall-clock runtime.
 * - Commands carrying their own bound (`timeout 600 …`) also fall back to
 *   wall-clock, because their silent phases are already bounded.
 * - While pi waits on a blocking UI prompt (permission dialogs) all accounting
 *   is frozen, otherwise "user is deciding" would look like "tool is stuck".
 */

import { classifyCommand, type ClassifyRules, type CommandKind } from "./hang-classify.ts";

export type GuardMode = "observe" | "guard" | "yolo";
export type GuardLevel = 0 | 1 | 2;
export type GuardBasis = "idle" | "runtime";
export type NotifyLevel = "info" | "warning" | "error";

/** The settings the host resolves once (env + defaults); no config file. */
export interface HangGuardSettings {
  enabled: boolean;
  mode: GuardMode;
  /** Tools that stream partial output, so "time with no output" is measurable. */
  streamingTools: string[];
  /** Seconds without output before a warning. Streaming tools only. */
  idleWarnSec: number;
  /** Seconds without output before the critical level. Streaming tools only. */
  idleCriticalSec: number;
  /** Raised thresholds for commands that may legitimately stay silent. */
  idleWhitelistWarnSec: number;
  idleWhitelistCriticalSec: number;
  /** Wall-clock seconds before a warning. Non-streaming tools and self-timed commands. */
  runtimeWarnSec: number;
  runtimeCriticalSec: number;
  /** Notification budget per tool call (1 suppresses the critical tier). */
  maxNotificationsPerCall: number;
  /** Seconds to wait after a soft kill before escalating to aborting the turn. */
  softKillGraceSec: number;
  /** Maximum automatic turn resumptions per session. `0` disables resuming. */
  maxAutoResumes: number;
  /** Minimum seconds between two automatic actions. */
  actionCooldownSec: number;
  /** How often the guard re-evaluates running tools. */
  tickIntervalMs: number;
  classify: ClassifyRules;
}

export const DEFAULT_GUARD_SETTINGS: HangGuardSettings = {
  enabled: true,
  mode: "observe",
  streamingTools: ["bash"],
  idleWarnSec: 90,
  idleCriticalSec: 150,
  idleWhitelistWarnSec: 300,
  idleWhitelistCriticalSec: 600,
  runtimeWarnSec: 180,
  runtimeCriticalSec: 600,
  maxNotificationsPerCall: 2,
  softKillGraceSec: 15,
  maxAutoResumes: 1,
  actionCooldownSec: 60,
  tickIntervalMs: 1000,
  classify: {},
};

export interface HangGuardUI {
  notify(message: string, level: NotifyLevel): void;
}

export interface HangGuardDeps {
  ui: HangGuardUI;
  settings: () => HangGuardSettings;
  /** Injectable clock. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Escalation capabilities supplied by the host. Omit them to make the engine
   * observe-only regardless of `mode` — the guard still works, it just never acts.
   */
  actions?: HangGuardActions;
}

/** Result of a soft kill attempt (killing tracked shell children). */
export interface SoftKillOutcome {
  ok: boolean;
  detail: string;
  /** The host is still resolving its killer; retry on the next tick instead of escalating. */
  pending?: boolean;
}

export interface HangGuardActions {
  /** Kill the shell processes pi is tracking. Returns whether it was possible. */
  softKill(): SoftKillOutcome;
  /** Abort the current agent turn (`ctx.abort()`). */
  abortTurn(): void;
}

/** One escalation step that was actually taken. */
export interface GuardActionReport {
  action: "soft-kill" | "abort";
  toolCallId: string;
  toolName: string;
  command: string;
  kind: CommandKind;
  basis: GuardBasis;
  observedMs: number;
  thresholdSec: number;
  mode: GuardMode;
  softKillDetail?: string;
  /** Set when this action queued an automatic turn resumption. */
  resumeIndex?: number;
  maxResumes?: number;
}

export interface ToolStartInput {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ToolUpdateInput {
  toolCallId: string;
}

export interface ToolEndInput {
  toolCallId: string;
  isError: boolean;
}

export interface GuardEntryStatus {
  toolCallId: string;
  toolName: string;
  command: string;
  kind: CommandKind;
  reason: string;
  basis: GuardBasis;
  observedMs: number;
  maxObservedMs: number;
  startedAt: number;
  lastActivityAt: number;
  level: GuardLevel;
  notifications: number;
  idleWhitelisted: boolean;
  selfTimed: boolean;
}

export interface GuardStats {
  running: number;
  skippedInteractive: number;
  notifications: number;
  paused: boolean;
  actions: number;
  resumes: number;
  pendingResume: boolean;
}

interface Entry {
  toolCallId: string;
  toolName: string;
  command: string;
  kind: CommandKind;
  reason: string;
  idleWhitelisted: boolean;
  selfTimed: boolean;
  startedAt: number;
  lastActivityAt: number;
  basis: GuardBasis;
  observedMs: number;
  maxObservedMs: number;
  level: GuardLevel;
  notifications: number;
  /** Set once a soft kill was issued for this tool. */
  softKilledAt?: number;
  softKillDetail?: string;
  /** Set once we requested a turn abort for this tool. */
  abortRequested?: boolean;
}

export interface HangGuardEngine {
  onToolStart(input: ToolStartInput): void;
  onToolUpdate(input: ToolUpdateInput): void;
  onToolEnd(input: ToolEndInput): void;
  onUiPromptStart(): void;
  onUiPromptEnd(): void;
  /** Safety net: drop every tracked tool (turn finished). */
  onAgentSettled(): void;
  onShutdown(): void;
  tick(): void;
  list(): GuardEntryStatus[];
  stats(): GuardStats;
  hasRunning(): boolean;
  /** Escalation steps taken so far, oldest first. */
  actionLog(): GuardActionReport[];
  /** Take the queued resumption report, if any, clearing it. */
  consumeResume(): GuardActionReport | null;
}

/** Collapse a multi-line command into one short line for messages. */
export function previewCommand(command: string, max = 56): string {
  const single = command.replace(/\s+/g, " ").trim();
  if (single === "") return "(no command)";
  if (single.length <= max) return single;
  return `${single.slice(0, Math.max(1, max - 1))}…`;
}

/** `95s`, `3m12s`, `1h05m`. Sub-second values round up so `0s` never appears. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h${(minutes % 60).toString().padStart(2, "0")}m`;
}

/** `1m30s idle` for streaming tools, `running 1m30s` for the wall-clock basis. */
export function observationText(basis: GuardBasis, observedMs: number): string {
  return basis === "idle"
    ? `${formatDuration(observedMs)} idle`
    : `running ${formatDuration(observedMs)}`;
}

function kindLabel(kind: CommandKind): string {
  if (kind === "watcher") return "server/watch";
  return kind;
}

/**
 * Structured report handed back to the model after an automatic action.
 * The aborted tool result only says `Command aborted`, so without this the
 * model has no idea why the turn ended.
 */
export function resumeMessage(report: GuardActionReport): string {
  const resumeIndex = report.resumeIndex ?? 1;
  const maxResumes = report.maxResumes ?? 1;
  const reason =
    `${report.toolName} ${observationText(report.basis, report.observedMs)} ` +
    `(over the ${report.thresholdSec}s threshold, ${kindLabel(report.kind)})`;
  const softKill =
    report.softKillDetail !== undefined
      ? `\ncommand: ${previewCommand(report.command, 80)}\n${report.softKillDetail}`
      : "";
  return (
    [
      `The watchdog stopped your turn: ${reason}.`,
      `command: ${previewCommand(report.command, 80)}`,
      `The command was ${report.mode === "yolo" ? "soft-killed" : "aborted"} automatically (resume ${resumeIndex} of ${maxResumes}).`,
      "Check the command for a hang, fix the cause, and continue the task. Do not restart the same command unchanged.",
    ].join("\n") + softKill
  );
}

function commandFromArgs(args: unknown): string {
  if (typeof args !== "object" || args === null) return "";
  const command = (args as { command?: unknown }).command;
  return typeof command === "string" ? command : "";
}

export function createHangGuardEngine(deps: HangGuardDeps): HangGuardEngine {
  const now = deps.now ?? (() => Date.now());
  const entries = new Map<string, Entry>();
  /** Host-injected actions are what make `guard` / `yolo` capable of acting at all. */
  const canAct = deps.actions !== undefined;
  /** The `guard`-mode hint is offered at most once per session, never per tool call. */
  let guardHintShown = false;

  let uiPromptDepth = 0;
  let pausedAt = 0;
  let skippedInteractive = 0;
  let notificationCount = 0;

  /** UI must never be able to break guard bookkeeping. */
  function tryUi(action: () => void): void {
    try {
      action();
    } catch {
      // A stale or unavailable UI context is not fatal for a watchdog.
    }
  }

  function notify(message: string, level: NotifyLevel): void {
    notificationCount += 1;
    tryUi(() => deps.ui.notify(message, level));
  }

  // --- escalation state -----------------------------------------------------
  let resumeCount = 0;
  let nextActionAt = 0;
  const actionsTaken: GuardActionReport[] = [];
  let resumeRequest: GuardActionReport | null = null;

  function trySoftKill(): SoftKillOutcome {
    const actions = deps.actions;
    if (!actions) return { ok: false, detail: "host has no escalation actions" };
    try {
      return actions.softKill();
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  function buildReport(
    entry: Entry,
    result: { basis: GuardBasis; observedMs: number; warnSec: number; criticalSec: number },
    settings: HangGuardSettings,
    action: "soft-kill" | "abort",
  ): GuardActionReport {
    return {
      action,
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      command: entry.command,
      kind: entry.kind,
      basis: result.basis,
      observedMs: result.observedMs,
      thresholdSec: result.criticalSec,
      mode: settings.mode,
      softKillDetail: entry.softKillDetail,
    };
  }

  /** Queue at most one resumption at a time, capped by `maxAutoResumes`. */
  function queueResume(report: GuardActionReport, settings: HangGuardSettings): void {
    if (settings.maxAutoResumes <= 0 || resumeCount >= settings.maxAutoResumes) return;
    if (resumeRequest) return;
    resumeCount += 1;
    report.resumeIndex = resumeCount;
    report.maxResumes = settings.maxAutoResumes;
    resumeRequest = report;
  }

  /** Abort the turn, log it, and queue a structured report for the host to deliver. */
  function abortTurn(
    entry: Entry,
    result: { basis: GuardBasis; observedMs: number; warnSec: number; criticalSec: number },
    settings: HangGuardSettings,
    at: number,
  ): void {
    const report = buildReport(entry, result, settings, "abort");
    nextActionAt = at + Math.max(0, settings.actionCooldownSec) * 1000;
    queueResume(report, settings);
    actionsTaken.push(report);
    try {
      deps.actions?.abortTurn();
    } catch {
      // Aborting is best effort: a stale context must not break bookkeeping.
    }
    notify(
      `Watchdog: ${entry.toolName} ${observationText(result.basis, result.observedMs)} — ` +
        "turn aborted so the hung command stops.",
      "error",
    );
  }

  /**
   * Escalation ladder. Warnings are level 1; level 2 is where the guard acts.
   *
   * - `observe`  never acts
   * - `guard`    aborts the turn (`ctx.abort()`), then reports back
   * - `yolo`     soft-kills the tracked shell children first (the turn survives and
   *              the model sees a normal non-zero exit), falling back to an abort
   *              when the soft kill is unavailable or the grace period elapses
   */
  function escalate(
    entry: Entry,
    result: { basis: GuardBasis; observedMs: number; warnSec: number; criticalSec: number },
    settings: HangGuardSettings,
    at: number,
  ): void {
    if (settings.mode === "observe" || !deps.actions) return;

    if (entry.softKilledAt !== undefined) {
      if (entry.abortRequested) return;
      if (at - entry.softKilledAt < Math.max(0, settings.softKillGraceSec) * 1000) return;
      entry.abortRequested = true;
      abortTurn(entry, result, settings, at);
      return;
    }
    if (entry.abortRequested) return;
    if (at < nextActionAt) return;

    if (settings.mode === "yolo") {
      const outcome = trySoftKill();
      if (outcome.ok) {
        entry.softKilledAt = at;
        entry.softKillDetail = outcome.detail;
        nextActionAt = at + Math.max(0, settings.softKillGraceSec) * 1000;
        actionsTaken.push(buildReport(entry, result, settings, "soft-kill"));
        notify(
          `Watchdog: soft-killed the hung ${entry.toolName} process; the turn continues.`,
          "warning",
        );
        return;
      }
      // The host may still be resolving its killer; give it another tick.
      if (outcome.pending) return;
      // Soft kill unavailable: fall through to aborting the turn, and tell the
      // model why the gentler option was not used.
      entry.softKillDetail = `soft kill unavailable: ${outcome.detail}`;
    }

    entry.abortRequested = true;
    abortTurn(entry, result, settings, at);
  }

  function isStreaming(toolName: string, settings: HangGuardSettings): boolean {
    return settings.streamingTools.includes(toolName);
  }

  /**
   * Decide what to measure and against which thresholds.
   *
   * `idle` is the trustworthy signal (the process produced nothing for N
   * seconds). It is only available for streaming tools whose command is not
   * already bounded by its own `timeout`.
   */
  function measure(
    entry: Entry,
    settings: HangGuardSettings,
    at: number,
  ): {
    basis: GuardBasis;
    observedMs: number;
    warnSec: number;
    criticalSec: number;
    level: GuardLevel;
  } {
    const idleCapable = isStreaming(entry.toolName, settings) && !entry.selfTimed;
    const basis: GuardBasis = idleCapable ? "idle" : "runtime";
    const observedMs =
      basis === "idle"
        ? at - Math.max(entry.startedAt, entry.lastActivityAt)
        : at - entry.startedAt;

    let warnSec: number;
    let criticalSec: number;
    if (basis === "idle" && entry.idleWhitelisted) {
      warnSec = settings.idleWhitelistWarnSec;
      criticalSec = settings.idleWhitelistCriticalSec;
    } else if (basis === "idle") {
      warnSec = settings.idleWarnSec;
      criticalSec = settings.idleCriticalSec;
    } else {
      warnSec = settings.runtimeWarnSec;
      criticalSec = settings.runtimeCriticalSec;
    }

    let level: GuardLevel = 0;
    if (observedMs >= criticalSec * 1000) level = 2;
    else if (observedMs >= warnSec * 1000) level = 1;

    return { basis, observedMs, warnSec, criticalSec, level };
  }

  function clearAll(): void {
    entries.clear();
    uiPromptDepth = 0;
    pausedAt = 0;
  }

  const engine: HangGuardEngine = {
    onToolStart(input: ToolStartInput): void {
      const settings = deps.settings();
      const command = commandFromArgs(input.args);
      const classification = classifyCommand(command, settings.classify);

      if (!classification.guardable) {
        skippedInteractive += 1;
        return;
      }
      if (!settings.enabled) {
        return;
      }

      const at = now();
      entries.set(input.toolCallId, {
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        command,
        kind: classification.kind,
        reason: classification.reason,
        idleWhitelisted: classification.idleWhitelisted,
        selfTimed: classification.selfTimed,
        startedAt: at,
        lastActivityAt: at,
        basis:
          isStreaming(input.toolName, settings) && !classification.selfTimed ? "idle" : "runtime",
        observedMs: 0,
        maxObservedMs: 0,
        level: 0,
        notifications: 0,
      });
    },

    onToolUpdate(input: ToolUpdateInput): void {
      // While a blocking UI prompt is open the guard is frozen, so a
      // heartbeat would not be meaningful either.
      if (uiPromptDepth > 0) return;
      const entry = entries.get(input.toolCallId);
      if (!entry) return;
      entry.lastActivityAt = now();
    },

    onToolEnd(input: ToolEndInput): void {
      const entry = entries.get(input.toolCallId);
      if (!entry) return;
      entries.delete(input.toolCallId);
    },

    onUiPromptStart(): void {
      if (uiPromptDepth === 0) pausedAt = now();
      uiPromptDepth += 1;
    },

    onUiPromptEnd(): void {
      if (uiPromptDepth === 0) return;
      uiPromptDepth -= 1;
      if (uiPromptDepth > 0) return;
      const delta = now() - pausedAt;
      pausedAt = 0;
      if (delta <= 0) return;
      for (const entry of entries.values()) {
        entry.startedAt += delta;
        entry.lastActivityAt += delta;
      }
    },

    onAgentSettled(): void {
      clearAll();
    },

    onShutdown(): void {
      clearAll();
      resumeRequest = null;
    },

    tick(): void {
      const settings = deps.settings();
      if (!settings.enabled || uiPromptDepth > 0) return;
      const at = now();

      for (const entry of entries.values()) {
        const result = measure(entry, settings, at);
        entry.basis = result.basis;
        entry.observedMs = result.observedMs;
        if (result.observedMs > entry.maxObservedMs) entry.maxObservedMs = result.observedMs;

        if (result.level > entry.level) {
          entry.level = result.level;
          if (entry.notifications < settings.maxNotificationsPerCall) {
            entry.notifications += 1;
            const critical = result.level === 2;
            // Offer `guard` once, and only where switching to it would actually
            // change the outcome for this host.
            const hint = critical && !guardHintShown && settings.mode === "observe" && canAct;
            const observed = observationText(result.basis, result.observedMs);
            const commandLine = previewCommand(entry.command, 80);
            if (critical) {
              notify(
                [
                  `Watchdog: ${entry.toolName} ${observed} (over the ${result.criticalSec}s threshold, ${kindLabel(entry.kind)}).`,
                  `command: ${commandLine}`,
                  hint
                    ? "Likely stuck. Set the guard mode to guard to abort hung commands automatically."
                    : "Likely stuck. The command runs with no output for too long.",
                ].join("\n"),
                "error",
              );
              if (hint) guardHintShown = true;
            } else {
              notify(
                [
                  `Watchdog: ${entry.toolName} ${observed} (${kindLabel(entry.kind)}).`,
                  `command: ${commandLine}`,
                  "The command may be stuck. It is still running.",
                ].join("\n"),
                "warning",
              );
            }
          }
        }

        // Escalation runs on every critical tick, not only on the transition:
        // `yolo` needs to keep checking its soft-kill grace period.
        if (result.level === 2) escalate(entry, result, settings, at);
      }
    },

    list(): GuardEntryStatus[] {
      const settings = deps.settings();
      const at = now();
      const out: GuardEntryStatus[] = [];
      for (const entry of entries.values()) {
        const result = measure(entry, settings, at);
        out.push({
          toolCallId: entry.toolCallId,
          toolName: entry.toolName,
          command: entry.command,
          kind: entry.kind,
          reason: entry.reason,
          basis: result.basis,
          observedMs: result.observedMs,
          maxObservedMs: entry.maxObservedMs,
          startedAt: entry.startedAt,
          lastActivityAt: entry.lastActivityAt,
          level: result.level,
          notifications: entry.notifications,
          idleWhitelisted: entry.idleWhitelisted,
          selfTimed: entry.selfTimed,
        });
      }
      return out;
    },

    stats(): GuardStats {
      return {
        running: entries.size,
        skippedInteractive,
        notifications: notificationCount,
        paused: uiPromptDepth > 0,
        actions: actionsTaken.length,
        resumes: resumeCount,
        pendingResume: resumeRequest !== null,
      };
    },

    actionLog(): GuardActionReport[] {
      return [...actionsTaken];
    },

    consumeResume(): GuardActionReport | null {
      const report = resumeRequest;
      resumeRequest = null;
      return report;
    },

    hasRunning(): boolean {
      return entries.size > 0;
    },
  };

  return engine;
}
