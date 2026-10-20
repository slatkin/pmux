/**
 * Pi → tmux turn-end notifications.
 *
 * A parent pi pane that you are not looking at gets one tmux status-line
 * notification when a turn ends, so you do not have to visit every pane to
 * learn that it waits for input. A failed turn notifies as an error instead.
 * Subagent children stay quiet: their completion already reaches the parent
 * through the exit sidecar and `pmux_done`.
 *
 * The notification chain runs after the event handler returns (the handler
 * never awaits it) and swallows every failure, so a slow or broken tmux call
 * can neither delay the next turn nor raise.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { isTmuxAvailable, isPaneFocusedAsync, pushNotificationAsync } from "./tmux.ts";
import { isSubagentChild } from "./child-env.ts";

/** What the ended turn should produce. `none` means no notification. */
export type TurnOutcome = "ended" | "failed" | "none";

/**
 * Classify the ended turn from the last assistant message. `aborted` is the
 * user's own action, so it stays silent. `error` and `timeout` are provider
 * failures. Everything else (including `stop`, `toolUse`, `length`) ended
 * normally.
 */
export function turnOutcome(messages: readonly unknown[]): TurnOutcome {
  let stopReason: unknown;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: unknown; stopReason?: unknown } | null | undefined;
    if (message && message.role === "assistant") {
      stopReason = message.stopReason;
      break;
    }
  }
  if (stopReason === "aborted") return "none";
  if (stopReason === "error" || stopReason === "timeout") return "failed";
  return "ended";
}

/** Notification label: the session name when it has one, else the cwd basename. */
export function turnLabel(sessionName: string | undefined, cwd: string): string {
  const name = sessionName?.trim();
  return name ? name : basename(cwd) || cwd;
}

/** The two tmux calls the notifier makes. Injectable so tests need no tmux. */
export interface TurnNotifierDeps {
  isPaneFocused(pane: string): Promise<boolean>;
  pushNotification(text: string, level: "success" | "error"): Promise<void>;
}

const DEFAULT_DEPS: TurnNotifierDeps = {
  isPaneFocused: isPaneFocusedAsync,
  pushNotification: async (text) => pushNotificationAsync(text),
};

export interface TurnNotifier {
  register(pi: ExtensionAPI): void;
}

export function createTurnNotifier(
  env: NodeJS.ProcessEnv = process.env,
  enabled = true,
  deps: TurnNotifierDeps = DEFAULT_DEPS,
): TurnNotifier {
  return {
    register(pi: ExtensionAPI): void {
      pi.on("agent_end", (event, ctx) => {
        if (isSubagentChild(env)) return;
        if (!enabled) return;
        if (!isTmuxAvailable(env)) return;
        const pane = env.TMUX_PANE as string;
        const outcome = turnOutcome(event.messages);
        if (outcome === "none") return;
        const label = turnLabel(ctx.sessionManager.getSessionName(), ctx.cwd);
        const text = outcome === "failed" ? `pi turn failed: ${label}` : `pi turn ended: ${label}`;
        const level = outcome === "failed" ? "error" : "success";
        // Fire and forget: the focus check must never delay the next turn.
        void deps
          .isPaneFocused(pane)
          .then((focused) => (focused ? undefined : deps.pushNotification(text, level)))
          .catch(() => {});
      });
    },
  };
}
