/**
 * Shared in-process tmux fake for tests that reach the tmux backend.
 *
 * The fake answers the lookups `createSurface` performs: a split or a new
 * window yields a pane id, `list-panes` answers the orchestrator listing, and
 * `display-message` answers the session and window lookups the tab placement
 * needs. Every other command returns empty output.
 *
 * The placement plumbing — the placement `list-panes` format (its template
 * names `#{pane_width}`) and the `@pmux_parent` marker — is answered but not
 * logged, so `lines` stays the sequence of pane-mutating calls the launch
 * tests assert. By default the placement listing returns one wide caller row
 * (200x50), which keeps the historical side-by-side split.
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
    const joined = args.join(" ");
    // The placement plumbing is answered but not logged, so `lines` stays the
    // sequence of pane-mutating calls the launch tests assert.
    if (args[0] === "list-panes" && joined.includes("#{pane_width}")) {
      const at = args.indexOf("-t");
      const caller = at >= 0 ? (args[at + 1] ?? "%21") : "%21";
      // One row for the caller: unset `@pmux_parent` prints as an empty
      // fourth field.
      return `${caller} 200 50 \n`;
    }
    if (args[0] === "set-option") return "";
    lines.push(joined);
    if (args[0] === "split-window" || args[0] === "new-window") return "%24";
    if (args[0] === "list-panes") return "%88 orch\n";
    if (args[0] === "display-message" && args.includes("#{session_id}")) return "$7";
    if (args[0] === "display-message" && args.includes("#{window_id}")) return "@4";
    return "";
  });
  return { lines };
}
