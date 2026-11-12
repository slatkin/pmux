/*!
 * pi-hang-guard — vendored into pmux.
 *
 * Copyright (c) 2026 ducaoya
 *
 * MIT License. The extension entry is pmux's own (the upstream one loads a
 * config file, a status widget and i18n, none of which a pmux child keeps),
 * but its killer resolution follows upstream's, including the bundled-build
 * detection. The vendored engine it drives lives in `hang-engine.ts`.
 *
 * The command watchdog every pmux child (and the parent session) loads as a
 * second `-e` extension next to `pmux-done.ts`. It reads tool events only,
 * escalates inside this process — where the abort path reaps a detached tool's
 * whole process tree, which `kill-pane` cannot — and publishes hang state to
 * the shared activity file.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ACTIVITY_RECORDER_KEY,
  type SubagentActivityHang,
  type SubagentActivityRecorder,
} from "./activity.ts";
import { decodeChildEnv } from "./child-env.ts";
import {
  DEFAULT_GUARD_SETTINGS,
  createHangGuardEngine,
  resumeMessage,
  type GuardActionReport,
  type GuardMode,
  type HangGuardSettings,
  type SoftKillOutcome,
} from "./hang-engine.ts";
import { writeInterruptMarker } from "./exit-sidecar.ts";

/** The ticker-stop function of the registration alive in this process. A
 * /reload re-runs registration; the new one retires the old ticker through
 * this key, the same way `index.ts` retires its supervisor. */
const HANG_GUARD_TIMER_KEY: symbol = Symbol.for("pmux/hang-guard-timer");

export interface ResolvedGuardConfig {
  enabled: boolean;
  mode: GuardMode;
}

const GUARD_MODES: readonly GuardMode[] = ["observe", "guard", "yolo"];

/**
 * Resolve the watchdog mode (command-hang-guard spec): `PI_PMUX_GUARD_DISABLED=1`
 * switches the watchdog off; a valid `PI_PMUX_GUARD_MODE` overrides the
 * default; otherwise a non-interactive pmux child (auto-exit, no user driving
 * the pane) runs `yolo` and every other session runs `observe`.
 */
export function resolveGuardConfig(env: NodeJS.ProcessEnv): ResolvedGuardConfig {
  if (env.PI_PMUX_GUARD_DISABLED === "1") return { enabled: false, mode: "observe" };

  const rawMode = env.PI_PMUX_GUARD_MODE;
  const overridden = rawMode && (GUARD_MODES as readonly string[]).includes(rawMode);
  if (overridden) return { enabled: true, mode: rawMode as GuardMode };

  const isPmuxChild = Boolean(env.PI_PMUX_SESSION);
  const nonInteractive = env.PI_PMUX_AUTO_EXIT === "1";
  return { enabled: true, mode: isPmuxChild && nonInteractive ? "yolo" : "observe" };
}

/** The engine settings this session runs with: defaults plus the resolved mode. */
export function resolveGuardSettings(env: NodeJS.ProcessEnv): HangGuardSettings {
  const resolved = resolveGuardConfig(env);
  return { ...DEFAULT_GUARD_SETTINGS, enabled: resolved.enabled, mode: resolved.mode };
}

/**
 * pi's internal "kill everything I spawned" helper lives outside the package
 * exports map, so it can only be reached through `getPackageDir()`. This only
 * works on the unbundled build: the shipped bin is `dist/bundle/cli.js`, whose
 * chunks export nothing, so importing `dist/utils/shell.js` would yield a
 * second module instance with its own empty process registry. Detect the
 * bundled entry up front and report the capability unavailable instead of
 * pretending (the bundled build is exactly what the managed install runs, so
 * `yolo` degrades to the abort path there — still correct, see design D4).
 */
function isBundledEntry(): boolean {
  const entry = process.argv[1] ?? "";
  return /[\\/]bundle[\\/][^\\/]*\.js$/.test(entry);
}

export type SoftKiller = () => SoftKillOutcome;

/** Resolve the soft-kill capability once per process, lazily and host-independently. */
export function createSoftKiller(
  importModule: (specifier: string) => Promise<unknown> = (specifier) => import(specifier),
): SoftKiller {
  let killer: (() => void) | null | undefined;
  let reason = "not resolved yet";
  let resolving: Promise<void> | null = null;

  async function resolve(): Promise<void> {
    if (isBundledEntry()) {
      killer = null;
      reason = "this pi is the bundled build; the internal process registry is a private copy";
      return;
    }
    try {
      const sdk = (await importModule("@earendil-works/pi-coding-agent")) as {
        getPackageDir?: () => string | undefined;
      };
      const packageDir = typeof sdk.getPackageDir === "function" ? sdk.getPackageDir() : undefined;
      if (!packageDir) {
        killer = null;
        reason = "getPackageDir() is unavailable";
        return;
      }
      const shell = (await importModule(
        pathToFileURL(join(packageDir, "dist", "utils", "shell.js")).href,
      )) as { killTrackedDetachedChildren?: () => void };
      if (typeof shell.killTrackedDetachedChildren !== "function") {
        killer = null;
        reason = "killTrackedDetachedChildren is unavailable";
        return;
      }
      const kill = shell.killTrackedDetachedChildren.bind(shell);
      killer = () => kill();
      reason = "resolved";
    } catch (error) {
      killer = null;
      reason = error instanceof Error ? error.message : String(error);
    }
  }

  return (): SoftKillOutcome => {
    if (killer !== undefined) {
      if (killer === null) return { ok: false, detail: reason };
      try {
        killer();
        return { ok: true, detail: "killed pi's tracked tool child processes" };
      } catch (error) {
        return {
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }
    resolving ??= resolve().catch((error: unknown) => {
      killer = null;
      reason = error instanceof Error ? error.message : String(error);
    });
    return { ok: false, detail: reason, pending: true };
  };
}

/** The shared recorder `pmux-done.ts` published, or null when this session has
 * no activity file (a parent session or a standalone agent). */
export function fetchSharedRecorder(): SubagentActivityRecorder | null {
  const recorder = (globalThis as unknown as Record<symbol, unknown>)[ACTIVITY_RECORDER_KEY] as
    SubagentActivityRecorder | undefined;
  if (!recorder || typeof recorder.hangUpdate !== "function") return null;
  return recorder;
}

/** Format one ParentMessage body: child, command, measurement and class. */
export function parentHangMessage(params: {
  childName: string;
  toolName: string;
  command: string;
  basis: SubagentActivityHang["basis"];
  observedMs: number;
  kind: SubagentActivityHang["kind"];
}): string {
  const observed =
    params.basis === "idle"
      ? `${Math.round(params.observedMs / 1000)}s without output`
      : `${Math.round(params.observedMs / 1000)}s of wall-clock runtime`;
  return [
    `${params.childName || "subagent"}: ${params.toolName} is likely stuck (${params.kind}, ${observed}).`,
    `command: ${params.command.replace(/\s+/g, " ").trim().slice(0, 200) || "(no command)"}`,
    "The child's own watchdog is handling it; you can pmux_interrupt it or wait.",
  ].join("\n");
}

export default function hangGuardExtension(pi: ExtensionAPI) {
  const childEnv = decodeChildEnv(process.env);
  const settings = resolveGuardSettings(process.env);
  // PI_PMUX_GUARD_DISABLED=1 switches the watchdog off for this session.
  if (!settings.enabled) return;

  // A second registration in this process (a /reload, or index.ts and the
  // standalone file both registering) retires the previous ticker.
  const previousStop = (globalThis as unknown as Record<symbol, unknown>)[HANG_GUARD_TIMER_KEY] as
    (() => void) | undefined;
  previousStop?.();

  let activeCtx: ExtensionContext | undefined;
  let stale = false;
  const recorder = fetchSharedRecorder();
  // One parent message per tool call per level keeps the steering a signal.
  const parentNotified = new Set<string>();
  // The hang blocks currently published to the activity file, by tool call.
  const publishedHangs = new Map<string, SubagentActivityHang>();

  const softKill = createSoftKiller();

  const engine = createHangGuardEngine({
    settings: () => settings,
    now: () => Date.now(),
    ui: {
      notify: (message, level) => {
        // A pane notify is the whole behavior when no parent session watches
        // this file: a standalone session or the parent session itself (D8).
        try {
          activeCtx?.ui.notify(message, level);
        } catch {
          // A stale UI context must not break the watchdog.
        }
      },
    },
    actions: {
      softKill: () => softKill(),
      abortTurn: () => {
        // The abort makes the turn end with stopReason "aborted", which
        // `pmux-done` would read as a user cancel and end the child. The
        // marker routes the abort through the parent-interrupt path instead:
        // the session stays open and the structured report goes in as a new
        // user message (command-hang-guard D5). Written immediately before
        // the abort in one tick, and `pmux-done` clears markers on every
        // agent start and end, so a failed abort cannot outlive the turn.
        if (childEnv.sessionFile) writeInterruptMarker(childEnv.sessionFile);
        try {
          activeCtx?.abort();
        } catch {
          // Best effort: a stale context must not break bookkeeping.
        }
      },
    },
  });

  /** Publish and retract the activity file's `hang` block for watched tools. */
  function syncHangs(): void {
    if (!recorder) return;
    const entries = engine.list().filter((entry) => entry.level >= 1);
    const live = new Set(entries.map((entry) => entry.toolCallId));

    for (const entry of entries) {
      const hang: SubagentActivityHang = {
        toolCallId: entry.toolCallId,
        basis: entry.basis,
        observedMs: entry.observedMs,
        kind: entry.kind,
        level: entry.level === 2 ? 2 : 1,
      };
      // Send only state that actually changed: the tick runs every second and
      // each send is an activity-file write.
      const previous = publishedHangs.get(entry.toolCallId);
      if (
        previous &&
        previous.basis === hang.basis &&
        previous.kind === hang.kind &&
        previous.level === hang.level &&
        previous.observedMs === hang.observedMs
      ) {
        continue;
      }
      publishedHangs.set(entry.toolCallId, hang);
      recorder.hangUpdate(hang);

      if (entry.level === 2 && childEnv.sessionFile && !childEnv.externalParent) {
        const dedupeKey = `${entry.toolCallId}:2`;
        if (!parentNotified.has(dedupeKey)) {
          parentNotified.add(dedupeKey);
          try {
            appendFileSync(
              `${childEnv.sessionFile}.msg`,
              `${JSON.stringify({
                header: `[hang from ${childEnv.name || childEnv.agent || "subagent"}]`,
                message: parentHangMessage({
                  childName: childEnv.name || childEnv.agent || "subagent",
                  toolName: entry.toolName,
                  command: entry.command,
                  basis: entry.basis,
                  observedMs: entry.observedMs,
                  kind: entry.kind,
                }),
              })}\n`,
              "utf8",
            );
          } catch {
            // A failed parent message must not break the watchdog.
          }
        }
      }
    }

    // An execution that produced output (level back to 0) or ended loses its
    // published hang block.
    for (const toolCallId of publishedHangs.keys()) {
      if (live.has(toolCallId)) continue;
      publishedHangs.delete(toolCallId);
      recorder.hangUpdate(undefined);
    }
  }

  function stopTicker(): void {
    stale = true;
    if ((globalThis as unknown as Record<symbol, unknown>)[HANG_GUARD_TIMER_KEY] === stop) {
      delete (globalThis as unknown as Record<symbol, unknown>)[HANG_GUARD_TIMER_KEY];
    }
  }

  const ticker = setInterval(() => {
    if (stale) return;
    syncHangs();
    engine.tick();
  }, settings.tickIntervalMs);
  ticker.unref();
  const stop: () => void = () => {
    clearInterval(ticker);
    stopTicker();
  };
  (globalThis as unknown as Record<symbol, unknown>)[HANG_GUARD_TIMER_KEY] = stop;

  pi.on("session_start", (_event, ctx) => {
    activeCtx = ctx;
  });

  pi.on("tool_execution_start", (event) => {
    const toolEvent = event as { toolCallId: string; toolName: string; args: unknown };
    engine.onToolStart({
      toolCallId: toolEvent.toolCallId,
      toolName: toolEvent.toolName,
      args: toolEvent.args,
    });
  });

  pi.on("tool_execution_update", (event) => {
    const toolEvent = event as { toolCallId: string };
    engine.onToolUpdate({ toolCallId: toolEvent.toolCallId });
    // Output resets the silence clock: retract the published hang at once,
    // not on the next tick.
    if (recorder && publishedHangs.delete(toolEvent.toolCallId)) {
      recorder.hangUpdate(undefined);
    }
  });

  pi.on("tool_execution_end", (event) => {
    const toolEvent = event as { toolCallId: string };
    engine.onToolEnd({ toolCallId: toolEvent.toolCallId, isError: false });
    parentNotified.delete(toolEvent.toolCallId);
    if (recorder && publishedHangs.delete(toolEvent.toolCallId)) {
      recorder.hangUpdate(undefined);
    }
  });

  pi.on("ui_prompt_start", () => {
    engine.onUiPromptStart();
  });

  pi.on("ui_prompt_end", () => {
    engine.onUiPromptEnd();
  });

  pi.on("agent_settled", () => {
    engine.onAgentSettled();
    for (const toolCallId of publishedHangs.keys()) {
      publishedHangs.delete(toolCallId);
      recorder?.hangUpdate(undefined);
    }
    // The abort path queued one structured report: deliver it as a new user
    // message so the model learns why the turn ended and adapts (D5). The
    // engine's resume cap makes this bounded; a null report means the cap is
    // reached and the session stays in observe for this command.
    const report: GuardActionReport | null = engine.consumeResume();
    if (report) {
      try {
        pi.sendUserMessage(resumeMessage(report), { deliverAs: "followUp" });
      } catch {
        // A failed delivery must not break the session.
      }
    }
  });

  pi.on("session_shutdown", () => {
    engine.onShutdown();
    stop();
  });
}
