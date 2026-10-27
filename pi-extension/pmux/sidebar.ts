/**
 * pi → pmux-explorer event publishing.
 *
 * The sidebar learns about an agent through one channel: a producer that runs
 * `pmux-explorer hook <agent> <event>` and hands it a JSON payload on
 * stdin (docs/agent-protocol.md in the pmux-explorer repository). This module
 * is the pi producer. It lives in the extension — not the supervisor — because
 * the extension loads in every pi session, so a pi pane a human opened by hand
 * reaches the sidebar too.
 *
 * Every call is fire and forget: the child is spawned with the process's own
 * environment (the sidebar reads `TMUX_PANE` from it), the payload goes to its
 * stdin, and nothing is awaited. A missing, broken or slow sidebar never
 * delays a turn, raises an extension error, or writes to the session output.
 *
 * The payload builders are pure functions; the publisher does the side effect.
 * That split keeps the mapping testable without pi, without tmux and without
 * a sidebar.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";

// ── Binary lookup (design D3) ──

/**
 * Resolve the sidebar binary, in order: the `PMUX_EXPLORER_BIN` override,
 * the tmux plugin's `bin` path, its release build, then `PATH`. `exists` is
 * the file check, so a test needs no real home directory. `null` means the
 * sidebar is not installed and nothing should be published.
 */
export function resolveSidebarBinary(
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
): string | null {
  const override = env.PMUX_EXPLORER_BIN;
  if (override && exists(override)) return override;

  const home = env.HOME ?? "";
  if (home) {
    const pluginBin = `${home}/.tmux/plugins/pmux-explorer/bin/pmux-explorer`;
    if (exists(pluginBin)) return pluginBin;
    const pluginRelease = `${home}/.tmux/plugins/pmux-explorer/target/release/pmux-explorer`;
    if (exists(pluginRelease)) return pluginRelease;
  }

  for (const dir of (env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = `${dir}/pmux-explorer`;
    if (exists(candidate)) return candidate;
  }
  return null;
}

// ── Payload builders (design D5, D6) ──

/** The identity every session-scoped payload carries (design D8). */
export interface SidebarSession {
  cwd: string;
  sessionId: string;
}

/** The cwd and the session id, in the protocol's key order. */
function sessionFields(session: SidebarSession): { cwd: string; session_id: string } {
  return { cwd: session.cwd, session_id: session.sessionId };
}

/** The worktree fields the sidebar's protocol accepts. The window options
 * carry the worktree path and the branch; the other fields are unknown to a
 * pi producer and stay out of the payload. */
export interface SidebarWorktree {
  path: string;
  branch: string;
}

/**
 * The window options the sidebar records the worktree and the branch in
 * (design D7). `display-message` falls through the pane scope to the window
 * scope, so every pane of that window reads them.
 */
export const SIDEBAR_WORKTREE_OPTION = "@pmux-explorer-spawned-worktree";
export const SIDEBAR_BRANCH_OPTION = "@pmux-explorer-spawned-branch";

/**
 * Worktree fields from the sidebar's window options
 * (`@pmux-explorer-spawned-worktree`, `@pmux-explorer-spawned-branch`).
 * `undefined` when neither option is set: the pane is not in a sidebar
 * worktree and the payload carries no worktree.
 */
export function worktreeFromOptions(options: {
  worktree?: string;
  branch?: string;
}): SidebarWorktree | undefined {
  const path = options.worktree?.trim();
  const branch = options.branch?.trim();
  if (!path && !branch) return undefined;
  return { path: path ?? "", branch: branch ?? "" };
}

export function buildSessionStart(params: {
  source: string;
  session: SidebarSession;
  worktree?: SidebarWorktree;
}): Record<string, unknown> {
  return {
    ...sessionFields(params.session),
    source: params.source,
    ...(params.worktree ? { worktree: params.worktree } : {}),
  };
}

export function buildUserPromptSubmit(params: {
  prompt: string;
  session: SidebarSession;
}): Record<string, unknown> {
  return { prompt: params.prompt, ...sessionFields(params.session) };
}

export function buildActivityLog(params: {
  toolName: string;
  toolInput: unknown;
  toolResponse?: unknown;
}): Record<string, unknown> {
  return {
    tool_name: params.toolName,
    tool_input: params.toolInput,
    ...(params.toolResponse !== undefined ? { tool_response: params.toolResponse } : {}),
  };
}

export function buildStop(params: {
  lastAssistantMessage: string;
  session: SidebarSession;
}): Record<string, unknown> {
  return { last_assistant_message: params.lastAssistantMessage, ...sessionFields(params.session) };
}

export function buildStopFailure(params: {
  error: string;
  session: SidebarSession;
}): Record<string, unknown> {
  return { error: params.error, ...sessionFields(params.session) };
}

export function buildNotification(params: { waitReason: string }): Record<string, unknown> {
  return { notification_type: params.waitReason };
}

export function buildSessionEnd(params: { endReason: string }): Record<string, unknown> {
  return { end_reason: params.endReason };
}

// ── Publisher (design D2) ──

/**
 * The protocol's event names (design D6). The publisher takes only these, so
 * a typo in a call site does not compile.
 */
export type SidebarEvent =
  | "session-start"
  | "user-prompt-submit"
  | "activity-log"
  | "stop"
  | "stop-failure"
  | "notification"
  | "session-end";

/** The part of a spawned child the publisher touches: its stdin. */
export interface SidebarChild {
  stdin: {
    write(chunk: string): boolean | void;
    end(): void;
  };
}

export interface SidebarDeps {
  /** The process environment; carries `TMUX_PANE` and the sidebar switch. */
  env: NodeJS.ProcessEnv;
  /** The file check behind the binary lookup. */
  exists(path: string): boolean;
  /** The spawner. It must not await the child, and it must inherit `env`. */
  spawn(command: string, args: string[], options: { env: NodeJS.ProcessEnv }): SidebarChild;
}

const DEFAULT_DEPS: SidebarDeps = {
  env: process.env,
  exists: existsSync,
  spawn: (command, args, options) => {
    // stdout and stderr are ignored; stdin carries the payload. The child is
    // unref'd so it never holds the pi process open, and its errors are
    // swallowed: a broken sidebar is not the session's problem.
    const child = nodeSpawn(command, args, { ...options, stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => {});
    child.stdin?.on?.("error", () => {});
    child.unref();
    return child as SidebarChild;
  },
};

export interface SidebarPublisher {
  /**
   * Whether publishing is actually possible: the switch on, the pane set and
   * the binary found. Cheap and synchronous, so a caller can skip its own
   * work (the worktree read) when the answer is no. Caches the lookup.
   */
  canPublish(): boolean;
  /**
   * Fire and forget: the guards run now, the spawn, the JSON.stringify and
   * the stdin write are deferred (setImmediate), so serializing a large tool
   * payload never runs inside pi's event handler.
   */
  publish(event: SidebarEvent, payload: Record<string, unknown>): void;
  /**
   * The synchronous publish, for an event the session must not lose: it
   * spawns and writes now, without waiting for the deferred queue.
   */
  publishSync(event: SidebarEvent, payload: Record<string, unknown>): void;
}

/**
 * The switch: `PMUX_EXPLORER=0` turns publishing off. Any other value,
 * and the absence of the variable, leaves it on.
 */
export function sidebarSwitchEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.PMUX_EXPLORER !== "0";
}

/**
 * The sidebar's two guards: the session runs in a tmux pane and the sidebar
 * switch is on. The publisher adds its binary lookup on top; the thinking
 * feed follows these guards exactly, without the lookup.
 */
export function sidebarGuardsEnabled(env: NodeJS.ProcessEnv): boolean {
  // The pane comes from the session's own environment; a session outside
  // tmux has no pane to describe.
  return sidebarSwitchEnabled(env) && Boolean(env.TMUX_PANE);
}

export function createSidebarPublisher(deps: SidebarDeps = DEFAULT_DEPS): SidebarPublisher {
  // The lookup is done once per session and kept, so its cost is not paid
  // per event (design D3). A cached `null` counts as kept: a session that
  // starts without the sidebar stays quiet.
  let binary: string | null | undefined;

  // The one place the binary is looked up and the one place it is cached.
  const findBinary = (): string | null => (binary ??= resolveSidebarBinary(deps.env, deps.exists));

  // The guards are cheap and synchronous; the expensive part (stringify the
  // payload, spawn, write) runs off the event handler's path.
  const guardsPass = (): boolean => sidebarGuardsEnabled(deps.env);

  const emit = (event: SidebarEvent, payload: Record<string, unknown>): void => {
    try {
      const bin = findBinary();
      if (!bin) return;
      const child = deps.spawn(bin, ["hook", "pi", event], { env: deps.env });
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    } catch {
      // A missing, broken or slow sidebar never disturbs the session.
    }
  };

  return {
    canPublish(): boolean {
      try {
        if (!guardsPass()) return false;
        return findBinary() !== null;
      } catch {
        return false;
      }
    },

    publish(event: SidebarEvent, payload: Record<string, unknown>): void {
      try {
        if (!guardsPass()) return;
        // setImmediate keeps the relative order: events published in one
        // handler turn reach the sidebar in the order they were published.
        setImmediate(() => emit(event, payload));
      } catch {
        // A missing, broken or slow sidebar never disturbs the session.
      }
    },

    publishSync(event: SidebarEvent, payload: Record<string, unknown>): void {
      if (!guardsPass()) return;
      emit(event, payload);
    },
  };
}
