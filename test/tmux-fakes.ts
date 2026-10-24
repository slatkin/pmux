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
  /**
   * Replace the rows the placement listing answers, or `null` for the default
   * one wide caller row. Row format: `#{pane_id} #{pane_width} #{pane_height}
   * #{pane_floating_flag} #{pane_left} #{pane_top} #{window_width}
   * #{window_height} #{pane-border-lines} #{@pmux_parent}` — an unset
   * `@pmux_parent` prints as an empty field.
   */
  placementRows: string | null;
  /**
   * The `@pane_session_id` the caller pane answers on a `show -pv` read: a
   * string returned verbatim, `null` making the read fail, unset answering
   * empty. A `show` read is answered but not logged, like the placement
   * plumbing, so `lines` stays the pane-mutating call sequence the launch
   * tests assert; an unset or empty answer reads as no id.
   */
  paneSessionId?: string | null;
  /**
   * The literal text the fake last typed with `send-keys ... -l`, and the
   * pane it typed it into. When it is set, `capture-pane` for that pane
   * echoes the text: the verified-input flow reads the visible screen, and
   * the fake must put the typed text there for the visibility token to be
   * seen. Clear it before a test that needs a virgin screen.
   */
  echoTyped: { pane: string; text: string } | null;
  /** When true, `display-message ... #{pane_in_mode}` answers `1`, so the
   * verified-input flow refuses at its first check. */
  paneInMode?: boolean;
  /** When true, the Enter `send-keys` (no `-l`) throws, as a failing tmux
   * call would; the verified-input flow then reports `unknown`. */
  failEnter?: boolean;
}

/**
 * One row of the placement listing: `#{pane_id} #{pane_width} #{pane_height}
 * #{pane_floating_flag} #{pane_left} #{pane_top} #{window_width}
 * #{window_height} #{pane-border-lines} #{@pmux_parent}`. An unset
 * `@pmux_parent` leaves the last field empty. The defaults describe a tiled
 * pane of a 200x50 window with the default border.
 */
export function placementRow(
  id: string,
  width: number,
  height: number,
  parent = "",
  shape: {
    floating?: number;
    left?: number;
    top?: number;
    windowWidth?: number;
    windowHeight?: number;
    border?: string;
  } = {},
): string {
  const floating = shape.floating ?? 0;
  const left = shape.left ?? 0;
  const top = shape.top ?? 0;
  const windowWidth = shape.windowWidth ?? 200;
  const windowHeight = shape.windowHeight ?? 50;
  const border = shape.border ?? "single";
  return `${id} ${width} ${height} ${floating} ${left} ${top} ${windowWidth} ${windowHeight} ${border} ${parent}`;
}

export function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

/**
 * Install the standard fake and return the recorded calls. Reset `lines`
 * between tests; uninstall with `__setTmuxExecForTests__(null)`.
 */
export function useTmuxPaneFake(): TmuxPaneFake {
  const lines: string[] = [];
  const fake: TmuxPaneFake = { lines, placementRows: null, echoTyped: null };
  __setTmuxExecForTests__((args) => {
    const joined = args.join(" ");
    if (args[0] === "show") {
      if (args.includes("@pane_session_id") && fake.paneSessionId !== undefined) {
        if (fake.paneSessionId === null) throw new Error("no such pane: simulated read failure");
        return fake.paneSessionId;
      }
      return "";
    }
    // The placement plumbing is answered but not logged, so `lines` stays the
    // sequence of pane-mutating calls the launch tests assert.
    if (args[0] === "list-panes" && joined.includes("#{pane_width}")) {
      const at = args.indexOf("-t");
      const caller = at >= 0 ? (args[at + 1] ?? "%21") : "%21";
      if (fake.placementRows !== null) return fake.placementRows;
      // One row for the caller: unset `@pmux_parent` prints as an empty
      // last field.
      return `${placementRow(caller, 200, 50)}\n`;
    }
    if (args[0] === "set-option") return "";
    if (fake.paneInMode === true && args.includes("#{pane_in_mode}")) return "1";
    if (args[0] === "send-keys" && args.includes("-l")) {
      // Literal typing: remember the pane and the text, so a later
      // `capture-pane` of that pane can echo them.
      fake.echoTyped = {
        pane: args[args.indexOf("-t") + 1] ?? "",
        text: args[args.indexOf("-l") + 1] ?? "",
      };
    }
    if (args[0] === "capture-pane") {
      const target = args[args.indexOf("-t") + 1] ?? "";
      if (fake.echoTyped !== null && fake.echoTyped.pane === target) return fake.echoTyped.text;
    }
    if (fake.failEnter === true && args[0] === "send-keys" && !args.includes("-l")) {
      throw new Error("tmux: the Enter call failed");
    }
    lines.push(joined);
    if (args[0] === "split-window" || args[0] === "new-window" || args[0] === "new-pane") {
      return "%24";
    }
    if (args[0] === "list-panes") return "%88 orch\n";
    if (args[0] === "display-message" && args.includes("#{session_id}")) return "$7";
    if (args[0] === "display-message" && args.includes("#{window_id}")) return "@4";
    return "";
  });
  return fake;
}
