/**
 * Unit tests for the dialog host: the outer side's wait on the state file
 * (design D1). The popup call, the clock and the pid check are injected, so
 * the suite needs no tmux server, no popup and no real waiting.
 */
import "./host-env.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  DIALOG_HOST_LIMIT_MS,
  DIALOG_POLL_MS,
  DIALOG_STATE_ENV,
  DIALOG_STILL_OPEN_LINE,
  markDialogOpen,
  runDialog,
  writeDialogDone,
  type RunDialogArgs,
} from "../pi-extension/pmux/dialog-host.ts";
import type { PopupHandle } from "../pi-extension/pmux/tmux.ts";
import { tempDirHelpers } from "./temp-dir.ts";

const { withTempDirAsync } = tempDirHelpers("pmux-dialog-host-");

/** A caller env that satisfies the tmux check. */
const ENV: NodeJS.ProcessEnv = {
  TMUX: "/tmp/tmux-1000/default,1234,0",
  TMUX_PANE: "%5",
  PATH: "/usr/bin",
};

function dialogArgs(env: NodeJS.ProcessEnv = ENV): RunDialogArgs {
  return {
    title: "pmux roles",
    innerArgs: ["roles", "--inner", "--cwd", "/work", "--agent-dir", "/agent", "--pane", "%5"],
    cwd: "/work",
    agentDir: "/agent",
    env,
  };
}

/** A clock the injected sleep advances, so any wait runs instantly. */
function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    elapsed: () => t,
    sleeps,
  };
}

/** The `-e PMUX_DIALOG_STATE=<path>` value in a popup argv. */
function statePathFrom(args: string[]): string {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-e" && args[i + 1]!.startsWith(`${DIALOG_STATE_ENV}=`)) {
      return args[i + 1]!.slice(DIALOG_STATE_ENV.length + 1);
    }
  }
  throw new Error("the popup argv carries no state path");
}

interface FakePopup {
  calls: string[][];
  unrefs: number;
  /** The state path the last call carried. */
  statePath(): string;
  openPopup: (args: string[]) => PopupHandle;
}

/**
 * A fake `openPopup`: records the argv, and when `markOpen` is set writes
 * the inner side's `open` record with `pid`. `done` defaults to a promise
 * that never settles — a tmux client that waits for the popup.
 */
function fakePopup(
  options: { markOpen?: boolean; pid?: number; done?: Promise<void> } = {},
): FakePopup {
  const fake: FakePopup = {
    calls: [],
    unrefs: 0,
    statePath: () => {
      const last = fake.calls.at(-1);
      if (!last) throw new Error("openPopup was never called");
      return statePathFrom(last);
    },
    openPopup: (args) => {
      fake.calls.push(args);
      if (options.markOpen) markDialogOpen(statePathFrom(args), options.pid ?? 4242);
      return {
        done: options.done ?? new Promise<void>(() => {}),
        unref: () => {
          fake.unrefs += 1;
        },
      };
    },
  };
  return fake;
}

describe("dialog host", () => {
  it("opens the popup over the caller's pane with the state path in its env", async () => {
    await withTempDirAsync(async (dir) => {
      const clock = fakeClock();
      const popup = fakePopup({ markOpen: true });
      const env = { ...ENV, VISUAL: "vim", EDITOR: "nano", PAGER: "less" };
      const outcome = await runDialog(
        { ...dialogArgs(env), nodePath: "/usr/bin/node", cliPath: "/pkg/cli.ts" },
        {
          openPopup: popup.openPopup,
          now: clock.now,
          sleep: async (ms) => {
            await clock.sleep(ms);
            writeDialogDone(popup.statePath(), {});
          },
          pidAlive: () => true,
          makeDir: () => dir,
        },
      );
      assert.equal(outcome.kind, "done");
      assert.deepEqual(popup.calls, [
        [
          "display-popup",
          "-E",
          "-t",
          "%5",
          "-T",
          "pmux roles",
          "-w",
          "80%",
          "-h",
          "80%",
          "-d",
          "/work",
          "-e",
          `${DIALOG_STATE_ENV}=${dir}/state.json`,
          "-e",
          "PI_CODING_AGENT_DIR=/agent",
          "-e",
          "PATH=/usr/bin",
          "-e",
          "VISUAL=vim",
          "-e",
          "EDITOR=nano",
          "-e",
          "PAGER=less",
          "/usr/bin/node",
          "/pkg/cli.ts",
          "roles",
          "--inner",
          "--cwd",
          "/work",
          "--agent-dir",
          "/agent",
          "--pane",
          "%5",
        ],
      ]);
    });
  });

  it("leaves VISUAL, EDITOR and PAGER out of the popup env when the caller lacks them", async () => {
    await withTempDirAsync(async (dir) => {
      const clock = fakeClock();
      const popup = fakePopup({ markOpen: true });
      await runDialog(dialogArgs(), {
        openPopup: popup.openPopup,
        now: clock.now,
        sleep: async (ms) => {
          await clock.sleep(ms);
          writeDialogDone(popup.statePath(), {});
        },
        pidAlive: () => true,
        makeDir: () => dir,
      });
      const envPairs = popup.calls[0]!.filter((arg) => /^[A-Z_]+=/.test(arg));
      assert.deepEqual(envPairs, [
        `${DIALOG_STATE_ENV}=${dir}/state.json`,
        "PI_CODING_AGENT_DIR=/agent",
        "PATH=/usr/bin",
      ]);
    });
  });

  it("returns the inner side's done result", async () => {
    await withTempDirAsync(async (dir) => {
      const clock = fakeClock();
      const popup = fakePopup({ markOpen: true });
      const outcome = await runDialog(dialogArgs(), {
        openPopup: popup.openPopup,
        now: clock.now,
        sleep: async (ms) => {
          await clock.sleep(ms);
          if (clock.elapsed() >= 600) {
            writeDialogDone(popup.statePath(), { line: "edited model" });
          }
        },
        pidAlive: () => true,
        makeDir: () => dir,
      });
      assert.deepEqual(outcome, { kind: "done", result: { line: "edited model" } });
      // The private state dir is gone once the wait ended for good.
      assert.equal(existsSync(dir), false);
    });
  });

  it("reads a dead inner pid with no final state as a cancel", async () => {
    await withTempDirAsync(async (dir) => {
      const clock = fakeClock();
      // The inner side wrote `open`, then the user closed the popup with
      // Escape before a final state: the pid is dead, the file never final.
      const popup = fakePopup({ markOpen: true, pid: 4242 });
      const outcome = await runDialog(dialogArgs(), {
        openPopup: popup.openPopup,
        now: clock.now,
        sleep: clock.sleep,
        pidAlive: () => false,
        makeDir: () => dir,
      });
      assert.deepEqual(outcome, { kind: "cancel" });
      assert.equal(existsSync(dir), false);
    });
  });

  it("reports the popup's error and changes nothing", async () => {
    await withTempDirAsync(async (dir) => {
      const clock = fakeClock();
      const popup = fakePopup({ done: Promise.reject(new Error("unknown option: -T")) });
      await assert.rejects(
        runDialog(dialogArgs(), {
          openPopup: popup.openPopup,
          now: clock.now,
          sleep: clock.sleep,
          pidAlive: () => true,
          makeDir: () => dir,
        }),
        /unknown option: -T/,
      );
      // No inner pid ever opened, and the state dir is removed.
      assert.equal(existsSync(dir), false);
    });
  });

  it("refuses before any tmux call when TMUX_PANE is unset", async () => {
    let called = false;
    await assert.rejects(
      runDialog(dialogArgs({ TMUX: "/tmp/tmux-1000/default,1234,0" }), {
        openPopup: () => {
          called = true;
          return { done: new Promise<void>(() => {}), unref: () => {} };
        },
      }),
      /tmux/i,
    );
    assert.equal(called, false);
  });

  it("refuses before any tmux call when TMUX is unset", async () => {
    let called = false;
    await assert.rejects(
      runDialog(dialogArgs({ TMUX_PANE: "%5" }), {
        openPopup: () => {
          called = true;
          return { done: new Promise<void>(() => {}), unref: () => {} };
        },
      }),
      /tmux/i,
    );
    assert.equal(called, false);
  });

  it("keeps waiting past the five-second tmux call budget", async () => {
    await withTempDirAsync(async (dir) => {
      const clock = fakeClock();
      const popup = fakePopup({ markOpen: true });
      const outcome = await runDialog(dialogArgs(), {
        openPopup: popup.openPopup,
        now: clock.now,
        sleep: async (ms) => {
          await clock.sleep(ms);
          if (clock.elapsed() >= 6000) {
            writeDialogDone(popup.statePath(), { line: "done late" });
          }
        },
        pidAlive: () => true,
        makeDir: () => dir,
      });
      assert.equal(outcome.kind, "done");
      assert.ok(clock.elapsed() > 5000, `the wait ended at ${clock.elapsed()} ms`);
      // Every poll slept the 200 ms cadence design D1 names.
      assert.ok(clock.sleeps.every((ms) => ms === DIALOG_POLL_MS));
    });
  });

  it("fails the dialog when no open state appears within ten seconds", async () => {
    await withTempDirAsync(async (dir) => {
      const clock = fakeClock();
      // The popup call never settles and the state file never appears.
      const popup = fakePopup();
      await assert.rejects(
        runDialog(dialogArgs(), {
          openPopup: popup.openPopup,
          now: clock.now,
          sleep: clock.sleep,
          pidAlive: () => true,
          makeDir: () => dir,
        }),
        /did not open within 10 seconds/,
      );
    });
  });

  it("stops at the host limit with the still-open line", async () => {
    await withTempDirAsync(async (dir) => {
      const clock = fakeClock();
      const popup = fakePopup({ markOpen: true, done: Promise.resolve() });
      const outcome = await runDialog(
        { ...dialogArgs(), stopAfterMs: DIALOG_HOST_LIMIT_MS },
        {
          openPopup: popup.openPopup,
          now: clock.now,
          sleep: clock.sleep,
          pidAlive: () => true,
          makeDir: () => dir,
        },
      );
      assert.deepEqual(outcome, { kind: "still-open", line: DIALOG_STILL_OPEN_LINE });
      assert.equal(clock.elapsed(), DIALOG_HOST_LIMIT_MS);
      assert.equal(popup.unrefs, 1);
      // The state dir stays: the inner side may still be writing.
      assert.equal(existsSync(dir), true);
    });
  });

  it("completes the host-limit stop while the popup call never settles", async () => {
    await withTempDirAsync(async (dir) => {
      const clock = fakeClock();
      // `done` never settles: a tmux client that waits for the popup. The
      // 100-second stop must still finish, and unref releases that client.
      const popup = fakePopup({ markOpen: true });
      const outcome = await runDialog(
        { ...dialogArgs(), stopAfterMs: DIALOG_HOST_LIMIT_MS },
        {
          openPopup: popup.openPopup,
          now: clock.now,
          sleep: clock.sleep,
          pidAlive: () => true,
          makeDir: () => dir,
        },
      );
      assert.deepEqual(outcome, { kind: "still-open", line: DIALOG_STILL_OPEN_LINE });
      assert.equal(popup.unrefs, 1);
      assert.equal(existsSync(dir), true);
    });
  });
});
