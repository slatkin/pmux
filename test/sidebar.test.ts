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
  lastAssistantMessage,
  resolveSidebarBinary,
  sidebarSwitchEnabled,
  stopFailureError,
  worktreeFromOptions,
  type SidebarChild,
} from "../pi-extension/pmux/sidebar.ts";

const existsNever = () => false;

/** A fake spawner that records the command line and the stdin JSON. */
function makeSpawn() {
  const calls: Array<{ command: string; args: string[]; stdin: string }> = [];
  const spawn = (command: string, args: string[]): SidebarChild => {
    calls.push({ command, args, stdin: "" });
    return {
      stdin: {
        write(chunk: string) {
          calls[calls.length - 1].stdin += chunk;
          return true;
        },
        end() {},
      },
    };
  };
  return { spawn, calls };
}

const ENV = { TMUX: "/tmp/tmux-0/default", TMUX_PANE: "%7", PATH: "/usr/bin" };
const BIN = "/opt/sidebar/bin/tmux-agent-sidebar";
const binaryThere = (path: string) => path === BIN;

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function publishWith(
  deps: Partial<Parameters<typeof createSidebarPublisher>[0]>,
  event: string,
  payload: unknown,
) {
  const { spawn, calls } = makeSpawn();
  createSidebarPublisher({
    env: ENV,
    exists: existsNever,
    spawn,
    ...deps,
  } as Parameters<typeof createSidebarPublisher>[0]).publish(event, payload);
  await flush();
  return calls;
}

describe("resolveSidebarBinary", () => {
  const existsFor = (paths: string[]) => (path: string) => paths.includes(path);
  const homeBin = "/home/u/.tmux/plugins/tmux-agent-sidebar/bin/tmux-agent-sidebar";
  const homeRelease = "/home/u/.tmux/plugins/tmux-agent-sidebar/target/release/tmux-agent-sidebar";

  it("walks the order: override, plugin bin, plugin release, PATH, none", () => {
    const cases = [
      {
        env: { TMUX_AGENT_SIDEBAR_BIN: BIN, HOME: "/home/u", PATH: "" },
        exists: existsFor([BIN, homeBin]),
        want: BIN,
      },
      {
        env: { TMUX_AGENT_SIDEBAR_BIN: BIN, HOME: "/home/u", PATH: "" },
        exists: existsFor([homeBin]),
        want: homeBin,
      },
      { env: { HOME: "/home/u", PATH: "" }, exists: existsFor([homeRelease]), want: homeRelease },
      {
        env: { HOME: "/home/u", PATH: "/usr/local/bin:/usr/bin" },
        exists: existsFor(["/usr/bin/tmux-agent-sidebar"]),
        want: "/usr/bin/tmux-agent-sidebar",
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

  it("lastAssistantMessage takes the last assistant message's text", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "a " },
          { type: "text", text: "b" },
        ],
        stopReason: "stop",
      },
      { role: "user", content: [{ type: "text", text: "noise" }] },
    ];
    assert.deepEqual(lastAssistantMessage(messages), {
      text: "a b",
      stopReason: "stop",
      errorMessage: undefined,
    });
  });

  it("lastAssistantMessage returns null without an assistant message", () => {
    assert.equal(lastAssistantMessage([{ role: "user", content: [] }]), null);
    assert.equal(lastAssistantMessage([]), null);
  });

  it("stopFailureError prefers pi's error message, then the stop reason", () => {
    assert.equal(stopFailureError({ text: "", stopReason: "error", errorMessage: "boom" }), "boom");
    assert.equal(stopFailureError({ text: "", stopReason: "error" }), "error");
    assert.equal(stopFailureError(null), "error");
  });
});

describe("sidebarSwitchEnabled", () => {
  it("TMUX_AGENT_SIDEBAR=0 turns publishing off; anything else leaves it on", () => {
    assert.equal(sidebarSwitchEnabled({ TMUX_AGENT_SIDEBAR: "0" }), false);
    assert.equal(sidebarSwitchEnabled({}), true);
    assert.equal(sidebarSwitchEnabled({ TMUX_AGENT_SIDEBAR: "1" }), true);
  });
});

describe("publisher", () => {
  it("spawns the binary with the protocol command line and the payload on stdin", async () => {
    const calls = await publishWith(
      { env: { ...ENV, TMUX_AGENT_SIDEBAR_BIN: BIN }, exists: binaryThere },
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
        deps: { env: { ...ENV, TMUX_AGENT_SIDEBAR: "0" }, exists: binaryThere },
      },
      { name: "no pane", deps: { env: {}, exists: binaryThere } },
      { name: "binary missing", deps: { exists: existsNever } },
    ];
    for (const { name, deps } of cases) {
      const { spawn, calls } = makeSpawn();
      createSidebarPublisher({
        env: ENV,
        exists: existsNever,
        spawn,
        ...deps,
      } as Parameters<typeof createSidebarPublisher>[0]).publish("session-start", { cwd: "/w" });
      assert.deepEqual(calls, [], name);
    }
  });

  it("defers the spawn, keeps the event order, and looks the binary up once", async () => {
    let lookups = 0;
    const { spawn, calls } = makeSpawn();
    const publisher = createSidebarPublisher({
      env: { ...ENV, TMUX_AGENT_SIDEBAR_BIN: BIN },
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
    await flush();
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
      }),
    }).publish("stop", { last_assistant_message: "x" });
    await flush();
    assert.deepEqual(writes, []);
    assert.equal(published, false);
  });
});
