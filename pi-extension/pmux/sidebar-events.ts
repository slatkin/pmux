/**
 * The mapping from pi's events to the sidebar's protocol events.
 *
 * `index.ts` only wires what this module registers. The module holds the
 * run-scoped captures (the last assistant message, the settled outcome, the
 * running tool arguments) in the factory's closure: per registration, no
 * timers, no global state, so `/reload` safety is unchanged.
 *
 * The publisher and the worktree reader are injected, so a test can drive
 * the handlers without pi, without tmux and without a sidebar.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildActivityLog,
  buildNotification,
  buildSessionEnd,
  buildSessionStart,
  buildStop,
  buildStopFailure,
  buildUserPromptSubmit,
  type SidebarPublisher,
  type SidebarSession,
  type SidebarWorktree,
} from "./sidebar.ts";
import { lastAssistantMessage, stopFailureError, type LastAssistant } from "./last-assistant.ts";

export interface SidebarEventsDeps {
  /** The publisher: guards synchronously, spawns deferred, end sync. */
  publisher: SidebarPublisher;
  /**
   * The pane's sidebar worktree, or `undefined` when the pane has none.
   * Called only when the publisher can actually publish, so a session with
   * publishing off never pays the tmux round trip.
   */
  readWorktree(): SidebarWorktree | undefined;
}

export function createSidebarEvents(deps: SidebarEventsDeps): { register(pi: ExtensionAPI): void } {
  // Run-scoped captures: `agent_settled` carries neither the messages nor
  // the outcome, so the last assistant message is kept from `agent_end` and
  // the outcome from `agent_before_settle` until the run settles. Tool args
  // are kept per call id, because `tool_execution_end` does not repeat them.
  let lastAssistant: LastAssistant | null = null;
  let settledOutcome: "completed" | "aborted" | "error" | undefined;
  const runningToolArgs = new Map<string, unknown>();

  const sessionOf = (ctx: {
    cwd: string;
    sessionManager: { getSessionId(): string };
  }): SidebarSession => ({ cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() });

  return {
    register(pi: ExtensionAPI): void {
      pi.on("session_start", (event, ctx) => {
        // The worktree read is a blocking tmux call; pay it only when the
        // publisher would actually use the payload.
        const worktree = deps.publisher.canPublish() ? deps.readWorktree() : undefined;
        deps.publisher.publish(
          "session-start",
          buildSessionStart({
            source: event?.reason ?? "",
            session: sessionOf(ctx),
            worktree,
          }),
        );
      });

      pi.on("input", (event, ctx) => {
        deps.publisher.publish(
          "user-prompt-submit",
          buildUserPromptSubmit({ prompt: event.text, session: sessionOf(ctx) }),
        );
      });

      pi.on("tool_execution_start", (event) => {
        runningToolArgs.set(event.toolCallId, event.args);
        deps.publisher.publish(
          "activity-log",
          buildActivityLog({ toolName: event.toolName, toolInput: event.args }),
        );
      });

      pi.on("tool_execution_end", (event) => {
        const toolInput = runningToolArgs.get(event.toolCallId) ?? {};
        runningToolArgs.delete(event.toolCallId);
        deps.publisher.publish(
          "activity-log",
          buildActivityLog({
            toolName: event.toolName,
            toolInput,
            toolResponse: event.result,
          }),
        );
      });

      pi.on("agent_end", (event) => {
        lastAssistant = lastAssistantMessage(event.messages);
      });

      pi.on("agent_before_settle", (event) => {
        settledOutcome = event.outcome;
      });

      pi.on("agent_settled", (_event, ctx) => {
        const outcome = settledOutcome ?? "completed";
        if (outcome === "error") {
          deps.publisher.publish(
            "stop-failure",
            buildStopFailure({
              error: stopFailureError(lastAssistant),
              session: sessionOf(ctx),
            }),
          );
        } else {
          deps.publisher.publish(
            "stop",
            buildStop({
              lastAssistantMessage: lastAssistant?.text ?? "",
              session: sessionOf(ctx),
            }),
          );
        }
        lastAssistant = null;
        settledOutcome = undefined;
      });

      // A blocking extension prompt (a permission dialog, for example) is a
      // wait for a human; the end of the wait returns the pane to running
      // without touching the prompt text it already shows.
      pi.on("ui_prompt_start", (event) => {
        deps.publisher.publish("notification", buildNotification({ waitReason: event.kind }));
      });

      pi.on("ui_prompt_end", (_event, ctx) => {
        deps.publisher.publish(
          "user-prompt-submit",
          buildUserPromptSubmit({ prompt: "", session: sessionOf(ctx) }),
        );
      });

      // The session is going away; publish synchronously so the end is not
      // lost to a deferred task the exiting process never runs.
      pi.on("session_shutdown", (event) => {
        deps.publisher.publishSync(
          "session-end",
          buildSessionEnd({ endReason: event?.reason ?? "" }),
        );
      });
    },
  };
}
