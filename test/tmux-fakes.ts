/**
 * Shared in-process tmux fake for tests that reach the tmux backend.
 *
 * The fake answers the lookups `createSurface` performs: a split or a new
 * window yields a pane id, `list-panes` answers the orchestrator listing, and
 * `display-message` answers the session and window lookups the tab placement
 * needs. Every other command returns empty output.
 */
import { __setTmuxExecForTests__ } from "../pi-extension/pmux/tmux.ts";

export interface TmuxPaneFake {
  /** Every tmux argv, joined with spaces, in call order. */
  lines: string[];
}

/**
 * Install the standard fake and return the recorded calls. Reset `lines`
 * between tests; uninstall with `__setTmuxExecForTests__(null)`.
 */
export function useTmuxPaneFake(): TmuxPaneFake {
  const lines: string[] = [];
  __setTmuxExecForTests__((args) => {
    lines.push(args.join(" "));
    if (args[0] === "split-window" || args[0] === "new-window") return "%24";
    if (args[0] === "list-panes") return "%88 orch\n";
    if (args[0] === "display-message" && args.includes("#{session_id}")) return "$7";
    if (args[0] === "display-message" && args.includes("#{window_id}")) return "@4";
    return "";
  });
  return { lines };
}
