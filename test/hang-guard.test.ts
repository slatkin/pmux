import { describe, it, beforeEach, afterEach, type MockTimers } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTIVITY_RECORDER_KEY,
  createSubagentActivityRecorder,
  readSubagentActivityFile,
} from "../pi-extension/pmux/activity.ts";
import { resolveGuardConfig } from "../pi-extension/pmux/hang-guard.ts";
import { createSoftKiller } from "../pi-extension/pmux/hang-guard.ts";
import hangGuardExtension from "../pi-extension/pmux/hang-guard.ts";

// --- helpers ---

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "hang-guard-test-"));
}

const ENV_KEYS = [
  "PI_PMUX_SESSION",
  "PI_PMUX_AUTO_EXIT",
  "PI_PMUX_EXTERNAL_PARENT",
  "PI_PMUX_NAME",
  "PI_PMUX_GUARD_MODE",
  "PI_PMUX_GUARD_DISABLED",
] as const;

interface MockApi {
  handlers: Map<string, Array<(event: unknown, ctx: unknown) => void>>;
  sentUserMessages: Array<{ text: string; options: unknown }>;
  abortChecks: boolean[];
  api: {
    on(event: string, handler: (event: unknown, ctx: unknown) => void): void;
    sendUserMessage(text: string, options?: unknown): void;
  };
  dispatch(event: string, payload?: unknown): void;
}

function createMockApi(): MockApi {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void>>();
  const sentUserMessages: Array<{ text: string; options: unknown }> = [];
  const abortChecks: boolean[] = [];
  const api = {
    on(event: string, handler: (event: unknown, ctx: unknown) => void) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendUserMessage(text: string, options?: unknown) {
      sentUserMessages.push({ text, options });
    },
  };
  return {
    handlers,
    sentUserMessages,
    abortChecks,
    api: api as unknown as MockApi["api"],
    dispatch(event: string, payload = {}) {
      for (const handler of handlers.get(event) ?? []) handler(payload, undefined);
    },
  };
}

/** Dispatch `session_start` with a context every registration on this api sees. */
function startSession(mock: MockApi, ctx: unknown): void {
  for (const handler of mock.handlers.get("session_start") ?? []) handler({}, ctx);
}

function toolStart(toolCallId: string, command: string, toolName = "bash"): unknown {
  return { toolCallId, toolName, args: { command } };
}

interface NotifyRecord {
  message: string;
  level?: string;
}

function createCtx(notifies: NotifyRecord[], abortLog: boolean[] = []) {
  return {
    ui: {
      notify: (message: string, level?: string) => {
        notifies.push({ message, level });
      },
    },
    abort: () => {
      abortLog.push(existsSync(markerFile));
    },
  };
}

// The guard reads its env at registration time and the shared recorder at
// registration time, so each test stages both before registering.
let dir: string;
let sessionFile: string;
let markerFile: string;
let savedEnv: Record<string, string | undefined>;
let savedRecorder: unknown;

function stageChildEnv(overrides: Record<string, string | undefined> = {}): void {
  process.env.PI_PMUX_SESSION = sessionFile;
  process.env.PI_PMUX_AUTO_EXIT = "1";
  delete process.env.PI_PMUX_EXTERNAL_PARENT;
  process.env.PI_PMUX_NAME = "Worker";
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete (process.env as Record<string, unknown>)[key];
    else process.env[key] = value;
  }
}

beforeEach(() => {
  dir = createTestDir();
  sessionFile = join(dir, "child-session.jsonl");
  markerFile = `${sessionFile}.interrupt`;
  // A previous test's ticker stop belongs to a mock-timers controller that has
  // already been restored; clearing it again from this test's controller would
  // poison this controller's tick bookkeeping. Its interval is dead either way.
  delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("pmux/hang-guard-timer")];
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  savedRecorder = (globalThis as unknown as Record<symbol, unknown>)[ACTIVITY_RECORDER_KEY];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  if (savedRecorder === undefined) {
    delete (globalThis as unknown as Record<symbol, unknown>)[ACTIVITY_RECORDER_KEY];
  } else {
    (globalThis as unknown as Record<symbol, unknown>)[ACTIVITY_RECORDER_KEY] = savedRecorder;
  }
  rmSync(dir, { recursive: true, force: true });
});

// --- tests ---

describe("hang-guard mode resolution", () => {
  it("resolves the mode matrix from the child env", () => {
    // No pmux env at all: a parent session or standalone agent.
    assert.deepEqual(resolveGuardConfig({} as NodeJS.ProcessEnv), {
      enabled: true,
      mode: "observe",
    });
    // A pmux child that auto-exits (the non-interactive default).
    assert.deepEqual(
      resolveGuardConfig({
        PI_PMUX_SESSION: "s",
        PI_PMUX_AUTO_EXIT: "1",
      } as unknown as NodeJS.ProcessEnv),
      { enabled: true, mode: "yolo" },
    );
    // An interactive pmux child: a user may be driving the pane.
    assert.deepEqual(resolveGuardConfig({ PI_PMUX_SESSION: "s" } as unknown as NodeJS.ProcessEnv), {
      enabled: true,
      mode: "observe",
    });
    // An explicit env override wins over every default.
    assert.deepEqual(
      resolveGuardConfig({
        PI_PMUX_SESSION: "s",
        PI_PMUX_AUTO_EXIT: "1",
        PI_PMUX_GUARD_MODE: "guard",
      } as unknown as NodeJS.ProcessEnv),
      { enabled: true, mode: "guard" },
    );
    // An unknown mode is no override: the default applies.
    assert.deepEqual(
      resolveGuardConfig({
        PI_PMUX_SESSION: "s",
        PI_PMUX_AUTO_EXIT: "1",
        PI_PMUX_GUARD_MODE: "yolo?",
      } as unknown as NodeJS.ProcessEnv),
      { enabled: true, mode: "yolo" },
    );
    // The disable switch wins over everything.
    assert.deepEqual(
      resolveGuardConfig({
        PI_PMUX_SESSION: "s",
        PI_PMUX_AUTO_EXIT: "1",
        PI_PMUX_GUARD_MODE: "guard",
        PI_PMUX_GUARD_DISABLED: "1",
      } as unknown as NodeJS.ProcessEnv),
      { enabled: false, mode: "observe" },
    );
  });
});

describe("hang-guard extension", () => {
  it("writes the interrupt marker before the abort and delivers the report as a user message", (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "Date"] });
    // `guard` isolates the abort path from the yolo soft-kill branch, whose
    // real killer would resolve against the installed pi.
    stageChildEnv({ PI_PMUX_GUARD_MODE: "guard" });
    const activityFile = join(dir, "worker.activity.json");
    const recorder = createSubagentActivityRecorder({
      runningChildId: "worker",
      activityFile,
    });
    (globalThis as unknown as Record<symbol, unknown>)[ACTIVITY_RECORDER_KEY] = recorder;

    const mock = createMockApi();
    hangGuardExtension(mock.api as never);
    const notifies: NotifyRecord[] = [];
    const abortLog: boolean[] = [];
    startSession(mock, createCtx(notifies, abortLog));

    mock.dispatch("tool_execution_start", toolStart("t1", "sleep 600"));
    (t.mock.timers as MockTimers).tick(160_000);

    // The marker was on disk at the moment abort ran, so `pmux-done` reads the
    // abort as parent-driven and keeps the session open.
    assert.equal(abortLog.length, 1);
    assert.equal(abortLog[0], true);
    assert.ok(existsSync(markerFile), "the marker outlives the abort for pmux-done to take");

    // The structured report lands as a follow-up user message.
    mock.dispatch("agent_settled");
    assert.equal(mock.sentUserMessages.length, 1);
    assert.match(mock.sentUserMessages[0].text, /sleep 600/);
    assert.match(mock.sentUserMessages[0].text, /aborted automatically/);
  });

  it("appends exactly one parent message at critical and never repeats it", (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "Date"] });
    stageChildEnv({ PI_PMUX_GUARD_MODE: "guard" });
    const activityFile = join(dir, "worker.activity.json");
    (globalThis as unknown as Record<symbol, unknown>)[ACTIVITY_RECORDER_KEY] =
      createSubagentActivityRecorder({ runningChildId: "worker", activityFile });

    const mock = createMockApi();
    hangGuardExtension(mock.api as never);
    startSession(mock, createCtx([]));

    mock.dispatch("tool_execution_start", toolStart("t1", "sleep 600"));
    (t.mock.timers as MockTimers).tick(400_000);

    const msgFile = `${sessionFile}.msg`;
    assert.ok(existsSync(msgFile), "a critical hang steers the pi parent");
    const lines = readFileSync(msgFile, "utf8").trim().split("\n");
    assert.equal(lines.length, 1, "repeated critical ticks do not re-append");
    const payload = JSON.parse(lines[0]) as { header: string; message: string };
    assert.match(payload.header, /Worker/);
    assert.match(payload.message, /sleep 600/);
    assert.match(payload.message, /without output/);
  });

  it("sends nothing to a parent for an external orchestrator child or with no parent", (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "Date"] });
    // External orchestrator child: the hang is visible in the activity file
    // and the status, not steered.
    stageChildEnv({ PI_PMUX_GUARD_MODE: "guard", PI_PMUX_EXTERNAL_PARENT: "1" });
    const activityFile = join(dir, "worker.activity.json");
    const recorder = createSubagentActivityRecorder({
      runningChildId: "worker",
      activityFile,
    });
    (globalThis as unknown as Record<symbol, unknown>)[ACTIVITY_RECORDER_KEY] = recorder;

    const mock = createMockApi();
    hangGuardExtension(mock.api as never);
    startSession(mock, createCtx([]));
    mock.dispatch("tool_execution_start", toolStart("t1", "sleep 600"));
    (t.mock.timers as MockTimers).tick(400_000);

    assert.equal(
      existsSync(`${sessionFile}.msg`),
      false,
      "no steering channel for an external parent",
    );
    // The hang block is still published for the status/activity channel.
    const read = readSubagentActivityFile(activityFile, "worker");
    assert.ok(read.ok);
    assert.equal(read.activity.hang?.level, 2);
    // The child still handles its own hang: the abort fired (guard mode), so
    // the marker is written for `pmux-done`.
    assert.ok(existsSync(markerFile), "the child still handles its own hang");
  });

  it("writes no activity state when the shared recorder is absent", (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "Date"] });
    stageChildEnv({ PI_PMUX_GUARD_MODE: "guard" });
    delete (globalThis as unknown as Record<symbol, unknown>)[ACTIVITY_RECORDER_KEY];

    const mock = createMockApi();
    hangGuardExtension(mock.api as never);
    const notifies: NotifyRecord[] = [];
    startSession(mock, createCtx(notifies));

    mock.dispatch("tool_execution_start", toolStart("t1", "sleep 600"));
    (t.mock.timers as MockTimers).tick(200_000);

    assert.ok(notifies.length > 0, "the watchdog still reports in the pane");
    assert.ok(existsSync(markerFile), "the abort path does not need the recorder");
  });

  it("retracts the hang block when the execution produces output or ends", (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "Date"] });
    stageChildEnv({ PI_PMUX_GUARD_MODE: "observe" });
    const activityFile = join(dir, "worker.activity.json");
    const recorder = createSubagentActivityRecorder({
      runningChildId: "worker",
      activityFile,
    });
    (globalThis as unknown as Record<symbol, unknown>)[ACTIVITY_RECORDER_KEY] = recorder;

    const mock = createMockApi();
    hangGuardExtension(mock.api as never);
    startSession(mock, createCtx([]));
    mock.dispatch("tool_execution_start", toolStart("t1", "sleep 600"));
    (t.mock.timers as MockTimers).tick(160_000);

    let read = readSubagentActivityFile(activityFile, "worker");
    assert.ok(read.ok);
    assert.ok(read.activity.hang, "a flagged execution publishes the hang block");

    mock.dispatch("tool_execution_update", { toolCallId: "t1" });
    read = readSubagentActivityFile(activityFile, "worker");
    assert.ok(read.ok);
    assert.equal(read.activity.hang, undefined, "output clears the hang block");

    mock.dispatch("tool_execution_start", toolStart("t2", "sleep 600"));
    (t.mock.timers as MockTimers).tick(160_000);
    read = readSubagentActivityFile(activityFile, "worker");
    assert.ok(read.ok);
    assert.ok(read.activity.hang, "the second call publishes again");

    mock.dispatch("tool_execution_end", { toolCallId: "t2" });
    read = readSubagentActivityFile(activityFile, "worker");
    assert.ok(read.ok);
    assert.equal(read.activity.hang, undefined, "the end clears the hang block");
  });

  it("a second registration retires the first registration's ticker", (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "Date"] });
    stageChildEnv();
    const activityFile = join(dir, "worker.activity.json");
    const recorder = createSubagentActivityRecorder({
      runningChildId: "worker",
      activityFile,
    });
    (globalThis as unknown as Record<symbol, unknown>)[ACTIVITY_RECORDER_KEY] = recorder;

    const first = createMockApi();
    hangGuardExtension(first.api as never);
    const second = createMockApi();
    hangGuardExtension(second.api as never);

    const firstNotifies: NotifyRecord[] = [];
    startSession(first, createCtx(firstNotifies));
    startSession(second, createCtx([]));

    // Only the first registration's engine sees this tool; its ticker was
    // retired by the second registration, so nothing escalates.
    first.dispatch("tool_execution_start", toolStart("t1", "sleep 600"));
    (t.mock.timers as MockTimers).tick(400_000);
    assert.equal(firstNotifies.length, 0, "the retired ticker never fires");
  });
});

describe("hang-guard soft killer", () => {
  it("resolves pi's tracked-children killer and reports unavailability", async () => {
    const shellModule = { killTrackedDetachedChildren: () => {} };
    const killer = createSoftKiller((specifier: string) => {
      if (specifier.includes("shell.js")) return Promise.resolve(shellModule);
      return Promise.resolve({ getPackageDir: () => "/pkg" });
    });

    // First call resolves lazily: pending, not a failure.
    const pending = killer();
    assert.equal(pending.ok, false);
    assert.equal(pending.pending, true);

    await new Promise((resolve) => setTimeout(resolve, 10));
    const outcome = killer();
    assert.equal(outcome.ok, true);
  });

  it("reports a missing capability as unavailable, never pending", async () => {
    const killer = createSoftKiller(() => Promise.resolve({}));
    assert.equal(killer().pending, true, "the first call is pending, not a failure");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const outcome = killer();
    assert.equal(outcome.ok, false);
    assert.equal(outcome.pending, undefined);
    assert.match(outcome.detail, /unavailable/);
  });

  it("reports a rejected import as unavailable", async () => {
    const killer = createSoftKiller(() => Promise.reject(new Error("no sdk")));
    assert.equal(killer().pending, true, "the first call starts the resolution");
    // Let the rejection chain settle.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const outcome = killer();
    assert.equal(outcome.ok, false);
    assert.equal(outcome.pending, undefined);
    assert.match(outcome.detail, /no sdk/);
  });
});
