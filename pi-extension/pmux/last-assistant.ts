/**
 * The last assistant message of an agent run.
 *
 * `sidebar.ts` needs the text for the stop payload and `turn-notify.ts` needs
 * the stop reason to classify the turn. Both walk the run's messages
 * backwards, so the walk lives here, once, and both read from it.
 */

/** The last assistant message of a run: its text, stop reason and error. */
export interface LastAssistant {
  text: string;
  stopReason?: string;
  errorMessage?: string;
}

/**
 * The last assistant message in a run's messages, or `null` when the run has
 * none. Pure: callers keep the result between the events that need it.
 */
export function lastAssistantMessage(messages: readonly unknown[]): LastAssistant | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as
      | { role?: unknown; content?: unknown; stopReason?: unknown; errorMessage?: unknown }
      | null
      | undefined;
    if (!message || message.role !== "assistant") continue;
    const parts = Array.isArray(message.content)
      ? (message.content as Array<{ type?: unknown; text?: unknown }>)
      : [];
    const text = parts
      .filter((part) => part && part.type === "text")
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("");
    return {
      text,
      stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
      errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
    };
  }
  return null;
}

/** The error text of a failed run: pi's own message, else the stop reason. */
export function stopFailureError(last: LastAssistant | null): string {
  return last?.errorMessage || last?.stopReason || "error";
}
