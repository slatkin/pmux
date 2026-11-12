import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_GUARD_SETTINGS,
  createHangGuardEngine,
  formatDuration,
  observationText,
  previewCommand,
  resumeMessage,
  type HangGuardSettings,
  type NotifyLevel,
} from "../pi-extension/pmux/hang-engine.ts";

interface Harness {
  engine: ReturnType<typeof createHangGuardEngine>;
  notifications: Array<{ message: string; level: NotifyLevel }>;
  advance(ms: number): void;
  tick(): void;
  setSettings(patch: Partial<HangGuardSettings>): void;
  actions: {
    softKillCalls: number;
    abortCalls: number;
    softKillOutcome: { ok: boolean; detail: string; pending?: boolean };
  };
}

function createHarness(patch: Partial<HangGuardSettings> = {}): Harness {
  let clock = 0;
  let settings: HangGuardSettings = { ...DEFAULT_GUARD_SETTINGS, ...patch };
  const notifications: Array<{ message: string; level: NotifyLevel }> = [];
  const actions = {
    softKillCalls: 0,
    abortCalls: 0,
    softKillOutcome: { ok: true, detail: "killed 1 tracked child" } as {
      ok: boolean;
      detail: string;
      pending?: boolean;
    },
  };

  const engine = createHangGuardEngine({
    now: () => clock,
    settings: () => settings,
    ui: {
      notify: (message, level) => {
        notifications.push({ message, level });
      },
    },
    actions: {
      softKill: () => {
        actions.softKillCalls += 1;
        return actions.softKillOutcome;
      },
      abortTurn: () => {
        actions.abortCalls += 1;
      },
    },
  });

  return {
    engine,
    notifications,
    actions,
    advance(ms) {
      clock += ms;
    },
    tick() {
      engine.tick();
    },
    setSettings(next) {
      settings = { ...settings, ...next };
    },
  };
}

function startBash(harness: Harness, toolCallId: string, command: string, toolName = "bash"): void {
  harness.engine.onToolStart({ toolCallId, toolName, args: { command } });
}

describe("hang-engine (vendored pi-hang-guard engine)", () => {
  it("warns when a streaming command stops producing output", () => {
    const h = createHarness({ idleWarnSec: 90, idleCriticalSec: 150 });
    startBash(h, "t1", "sleep 600");

    h.advance(89_000);
    h.tick();
    assert.equal(h.notifications.length, 0, "must not warn before the threshold");

    h.advance(1_000);
    h.tick();
    assert.equal(h.notifications.length, 1);
    assert.equal(h.notifications[0].level, "warning");
    assert.match(h.notifications[0].message, /idle/);
    assert.match(h.notifications[0].message, /sleep 600/);
  });

  it("critical fires past the critical threshold and stays warning below it", () => {
    const h = createHarness({ idleWarnSec: 10, idleCriticalSec: 20 });
    startBash(h, "t1", "sleep 600");

    h.advance(15_000);
    h.tick();
    assert.equal(h.notifications[0].level, "warning");

    h.advance(10_000);
    h.tick();
    assert.equal(h.notifications[1].level, "error");
  });

  it("an update resets the silence clock so busy commands never warn", () => {
    const h = createHarness({ idleWarnSec: 90, idleCriticalSec: 150 });
    startBash(h, "t1", "npm run build");

    for (let i = 0; i < 5; i += 1) {
      h.advance(80_000);
      h.engine.onToolUpdate({ toolCallId: "t1" });
      h.tick();
    }
    assert.equal(h.notifications.length, 0, "5 minutes of work with output must not warn");

    h.advance(95_000);
    h.tick();
    assert.equal(h.notifications.length, 1, "warn only after 95s of true silence");
  });

  it("a non-streaming tool is measured by wall clock, not by silence", () => {
    const h = createHarness({ runtimeWarnSec: 180, runtimeCriticalSec: 600 });
    h.engine.onToolStart({ toolCallId: "r1", toolName: "read", args: { path: "/tmp/x" } });

    h.advance(179_000);
    h.tick();
    assert.equal(h.notifications.length, 0);

    h.advance(2_000);
    h.tick();
    assert.equal(h.notifications.length, 1);
    assert.match(h.notifications[0].message, /running \d/);
    assert.equal(h.engine.list()[0].basis, "runtime");
  });

  it("self-timed commands fall back to wall clock", () => {
    const h = createHarness({ idleWarnSec: 30, idleCriticalSec: 60, runtimeWarnSec: 180 });
    startBash(h, "t1", "timeout 600 npm run dev");

    h.advance(100_000);
    h.tick();
    assert.equal(
      h.notifications.length,
      0,
      "the command carries its own bound, so silence is expected",
    );
    assert.equal(h.engine.list()[0].basis, "runtime");
  });

  it("idle whitelist raises thresholds instead of disabling the guard", () => {
    const h = createHarness({
      idleWarnSec: 90,
      idleCriticalSec: 150,
      idleWhitelistWarnSec: 300,
      idleWhitelistCriticalSec: 600,
    });
    startBash(h, "t1", "docker build .");

    h.advance(200_000);
    h.tick();
    assert.equal(h.notifications.length, 0, "docker build may be silent for a while");

    h.advance(101_000);
    h.tick();
    assert.equal(h.notifications.length, 1);
  });

  it("interactive commands are skipped entirely", () => {
    const h = createHarness();
    startBash(h, "t1", "vim notes.md");

    assert.equal(h.engine.hasRunning(), false);
    assert.equal(h.engine.stats().skippedInteractive, 1);

    h.advance(3_600_000);
    h.tick();
    assert.equal(h.notifications.length, 0);
  });

  it("a blocking UI prompt freezes the accounting", () => {
    const h = createHarness({ idleWarnSec: 90, idleCriticalSec: 150 });
    startBash(h, "t1", "npm run dev");

    h.advance(30_000);
    h.tick();
    h.engine.onUiPromptStart();

    h.advance(630_000); // user is deciding for 10 minutes
    h.tick();
    assert.equal(h.notifications.length, 0, "waiting on the user is not a stuck command");

    h.engine.onUiPromptEnd();
    h.advance(59_000);
    h.tick();
    assert.equal(
      h.notifications.length,
      0,
      "the 30s before the prompt plus 59s after is still below 90s",
    );

    h.advance(2_000);
    h.tick();
    assert.equal(h.notifications.length, 1);
  });

  it("notifications are capped per tool call", () => {
    const capped = createHarness({
      idleWarnSec: 10,
      idleCriticalSec: 20,
      maxNotificationsPerCall: 1,
    });
    startBash(capped, "t1", "sleep 600");
    capped.advance(25_000);
    capped.tick();
    assert.equal(capped.notifications.length, 1, "cap of 1 keeps only the first alert");

    const uncapped = createHarness({ idleWarnSec: 10, idleCriticalSec: 20 });
    startBash(uncapped, "t1", "sleep 600");
    uncapped.advance(15_000);
    uncapped.tick();
    uncapped.advance(10_000);
    uncapped.tick();
    assert.equal(uncapped.notifications.length, 2, "both tiers are reported by default");
    assert.equal(uncapped.notifications[1].level, "error");
  });

  it("observe never acts even at critical", () => {
    const h = createHarness({ mode: "observe", idleWarnSec: 10, idleCriticalSec: 20 });
    startBash(h, "t1", "sleep 600");
    h.advance(30_000);
    h.tick();
    assert.equal(h.notifications.length, 1, "the critical alert still fires");
    assert.ok(h.notifications.some((n) => /Likely stuck/.test(n.message)));
    assert.equal(h.actions.softKillCalls, 0);
    assert.equal(h.actions.abortCalls, 0);
    assert.equal(h.engine.actionLog().length, 0);
  });

  it("guard aborts the turn at critical and delivers a structured report", () => {
    const h = createHarness({ mode: "guard", idleWarnSec: 10, idleCriticalSec: 20 });
    startBash(h, "t1", "sleep 600");
    h.advance(30_000);
    h.tick();

    assert.equal(h.actions.abortCalls, 1);
    const actions = h.engine.actionLog();
    assert.equal(actions.length, 1);
    assert.equal(actions[0].action, "abort");
    assert.equal(actions[0].toolCallId, "t1");
    assert.equal(actions[0].command, "sleep 600");

    const report = h.engine.consumeResume();
    assert.ok(report);
    const message = resumeMessage(report);
    assert.match(message, /sleep 600/);
    assert.match(message, /aborted automatically/);
    assert.equal(h.engine.consumeResume(), null, "the report is taken once");
  });

  it("yolo soft-kills first and the turn survives", () => {
    const h = createHarness({ mode: "yolo", idleWarnSec: 10, idleCriticalSec: 20 });
    startBash(h, "t1", "sleep 600");
    h.advance(30_000);
    h.tick();

    assert.equal(h.actions.softKillCalls, 1);
    assert.equal(h.actions.abortCalls, 0, "the turn is not aborted after a successful soft kill");
    assert.ok(h.engine.actionLog()[0].action === "soft-kill");
    assert.equal(h.engine.consumeResume(), null, "a soft kill queues no turn resume");
  });

  it("yolo falls back to abort when the soft kill is unavailable", () => {
    const h = createHarness({
      mode: "yolo",
      idleWarnSec: 10,
      idleCriticalSec: 20,
      softKillGraceSec: 1,
    });
    h.actions.softKillOutcome = { ok: false, detail: "bundled build; registry is private" };
    startBash(h, "t1", "sleep 600");
    h.advance(30_000);
    h.tick();

    assert.equal(h.actions.abortCalls, 1, "an unavailable soft kill degrades to the abort path");
    const actions = h.engine.actionLog();
    assert.equal(actions[0].action, "abort");
    assert.match(actions[0].softKillDetail ?? "", /soft kill unavailable/);
  });

  it("yolo falls back to abort when the command still runs after the grace period", () => {
    const h = createHarness({
      mode: "yolo",
      idleWarnSec: 10,
      idleCriticalSec: 20,
      softKillGraceSec: 5,
    });
    startBash(h, "t1", "sleep 600");
    h.advance(30_000);
    h.tick();
    assert.equal(h.actions.abortCalls, 0, "inside the grace period nothing more happens");

    h.advance(4_000);
    h.tick();
    assert.equal(h.actions.abortCalls, 0, "still inside the grace period");

    h.advance(2_000);
    h.tick();
    assert.equal(h.actions.abortCalls, 1, "past the grace period the turn is aborted");
  });

  it("yolo retries a pending killer instead of escalating at once", () => {
    const h = createHarness({ mode: "yolo", idleWarnSec: 10, idleCriticalSec: 20 });
    h.actions.softKillOutcome = { ok: false, detail: "resolving", pending: true };
    startBash(h, "t1", "sleep 600");
    h.advance(30_000);
    h.tick();
    assert.equal(h.actions.abortCalls, 0);

    h.actions.softKillOutcome = { ok: true, detail: "killed 1" };
    h.advance(1_000);
    h.tick();
    assert.equal(h.actions.abortCalls, 0);
    assert.equal(h.actions.softKillCalls, 2);
  });

  it("auto-resume is capped by maxAutoResumes", () => {
    const h = createHarness({
      mode: "guard",
      idleWarnSec: 10,
      idleCriticalSec: 20,
      maxAutoResumes: 1,
    });
    startBash(h, "t1", "sleep 600");

    h.advance(30_000);
    h.tick();
    assert.equal(h.engine.stats().resumes, 1);
    assert.ok(h.engine.consumeResume());

    // The action cooldown keeps the next critical tick from acting at once.
    h.advance(5_000);
    h.tick();
    assert.equal(h.actions.abortCalls, 1, "no second abort inside the cooldown");

    h.advance(120_000);
    h.tick();
    assert.equal(h.engine.stats().resumes, 1, "the second abort queues no resume: cap reached");
    assert.equal(h.engine.consumeResume(), null);
  });

  it("a zero maxAutoResumes disables resuming but still aborts", () => {
    const h = createHarness({
      mode: "guard",
      idleWarnSec: 10,
      idleCriticalSec: 20,
      maxAutoResumes: 0,
    });
    startBash(h, "t1", "sleep 600");
    h.advance(30_000);
    h.tick();
    assert.equal(h.actions.abortCalls, 1);
    assert.equal(h.engine.stats().resumes, 0);
    assert.equal(h.engine.consumeResume(), null);
  });

  it("agent_settled and shutdown clear every tracked tool", () => {
    const h = createHarness({ idleWarnSec: 10, idleCriticalSec: 20 });
    startBash(h, "a", "sleep 600");
    startBash(h, "b", "sleep 600");
    h.advance(15_000);
    h.tick();

    h.engine.onAgentSettled();
    assert.equal(h.engine.hasRunning(), false);

    startBash(h, "c", "sleep 600");
    h.advance(15_000);
    h.tick();
    h.engine.onShutdown();
    assert.equal(h.engine.hasRunning(), false);
  });

  it("a disabled guard tracks nothing", () => {
    const h = createHarness({ enabled: false });
    startBash(h, "t1", "sleep 600");
    assert.equal(h.engine.hasRunning(), false);
    h.advance(3_600_000);
    h.tick();
    assert.equal(h.notifications.length, 0);
  });

  it("toggling the guard off mid-run stops alerts", () => {
    const h = createHarness({ idleWarnSec: 90, idleCriticalSec: 150 });
    startBash(h, "t1", "sleep 600");
    h.advance(95_000);
    h.tick();
    assert.equal(h.notifications.length, 1);

    h.setSettings({ enabled: false });
    h.advance(600_000);
    h.tick();
    assert.equal(h.notifications.length, 1, "no further alerts while disabled");
  });

  it("a UI sink that throws cannot break bookkeeping", () => {
    let clock = 0;
    const engine = createHangGuardEngine({
      now: () => clock,
      settings: () => ({ ...DEFAULT_GUARD_SETTINGS, idleWarnSec: 10, idleCriticalSec: 20 }),
      ui: {
        notify() {
          throw new Error("stale UI context");
        },
      },
    });

    engine.onToolStart({ toolCallId: "t1", toolName: "bash", args: { command: "sleep 600" } });
    clock += 15_000;
    assert.doesNotThrow(() => engine.tick());
    engine.onToolEnd({ toolCallId: "t1", isError: false });
    assert.equal(engine.hasRunning(), false);
  });

  it("stats and list summarise the running set", () => {
    const h = createHarness({ idleWarnSec: 10, idleCriticalSec: 20 });
    startBash(h, "a", "npm run dev");
    startBash(h, "b", "vim x");
    h.advance(15_000);
    h.tick();

    const stats = h.engine.stats();
    assert.equal(stats.running, 1);
    assert.equal(stats.skippedInteractive, 1);
    assert.equal(stats.notifications, 1);

    const list = h.engine.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].toolCallId, "a");
    assert.equal(list[0].kind, "watcher");
    assert.equal(list[0].level, 1);
  });

  it("formats durations, observations and command previews", () => {
    assert.equal(formatDuration(95_000), "1m35s");
    assert.equal(formatDuration(90_000), "1m30s");
    assert.equal(formatDuration(3_600_000), "1h00m");
    assert.equal(observationText("idle", 90_000), "1m30s idle");
    assert.equal(observationText("runtime", 90_000), "running 1m30s");
    assert.equal(previewCommand("a\nb   c", 56), "a b c");
    assert.equal(previewCommand("x".repeat(80), 10).length, 10);
    assert.equal(previewCommand("", 56), "(no command)");
  });
});
