/**
 * Host dispatch for subagent panes.
 *
 * Two hosts are supported: Luvus (when the `LUVUS_*` keys are set) and tmux
 * (when this process runs inside a tmux pane). Luvus wins when both are
 * present, so an existing Luvus workflow is unchanged.
 *
 * Every function here is the host-independent name the rest of the extension
 * uses; the work is dispatched to the active host's backend.
 */
import * as luvus from "./luvus.ts";
import * as tmux from "./tmux.ts";
import type { PollResult } from "./exit-sidecar.ts";
import {
  DEFAULT_SURFACE_PLACEMENT,
  parseSurfacePlacement,
  type SplitDirection,
  type SurfacePlacement,
} from "./placement.ts";

export { DEFAULT_SURFACE_PLACEMENT, parseSurfacePlacement };
export type { SplitDirection, SurfacePlacement };
export type { PollResult } from "./exit-sidecar.ts";
export type { AgentPromptResult } from "./surface-types.ts";

/** The terminal host that runs the subagent panes. */
export type Host = "luvus" | "tmux";

/** The active host, or null when this process runs in no supported host. */
export function activeHost(env: NodeJS.ProcessEnv = process.env): Host | null {
  if (luvus.isMuxAvailable(env)) return "luvus";
  if (tmux.isTmuxAvailable(env)) return "tmux";
  return null;
}

/** True when a supported host is available. */
export function isMuxAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return activeHost(env) !== null;
}

/**
 * The host that runs the panes. With no host detected the Luvus backend
 * still handles the call, so the refusal keeps its historic message.
 *
 * Callers that carry their own environment (the CLI, which takes an injected
 * env) pass the host explicitly, so the dispatch follows that environment
 * rather than this process's own.
 */
function host(explicit?: Host): Host {
  return explicit ?? activeHost() ?? "luvus";
}

/** The setup hint for a process that runs in no supported host. */
export function muxSetupHint(): string {
  return "Start pi inside a Luvus pane or a tmux pane.";
}

/**
 * The caller's own pane id — the anchor every split is made from. It is the
 * `LUVUS_PANE_ID` under Luvus and the `TMUX_PANE` under tmux.
 */
export function callerPaneId(env: NodeJS.ProcessEnv = process.env): string {
  if (luvus.isMuxAvailable(env)) {
    const pane = env.LUVUS_PANE_ID;
    if (!pane) throw new Error("LUVUS_PANE_ID is not set. Start pi inside a Luvus pane.");
    return pane;
  }
  return tmux.callerPaneId(env);
}

/** Create a new pane for a subagent and return its id. */
export function createSurface(
  name: string,
  placement: SurfacePlacement = DEFAULT_SURFACE_PLACEMENT,
  caller?: string,
  target?: Host,
): string {
  const selected = host(target);
  if (selected === "luvus") {
    return luvus.createSurface(name, placement, caller ?? process.env.LUVUS_PANE_ID);
  }
  return tmux.createSurface(name, placement, caller ?? process.env.TMUX_PANE);
}

/** Split a pane without taking focus and return the new pane id. */
export function splitPane(
  caller: string,
  direction: SplitDirection = "right",
  target?: Host,
): string {
  return host(target) === "luvus"
    ? luvus.splitPane(caller, direction)
    : tmux.splitPane(caller, direction);
}

/** Name a pane. */
export function namePane(surface: string, name: string, target?: Host): void {
  if (host(target) === "luvus") luvus.namePane(surface, name);
  else tmux.namePane(surface, name);
}

/** Send one command line to a pane and execute it there. */
export function runInPane(surface: string, line: string, target?: Host): void {
  if (host(target) === "luvus") luvus.runInPane(surface, line);
  else tmux.runInPane(surface, line);
}

/** Read the visible contents of a pane (sync). */
export function readScreen(surface: string, lines = 50, target?: Host): string {
  return host(target) === "luvus"
    ? luvus.readScreen(surface, lines)
    : tmux.readScreen(surface, lines);
}

/** Read the visible contents of a pane (async). */
export async function readScreenAsync(surface: string, lines = 50, target?: Host): Promise<string> {
  if (host(target) === "luvus") {
    const screen = await luvus.readScreenAsync(surface, lines);
    return screen;
  }
  const screen = await tmux.readScreenAsync(surface, lines);
  return screen;
}

/** Send one Escape keypress to an active pane. */
export function sendEscape(surface: string, target?: Host): void {
  if (host(target) === "luvus") luvus.sendEscape(surface);
  else tmux.sendEscape(surface);
}

/** Close a pane. */
export function closeSurface(surface: string, target?: Host): void {
  if (host(target) === "luvus") luvus.closeSurface(surface);
  else tmux.closeSurface(surface);
}

/** Deliver `text` to a pane as input and submit it. */
export function agentPrompt(
  pane: string,
  text: string,
  target?: Host,
): ReturnType<typeof luvus.agentPrompt> {
  return host(target) === "luvus" ? luvus.agentPrompt(pane, text) : tmux.agentPrompt(pane, text);
}

/** Send `text` to a named agent pane, waking it. */
export function agentSend(name: string, text: string, target?: Host): void {
  if (host(target) === "luvus") luvus.agentSend(name, text);
  else tmux.agentSend(name, text);
}

/** Whether the pane currently has focus. */
export async function isPaneFocusedAsync(pane: string, target?: Host): Promise<boolean> {
  if (host(target) === "luvus") {
    const focused = await luvus.isPaneFocusedAsync(pane);
    return focused;
  }
  const focused = await tmux.isPaneFocusedAsync(pane);
  return focused;
}

/** Push one notification into the host's notification surface. */
export async function pushNotificationAsync(
  text: string,
  level: "info" | "success" | "warning" | "error",
  target?: Host,
): Promise<void> {
  if (host(target) === "luvus") await luvus.pushNotificationAsync(text, level);
  else await tmux.pushNotificationAsync(text);
}

/**
 * Poll until the subagent exits. The event stream is a Luvus feature; the
 * tmux backend polls the sidecar and the pane instead.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: Parameters<typeof luvus.pollForExit>[2],
  target?: Host,
): Promise<PollResult> {
  if (host(target) === "luvus") {
    const result = await luvus.pollForExit(surface, signal, options);
    return result;
  }
  const result = await tmux.pollForExit(surface, signal, options);
  return result;
}
