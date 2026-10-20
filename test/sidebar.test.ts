/**
 * The sidebar publisher, tested without pi, without tmux and without a
 * sidebar: the payload builders are pure functions, the binary lookup takes
 * its file check as an argument, and the spawner is injected.
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

function publishWith(
  deps: Partial<Parameters<typeof createSidebarPublisher>[0]>,
  event: string,
  payload: unknown,
): Array<{ command: string; args: string[]; stdin: string }> {
  const { spawn, calls } = makeSpawn();
  createSidebarPublisher({
    env: ENV,
    exists: existsNever,
    spawn,
    ...deps,
  } as Parameters<typeof createSidebarPublisher>[0]).publish(event, payload);
  return calls;
}

describe("resolveSidebarBinary", () => {
  const existsFor = (paths: string[]) => (path: string) => paths.includes(path);
  const bin = "/opt/sidebar/bin/tmux-agent-sidebar";
  const homeBin = "/home/u/.tmux/plugins/tmux-agent-sidebar/bin/tmux-agent-sidebar";
  const homeRelease = "/home/u/.tmux/plugins/tmux-agent-sidebar/target/release/tmux-agent-sidebar";

  it("prefers the environment override", () => {
    const env = { TMUX_AGENT_SIDEBAR_BIN: bin, HOME: "/home/u", PATH: "/usr/bin" };
    assert.equal(resolveSidebarBinary(env, existsFor([bin, homeBin])), bin);
  });

  it("skips an override whose file is not there", () => {
    const env = { TMUX_AGENT_SIDEBAR_BIN: bin, HOME: "/home/u", PATH: "" };
    assert.equal(resolveSidebarBinary(env, existsFor([homeBin])), homeBin);
  });

  it("uses the plugin bin path", () => {
    const env = { HOME: "/home/u", PATH: "" };
    assert.equal(resolveSidebarBinary(env, existsFor([homeBin])), homeBin);
  });

  it("falls back to the plugin release build", () => {
    const env = { HOME: "/home/u", PATH: "" };
    assert.equal(resolveSidebarBinary(env, existsFor([homeRelease])), homeRelease);
  });

  it("falls back to PATH", () => {
    const env = { HOME: "/home/u", PATH: "/usr/local/bin:/usr/bin" };
    assert.equal(
      resolveSidebarBinary(env, existsFor(["/usr/bin/tmux-agent-sidebar"])),
      "/usr/bin/tmux-agent-sidebar",
    );
  });

  it("returns null when nothing is found", () => {
    const env = { HOME: "/home/u", PATH: "/usr/bin" };
    assert.equal(resolveSidebarBinary(env, existsNever), null);
  });
});

describe("payload builders", () => {
  it("buildSessionStart", () => {
    assert.deepEqual(buildSessionStart({ source: "startup", cwd: "/work/app", sessionId: "s1" }), {
      cwd: "/work/app",
      session_id: "s1",
      source: "startup",
    });
  });

  it("buildSessionStart carries the worktree when the pane has one", () => {
    assert.deepEqual(
      buildSessionStart({
        source: "startup",
        cwd: "/work/app",
        sessionId: "s1",
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

  it("buildUserPromptSubmit", () => {
    assert.deepEqual(buildUserPromptSubmit({ prompt: "hi", cwd: "/work/app", sessionId: "s1" }), {
      prompt: "hi",
      cwd: "/work/app",
      session_id: "s1",
    });
  });

  it("buildActivityLog at tool start has no tool_response", () => {
    assert.deepEqual(buildActivityLog({ toolName: "bash", toolInput: { command: "ls" } }), {
      tool_name: "bash",
      tool_input: { command: "ls" },
    });
  });

  it("buildActivityLog at tool end carries the result", () => {
    assert.deepEqual(
      buildActivityLog({
        toolName: "read",
        toolInput: { path: "/a" },
        toolResponse: { content: "ok" },
      }),
      { tool_name: "read", tool_input: { path: "/a" }, tool_response: { content: "ok" } },
    );
  });

  it("buildStop", () => {
    assert.deepEqual(
      buildStop({ lastAssistantMessage: "done", cwd: "/work/app", sessionId: "s1" }),
      { last_assistant_message: "done", cwd: "/work/app", session_id: "s1" },
    );
  });

  it("buildStopFailure", () => {
    assert.deepEqual(
      buildStopFailure({ error: "provider exploded", cwd: "/work/app", sessionId: "s1" }),
      { error: "provider exploded", cwd: "/work/app", session_id: "s1" },
    );
  });

  it("buildNotification names the kind of prompt", () => {
    assert.deepEqual(buildNotification({ waitReason: "confirm" }), {
      notification_type: "confirm",
    });
  });

  it("buildSessionEnd", () => {
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
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "part one " },
          { type: "text", text: "part two" },
        ],
        stopReason: "stop",
      },
      { role: "user", content: [{ type: "text", text: "noise" }] },
    ];
    assert.deepEqual(lastAssistantMessage(messages), {
      text: "part one part two",
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
  it("TMUX_AGENT_SIDEBAR=0 turns publishing off", () => {
    assert.equal(sidebarSwitchEnabled({ TMUX_AGENT_SIDEBAR: "0" }), false);
  });

  it("any other value, and the absence of the variable, leave it on", () => {
    assert.equal(sidebarSwitchEnabled({}), true);
    assert.equal(sidebarSwitchEnabled({ TMUX_AGENT_SIDEBAR: "1" }), true);
  });
});

describe("publisher", () => {
  it("spawns the binary with the protocol command line and the payload on stdin", () => {
    const bin = "/opt/sidebar/bin/tmux-agent-sidebar";
    const calls = publishWith(
      {
        env: { ...ENV, TMUX_AGENT_SIDEBAR_BIN: bin },
        exists: (path) => path === bin,
      },
      "user-prompt-submit",
      { prompt: "hi" },
    );
    assert.deepEqual(calls, [
      { command: bin, args: ["hook", "pi", "user-prompt-submit"], stdin: '{"prompt":"hi"}' },
    ]);
  });

  it("does nothing when the binary is missing", () => {
    const calls = publishWith({}, "session-start", { cwd: "/w" });
    assert.deepEqual(calls, []);
  });

  it("does nothing when TMUX_PANE is unset", () => {
    const bin = "/opt/sidebar/bin/tmux-agent-sidebar";
    const calls = publishWith({ env: {}, exists: (path) => path === bin }, "session-start", {
      cwd: "/w",
    });
    assert.deepEqual(calls, []);
  });

  it("does nothing when the switch is off", () => {
    const bin = "/opt/sidebar/bin/tmux-agent-sidebar";
    const calls = publishWith(
      { env: { ...ENV, TMUX_AGENT_SIDEBAR: "0" }, exists: (path) => path === bin },
      "session-start",
      { cwd: "/w" },
    );
    assert.deepEqual(calls, []);
  });

  it("swallows a throwing spawner", () => {
    const bin = "/opt/sidebar/bin/tmux-agent-sidebar";
    const calls = publishWith(
      {
        exists: (path) => path === bin,
        spawn: () => {
          throw new Error("EACCES");
        },
      },
      "activity-log",
      { tool_name: "bash" },
    );
    assert.deepEqual(calls, []);
  });

  it("swallows a throwing stdin and writes nothing to the session output", () => {
    const bin = "/opt/sidebar/bin/tmux-agent-sidebar";
    const writes: string[] = [];
    let published = false;
    createSidebarPublisher({
      env: ENV,
      exists: (path) => path === bin,
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
    assert.deepEqual(writes, []);
    assert.equal(published, false);
  });
});
