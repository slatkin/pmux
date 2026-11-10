/**
 * The sidebar publisher, tested without pi, tmux or a sidebar: the builders
 * are pure, the lookup takes its file check, the spawner is injected, and
 * deferred publishes are awaited with a setImmediate tick.
 */
import "./host-env.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildActivityLog,
  buildNotification,
  buildSessionEnd,
  buildSessionStart,
  buildStop,
  buildStopFailure,
  buildUserPromptSubmit,
  createSidebarPublisher,
  resolveSidebarBinary,
  sidebarSwitchEnabled,
  worktreeFromOptions,
  type SidebarDeps,
  type SidebarEvent,
} from "../pi-extension/pmux/sidebar.ts";
import { exitOneSidebarChild, flushSidebarQueue, makeSidebarSpawn } from "./sidebar-fakes.ts";

const existsNever = () => false;

const ENV = { TMUX: "/tmp/tmux-0/default", TMUX_PANE: "%7", PATH: "/usr/bin" };
const BIN = "/opt/sidebar/bin/pmux-explorer";
const binaryThere = (path: string) => path === BIN;

async function publishWith(
  deps: Partial<SidebarDeps>,
  event: SidebarEvent,
  payload: Record<string, unknown>,
) {
  const { spawn, calls } = makeSidebarSpawn();
  createSidebarPublisher({ env: ENV, exists: existsNever, spawn, ...deps }).publish(event, payload);
  await flushSidebarQueue();
  return calls;
}

describe("resolveSidebarBinary", () => {
  const existsFor = (paths: string[]) => (path: string) => paths.includes(path);
  const homeBin = "/home/u/.tmux/plugins/pmux-explorer/bin/pmux-explorer";
  const homeRelease = "/home/u/.tmux/plugins/pmux-explorer/target/release/pmux-explorer";

  it("walks the order: override, plugin bin, plugin release, PATH, none", () => {
    const cases = [
      {
        env: { PMUX_EXPLORER_BIN: BIN, HOME: "/home/u", PATH: "" },
        exists: existsFor([BIN, homeBin]),
        want: BIN,
      },
      {
        env: { PMUX_EXPLORER_BIN: BIN, HOME: "/home/u", PATH: "" },
        exists: existsFor([homeBin]),
        want: homeBin,
      },
      { env: { HOME: "/home/u", PATH: "" }, exists: existsFor([homeRelease]), want: homeRelease },
      {
        env: { HOME: "/home/u", PATH: "/usr/local/bin:/usr/bin" },
        exists: existsFor(["/usr/bin/pmux-explorer"]),
        want: "/usr/bin/pmux-explorer",
      },
      { env: { HOME: "/home/u", PATH: "/usr/bin" }, exists: existsNever, want: null },
    ];
    for (const { env, exists, want } of cases) {
      assert.equal(resolveSidebarBinary(env, exists), want);
    }
  });
});

describe("payload builders", () => {
  const session = { cwd: "/work/app", sessionId: "s1" };

  it("carries the session's cwd and session_id on every session-scoped payload", () => {
    assert.deepEqual(buildSessionStart({ source: "startup", session }), {
      cwd: "/work/app",
      session_id: "s1",
      source: "startup",
    });
    assert.deepEqual(buildUserPromptSubmit({ prompt: "hi", session }), {
      prompt: "hi",
      cwd: "/work/app",
      session_id: "s1",
    });
    assert.deepEqual(buildStop({ lastAssistantMessage: "done", session }), {
      last_assistant_message: "done",
      cwd: "/work/app",
      session_id: "s1",
    });
    assert.deepEqual(buildStopFailure({ error: "provider exploded", session }), {
      error: "provider exploded",
      cwd: "/work/app",
      session_id: "s1",
    });
    assert.deepEqual(
      buildSessionStart({
        source: "startup",
        session,
        worktree: { path: "/work/app/.worktrees/foo", branch: "agent/foo" },
      }),
      {
        cwd: "/work/app",
        session_id: "s1",
        source: "startup",
        worktree: { path: "/work/app/.worktrees/foo", branch: "agent/foo" },
      },
    );
  });

  it("activity-log: tool start has no tool_response, tool end carries the result", () => {
    assert.deepEqual(buildActivityLog({ toolName: "bash", toolInput: { command: "ls" } }), {
      tool_name: "bash",
      tool_input: { command: "ls" },
    });
    assert.deepEqual(
      buildActivityLog({
        toolName: "read",
        toolInput: { path: "/a" },
        toolResponse: { content: "ok" },
      }),
      { tool_name: "read", tool_input: { path: "/a" }, tool_response: { content: "ok" } },
    );
  });

  it("notification names the kind of prompt; session-end names the reason", () => {
    assert.deepEqual(buildNotification({ waitReason: "confirm" }), {
      notification_type: "confirm",
    });
    assert.deepEqual(buildSessionEnd({ endReason: "quit" }), { end_reason: "quit" });
  });

  it("worktreeFromOptions reads both options and drops an absent pair", () => {
    assert.deepEqual(worktreeFromOptions({ worktree: "/repo/.wt/x", branch: "agent/x" }), {
      path: "/repo/.wt/x",
      branch: "agent/x",
    });
    assert.equal(worktreeFromOptions({ worktree: "", branch: "" }), undefined);
    assert.equal(worktreeFromOptions({}), undefined);
  });
});

describe("sidebarSwitchEnabled", () => {
  it("PMUX_EXPLORER=0 turns publishing off; anything else leaves it on", () => {
    assert.equal(sidebarSwitchEnabled({ PMUX_EXPLORER: "0" }), false);
    assert.equal(sidebarSwitchEnabled({}), true);
    assert.equal(sidebarSwitchEnabled({ PMUX_EXPLORER: "1" }), true);
  });
});

describe("publisher", () => {
  it("spawns the binary with the protocol command line and the payload on stdin", async () => {
    const calls = await publishWith(
      { env: { ...ENV, PMUX_EXPLORER_BIN: BIN }, exists: binaryThere },
      "user-prompt-submit",
      { prompt: "hi" },
    );
    assert.deepEqual(calls, [
      { command: BIN, args: ["hook", "pi", "user-prompt-submit"], stdin: '{"prompt":"hi"}' },
    ]);
  });

  it("refuses to publish, with no spawn, when a guard fails", () => {
    const cases = [
      {
        name: "switch off",
        deps: { env: { ...ENV, PMUX_EXPLORER: "0" }, exists: binaryThere },
      },
      { name: "no pane", deps: { env: {}, exists: binaryThere } },
      { name: "binary missing", deps: { exists: existsNever } },
    ];
    for (const { name, deps } of cases) {
      const { spawn, calls } = makeSidebarSpawn();
      createSidebarPublisher({ env: ENV, exists: existsNever, spawn, ...deps }).publish(
        "session-start",
        { cwd: "/w" },
      );
      assert.deepEqual(calls, [], name);
    }
  });

  it("defers the spawn, keeps the event order, and looks the binary up once", async () => {
    let lookups = 0;
    const { spawn, calls } = makeSidebarSpawn();
    const publisher = createSidebarPublisher({
      env: { ...ENV, PMUX_EXPLORER_BIN: BIN },
      exists: (path) => {
        lookups++;
        return path === BIN;
      },
      spawn,
    });
    publisher.publish("activity-log", { tool_name: "start" });
    publisher.publish("activity-log", { tool_name: "end" });
    // Nothing spawned inside the caller's turn: the work happens later.
    assert.deepEqual(calls, []);
    await flushSidebarQueue();
    assert.deepEqual(
      calls.map((call) => call.stdin),
      ['{"tool_name":"start"}', '{"tool_name":"end"}'],
    );
    publisher.publishSync("session-end", { end_reason: "quit" });
    // publishSync emits without a flush; one lookup serves the whole session.
    assert.equal(publisher.canPublish(), true);
    assert.equal(lookups, 1);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[2], {
      command: BIN,
      args: ["hook", "pi", "session-end"],
      stdin: '{"end_reason":"quit"}',
    });
  });

  it("spawns the next hook only after the previous one exited", async () => {
    // The regression: pi emits `session_start` and the first `input` inside
    // one synchronous startup stretch, so their hook processes used to spawn
    // concurrently and could apply out of order — the session-start reset
    // landing last pinned the pane at `idle` for the whole run. The queue
    // spawns hook two only after hook one exited.
    const { spawn, calls } = makeSidebarSpawn();
    const publisher = createSidebarPublisher({
      env: { ...ENV, PMUX_EXPLORER_BIN: BIN },
      exists: binaryThere,
      spawn,
    });
    publisher.publish("session-start", { cwd: "/w", session_id: "s1" });
    publisher.publish("user-prompt-submit", { prompt: "task", cwd: "/w", session_id: "s1" });
    // One tick: both publishes enqueued, the first hook spawned, the second
    // one still waiting for the first child's exit.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1, "the second hook waits for the first child's exit");
    assert.deepEqual(calls[0].args, ["hook", "pi", "session-start"]);
    exitOneSidebarChild();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].args, ["hook", "pi", "user-prompt-submit"]);
    exitOneSidebarChild();
  });

  it("publishAfter reserves its slot before the payload loads, so the order holds", async () => {
    const { spawn, calls } = makeSidebarSpawn();
    const publisher = createSidebarPublisher({
      env: { ...ENV, PMUX_EXPLORER_BIN: BIN },
      exists: binaryThere,
      spawn,
    });
    let release!: (payload: Record<string, unknown>) => void;
    const loaded = new Promise<Record<string, unknown>>((resolve) => {
      release = resolve;
    });
    publisher.publishAfter("session-start", () => loaded);
    publisher.publish("user-prompt-submit", { prompt: "task" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [], "the loaded payload holds the head of the queue");
    release({ cwd: "/w", worktree: { path: "/wt", branch: "agent/x" } });
    await flushSidebarQueue();
    assert.deepEqual(
      calls.map((call) => call.args[2]),
      ["session-start", "user-prompt-submit"],
    );
    assert.deepEqual(JSON.parse(calls[0].stdin), {
      cwd: "/w",
      worktree: { path: "/wt", branch: "agent/x" },
    });
  });

  it("a payload that fails to load publishes nothing and the queue moves on", async () => {
    const { spawn, calls } = makeSidebarSpawn();
    const publisher = createSidebarPublisher({
      env: { ...ENV, PMUX_EXPLORER_BIN: BIN },
      exists: binaryThere,
      spawn,
    });
    publisher.publishAfter("session-start", () => Promise.reject(new Error("tmux is gone")));
    publisher.publish("activity-log", { tool_name: "bash" });
    await flushSidebarQueue();
    assert.deepEqual(
      calls.map((call) => call.args[2]),
      ["activity-log"],
      "one failed read does not poison the chain",
    );
  });

  it("publishAfter publishes nothing when a guard fails", async () => {
    let loads = 0;
    const { spawn, calls } = makeSidebarSpawn();
    createSidebarPublisher({
      env: { ...ENV, PMUX_EXPLORER: "0" },
      exists: binaryThere,
      spawn,
    }).publishAfter("session-start", () => {
      loads++;
      return Promise.resolve({ cwd: "/w" });
    });
    await flushSidebarQueue();
    assert.equal(loads, 0);
    assert.deepEqual(calls, []);
  });

  it("moves the queue on when a hook stalls past the stall bound", async () => {
    const { spawn, calls } = makeSidebarSpawn();
    const publisher = createSidebarPublisher({
      env: { ...ENV, PMUX_EXPLORER_BIN: BIN },
      exists: binaryThere,
      spawn,
      hookStallMs: 5,
    });
    publisher.publish("session-start", { cwd: "/w", session_id: "s1" });
    publisher.publish("user-prompt-submit", { prompt: "task", cwd: "/w", session_id: "s1" });
    // One tick spawns the first hook; flushSidebarQueue would exit it, and
    // this test needs it stuck, so the queue advances only via the stall.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 2, "a stalled hook must not strand the queue");
  });

  it("swallows a throwing spawner and a throwing stdin, and writes nothing to the output", async () => {
    const spawnCalls = await publishWith(
      {
        exists: binaryThere,
        spawn: () => {
          throw new Error("EACCES");
        },
      },
      "activity-log",
      { tool_name: "bash" },
    );
    assert.deepEqual(spawnCalls, []);
    const writes: string[] = [];
    let published = false;
    createSidebarPublisher({
      env: ENV,
      exists: binaryThere,
      spawn: () => ({
        stdin: {
          write(chunk: string) {
            writes.push(chunk);
            throw new Error("EPIPE");
          },
          end() {
            published = true;
          },
        },
        onExit() {},
      }),
    }).publish("stop", { last_assistant_message: "x" });
    await flushSidebarQueue();
    assert.deepEqual(writes, []);
    assert.equal(published, false);
  });
});
