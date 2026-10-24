/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+H)
 * - Provides a `pmux_done` tool for autonomous agents to self-terminate,
 *   optionally with a `handoff` text that writes the `handoff` `.exit` sidecar
 *   instead of `done` (context-alert handoff, D4)
 * - Nudges any agent that forgets to call pmux_done after generating
 * - Appends one `handoffs.jsonl` row per context alert and per handoff exit,
 *   fire-and-forget, so the alert and handoff events can be counted later
 * - Respects the child-env denied-tool list for its own tools: a denied tool is not registered,
 *   `caller_ping` included; `pmux_done` is never denied.
 *
 * Auto-exit: with PI_PMUX_AUTO_EXIT=1, a normal `agent_end` (no user takeover,
 * not aborted) writes the `done` `.exit` sidecar and shuts the session down.
 * Otherwise the only success-path exits are the explicit `pmux_done` /
 * `caller_ping` tools, and an agent that finishes without calling either is
 * nudged. Provider-error turns write the error `.exit` sidecar so the parent
 * learns about failures promptly. A user-aborted turn writes the `cancelled`
 * sidecar and leaves the session open, so a cancel is not mistaken for a
 * failure (report-user-cancel D1).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { writeFileSync } from "node:fs";
import { createSubagentActivityRecorder } from "./activity.ts";
import { decodeChildEnv } from "./child-env.ts";
import {
  alertText,
  appendHandoffLog,
  DEFAULT_CONTEXT_ALERT_THRESHOLD_TOKENS,
  formatThresholdValue,
  handoffLogPath,
  handoffNudgeText,
  shouldAlert,
  type ContextAlertConfig,
  type ContextUsageLike,
  type HandoffLogRow,
} from "./context-alert.ts";
import { loadStatusConfig } from "./status.ts";
import { writeChildStatus, type ChildStatus } from "./status-file.ts";
import {
  exitSidecarPath,
  readExitSidecar,
  removeExitSidecar,
  writeExitSidecar,
} from "./exit-sidecar.ts";
import { COMPLETION_NUDGE_TEXT } from "./nudge.ts";

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

const ASSISTANT_ROLE = "assistant";
const NORMAL_STOP_REASON = "stop";

/** Return true only when the latest assistant message ended by the model stopping normally. */
export function shouldScheduleAgentEndNudge(
  messages: readonly { role?: string; stopReason?: string }[] | undefined,
): boolean {
  if (!messages) return false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === ASSISTANT_ROLE) {
      return message.stopReason === NORMAL_STOP_REASON;
    }
  }

  return false;
}

/** Return true only when the latest assistant message ended because the user aborted it. */
export function didUserAbortTurn(
  messages: readonly { role?: string; stopReason?: string }[] | undefined,
): boolean {
  if (!messages) return false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === ASSISTANT_ROLE) return message.stopReason === "aborted";
  }

  return false;
}

export function shouldAutoExitOnAgentEnd(messages: any[] | undefined): boolean {
  // If the latest agent turn completed normally, close the session. Escape/abort
  // still leaves it open for inspection or another prompt. User takeover is the
  // caller's concern.
  //
  // stopReason: "error" (e.g. exhausted retries on a provider overload) also
  // returns true — we want to shut down so the parent is woken up — but we
  // pair this with findLatestAssistantError() so the parent learns it was an
  // error, not a clean completion.
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        return msg.stopReason !== "aborted";
      }
    }
  }

  return true;
}

export interface SubagentErrorInfo {
  errorMessage: string;
  stopReason: "error";
}

/**
 * If the last assistant message in the turn ended with `stopReason: "error"`
 * (typically auto-retry exhausted on an overload / rate limit / server error),
 * return its error info so the parent orchestrator can surface a clear
 * failure instead of silently treating the run as completed.
 *
 * Returns `null` when the latest assistant turn completed normally or was
 * aborted by the user (handled separately by shouldAutoExitOnAgentEnd).
 */
export function findLatestAssistantError(messages: any[] | undefined): SubagentErrorInfo | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason !== "error") return null;
    const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return {
      errorMessage:
        raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).",
      stopReason: "error",
    };
  }
  return null;
}

const ALERT_OFF_CONFIG: ContextAlertConfig = {
  enabled: false,
  threshold: { kind: "tokens", value: DEFAULT_CONTEXT_ALERT_THRESHOLD_TOKENS },
};

/**
 * Load the `contextAlert` block once at module load (D2). A bad config block
 * turns the alert off but must not stop the child from loading: the control
 * tools, the status reporter and the sidecar writes still register, and the
 * parent (or the user's own pi session) already reports the config error.
 */
export function loadContextAlertConfig(configPath?: string): ContextAlertConfig {
  try {
    return loadStatusConfig(configPath).contextAlert;
  } catch {
    return ALERT_OFF_CONFIG;
  }
}

const contextAlertConfig = loadContextAlertConfig();

/**
 * Pending handoff log writes, so tests can wait for the fire-and-forget rows
 * (D6) without the production callers awaiting them.
 */
export const __handoffLogWrites__: Promise<void>[] = [];

/**
 * Fire-and-forget handoff log row (D6): never awaited by the caller, and it
 * can never throw here — the append itself and the whole async chain are
 * guarded, so a failed log write cannot prevent the alert, the sidecar write,
 * or shutdown.
 */
function writeHandoffLogRow(row: HandoffLogRow): void {
  const write = (async () => {
    appendHandoffLog(row, handoffLogPath());
  })();
  __handoffLogWrites__.push(write);
  void write.catch(() => {});
}

export default function (pi: ExtensionAPI) {
  // Decode the child env once: a pi process does not change its own
  // PI_PMUX_* values. Every child-env reader below uses this value; the
  // nudge settings stay direct process settings.
  const childEnv = decodeChildEnv(process.env);

  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = childEnv.name ?? "";
  const subagentAgent = childEnv.agent ?? "";
  // Parsed for the restored auto-exit path below (2026-10-02-restore-auto-exit):
  // an auto-exit agent whose turn ends normally exits itself.
  const autoExit = childEnv.autoExit;
  const recorder = createSubagentActivityRecorder({
    runningChildId: childEnv.id,
    activityFile: childEnv.activityFile,
  });

  // ── Agent completion nudge configuration ──
  /** Delay (ms) before sending a nudge after agent_end. Configurable via env var. */
  const NUDGE_DELAY_MS = Math.max(
    1000,
    parseInt(process.env.PI_PMUX_NUDGE_DELAY_MS ?? "5000", 10) || 5000,
  );
  /** Set to "1" to disable the nudge entirely. */
  const NUDGE_DISABLED = process.env.PI_PMUX_NUDGE_DISABLE === "1";
  /**
   * The reminder. One text, shared with the parent-side idle watchdog
   * (`nudge.ts`), so the child never reads two different reminders.
   */
  const NUDGE_TEXT = COMPLETION_NUDGE_TEXT;

  let doneCalled = false;
  let userInputAfterAgentEnd = false;
  let alertFired = false;
  let nudgeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Cancel and forget the pending completion reminder, if any. */
  function clearNudgeTimer(): void {
    if (nudgeTimer !== null) {
      clearTimeout(nudgeTimer);
      nudgeTimer = null;
    }
  }

  /**
   * After a subagent stops normally, schedule a nudge reminding it to call
   * pmux_done if it hasn't already. Error and aborted runs are excluded.
   *
   * Each call replaces any pending nudge, so repeated agent_end events
   * automatically reset the timer. The nudge only fires if no new agent
   * activity or user input arrives within NUDGE_DELAY_MS.
   */
  function scheduleAgentEndNudge(pi: ExtensionAPI): void {
    clearNudgeTimer();
    if (NUDGE_DISABLED || doneCalled) return;

    nudgeTimer = setTimeout(() => {
      nudgeTimer = null;
      if (doneCalled || userInputAfterAgentEnd) return;

      // After a context alert the generic text is wrong: the last message was
      // NOT already delivered as the report, and the child must finish with a
      // handoff (D3).
      pi.sendUserMessage(alertFired ? handoffNudgeText() : NUDGE_TEXT, { deliverAs: "followUp" });
    }, NUDGE_DELAY_MS);
  }

  /**
   * D3: after each turn ends, fire the context alert at most once per
   * process when the context usage is at or above the threshold. The alert is
   * a takeover: `userTookOver` is set BEFORE the steer is sent, so even a
   * steer that arrives late (after the agent loop's steer read) cannot leave
   * an auto-exit child exiting with a plain `done` after the alert.
   */
  function checkContextAlert(event: unknown, ctx: unknown): void {
    if (alertFired || doneCalled || !contextAlertConfig.enabled) return;
    if (!childEnv.sessionFile) return;

    // Error and aborted turns end the run without the steer read; a steer
    // sent for them would only land on the next prompt.
    const message = (event as { message?: { role?: string; stopReason?: string } })?.message;
    if (
      message?.role === ASSISTANT_ROLE &&
      (message.stopReason === "error" || message.stopReason === "aborted")
    ) {
      return;
    }

    const usage = (
      ctx as { getContextUsage?: () => ContextUsageLike | undefined } | undefined
    )?.getContextUsage?.();
    if (!shouldAlert(usage, contextAlertConfig.threshold)) return;
    if (typeof usage.tokens !== "number") return;

    alertFired = true;
    userTookOver = true;
    const text = alertText(usage.tokens, contextAlertConfig.threshold);
    void pi.sendUserMessage(text, { deliverAs: "steer" });
    writeHandoffLogRow({
      at: new Date().toISOString(),
      event: "alert",
      child: childEnv.name ?? "",
      session: childEnv.sessionFile ?? "",
      tokens: usage.tokens,
      threshold: formatThresholdValue(contextAlertConfig.threshold),
    });
  }

  function renderWidget(ctx: Pick<ExtensionContext, "ui">, _theme: any) {
    ctx.ui.setWidget(
      "pmux-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+H to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+H to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  let userTookOver = false;
  let agentStarted = false;
  /** Set from `agent_settled.aborted`: the run-level abort flag the
   * message-level `didUserAbortTurn` check can miss. Read again at
   * `session_shutdown` to restore a consumed cancel notice. */
  let lastRunAborted = false;

  /** Best-effort status write; a failed write never blocks a turn or shutdown. */
  function writeStatus(status: ChildStatus, message?: string): void {
    if (childEnv.sessionFile) writeChildStatus(childEnv.sessionFile, status, message);
  }

  // Show widget + status bar on session start
  pi.on("session_start", (_event, ctx) => {
    recorder.sessionStart();
    doneCalled = false;
    userInputAfterAgentEnd = false;
    userTookOver = false;
    lastRunAborted = false;
    alertFired = false;
    clearNudgeTimer();
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = childEnv.denyTools;

    renderWidget(ctx, null);
  });

  pi.on("input", () => {
    recorder.input();
    // User typed something — they are in control, cancel any pending nudge.
    userInputAfterAgentEnd = true;
    clearNudgeTimer();
    // Ignore the initial task message that starts an autonomous subagent.
    // Only inputs after the first agent run has started count as user takeover,
    // which keeps an auto-exit session open instead of exiting it.
    if (shouldMarkUserTookOver(agentStarted)) userTookOver = true;
  });

  pi.on("before_agent_start", () => {
    recorder.beforeAgentStart();
    // Agent is about to generate — clear any pending nudge; the AI is active.
    clearNudgeTimer();
  });

  pi.on("agent_start", () => {
    agentStarted = true;
    recorder.agentStart();
    // A `cancelled` sidecar describes the turn that just ended. A new turn
    // means the user resumed, so drop it; a stale cancel must never satisfy a
    // later wait (D2). Every other payload is a real completion and stays.
    const sessionFile = childEnv.sessionFile;
    if (sessionFile && readExitSidecar(sessionFile)?.type === "cancelled") {
      removeExitSidecar(sessionFile);
    }
    // Agent has started a new generation cycle — clear any pending nudge.
    userInputAfterAgentEnd = false;
    clearNudgeTimer();
  });

  pi.on("agent_end", (event, ctx) => {
    const messages = (event as any).messages as any[] | undefined;

    // Error turns still exit so the parent learns about the failure promptly
    // (auto-retry exhausted, provider overload, etc.) — deviation from
    // maplezzk's port, which leans on the stalled watchdog for errors.
    // Without this the parent would only see exit code 0 and a stale
    // assistant message, mistaking the crash for a successful completion.
    const errorInfo = findLatestAssistantError(messages);
    const sessionFile = childEnv.sessionFile;
    if (errorInfo && sessionFile) {
      writeStatus("blocked", errorInfo.errorMessage);
      try {
        writeFileSync(
          exitSidecarPath(sessionFile),
          JSON.stringify({
            type: "error",
            errorMessage: errorInfo.errorMessage,
            stopReason: errorInfo.stopReason,
          }),
        );
      } catch {
        // Best effort — even without the sidecar, watcher's session-file
        // fallback can still recover the errorMessage.
      }
      recorder.agentEndDone();
      ctx.shutdown();
      return;
    }

    recorder.agentEndWaiting();
    // Only input arriving after this point counts as a takeover; input that
    // landed mid-run (e.g. pmux_message) must not silence the nudge.
    userInputAfterAgentEnd = false;

    // A user-aborted turn is a notification, not an exit: the session stays
    // open for inspection or another prompt, and the sidecar tells the parent
    // the user cancelled rather than that the child failed (D1). The flow
    // still falls through to the nudge check, which clears any pending nudge
    // for an aborted turn instead of scheduling one.
    if (sessionFile && didUserAbortTurn(messages)) {
      writeExitSidecar(sessionFile, { type: "cancelled" });
    }

    // Restored auto-exit: an auto-exit agent whose turn ended normally exits
    // itself instead of waiting on the nudge. A taken-over session stays open
    // (falls through to the nudge path); aborted stops stay open; the error
    // branch above already handled provider failures.
    if (autoExit && !userTookOver && shouldAutoExitOnAgentEnd(messages)) {
      recorder.agentEndDone();
      if (sessionFile) {
        writeStatus("done");
        try {
          writeFileSync(exitSidecarPath(sessionFile), JSON.stringify({ type: "done" }));
        } catch {
          // Best effort — without the sidecar the watcher falls back to the
          // session file / screen sentinel.
        }
      }
      ctx.shutdown();
      return;
    }

    // A normal stop leaves the session open and nudges the agent to call
    // pmux_done if it forgot.
    if (shouldScheduleAgentEndNudge(messages)) {
      scheduleAgentEndNudge(pi);
    } else {
      clearNudgeTimer();
    }
  });

  pi.on("agent_settled", (event) => {
    // Backstop for the agent_end gate: an abort that lands between tool
    // calls, or before the next model call starts, leaves no assistant
    // message marked `aborted`, so `didUserAbortTurn` sees nothing and the
    // parent hears "crashed" when the user then quits. `agent_settled`
    // carries the run-level abort flag instead. Write only when the settle
    // left no sidecar at all — never clobber a terminal payload from the
    // same settle, and the `cancelled` agent_end may have written needs no
    // second copy.
    lastRunAborted = (event as { aborted?: boolean } | undefined)?.aborted === true;
    const sessionFile = childEnv.sessionFile;
    if (!sessionFile || !lastRunAborted) return;
    if (readExitSidecar(sessionFile) === null) {
      writeExitSidecar(sessionFile, { type: "cancelled" });
    }
  });

  pi.on("turn_start", (event) => {
    writeStatus("working");
    recorder.turnStart((event as any).turnIndex);
  });

  pi.on("turn_end", (event, ctx) => {
    writeStatus("idle");
    recorder.turnEnd((event as any).turnIndex);
    checkContextAlert(event, ctx);
  });

  pi.on("before_provider_request", () => {
    recorder.beforeProviderRequest();
  });

  pi.on("after_provider_response", () => {
    recorder.afterProviderResponse();
  });

  pi.on("message_update", (event) => {
    recorder.messageUpdate((event as any).assistantMessageEvent?.type);
  });

  pi.on("tool_execution_start", (event) => {
    recorder.toolExecutionStart((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_call", (event) => {
    recorder.toolCall((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_update", (event) => {
    recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_result", (event) => {
    recorder.toolResult((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_end", (event) => {
    recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("session_shutdown", (event) => {
    clearNudgeTimer();
    recorder.sessionShutdown((event as any).reason);
    // A quit that races the parent's poll: the settle wrote `cancelled`,
    // the poll may already have consumed it, and the run wrapper would
    // otherwise read no sidecar and report the exit as a crash. Rewrite the
    // notification when the last run was aborted and nothing terminal was
    // left behind.
    const sessionFile = childEnv.sessionFile;
    if (sessionFile && lastRunAborted && readExitSidecar(sessionFile) === null) {
      writeExitSidecar(sessionFile, { type: "cancelled" });
    }
  });

  // Toggle expand/collapse with Ctrl+H (ctrl+j is the built-in new-line binding)
  pi.registerShortcut("ctrl+h", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx, null);
    },
  });

  pi.registerTool({
    name: "caller_ping",
    label: "Caller Ping",
    description:
      "Ask the parent for help, then END your session. The parent gets your message and can resume you with a reply. " +
      "Use it when you are blocked or need a decision. To keep working, use pmux_message.",
    parameters: Type.Object({
      message: Type.String({ description: "What you need help with." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = childEnv.sessionFile;
      if (!sessionFile) {
        throw new Error(
          "caller_ping is only available in subagent contexts. " +
            "PI_PMUX_SESSION environment variable is not set.",
        );
      }

      recorder.callerPing();
      doneCalled = true;
      clearNudgeTimer();
      const exitData = {
        type: "ping" as const,
        name: childEnv.name ?? "subagent",
        message: params.message,
      };
      writeStatus("blocked", params.message);
      writeFileSync(exitSidecarPath(sessionFile), JSON.stringify(exitData));

      ctx.shutdown();
      return {
        content: [
          { type: "text", text: "Ping sent. Session will exit and parent will be notified." },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "pmux_done",
    label: "Subagent Done",
    description:
      "Call this when your task is complete. It ENDS your session. " +
      "Your last assistant message before this call is the summary that goes to the caller. " +
      "To send a message and keep working, use pmux_message. " +
      "Pass `handoff` only after a context alert: it ends the session with a handoff " +
      "sidecar carrying that text for a fresh agent, and the task is reported as not complete.",
    parameters: Type.Object({
      handoff: Type.Optional(
        Type.String({
          description:
            "Handoff text for a fresh agent: the goal, what is done, what is left, and the current state. Use only after a context alert.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // A whitespace-only handoff must fail before any state changes, so the
      // session stays open and the model can retry with real text (D4).
      if (
        params.handoff !== undefined &&
        (typeof params.handoff !== "string" || params.handoff.trim() === "")
      ) {
        throw new Error(
          "pmux_done handoff must be a non-empty string: the handoff text a fresh agent needs to continue the task.",
        );
      }
      const sessionFile = childEnv.sessionFile;
      recorder.subagentDone();
      doneCalled = true;
      clearNudgeTimer();
      // The orchestrator learns that the task is not complete from the sidecar.
      if (sessionFile) {
        writeStatus("done");
        writeFileSync(
          exitSidecarPath(sessionFile),
          JSON.stringify(
            typeof params.handoff === "string"
              ? { type: "handoff", message: params.handoff }
              : { type: "done" },
          ),
        );
      }
      // Only a handoff exit logs the `handoff` row; a plain done does not.
      // The token count comes from the usage at the exit itself (D6).
      if (typeof params.handoff === "string") {
        const usage = (
          ctx as { getContextUsage?: () => ContextUsageLike | undefined } | undefined
        )?.getContextUsage?.();
        writeHandoffLogRow({
          at: new Date().toISOString(),
          event: "handoff",
          child: childEnv.name ?? "",
          session: sessionFile ?? "",
          tokens: typeof usage?.tokens === "number" ? usage.tokens : null,
        });
      }
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Shutting down subagent session." }],
        details: {},
      };
    },
  });
}
