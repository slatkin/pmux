import "./host-env.ts";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readChildStatus,
  removeChildStatus,
  statusFilePath,
  writeChildStatus,
} from "../pi-extension/pmux/status-file.ts";
import subagentDoneExtension from "../pi-extension/pmux/pmux-done.ts";
import { runSpec } from "../pi-extension/pmux/run.ts";
import { main } from "../pi-extension/pmux/cli.ts";
import { writeLaunchSpec, LAUNCH_SPEC_VERSION } from "../pi-extension/pmux/launch.ts";
import { __setTmuxExecForTests__ } from "../pi-extension/pmux/tmux.ts";
import { useTmuxPaneFake } from "./tmux-fakes.ts";
import { tempDirHelpers } from "./temp-dir.ts";
import {
  createSupervisor,
  type SupervisorContext,
  type SupervisorDeps,
} from "../pi-extension/pmux/supervisor.ts";
import { DEFAULT_STATUS_LINE_LIMIT } from "../pi-extension/pmux/status.ts";

const { withTempDir, withTempDirAsync } = tempDirHelpers("pmux-status-");

describe("status file module", () => {
  it("writes one JSON object and reads it back", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "child.jsonl");
      assert.equal(writeChildStatus(sessionFile, "working"), true);
      const record = readChildStatus(sessionFile);
      assert.ok(record);
      assert.equal(record.status, "working");
      assert.equal(typeof record.at, "string");
      assert.equal(record.message, undefined);

      assert.equal(writeChildStatus(sessionFile, "blocked", "what now?"), true);
      const blocked = readChildStatus(sessionFile);
      assert.ok(blocked);
      assert.equal(blocked.status, "blocked");
      assert.equal(blocked.message, "what now?");
      // The whole file is one JSON object: no trailing lines, no partial state.
      assert.deepEqual(JSON.parse(readFileSync(statusFilePath(sessionFile), "utf8")), blocked);
    });
  });

  it("omits the message key when no message is given", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "child.jsonl");
      writeChildStatus(sessionFile, "idle");
      const raw = JSON.parse(readFileSync(statusFilePath(sessionFile), "utf8"));
      assert.deepEqual(Object.keys(raw).sort(), ["at", "status"]);
    });
  });

  it("reads nothing for a missing or malformed file", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "child.jsonl");
      assert.equal(readChildStatus(sessionFile), null);
      writeFileSync(statusFilePath(sessionFile), "{ not json");
      assert.equal(readChildStatus(sessionFile), null);
      writeFileSync(statusFilePath(sessionFile), '{"status":"banana"}');
      assert.equal(readChildStatus(sessionFile), null);
    });
  });

  it("removes the file and tolerates a missing one", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "child.jsonl");
      removeChildStatus(sessionFile);
      writeChildStatus(sessionFile, "working");
      assert.equal(existsSync(statusFilePath(sessionFile)), true);
      removeChildStatus(sessionFile);
      assert.equal(existsSync(statusFilePath(sessionFile)), false);
    });
  });

  it("never throws when the write fails", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "child.jsonl");
      // A directory at the status path makes the rename fail.
      mkdirSync(statusFilePath(sessionFile));
      assert.equal(writeChildStatus(sessionFile, "working"), false);
      assert.equal(readChildStatus(sessionFile), null);
    });
  });
});

describe("status latch", () => {
  it("skips every write after a terminal done or blocked write", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "latch.jsonl");
      assert.equal(writeChildStatus(sessionFile, "done"), true);
      const terminal = readFileSync(statusFilePath(sessionFile), "utf8");
      assert.equal(writeChildStatus(sessionFile, "working"), false);
      assert.equal(writeChildStatus(sessionFile, "blocked", "late"), false);
      assert.equal(readFileSync(statusFilePath(sessionFile), "utf8"), terminal);
    });
  });

  it("does not latch on working or idle", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "live.jsonl");
      writeChildStatus(sessionFile, "working");
      assert.equal(writeChildStatus(sessionFile, "idle"), true);
      assert.equal(readChildStatus(sessionFile)?.status, "idle");
      assert.equal(writeChildStatus(sessionFile, "done"), true);
    });
  });
});

/** Load the child extension with a mock pi API under the given env. */
function loadChildExtension(env: Record<string, string | undefined>) {
  const saved = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const handlers: Record<string, Array<(event?: any, ctx?: any) => void>> = {};
  const tools: Array<any> = [];
  const mockPi: any = {
    on(name: string, handler: (event?: any, ctx?: any) => void) {
      (handlers[name] ??= []).push(handler);
    },
    registerTool(tool: any) {
      tools.push(tool);
    },
    registerShortcut() {},
    getAllTools() {
      return [];
    },
    setWidget() {},
    sendUserMessage() {},
  };
  try {
    (subagentDoneExtension as any)(mockPi);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const fire = (name: string, event?: any, ctx?: any) => {
    for (const handler of handlers[name] ?? []) handler(event, ctx);
  };
  return { handlers, tools, fire };
}

describe("status writes from the child extension", () => {
  it("writes working at a turn start and idle at a turn end", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "child.jsonl");
      const { fire } = loadChildExtension({ PI_PMUX_SESSION: sessionFile });
      fire("turn_start", { turnIndex: 0 });
      assert.equal(readChildStatus(sessionFile)?.status, "working");
      fire("turn_end", { turnIndex: 0 }, { shutdown() {} });
      assert.equal(readChildStatus(sessionFile)?.status, "idle");
    });
  });

  it("writes nothing without PI_PMUX_SESSION", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "child.jsonl");
      const { fire } = loadChildExtension({ PI_PMUX_SESSION: undefined });
      fire("turn_start", { turnIndex: 0 });
      fire("turn_end", { turnIndex: 0 }, { shutdown() {} });
      assert.equal(existsSync(statusFilePath(sessionFile)), false);
    });
  });

  it("writes blocked with the question at caller_ping, before the sidecar", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "child.jsonl");
      const { tools } = loadChildExtension({ PI_PMUX_SESSION: sessionFile });
      const ping = tools.find((tool) => tool.name === "caller_ping");
      assert.ok(ping);
      await ping.execute("call-1", { message: "which schema?" }, undefined, undefined, {
        shutdown() {},
      });
      assert.equal(readChildStatus(sessionFile)?.status, "blocked");
      assert.equal(readChildStatus(sessionFile)?.message, "which schema?");
      assert.equal(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")).type, "ping");
    });
  });

  it("writes done at pmux_done, before the sidecar, and latches", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "child.jsonl");
      const { tools, fire } = loadChildExtension({ PI_PMUX_SESSION: sessionFile });
      const done = tools.find((tool) => tool.name === "pmux_done");
      assert.ok(done);
      await done.execute("call-1", {}, undefined, undefined, { shutdown() {} });
      assert.equal(readChildStatus(sessionFile)?.status, "done");
      assert.equal(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")).type, "done");

      // The latch: a later write does not change the terminal file.
      fire("turn_start", { turnIndex: 1 });
      assert.equal(readChildStatus(sessionFile)?.status, "done");
    });
  });

  it("writes done with handoff at pmux_done handoff", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "child.jsonl");
      const { tools } = loadChildExtension({ PI_PMUX_SESSION: sessionFile });
      const done = tools.find((tool) => tool.name === "pmux_done");
      await done.execute("call-1", { handoff: "take over" }, undefined, undefined, {
        shutdown() {},
      });
      assert.equal(readChildStatus(sessionFile)?.status, "done");
    });
  });

  it("writes blocked with the error text on a provider-error agent_end", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "child.jsonl");
      const { fire } = loadChildExtension({ PI_PMUX_SESSION: sessionFile });
      fire("agent_start");
      fire(
        "agent_end",
        { messages: [{ role: "assistant", stopReason: "error", errorMessage: "529 overloaded" }] },
        { shutdown() {} },
      );
      assert.equal(readChildStatus(sessionFile)?.status, "blocked");
      assert.equal(readChildStatus(sessionFile)?.message, "529 overloaded");
      assert.equal(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")).type, "error");
    });
  });

  it("writes done on the auto-exit path", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "child.jsonl");
      const { fire } = loadChildExtension({
        PI_PMUX_SESSION: sessionFile,
        PI_PMUX_AUTO_EXIT: "1",
      });
      fire("agent_start");
      fire(
        "agent_end",
        { messages: [{ role: "assistant", stopReason: "stop" }] },
        { shutdown() {} },
      );
      assert.equal(readChildStatus(sessionFile)?.status, "done");
      assert.equal(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")).type, "done");
    });
  });
});

describe("runSpec crash status", () => {
  it("writes blocked with the exit code when the child crashes", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "session.jsonl");
      writeChildStatus(sessionFile, "working");
      const code = await runSpec(
        {
          version: LAUNCH_SPEC_VERSION,
          name: "crasher",
          env: {},
          command: process.execPath,
          args: ["-e", "process.exit(137)"],
          sessionFile,
        },
        undefined,
        { env: { PATH: process.env.PATH }, stdout: () => {}, stderr: () => {} },
      );
      assert.equal(code, 137);
      const status = readChildStatus(sessionFile);
      assert.equal(status?.status, "blocked");
      assert.match(status?.message ?? "", /137/);
    });
  });

  it("leaves the status of a completed run alone", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "session.jsonl");
      const exitPath = `${sessionFile}.exit`;
      writeFileSync(exitPath, JSON.stringify({ type: "done" }));
      writeChildStatus(sessionFile, "done");
      const code = await runSpec(
        {
          version: LAUNCH_SPEC_VERSION,
          name: "clean",
          env: {},
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
          sessionFile,
        },
        undefined,
        { env: { PATH: process.env.PATH }, stdout: () => {}, stderr: () => {} },
      );
      assert.equal(code, 0);
      assert.equal(readChildStatus(sessionFile)?.status, "done");
    });
  });

  it("leaves a blocked status alone when the child exited without a sidecar", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "session.jsonl");
      writeChildStatus(sessionFile, "blocked", "which schema?");
      const before = readFileSync(statusFilePath(sessionFile), "utf8");
      await runSpec(
        {
          version: LAUNCH_SPEC_VERSION,
          name: "pinged",
          env: {},
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
          sessionFile,
        },
        undefined,
        { env: { PATH: process.env.PATH }, stdout: () => {}, stderr: () => {} },
      );
      assert.equal(readFileSync(statusFilePath(sessionFile), "utf8"), before);
    });
  });
});

// ── Removal at start ──

describe("cli resume removes a stale status", () => {
  before(() => {
    useTmuxPaneFake();
  });

  after(() => {
    __setTmuxExecForTests__(null);
  });

  function tmuxEnv(): NodeJS.ProcessEnv {
    return { PATH: process.env.PATH, TMUX: "/tmp/tmux-0/default", TMUX_PANE: "%21" };
  }

  it("removes the status file of the earlier run before the child starts", async () => {
    await withTempDirAsync(async (dir) => {
      // The launch spec is written directly: the removal lives in `resume`,
      // so minting it through a full first launch adds nothing to the check.
      const scratch = join(dir, "scratch");
      const sessionFile = join(scratch, "scout-1.jsonl");
      const launchPath = join(scratch, "scout-1.json");
      writeLaunchSpec(launchPath, {
        version: LAUNCH_SPEC_VERSION,
        name: "scout-1",
        env: {},
        command: "pi",
        args: [],
        sessionFile,
        parent: "orch",
      });
      const followup = join(dir, "followup.md");
      writeFileSync(followup, "Continue.\n");

      // An earlier run's status must not survive into the resumed run.
      writeChildStatus(sessionFile, "done");
      const code = await main(
        ["resume", "--launch", launchPath, "--prompt", followup, "--surface", "right"],
        {
          env: tmuxEnv(),
          stdout: () => {},
          stderr: () => {},
          sleep: async () => {},
        },
      );
      assert.equal(code, 0);
      assert.equal(existsSync(statusFilePath(sessionFile)), false);
    });
  });
});

interface SupervisorHarness {
  supervisor: ReturnType<typeof createSupervisor>;
}

function makeSupervisorHarness(): SupervisorHarness {
  let nextPane = 24;
  const supervisor = createSupervisor({
    send: () => {},
    ui: () => null,
    pmux: {
      createSurface: () => String(nextPane++),
      runInPane: () => {},
      closeSurface: () => {},
      sendEscape: () => {},
      readScreen: () => "",
      pollForExit: () => new Promise(() => {}),
      agentPrompt: () => ({ submitted: true }),
    } as unknown as SupervisorDeps["pmux"],
    statusConfig: {
      enabled: true,
      lineLimit: DEFAULT_STATUS_LINE_LIMIT,
      notifyEnabled: false,
      contextAlert: { enabled: false, threshold: { kind: "tokens", value: 200000 } },
    },
  });
  return { supervisor };
}

interface SupervisorTestEnv {
  dir: string;
  ctx: SupervisorContext;
  restore(): void;
}

function createSupervisorEnv(): SupervisorTestEnv {
  const dir = mkdtempSync(join(tmpdir(), "pmux-status-sup-"));
  const saved = new Map(
    ["PI_CODING_AGENT_DIR", "PI_PMUX_SHELL_READY_DELAY_MS", "PI_PMUX_NAME", "TMUX_PANE"].map(
      (key) => [key, process.env[key]],
    ),
  );
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  process.env.PI_PMUX_SHELL_READY_DELAY_MS = "0";
  process.env.PI_PMUX_NAME = "parent";
  // The roster's parentPane reads the caller's own pane id.
  process.env.TMUX_PANE = "%21";
  return {
    dir,
    ctx: {
      cwd: dir,
      sessionManager: {
        getSessionFile: () => join(dir, "parent.jsonl"),
        getSessionId: () => "sess-001",
        getSessionDir: () => join(dir, "sessions"),
      },
    },
    restore() {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("supervisor resume removes a stale status", () => {
  it("removes the status file of the earlier run before the child starts", async () => {
    const env = createSupervisorEnv();
    const harness = makeSupervisorHarness();
    try {
      // No launch record: the resume falls back to a plain pi run, which is
      // enough to reach the real removal path in startRun.
      const sessionFile = join(env.dir, "earlier-run.jsonl");
      writeFileSync(sessionFile, "");
      writeChildStatus(sessionFile, "done");
      const result = await harness.supervisor.resume(
        { sessionPath: sessionFile, message: "Continue" },
        env.ctx,
      );
      assert.match(JSON.stringify(result), /resumed/i);
      assert.equal(existsSync(statusFilePath(sessionFile)), false);
    } finally {
      harness.supervisor.shutdown();
      env.restore();
    }
  });
});
