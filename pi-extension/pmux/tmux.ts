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
import { interpretExitSidecar, readExitSidecar, type PollResult } from "./exit-sidecar.ts";
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

/** True when the pane still exists. A closed pane fails the lookup. */
export function paneExists(surface: string): boolean {
  try {
    return tmux(["display-message", "-p", "-t", surface, "#{pane_id}"]).trim() === surface;
  } catch {
    return false;
  }
}

/**
 * Create a new pane for a subagent and return its id.
 *
 * `right` and `down` split the caller's pane without taking focus (`-d`), so
 * the new pane joins the caller's own window. `tab` opens a new window in the
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
    surface = tmux(["new-window", "-d", "-t", session, "-P", "-F", "#{pane_id}"]).trim();
    const callerWindow = tmux(["display-message", "-p", "-t", caller, "#{window_id}"]).trim();
    try {
      tmux(["select-window", "-t", callerWindow]);
    } catch {
      // Focus restore is best effort; the new window exists either way.
    }
  } else {
    surface = tmux([
      "split-window",
      "-d",
      splitFlag(placement === "down" ? "down" : "right"),
      "-t",
      caller,
      "-P",
      "-F",
      "#{pane_id}",
    ]).trim();
  }

  if (!surface.startsWith("%")) {
    throw new Error(`Unexpected tmux split result (no pane id): ${surface}`);
  }

  try {
    namePane(surface, name);
  } catch {
    // Naming is cosmetic — the pane works unnamed.
  }
  return surface;
}

/**
 * Split a pane without taking focus and return the new pane id. The caller
 * pane is passed in rather than read from the environment, because callers
 * may carry it in an injected environment.
 */
export function splitPane(caller: string, direction: SplitDirection = "right"): string {
  const surface = tmux([
    "split-window",
    "-d",
    splitFlag(direction),
    "-t",
    caller,
    "-P",
    "-F",
    "#{pane_id}",
  ]).trim();
  if (!surface.startsWith("%")) {
    throw new Error(`Unexpected tmux split result (no pane id): ${surface}`);
  }
  return surface;
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

/**
 * Find the pane that carries `name` as its title. Subagent panes are named
 * after the subagent, so the title is the agent name.
 */
function findPaneByName(name: string): string | null {
  let listing: string;
  try {
    listing = tmux(["list-panes", "-a", "-F", "#{pane_id} #{pane_title}"]);
  } catch {
    return null;
  }
  for (const line of listing.split("\n")) {
    const separator = line.indexOf(" ");
    if (separator < 0) continue;
    const pane = line.slice(0, separator).trim();
    const title = line.slice(separator + 1).trim();
    if (pane && title === name) return pane;
  }
  return null;
}

/** Send `text` to a named agent pane, waking it. */
export function agentSend(name: string, text: string): void {
  const pane = findPaneByName(name);
  if (!pane) throw new Error(`No pane named ${name}.`);
  tmux(["send-keys", "-t", pane, "-l", text]);
  tmux(["send-keys", "-t", pane, "Enter"]);
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
 * died without writing one.
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

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    if (options.sessionFile) {
      const data = readExitSidecar(options.sessionFile);
      if (data !== null) {
        rmSync(`${options.sessionFile}.exit`, { force: true });
        return interpretExitSidecar(data);
      }
    }

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
        if (options.sessionFile) {
          const data = readExitSidecar(options.sessionFile);
          if (data !== null) {
            rmSync(`${options.sessionFile}.exit`, { force: true });
            return interpretExitSidecar(data);
          }
        }
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
