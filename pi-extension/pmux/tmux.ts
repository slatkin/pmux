/**
 * tmux backend for subagent panes.
 *
 * Every call runs `tmux` directly (no shell, no command string). The caller's
 * pane identity comes from `$TMUX_PANE` — the pane this process actually runs
 * in — so a split always lands in the caller's own window, even when another
 * client is attached to a different window of the same server.
 *
 * A subagent pane is created empty (the default shell) and the launch command
 * is sent to it afterwards, which keeps the pane alive after the child exits:
 * the parent reads the exit sentinel from the pane and closes it afterwards.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, rmSync } from "node:fs";
import {
  exitSidecarPath,
  interpretExitSidecar,
  readExitSidecar,
  type PollResult,
} from "./exit-sidecar.ts";
import { defaultSleep } from "./report-artifact.ts";
import {
  DEFAULT_SURFACE_PLACEMENT,
  type SplitDirection,
  type SurfacePlacement,
} from "./placement.ts";
import type { AgentPromptResult } from "./surface-types.ts";

const execFileAsync = promisify(execFile);

/** Hard deadline for every tmux call: a wedged server must fail the call. */
export const TMUX_CALL_TIMEOUT_MS = 5000;

/**
 * Test seam: replaces the `tmux` invocation behind every call with an
 * in-process function, so the suite needs no tmux server and no shell.
 * Returns the raw stdout; `null` restores the real binary.
 */
export type TmuxExec = (args: string[]) => string | Promise<string>;

let execOverride: TmuxExec | null = null;

export function __setTmuxExecForTests__(fn: TmuxExec | null): void {
  execOverride = fn;
}

/** Run a tmux command for its effect only; returns stdout. */
function tmux(args: string[]): string {
  if (execOverride) {
    const output = execOverride(args);
    if (output instanceof Promise) {
      throw new Error("__setTmuxExecForTests__ returned a Promise on the synchronous tmux path");
    }
    return output;
  }
  return execFileSync("tmux", args, { encoding: "utf8", timeout: TMUX_CALL_TIMEOUT_MS });
}

/** Run a tmux command asynchronously; returns stdout. */
async function tmuxAsync(args: string[]): Promise<string> {
  if (execOverride) {
    const output = await execOverride(args);
    return output;
  }
  const { stdout } = await execFileAsync("tmux", args, {
    encoding: "utf8",
    timeout: TMUX_CALL_TIMEOUT_MS,
  });
  return stdout;
}

/** True when this process runs inside a tmux pane. */
export function isTmuxAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.TMUX && env.TMUX_PANE);
}

/** The caller's own pane id, the anchor for every split. */
export function callerPaneId(env: NodeJS.ProcessEnv = process.env): string {
  const pane = env.TMUX_PANE;
  if (!pane) throw new Error("TMUX_PANE is not set. Start pi inside a tmux pane.");
  return pane;
}

/** The setup hint for a process that runs in no supported host. */
export function tmuxSetupHint(): string {
  return "Start pi inside a tmux pane.";
}

function tailLines(text: string, lines: number): string {
  const split = text.split("\n");
  if (split.length <= lines) return text;
  return split.slice(-lines).join("\n");
}

/** The tmux split flag for a direction: `-h` side by side, `-v` stacked. */
function splitFlag(direction: SplitDirection): string {
  return direction === "down" ? "-v" : "-h";
}

/** The pane id in a tmux command's output, or a throw when there is none. */
function paneIdFrom(out: string): string {
  const surface = out.trim();
  if (!surface.startsWith("%")) {
    throw new Error(`Unexpected tmux split result (no pane id): ${surface}`);
  }
  return surface;
}

/**
 * Split a pane without taking focus and return the new pane id. The target
 * pane is passed in rather than read from the environment, because callers
 * may carry it in an injected environment.
 */
function splitWindow(target: string, direction: SplitDirection): string {
  return paneIdFrom(
    tmux(["split-window", "-d", splitFlag(direction), "-t", target, "-P", "-F", "#{pane_id}"]),
  );
}

/** True when the pane still exists. A closed pane fails the lookup. */
export function paneExists(surface: string): boolean {
  try {
    return tmux(["display-message", "-p", "-t", surface, "#{pane_id}"]).trim() === surface;
  } catch {
    return false;
  }
}

/** The tmux format of the placement listing, shared by both branches. */
const PLACEMENT_FORMAT =
  "#{pane_id} #{pane_width} #{pane_height} #{pane_floating_flag} #{pane_left} " +
  "#{pane_top} #{window_width} #{window_height} #{pane-border-lines} #{@pmux_parent}";

/** One row of the placement listing: a window pane with its shape and parent. */
interface PaneRow {
  id: string;
  /** The numeric part of the pane id (`%10` -> 10); `-1` when malformed. */
  num: number;
  width: number;
  height: number;
  /** 1 when the pane floats over the window's tiled panes. */
  floating: number;
  /** The pane's content-box origin in window cells; with a border drawn it
   * sits one cell inside the outer box, so the outer corner is
   * `left - border` / `top - border` (`border` is 0 for `none`, else 1). */
  left: number;
  top: number;
  /** The outer size of the pane's window. */
  windowWidth: number;
  windowHeight: number;
  /** The `pane-border-lines` style; `none` draws no border. */
  borderLines: string;
  /** The `@pmux_parent` value; empty when the option is unset. */
  parent: string;
}

/**
 * Parse the placement listing. A row carries 9 fields, or 10 when
 * `@pmux_parent` is set: `trim` drops the empty field an unset option prints.
 * Malformed rows are skipped.
 */
function parsePaneRows(out: string): PaneRow[] {
  const rows: PaneRow[] = [];
  for (const line of out.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 9 || !fields[0].startsWith("%")) continue;
    const numbers = fields.slice(1, 8).map(Number);
    if (numbers.some((value) => !Number.isFinite(value))) continue;
    const num = Number(fields[0].slice(1));
    const [width, height, floating, left, top, windowWidth, windowHeight] = numbers;
    rows.push({
      id: fields[0],
      num: Number.isFinite(num) ? num : -1,
      width,
      height,
      floating,
      left,
      top,
      windowWidth,
      windowHeight,
      borderLines: fields[8],
      parent: fields[9] ?? "",
    });
  }
  return rows;
}

/** The placement listing of a caller's window, parsed into rows. */
function listPlacementRows(caller: string): PaneRow[] {
  return parsePaneRows(tmux(["list-panes", "-t", caller, "-F", PLACEMENT_FORMAT]));
}

/** The row with the highest pane number, or `undefined` when there is none. */
function newestRow(rows: PaneRow[]): PaneRow | undefined {
  return rows.reduce<PaneRow | undefined>(
    (best, row) => (best === undefined || row.num > best.num ? row : best),
    undefined,
  );
}

/**
 * The origin of a new float of `width` by `height` in a window of
 * `windowWidth` by `windowHeight`. The first float sits two columns left of
 * the right edge, its top border on row 1. The next one cascades one row down
 * and two columns left from the newest pmux float, and wraps back to the first
 * position when it would leave the window.
 */
function floatOrigin(
  windowWidth: number,
  windowHeight: number,
  width: number,
  height: number,
  newest: PaneRow | undefined,
): { x: number; y: number } {
  const first = { x: windowWidth - width - 2, y: 1 };
  if (newest === undefined) return first;
  // With a border the outer corner sits one cell up and left of
  // `pane_left`/`pane_top`; with `none` the content is the outer box.
  const border = newest.borderLines === "none" ? 0 : 1;
  const x = newest.left - border - 2;
  const y = newest.top - border + 1;
  return x >= 0 && y + height <= windowHeight ? { x, y } : first;
}

/** Side by side when the target is at least twice as wide as it is tall. */
function axisDirection(row: PaneRow): SplitDirection {
  return row.width >= 2 * row.height ? "right" : "down";
}

/**
 * Create a new pane for a subagent and return its id.
 *
 * The `float` and `pane` branches each read one `list-panes` listing of the
 * caller's window. `pane` splits a target pane in that window without taking
 * focus (`-d`): the target is the newest living tiled pane this caller created
 * there (tracked with the `@pmux_parent` pane option), or the caller's own pane
 * when there is none; the axis comes from the target's shape. `float` opens a
 * floating pane of half the window's width and height (border included) with
 * its top border on row 1 and two columns of space to the window's right edge;
 * when a pmux float is already open, the new one cascades one row down and two
 * columns left from the newest of them, wrapping back to the first-float
 * position when it would leave the window. `tab` opens a new window in the
 * caller's session and restores focus to the caller's window afterwards.
 */
export function createSurface(
  name: string,
  placement: SurfacePlacement = DEFAULT_SURFACE_PLACEMENT,
  caller = process.env.TMUX_PANE,
): string {
  if (!caller) {
    throw new Error("TMUX_PANE is not set. Start pi inside a tmux pane.");
  }

  let surface: string;
  if (placement === "tab") {
    const session = tmux(["display-message", "-p", "-t", caller, "#{session_id}"]).trim();
    const created = tmux(["new-window", "-d", "-t", session, "-P", "-F", "#{pane_id}"]);
    const callerWindow = tmux(["display-message", "-p", "-t", caller, "#{window_id}"]).trim();
    try {
      tmux(["select-window", "-t", callerWindow]);
    } catch {
      // Focus restore is best effort; the new window exists either way.
    }
    surface = paneIdFrom(created);
  } else if (placement === "float") {
    // The float geometry needs the window size, and only the listing provides
    // it; without a row there is nothing to anchor on, so the spawn fails.
    let rows: PaneRow[];
    try {
      rows = listPlacementRows(caller);
    } catch (error) {
      throw new Error("Cannot place a float: the window listing failed.", { cause: error });
    }
    if (rows.length === 0) {
      throw new Error(`Cannot place a float: no panes listed in ${caller}'s window.`);
    }
    const { windowWidth, windowHeight } = rows[0];
    // Half the window, rounded down, border included.
    const width = Math.floor(windowWidth / 2);
    const height = Math.floor(windowHeight / 2);
    // The newest pmux float of the window, from every caller.
    const newest = newestRow(rows.filter((row) => row.floating === 1 && row.parent !== ""));
    const { x, y } = floatOrigin(windowWidth, windowHeight, width, height, newest);
    surface = paneIdFrom(
      tmux([
        "new-pane",
        "-d",
        "-t",
        caller,
        "-x",
        String(width),
        "-y",
        String(height),
        "-X",
        String(x),
        "-Y",
        String(y),
        "-P",
        "-F",
        "#{pane_id}",
      ]),
    );
    setParentOption(surface, caller);
  } else {
    let target = caller;
    let direction: SplitDirection = "right";
    try {
      const rows = listPlacementRows(caller);
      // A candidate is a living tiled pane this caller created in this window;
      // the caller's own row carries its own parent (or none) and never
      // matches.
      const candidates = rows.filter(
        (row) => row.parent === caller && row.id !== caller && row.floating === 0,
      );
      const newest = newestRow(candidates);
      // The newest child gives both the target and the shape; without one,
      // the caller's own row does — even when the caller itself floats.
      const targetRow = newest ?? rows.find((row) => row.id === caller);
      if (targetRow) {
        target = targetRow.id;
        direction = axisDirection(targetRow);
      }
    } catch {
      // The listing failed: fall back to splitting the caller side by side
      // rather than failing the spawn.
    }
    surface = splitWindow(target, direction);
    setParentOption(surface, caller);
  }

  try {
    namePane(surface, name);
  } catch {
    // Naming is cosmetic — the pane works unnamed.
  }
  return surface;
}

/** Tag a new pane with its caller. Best effort: without the marker the pane
 * works, it just cannot become a later spawn's target or cascade step. */
function setParentOption(surface: string, caller: string): void {
  try {
    tmux(["set-option", "-p", "-t", surface, "@pmux_parent", caller]);
  } catch {
    // The parentage marker is best effort.
  }
}

/**
 * Split a pane without taking focus and return the new pane id. The caller
 * pane is passed in rather than read from the environment, because callers
 * may carry it in an injected environment.
 */
export function splitPane(caller: string, direction: SplitDirection = "right"): string {
  return splitWindow(caller, direction);
}

/**
 * Name a pane. The name becomes the pane title, which tmux shows on the pane
 * border when `pane-border-status` is on.
 */
export function namePane(surface: string, name: string): void {
  tmux(["select-pane", "-t", surface, "-T", name]);
}

/** Send one command line to a pane and execute it there. */
export function runInPane(surface: string, line: string): void {
  tmux(["send-keys", "-t", surface, "-l", line]);
  tmux(["send-keys", "-t", surface, "Enter"]);
}

/**
 * Read window options for a pane. `display-message` resolves an option on the
 * pane first and falls through to the pane's window, so window-scope options
 * (for example the sidebar's `@pmux-explorer-spawned-*` markers) are visible
 * from any pane of the window. Unset options come back as empty strings.
 */
export function readWindowOptions(pane: string, names: string[]): string[] {
  const template = names.map((name) => `#{${name}}`).join("\n");
  const out = tmux(["display-message", "-p", "-t", pane, template]);
  const values = out.split("\n");
  return names.map((_, i) => values[i] ?? "");
}

/** Read one pane user option. `show -pv` reads the pane's own scope, so an
 * option no pane has set fails there and reads as no value.
 */
export function readPaneOption(pane: string, name: string): string | null {
  try {
    const value = tmux(["show", "-pv", "-t", pane, name]).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Read the visible contents of a pane (sync). */
export function readScreen(surface: string, lines = 50): string {
  return tailLines(
    tmux(["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`]),
    lines,
  );
}

/** Read the visible contents of a pane (async). */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  const out = await tmuxAsync([
    "capture-pane",
    "-p",
    "-t",
    surface,
    "-S",
    `-${Math.max(1, lines)}`,
  ]);
  return tailLines(out, lines);
}

/** Send one Escape keypress to an active pane. */
export function sendEscape(surface: string): void {
  tmux(["send-keys", "-t", surface, "Escape"]);
}

/** Close a pane. A pane that is already gone is not an error. */
export function closeSurface(surface: string): void {
  try {
    tmux(["kill-pane", "-t", surface]);
  } catch (error) {
    const message = String((error as { message?: unknown })?.message ?? error);
    if (!/can't find pane|no such pane|not found/i.test(message)) throw error;
  }
}

/** Shape of the prompt delivery result, as the tmux backend returns it. */
export type { AgentPromptResult };

/**
 * Deliver `text` to a pane as input and submit it. Resolves as soon as the
 * text is queued, without waiting for the target to act.
 */
export function agentPrompt(pane: string, text: string): AgentPromptResult {
  tmux(["send-keys", "-t", pane, "-l", text]);
  tmux(["send-keys", "-t", pane, "Enter"]);
  return { submitted: true, pane };
}

/** The interval between verified-input polls: design D4's 100 ms cadence. */
export const VERIFIED_PROMPT_POLL_MS = 100;
/** The deadline the typed text's token must appear within. */
const VERIFIED_PROMPT_TIMEOUT_MS = 2000;

/** The outcome of `verifiedAgentPrompt`, as the report protocol names it. */
export type VerifiedPromptStatus = "submitted" | "not-submitted" | "unknown";

/** Shape of the verified prompt delivery result. */
export interface VerifiedPromptResult {
  pane: string;
  /**
   * `submitted`: the token was verified and exactly one Enter was sent.
   * `not-submitted`: refused before the Enter — any text the typing already
   * delivered stays in the pane untouched. `unknown`: the Enter call threw,
   * so tmux may still have accepted it.
   */
  status: VerifiedPromptStatus;
  /** True only when the Enter call returned without an exception. */
  submitted: boolean;
  /** True once the Enter call was attempted. */
  enterAttempted: boolean;
  /** Why the submission was refused or its outcome is unknown. */
  error?: string;
}

function tmuxErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Deliver `text` to a pane as input and submit it only once its `token` was
 * seen on the visible screen — the verified report input of `file-ack-v1`
 * (design D4).
 *
 * The sequence: refuse when the pane is in a mode; capture the visible pane
 * and refuse when the token is already on it (a stale pointer would make the
 * new one unprovable); type the text; poll mode and the visible screen every
 * 100 ms for up to 2 s until the token appears; recheck both once; send
 * exactly one Enter.
 *
 * The pane is never edited: no Escape, Ctrl-U or other editing key is ever
 * sent. A refusal or a token timeout returns `not-submitted` and leaves any
 * unsubmitted text alone; a tmux exception on the Enter call returns
 * `unknown`, because tmux may still have accepted it. No post-Enter capture
 * can tell a dropped Enter from an accepted input still visible in a
 * composer, so none is taken and no Enter is ever retried.
 */
export async function verifiedAgentPrompt(
  pane: string,
  text: string,
  token: string,
  options: {
    /** Poll timer; defaults to a real `setTimeout`. */
    sleep?: (ms: number) => Promise<void>;
    /** Deadline clock; defaults to `Date.now`. */
    now?: () => number;
  } = {},
): Promise<VerifiedPromptResult> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  const refuse = (error: string): VerifiedPromptResult => ({
    pane,
    status: "not-submitted",
    submitted: false,
    enterAttempted: false,
    error,
  });

  const paneInMode = async (): Promise<boolean> =>
    (await tmuxAsync(["display-message", "-p", "-t", pane, "#{pane_in_mode}"])).trim() === "1";

  // The visible pane only: no `-S`, so scrollback never supplies the token.
  const visibleScreen = (): Promise<string> => tmuxAsync(["capture-pane", "-p", "-t", pane]);

  try {
    if (await paneInMode()) return refuse("the pane is in a mode");
    if ((await visibleScreen()).includes(token)) {
      return refuse("the token is already on the visible screen");
    }
    await tmuxAsync(["send-keys", "-t", pane, "-l", text]);
  } catch (error) {
    return refuse(tmuxErrorMessage(error));
  }

  const deadline = now() + VERIFIED_PROMPT_TIMEOUT_MS;
  for (;;) {
    try {
      if (await paneInMode()) return refuse("the pane entered a mode");
      if ((await visibleScreen()).includes(token)) break;
    } catch (error) {
      return refuse(tmuxErrorMessage(error));
    }
    const remaining = deadline - now();
    if (remaining <= 0) return refuse("the token never appeared on the visible screen");
    await sleep(Math.min(VERIFIED_PROMPT_POLL_MS, remaining));
  }

  // The last check before the Enter: the token was seen, but the pane may
  // have entered a mode since — and the token may have left the screen.
  try {
    if (await paneInMode()) return refuse("the pane entered a mode");
    if (!(await visibleScreen()).includes(token)) {
      return refuse("the token left the visible screen");
    }
  } catch (error) {
    return refuse(tmuxErrorMessage(error));
  }

  try {
    await tmuxAsync(["send-keys", "-t", pane, "Enter"]);
  } catch (error) {
    // The Enter may still have landed: the outcome cannot be told apart, so
    // a retry would risk a duplicate. Report `unknown` and stop.
    return {
      pane,
      status: "unknown",
      submitted: false,
      enterAttempted: true,
      error: tmuxErrorMessage(error),
    };
  }
  return { pane, status: "submitted", submitted: true, enterAttempted: true };
}

/** Whether the pane currently has focus. */
export async function isPaneFocusedAsync(pane: string): Promise<boolean> {
  try {
    const out = await tmuxAsync(["display-message", "-p", "-t", pane, "#{pane_active}"]);
    return out.trim() === "1";
  } catch {
    return false;
  }
}

/** Push one notification into the tmux status line. */
export async function pushNotificationAsync(text: string): Promise<void> {
  try {
    await tmuxAsync(["display-message", text]);
  } catch {
    // Best effort: a notification is never worth failing a turn over.
  }
}

/**
 * Poll until the subagent exits. The `.exit` sidecar is the primary signal
 * (host independent); the terminal sentinel is the fallback for a child that
 * died without writing one. A `cancelled` sidecar ends the poll like any
 * other: the user stopped the child (quiet-cancel-exit D2).
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
    maySkipScreenScan?: () => boolean;
  },
): Promise<PollResult> {
  const start = Date.now();

  /** Read and consume the sidecar. */
  const readSidecar = (): PollResult | null => {
    if (!options.sessionFile) return null;
    const data = readExitSidecar(options.sessionFile);
    if (data === null) return null;
    rmSync(exitSidecarPath(options.sessionFile), { force: true });
    return interpretExitSidecar(data);
  };

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    const sidecar = readSidecar();
    if (sidecar) return sidecar;

    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {
        // An unreadable sentinel is treated as absent.
      }
    }

    if (!options.maySkipScreenScan?.()) {
      try {
        const screen = await readScreenAsync(surface, 5);
        const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
        // A live pane invalidates the match: the pattern can be printed by the
        // child itself. The wrapper prints it just before the pane's shell
        // returns, so a match only counts once the pane is gone.
        if (match && !(await paneStillAlive(surface))) {
          return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
        }
      } catch {
        // The pane is gone: check for the sidecar one more time.
        const lastSidecar = readSidecar();
        if (lastSidecar) return lastSidecar;
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const onWake = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      function onAbort() {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(new Error("Aborted"));
      }
      const timer = setTimeout(onWake, options.interval);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/**
 * Give the wrapper a moment to exit after it printed the sentinel, then
 * report whether the pane is still there. A pane that is gone means the child
 * really finished.
 */
async function paneStillAlive(surface: string): Promise<boolean> {
  await new Promise((resolve) => setTimeout(resolve, 150));
  return paneExists(surface);
}
