/**
 * pi → tmux-agent-sidebar event publishing.
 *
 * The sidebar learns about an agent through one channel: a producer that runs
 * `tmux-agent-sidebar hook <agent> <event>` and hands it a JSON payload on
 * stdin (docs/agent-protocol.md in the tmux-agent-sidebar fork). This module
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

/** The environment values the lookup reads. `HOME` and `PATH` come with it. */
export interface SidebarLookupEnv {
  TMUX_AGENT_SIDEBAR_BIN?: string | undefined;
  HOME?: string | undefined;
  PATH?: string | undefined;
}

/**
 * Resolve the sidebar binary, in order: the `TMUX_AGENT_SIDEBAR_BIN` override,
 * the tmux plugin's `bin` path, its release build, then `PATH`. `exists` is
 * the file check, so a test needs no real home directory. `null` means the
 * sidebar is not installed and nothing should be published.
 */
export function resolveSidebarBinary(
  env: SidebarLookupEnv,
  exists: (path: string) => boolean,
): string | null {
  const override = env.TMUX_AGENT_SIDEBAR_BIN;
  if (override && exists(override)) return override;

  const home = env.HOME ?? "";
  if (home) {
    const pluginBin = `${home}/.tmux/plugins/tmux-agent-sidebar/bin/tmux-agent-sidebar`;
    if (exists(pluginBin)) return pluginBin;
    const pluginRelease = `${home}/.tmux/plugins/tmux-agent-sidebar/target/release/tmux-agent-sidebar`;
    if (exists(pluginRelease)) return pluginRelease;
  }

  for (const dir of (env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = `${dir}/tmux-agent-sidebar`;
    if (exists(candidate)) return candidate;
  }
  return null;
}

// ── Payload builders (design D5, D6) ──

/** The worktree fields the sidebar's protocol accepts. The window options
 * carry the worktree path and the branch; the other fields are unknown to a
 * pi producer and stay out of the payload. */
export interface SidebarWorktree {
  path: string;
  branch: string;
}

/**
 * Worktree fields from the sidebar's window options
 * (`@agent-sidebar-spawned-worktree`, `@agent-sidebar-spawned-branch`).
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
  cwd: string;
  sessionId: string;
  worktree?: SidebarWorktree;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    cwd: params.cwd,
    session_id: params.sessionId,
    source: params.source,
  };
  if (params.worktree) payload.worktree = params.worktree;
  return payload;
}

export function buildUserPromptSubmit(params: {
  prompt: string;
  cwd: string;
  sessionId: string;
}): Record<string, unknown> {
  return {
    prompt: params.prompt,
    cwd: params.cwd,
    session_id: params.sessionId,
  };
}

export function buildActivityLog(params: {
  toolName: string;
  toolInput: unknown;
  toolResponse?: unknown;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    tool_name: params.toolName,
    tool_input: params.toolInput,
  };
  if (params.toolResponse !== undefined) payload.tool_response = params.toolResponse;
  return payload;
}

export function buildStop(params: {
  lastAssistantMessage: string;
  cwd: string;
  sessionId: string;
}): Record<string, unknown> {
  return {
    last_assistant_message: params.lastAssistantMessage,
    cwd: params.cwd,
    session_id: params.sessionId,
  };
}

export function buildStopFailure(params: {
  error: string;
  cwd: string;
  sessionId: string;
}): Record<string, unknown> {
  return {
    error: params.error,
    cwd: params.cwd,
    session_id: params.sessionId,
  };
}

export function buildNotification(params: { waitReason: string }): Record<string, unknown> {
  return { notification_type: params.waitReason };
}

export function buildSessionEnd(params: { endReason: string }): Record<string, unknown> {
  return { end_reason: params.endReason };
}

// ── Agent run captures (design D6) ──
//
// `agent_settled` says how a run ended but does not carry the run's messages,
// so the last assistant message is taken from `agent_end` and kept until the
// run settles.

/** The last assistant message of a run: its text, stop reason and error. */
export interface LastAssistant {
  text: string;
  stopReason?: string;
  errorMessage?: string;
}

/**
 * The last assistant message in a run's messages, or `null` when the run has
 * none. Pure: the publisher keeps it between `agent_end` and `agent_settled`.
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

// ── Publisher (design D2) ──

/** The part of a spawned child the publisher touches: its stdin. */
export interface SidebarChild {
  stdin: {
    write(chunk: string): boolean | void;
    end(): void;
    on?(event: string, listener: () => void): void;
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
  /** Fire and forget: spawn the sidebar, write the payload, move on. */
  publish(event: string, payload: unknown): void;
}

/**
 * The switch: `TMUX_AGENT_SIDEBAR=0` turns publishing off. Any other value,
 * and the absence of the variable, leaves it on.
 */
export function sidebarSwitchEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.TMUX_AGENT_SIDEBAR !== "0";
}

export function createSidebarPublisher(deps: SidebarDeps = DEFAULT_DEPS): SidebarPublisher {
  // The lookup is done once per session and kept, so its cost is not paid
  // per event (design D3). A cached `null` counts as kept: a session that
  // starts without the sidebar stays quiet.
  let binary: string | null | undefined;

  return {
    publish(event: string, payload: unknown): void {
      try {
        if (!sidebarSwitchEnabled(deps.env)) return;
        // The pane comes from the publisher's own environment; a session
        // outside tmux has no pane to describe.
        const pane = deps.env.TMUX_PANE;
        if (!pane) return;
        binary ??= resolveSidebarBinary(deps.env, deps.exists);
        if (!binary) return;
        const child = deps.spawn(binary, ["hook", "pi", event], { env: deps.env });
        child.stdin.write(JSON.stringify(payload));
        child.stdin.end();
      } catch {
        // A missing, broken or slow sidebar never disturbs the session.
      }
    },
  };
}
