/**
 * The completion reminder, in one place.
 *
 * Two paths deliver it: the child extension nudges itself after a normal
 * turn (`pmux-done.ts`), and the parent-side idle watchdog types the same
 * reminder into a stalled child's pane (`idle-watchdog.ts`). One text, so the
 * two cannot drift apart and the child never reads two different reminders.
 */

/**
 * The reminder a child receives when its turn ended but the session stayed
 * open. It names the two ways out — `pmux_done` when the task is done,
 * `caller_ping` when it is blocked — and says the report was already
 * delivered, so the child does not repeat it.
 */
export const COMPLETION_NUDGE_TEXT = [
  "[Automated reminder] Your last turn ended but this session is still open.",
  "If your task is complete, call the pmux_done tool now, with no other text — your last message was already delivered as your report, do not repeat or summarise it.",
  "If you are blocked, call caller_ping with your question. Otherwise, continue working.",
].join("\n");
