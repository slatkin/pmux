/**
 * The pi-event → sidebar-publish mapping (design D6), driven without pi: the
 * handlers are registered on a fake ExtensionAPI and fired with fake events.
 * The publisher is real, with a fake spawner, so the published payloads and
 * their timing are exactly what reaches the sidebar.
 */
import "./host-env.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSidebarEvents } from "../pi-extension/pmux/sidebar-events.ts";
import { createSidebarPublisher, type SidebarWorktree } from "../pi-extension/pmux/sidebar.ts";
import { flushSidebarQueue, makeSidebarSpawn } from "./sidebar-fakes.ts";

const BIN = "/opt/sidebar/bin/pmux-explorer";
const ENV = { TMUX: "/tmp/tmux-0/default", TMUX_PANE: "%7", PMUX_EXPLORER_BIN: BIN };
const CTX = { cwd: "/work/app", sessionManager: { getSessionId: () => "s1" } };

function makeHarness(options: { env?: NodeJS.ProcessEnv; worktree?: SidebarWorktree } = {}) {
  const { spawn, calls } = makeSidebarSpawn();
  const worktreeReads = { count: 0 };
  const events = createSidebarEvents({
    publisher: createSidebarPublisher({
      env: options.env ?? ENV,
      exists: (path) => path === BIN,
      spawn,
    }),
    readWorktree: () => {
      worktreeReads.count++;
      return options.worktree;
    },
  });
  const handlers = new Map<string, Array<(event?: unknown, ctx?: unknown) => void>>();
  const busHandlers = new Map<string, Array<(data?: unknown) => void>>();
  events.register({
    on: (event: string, fn: (event?: unknown, ctx?: unknown) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    },
    events: {
      on: (channel: string, fn: (data?: unknown) => void) => {
        busHandlers.set(channel, [...(busHandlers.get(channel) ?? []), fn]);
      },
    },
  } as never);
  const fire = (event: string, data: unknown, ctx: unknown = CTX) => {
    for (const fn of handlers.get(event) ?? []) fn(data, ctx);
  };
  const fireBus = (channel: string, data: unknown) => {
    for (const fn of busHandlers.get(channel) ?? []) fn(data);
  };
  return { calls, worktreeReads, fire, fireBus };
}

describe("the pi-event mapping", () => {
  it("the end of the wait publishes user-prompt-submit with an empty prompt and nothing else", async () => {
    const { calls, fire } = makeHarness();
    fire("ui_prompt_start", { kind: "confirm" });
    fire("ui_prompt_end", { reason: "confirmed" });
    await flushSidebarQueue();
    assert.equal(calls.length, 2);
    assert.deepEqual(JSON.parse(calls[1].stdin), {
      prompt: "",
      cwd: "/work/app",
      session_id: "s1",
    });
    assert.equal(calls[1].args[2], "user-prompt-submit");
  });

  it("an end with no open wait publishes nothing, and a later start still notifies", async () => {
    const { calls, fire, fireBus } = makeHarness();
    fire("ui_prompt_end", { reason: "confirmed" });
    fireBus("herdr:blocked", { active: false });
    await flushSidebarQueue();
    assert.deepEqual(calls, []);
    fire("ui_prompt_start", { kind: "confirm" });
    await flushSidebarQueue();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[2], "notification");
  });

  it("a bus question publishes one notification with the question wait reason", async () => {
    const { calls, fireBus } = makeHarness();
    fireBus("herdr:blocked", { active: true, label: "Waiting for user response" });
    await flushSidebarQueue();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[2], "notification");
    assert.deepEqual(JSON.parse(calls[0].stdin), { notification_type: "question" });
  });

  it("the bus end publishes one empty user-prompt-submit under the last seen session", async () => {
    const { calls, fire, fireBus } = makeHarness();
    fire("input", { text: "ask me" });
    fireBus("herdr:blocked", { active: true });
    fireBus("herdr:blocked", { active: false });
    await flushSidebarQueue();
    assert.equal(calls.length, 3);
    assert.equal(calls[2].args[2], "user-prompt-submit");
    assert.deepEqual(JSON.parse(calls[2].stdin), {
      prompt: "",
      cwd: "/work/app",
      session_id: "s1",
    });
  });

  it("a bus question and a ui prompt for one prompt publish one notification and one resume (bus first)", async () => {
    const { calls, fire, fireBus } = makeHarness();
    fireBus("herdr:blocked", { active: true });
    fire("ui_prompt_start", { kind: "input" });
    fireBus("herdr:blocked", { active: false });
    fire("ui_prompt_end", { reason: "confirmed" });
    await flushSidebarQueue();
    assert.deepEqual(
      calls.map((call) => call.args[2]),
      ["notification", "user-prompt-submit"],
    );
    assert.deepEqual(JSON.parse(calls[0].stdin), { notification_type: "question" });
  });

  it("a bus question and a ui prompt for one prompt publish one notification and one resume (ui first)", async () => {
    const { calls, fire, fireBus } = makeHarness();
    fire("ui_prompt_start", { kind: "input" });
    fireBus("herdr:blocked", { active: true });
    fire("ui_prompt_end", { reason: "confirmed" });
    fireBus("herdr:blocked", { active: false });
    await flushSidebarQueue();
    assert.deepEqual(
      calls.map((call) => call.args[2]),
      ["notification", "user-prompt-submit"],
    );
    assert.deepEqual(JSON.parse(calls[0].stdin), { notification_type: "input" });
  });

  it("malformed bus payloads publish nothing and leave the wait count alone", async () => {
    const { calls, fire, fireBus } = makeHarness();
    fire("input", { text: "go" });
    for (const data of [undefined, null, "active", 1, {}, { active: "yes" }, { active: 1 }]) {
      assert.doesNotThrow(() => fireBus("herdr:blocked", data));
    }
    fireBus("herdr:blocked", { active: true });
    fireBus("herdr:blocked", { active: false });
    await flushSidebarQueue();
    assert.deepEqual(
      calls.map((call) => call.args[2]),
      ["user-prompt-submit", "notification", "user-prompt-submit"],
    );
  });

  it("the wait start publishes notification with the kind of prompt", async () => {
    const { calls, fire } = makeHarness();
    fire("ui_prompt_start", { kind: "confirm" });
    await flushSidebarQueue();
    assert.deepEqual(JSON.parse(calls[0].stdin), { notification_type: "confirm" });
    assert.equal(calls[0].args[2], "notification");
  });

  it("session-start carries the worktree when the pane has one", async () => {
    const { calls, worktreeReads, fire } = makeHarness({
      worktree: { path: "/repo/.wt/x", branch: "agent/x" },
    });
    fire("session_start", { reason: "startup" });
    await flushSidebarQueue();
    assert.deepEqual(JSON.parse(calls[0].stdin), {
      cwd: "/work/app",
      session_id: "s1",
      source: "startup",
      worktree: { path: "/repo/.wt/x", branch: "agent/x" },
    });
    assert.equal(worktreeReads.count, 1);
  });

  it("session-start omits the worktree when the pane has none", async () => {
    const { calls, fire } = makeHarness();
    fire("session_start", { reason: "startup" });
    await flushSidebarQueue();
    assert.deepEqual(JSON.parse(calls[0].stdin), {
      cwd: "/work/app",
      session_id: "s1",
      source: "startup",
    });
  });

  it("with publishing off, the worktree is not read and nothing spawns", async () => {
    const { calls, worktreeReads, fire } = makeHarness({
      env: { ...ENV, PMUX_EXPLORER: "0" },
    });
    fire("session_start", { reason: "startup" });
    await flushSidebarQueue();
    assert.equal(worktreeReads.count, 0);
    assert.deepEqual(calls, []);
  });

  it("session-end is published synchronously, before any deferred task runs", () => {
    const { calls, fire } = makeHarness();
    fire("session_shutdown", { reason: "quit" });
    // No tick awaited: the publish must not depend on the deferred queue.
    assert.deepEqual(calls, [
      { command: BIN, args: ["hook", "pi", "session-end"], stdin: '{"end_reason":"quit"}' },
    ]);
  });

  it("session-end names no reason when the event carries none", async () => {
    const { calls, fire } = makeHarness();
    fire("session_shutdown", undefined);
    await flushSidebarQueue();
    assert.deepEqual(JSON.parse(calls[0].stdin), { end_reason: "" });
  });

  it("a user prompt is published with its text", async () => {
    const { calls, fire } = makeHarness();
    fire("input", { text: "hi" });
    await flushSidebarQueue();
    assert.deepEqual(JSON.parse(calls[0].stdin), {
      prompt: "hi",
      cwd: "/work/app",
      session_id: "s1",
    });
    assert.equal(calls[0].args[2], "user-prompt-submit");
  });

  it("tool activity keeps the arguments from the start event for the end entry", async () => {
    const { calls, fire } = makeHarness();
    fire("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
    fire("tool_execution_end", { toolCallId: "t1", toolName: "bash", result: { content: "ok" } });
    await flushSidebarQueue();
    assert.deepEqual(JSON.parse(calls[0].stdin), {
      tool_name: "bash",
      tool_input: { command: "ls" },
    });
    assert.deepEqual(JSON.parse(calls[1].stdin), {
      tool_name: "bash",
      tool_input: { command: "ls" },
      tool_response: { content: "ok" },
    });
  });

  it("a failed run publishes stop-failure with pi's error text", async () => {
    const { calls, fire } = makeHarness();
    fire("agent_end", {
      messages: [
        { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "error" },
      ],
    });
    fire("agent_before_settle", { outcome: "error" });
    fire("agent_settled", {});
    await flushSidebarQueue();
    assert.equal(calls[0].args[2], "stop-failure");
    assert.deepEqual(JSON.parse(calls[0].stdin), {
      error: "error",
      cwd: "/work/app",
      session_id: "s1",
    });
  });

  it("a completed run publishes stop with the run's last assistant message", async () => {
    const { calls, fire } = makeHarness();
    fire("agent_end", {
      messages: [
        { role: "assistant", content: [{ type: "text", text: "earlier" }], stopReason: "stop" },
        { role: "user", content: [] },
        { role: "assistant", content: [{ type: "text", text: "final" }], stopReason: "stop" },
      ],
    });
    fire("agent_before_settle", { outcome: "completed" });
    fire("agent_settled", {});
    await flushSidebarQueue();
    assert.equal(calls[0].args[2], "stop");
    assert.deepEqual(JSON.parse(calls[0].stdin), {
      last_assistant_message: "final",
      cwd: "/work/app",
      session_id: "s1",
    });
  });

  it("a run with no captured outcome settles as completed", async () => {
    const { calls, fire } = makeHarness();
    fire("agent_settled", {});
    await flushSidebarQueue();
    assert.equal(calls[0].args[2], "stop");
    assert.deepEqual(JSON.parse(calls[0].stdin), {
      last_assistant_message: "",
      cwd: "/work/app",
      session_id: "s1",
    });
  });
});
