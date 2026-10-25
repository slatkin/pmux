import "./host-env.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Value } from "@sinclair/typebox/value";
import { tempDirHelpers } from "./temp-dir.ts";

import {
  createSupervisor,
  getArtifactDir,
  getRosterFile,
  SubagentParams,
  type ResumeParams,
  type RunningSubagent,
  type SendOptions,
  type SteerMessage,
  type SupervisorContext,
  type SupervisorDeps,
} from "../pi-extension/pmux/supervisor.ts";
import { paneCommandLine, readLaunchSpec } from "../pi-extension/pmux/launch.ts";
import { DEFAULT_STATUS_LINE_LIMIT } from "../pi-extension/pmux/status.ts";
import {
  LAUNCH_RECORD_VERSION,
  getLaunchRecordFile,
  readLaunchRecord,
  writeLaunchRecord,
  type LaunchRecord,
} from "../pi-extension/pmux/launch-record.ts";
import type { PollResult } from "../pi-extension/pmux/exit-sidecar.ts";
import {
  classifyStatus,
  createStatusState,
  observeStatus,
  type StatusSnapshot,
} from "../pi-extension/pmux/status.ts";

const SUBAGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "pi-extension", "pmux");
const CLI = join(SUBAGENTS_DIR, "cli.ts");

const SESSION_HEADER = { type: "session", id: "sess-001", version: 3 };
const MODEL_CHANGE = { type: "model_change", id: "mc-001", parentId: null };
const USER_MSG = {
  type: "message",
  id: "user-001",
  parentId: "mc-001",
  message: { role: "user", content: [{ type: "text", text: "Hello, plan something" }] },
};
const ASSISTANT_MSG = {
  type: "message",
  id: "asst-001",
  parentId: "user-001",
  message: { role: "assistant", content: [{ type: "text", text: "Here is my plan..." }] },
};

type TmuxPoll = SupervisorDeps["pmux"]["pollForExit"];

interface TestEnv {
  dir: string;
  ctx: SupervisorContext;
  restore(): void;
}

/**
 * Temp session and agent roots with a fake `TMUX_PANE`. No test here talks to
 * Surface: every deps.pmux operation is injected below.
 */
function createEnv(): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "supervisor-test-"));
  const saved = new Map(
    ["PI_CODING_AGENT_DIR", "PI_PMUX_SHELL_READY_DELAY_MS", "PI_PMUX_NAME", "TMUX_PANE"].map(
      (key) => [key, process.env[key]],
    ),
  );
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  process.env.PI_PMUX_SHELL_READY_DELAY_MS = "0";
  process.env.PI_PMUX_NAME = "parent";
  process.env.TMUX_PANE = "%21";
  // The post-change world (required-role spec): every spawn names a role.
  // `plain-role` carries no model, tools or surface, so the mechanics tests
  // below launch the same bytes a role-less spawn produced.
  writeAgentFile(join(dir, "agent", "agents"), "plain-role", "", "You are a plain test agent.");
  const ctx: SupervisorContext = {
    cwd: dir,
    sessionManager: {
      getSessionFile: () => join(dir, "parent.jsonl"),
      getSessionId: () => "sess-001",
      getSessionDir: () => join(dir, "sessions"),
    },
  };
  return {
    dir,
    ctx,
    restore() {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function writeAgentFile(agentsDir: string, name: string, frontmatter: string, body: string) {
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, `${name}.md`), `---\n${frontmatter}\n---\n\n${body}\n`);
}

function createPollQueue(override?: TmuxPoll) {
  const pending: Array<(result: PollResult) => void> = [];
  const signals: AbortSignal[] = [];
  const pollOptions: Array<Parameters<TmuxPoll>[2]> = [];
  const poll: TmuxPoll =
    override ??
    ((_surface, signal, options) => {
      signals.push(signal);
      pollOptions.push(options);
      return new Promise<PollResult>((resolve) => {
        pending.push(resolve);
        signal.addEventListener("abort", () => resolve({ reason: "done", exitCode: 0 }), {
          once: true,
        });
      });
    });
  return {
    poll,
    signals,
    finish(result: PollResult) {
      const resolve = pending.shift();
      assert.ok(resolve, "expected a pending poll");
      resolve(result);
    },
  };
}

interface SupervisorOptions {
  closeSurfaceThrows?: boolean;
  ui?: boolean;
  pollForExit?: TmuxPoll;
  onRunInPane?: (line: string) => void;
  /** Throw on the first message that matches, to exercise the watcher error path. */
  failSendOnce?: (message: SteerMessage) => boolean;
}

function makeSupervisor(env: TestEnv, options: SupervisorOptions = {}) {
  const sent: Array<{ message: SteerMessage; options: SendOptions | undefined }> = [];
  const runs: Array<{ surface: string; line: string }> = [];
  const surfaces: Array<{ name: string; placement: unknown }> = [];
  const closed: string[] = [];
  const polls = createPollQueue(options.pollForExit);
  let failedSend = false;
  let nextPane = 24;
  const supervisor = createSupervisor({
    send: (message, sendOptions) => {
      if (!failedSend && options.failSendOnce?.(message)) {
        failedSend = true;
        throw new Error("send failed");
      }
      sent.push({ message, options: sendOptions });
    },
    ui: () =>
      options.ui
        ? ({
            hasUI: true,
            ui: { setWidget() {} },
          } as unknown as ReturnType<SupervisorDeps["ui"]>)
        : null,
    pmux: {
      createSurface: (name, placement) => {
        surfaces.push({ name, placement });
        return String(nextPane++);
      },
      runInPane: (surface, line) => {
        options.onRunInPane?.(line);
        runs.push({ surface, line });
      },
      closeSurface: (surface) => {
        closed.push(surface);
        if (options.closeSurfaceThrows) throw new Error("pane not found: already closed");
      },
      sendEscape: () => {},
      readScreen: () => "",
      pollForExit: polls.poll,
      agentPrompt: () => ({ submitted: true }),
    },
    statusConfig: {
      enabled: true,
      lineLimit: DEFAULT_STATUS_LINE_LIMIT,
      notifyEnabled: false,
      contextAlert: { enabled: false, threshold: { kind: "tokens", value: 200000 } },
    },
  });
  return {
    supervisor,
    sent,
    runs,
    surfaces,
    closed,
    polls,
    newSupervisor: (next: SupervisorOptions = {}) => makeSupervisor(env, next),
  };
}

async function withHarness(
  run: (harness: ReturnType<typeof makeSupervisor>, env: TestEnv) => Promise<void>,
  options: SupervisorOptions = {},
): Promise<void> {
  const env = createEnv();
  const harness = makeSupervisor(env, options);
  try {
    await run(harness, env);
  } finally {
    harness.supervisor.shutdown();
    env.restore();
  }
}

async function waitFor(predicate: () => boolean, label = "condition"): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function withMockedNow<T>(now: number, fn: () => T): T {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    return fn();
  } finally {
    Date.now = originalNow;
  }
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function activeObservation(): Parameters<typeof observeStatus>[1] {
  return {
    snapshot: "present",
    updatedAt: 5_000,
    sequence: 1,
    phase: "active",
    active: true,
    activeScope: "tool",
    activeSince: 5_000,
    activityLabel: "bash",
  } as Parameters<typeof observeStatus>[1];
}

function rosterChildren(env: TestEnv): unknown {
  const file = getRosterFile(getArtifactDir(join(env.dir, "sessions"), "sess-001"));
  return JSON.parse(readFileSync(file, "utf8")).children;
}

const BASE_RECORD: LaunchRecord = {
  version: LAUNCH_RECORD_VERSION,
  backend: "pi",
  name: "Worker",
  denyTools: ["pmux_spawn"],
  autoExit: true,
  interactive: false,
};

const { withTempDir } = tempDirHelpers("launch-record-test-");

describe("launch record", () => {
  it("round trips a record through a temp file and a rename", () => {
    withTempDir((dir) => {
      const file = join(dir, "nested", "child.jsonl.launch.json");
      const record: LaunchRecord = {
        ...BASE_RECORD,
        agent: "worker",
        cwd: "/repo",
        model: "test-model",
        thinking: "high",
        tools: "read,bash",
        rolePrompt: "You are a worker.",
        systemPromptMode: "append",
      };

      writeLaunchRecord(file, record);

      assert.deepEqual(readLaunchRecord(file), record);
      // The record is renamed into place, not left behind as a temp file.
      assert.deepEqual(readdirSync(dirname(file)), ["child.jsonl.launch.json"]);
    });
  });

  it("treats a missing file as no record", () => {
    withTempDir((dir) => {
      assert.equal(readLaunchRecord(join(dir, "absent.jsonl.launch.json")), null);
    });
  });

  it("treats invalid JSON as no record", () => {
    withTempDir((dir) => {
      const file = join(dir, "broken.jsonl.launch.json");
      writeFileSync(file, '{"version": 1, "backend": ');
      assert.equal(readLaunchRecord(file), null);
    });
  });

  it("treats a wrong version as no record", () => {
    withTempDir((dir) => {
      const file = join(dir, "future.jsonl.launch.json");
      writeFileSync(file, JSON.stringify({ ...BASE_RECORD, version: 2 }));
      assert.equal(readLaunchRecord(file), null);
    });
  });

  it("keeps a record with no per-run fields", () => {
    withTempDir((dir) => {
      const file = join(dir, "minimal.jsonl.launch.json");
      writeLaunchRecord(file, BASE_RECORD);

      assert.deepEqual(readLaunchRecord(file), BASE_RECORD);
      const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      for (const key of [
        "id",
        "task",
        "activityFile",
        "rosterFile",
        "sentinelFile",
        "artifactDir",
        "entryCountBefore",
      ]) {
        assert.equal(key in raw, false, `expected no per-run field ${key}`);
      }
    });
  });

  it("round trips the external-only fields", () => {
    withTempDir((dir) => {
      const file = join(dir, "external.jsonl.launch.json");
      const record: LaunchRecord = {
        ...BASE_RECORD,
        parentSessionId: "%12",
        closeGraceMs: 1500,
      };
      writeLaunchRecord(file, record);

      assert.deepEqual(readLaunchRecord(file), record);
    });
  });

  it("keeps a record without the external-only fields", () => {
    withTempDir((dir) => {
      const file = join(dir, "supervisor.jsonl.launch.json");
      writeLaunchRecord(file, BASE_RECORD);

      const record = readLaunchRecord(file);
      assert.ok(record);
      assert.equal("parentSessionId" in record, false);
      assert.equal("closeGraceMs" in record, false);
    });
  });

  it("rejects a non-numeric closeGraceMs", () => {
    withTempDir((dir) => {
      const file = join(dir, "grace.jsonl.launch.json");
      writeFileSync(file, JSON.stringify({ ...BASE_RECORD, closeGraceMs: "soon" }));
      assert.equal(readLaunchRecord(file), null);
    });
  });
});

describe("the required-role schema", () => {
  it("rejects a call without an agent and accepts one that names a role", () => {
    assert.equal(Value.Check(SubagentParams, { name: "Scout", task: "survey" }), false);
    assert.equal(
      Value.Check(SubagentParams, { name: "Scout", agent: "scout", task: "survey" }),
      true,
    );
  });
});

describe("supervisor launch", () => {
  it("writes a launch spec and runs one node line, with no shell script", async () => {
    await withHarness(async (h, env) => {
      const running = await h.supervisor.spawn(
        { name: "Scout", task: "Fix the login bug", model: "test-model", agent: "plain-role" },
        env.ctx,
        { fallback: "pane" },
      );

      const launchPath = running.launchScriptFile as string;
      assert.ok(launchPath.endsWith(".json"), `expected a JSON spec, got ${launchPath}`);

      // Exactly one pane run, and it follows the shell-neutral node line.
      assert.equal(h.runs.length, 1);
      assert.equal(h.runs[0].surface, "24");
      assert.equal(h.runs[0].line, paneCommandLine(CLI, launchPath));
      assert.match(h.runs[0].line, /^node ".*cli\.ts" "run" ".*\.json"$/);

      // The spec carries the child argv and env; the parent owns the close.
      const spec = readLaunchSpec(launchPath);
      assert.equal(spec.command, "pi");
      assert.deepEqual(spec.args.slice(0, 2), ["--session", running.sessionFile]);
      assert.equal(spec.sessionFile, running.sessionFile);
      assert.equal(spec.closeOnDone, undefined);
      assert.equal(spec.cwd, undefined);
      assert.equal(spec.title, "Scout — Fix the login bug");
      assert.equal(spec.env.PI_PMUX_NAME, "Scout");
      assert.equal(spec.env.PI_PMUX_SESSION, running.sessionFile);
      assert.equal(spec.env.PI_PMUX_SURFACE, "24");
      assert.equal(flagValue(spec.args, "--model"), "test-model");
      assert.equal(
        flagValue(spec.args, "--tools"),
        "read,bash,edit,write,grep,find,ls,caller_ping,pmux_done,pmux_message",
      );

      // The spec is written where the old shell script went, and it is no script.
      const scriptsDir = join(env.dir, "sessions", "artifacts", "sess-001", "pmux-scripts");
      assert.deepEqual(
        readFileNames(scriptsDir).filter((file) => file.endsWith(".sh")),
        [],
      );
      assert.equal(readFileNames(scriptsDir).length, 1);
    });
  });

  it("writes a launch record before the pane line and keeps the pi launch spec", async () => {
    const recordExistedAtPaneRun: boolean[] = [];

    await withHarness(
      async (h, env) => {
        const repoDir = join(env.dir, "repo");
        writeAgentFile(
          join(env.dir, "agent", "agents"),
          "scout",
          `spawning: false\ncwd: ${repoDir}\nmodel: test-model\ntools: read,bash\nsystem-prompt: append`,
          "You are a scout.",
        );

        const running = await h.supervisor.spawn(
          { name: "Scout", task: "Fix the login bug", agent: "scout" },
          env.ctx,
        );

        const recordFile = getLaunchRecordFile(running.sessionFile);
        assert.equal(existsSync(recordFile), true);

        const record = readLaunchRecord(recordFile);
        assert.ok(record);
        assert.equal(record.version, LAUNCH_RECORD_VERSION);
        assert.equal(record.backend, "pi");
        assert.equal(record.agent, "scout");
        assert.equal(record.cwd, repoDir);
        assert.equal(record.model, "test-model");
        assert.equal(record.tools, "read,bash");
        assert.equal(record.rolePrompt, "You are a scout.");
        assert.equal(record.systemPromptMode, "append");
        assert.deepEqual([...record.denyTools].sort(), [
          "pmux_interrupt",
          "pmux_list",
          "pmux_resume",
          "pmux_spawn",
        ]);
        assert.equal(record.autoExit, false);
        assert.equal(record.interactive, true);

        // The record holds role values only: no task text, pane or run id.
        assert.equal("task" in record, false);
        assert.equal("id" in record, false);
        assert.doesNotMatch(JSON.stringify(record), /Fix the login bug/);
        assert.doesNotMatch(JSON.stringify(record), new RegExp(running.id));

        // The spec keeps the argv and env the spawn built before the record.
        const spec = readLaunchSpec(running.launchScriptFile as string);
        assert.equal(spec.command, "pi");
        assert.equal(spec.cwd, repoDir);
        assert.equal(spec.sessionFile, running.sessionFile);

        const syspromptPath = flagValue(spec.args, "--append-system-prompt");
        assert.match(syspromptPath ?? "", /sysprompt-.*\.md$/);
        assert.equal(readFileSync(syspromptPath as string, "utf8"), "You are a scout.");

        const taskArg = spec.args.at(-1) ?? "";
        assert.match(taskArg, /^@.*\.md$/);
        assert.match(readFileSync(taskArg.slice(1), "utf8"), /Fix the login bug/);

        assert.deepEqual(spec.args, [
          "--session",
          running.sessionFile,
          "-e",
          join(SUBAGENTS_DIR, "pmux-done.ts"),
          "--model",
          "test-model",
          "--append-system-prompt",
          syspromptPath,
          "--tools",
          "read,bash,caller_ping,pmux_done,pmux_message",
          taskArg,
        ]);
        assert.deepEqual(spec.env, {
          PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
          PI_DENY_TOOLS: "pmux_spawn,pmux_interrupt,pmux_list,pmux_resume",
          PI_PMUX_NAME: "Scout",
          PI_PMUX_AGENT: "scout",
          PI_PMUX_SESSION: running.sessionFile,
          PI_PMUX_ID: running.id,
          PI_PMUX_ACTIVITY_FILE: running.activityFile,
          PI_PMUX_SURFACE: running.surface,
          PI_PMUX_PARENT_ROSTER: getRosterFile(
            getArtifactDir(join(env.dir, "sessions"), "sess-001"),
          ),
          PI_SUBAGENT_DEPTH: "1",
          PI_BLACKHOLE_SUBAGENT_MARKERS: "PI_PMUX_SESSION",
        });
        assert.equal("PI_PMUX_AUTO_EXIT" in spec.env, false);

        // The record is on disk by the time the pane line runs.
        assert.deepEqual(recordExistedAtPaneRun, [true]);
      },
      {
        onRunInPane: (line) => {
          const specPath = /"([^"]+\.json)"/.exec(line)?.[1];
          assert.ok(specPath, `expected a launch spec path in ${line}`);
          const spec = readLaunchSpec(specPath);
          recordExistedAtPaneRun.push(
            spec.sessionFile !== undefined && existsSync(getLaunchRecordFile(spec.sessionFile)),
          );
        },
      },
    );
  });

  it("writes a Claude launch spec with a tmpdir sentinel", async () => {
    await withHarness(async (h, env) => {
      writeAgentFile(
        join(env.dir, "agent", "agents"),
        "claude-role",
        "model: claude-model\ncli: claude",
        "You are Claude.",
      );

      const running = await h.supervisor.spawn(
        { name: "ClaudeWorker", task: "Do the thing", agent: "claude-role" },
        env.ctx,
      );

      assert.equal(running.cli, "claude");
      const spec = readLaunchSpec(running.launchScriptFile as string);
      assert.equal(spec.command, "claude");
      assert.equal(spec.args[0], "--dangerously-skip-permissions");
      assert.equal(flagValue(spec.args, "--model"), "claude-model");
      assert.equal(spec.args.at(-1), "Do the thing");
      assert.equal(flagValue(spec.args, "--plugin-dir"), join(SUBAGENTS_DIR, "plugin"));
      assert.equal(spec.env.PI_CLAUDE_SENTINEL, running.sentinelFile);
      assert.ok(String(spec.env.PI_CLAUDE_SENTINEL).startsWith(tmpdir()));
      assert.equal(spec.closeOnDone, undefined);
      assert.equal(h.runs.length, 1);

      const record = readLaunchRecord(getLaunchRecordFile(running.sessionFile));
      assert.ok(record);
      assert.equal(record.backend, "claude");
      assert.equal(record.agent, "claude-role");
      assert.equal(record.model, "claude-model");
      assert.equal(record.rolePrompt, "You are Claude.");
      assert.equal(record.systemPromptMode, undefined);
    });
  });

  it("resolves the spawn role and a relative cwd against the process cwd", async () => {
    const roleFile = join(process.cwd(), ".pi", "agents", "anchor-pi-anchor.md");
    writeAgentFile(
      join(process.cwd(), ".pi", "agents"),
      "anchor-pi-anchor",
      "model: process-model",
      "You anchor at the process cwd.",
    );
    try {
      await withHarness(async (h, env) => {
        // ctx.cwd is a temp dir that differs from process.cwd(); the role
        // file exists only under the process cwd's `.pi/agents`, so a
        // session-cwd anchor would leave the role unknown.
        const running = await h.supervisor.spawn(
          { name: "Anchor", task: "do it", agent: "anchor-pi-anchor", cwd: "relative-cwd" },
          env.ctx,
          { fallback: "pane" },
        );

        const record = readLaunchRecord(getLaunchRecordFile(running.sessionFile));
        assert.ok(record);
        assert.equal(record.agent, "anchor-pi-anchor");
        assert.equal(record.model, "process-model");
        assert.equal(record.rolePrompt, "You anchor at the process cwd.");
        // The relative per-call cwd resolves against the same anchor.
        assert.equal(record.cwd, join(process.cwd(), "relative-cwd"));
        assert.equal(h.runs.length, 1);
      });
    } finally {
      rmSync(roleFile, { force: true });
    }
  });
});

function readFileNames(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}

function writePiSession(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
}

function appendPiSession(file: string, entries: unknown[]): void {
  writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", {
    flag: "a",
  });
}

function writeRecord(sessionPath: string, overrides: Partial<LaunchRecord> = {}): LaunchRecord {
  const record: LaunchRecord = {
    version: LAUNCH_RECORD_VERSION,
    backend: "pi",
    name: "Worker",
    agent: "worker",
    model: "test-model",
    tools: "read,bash",
    rolePrompt: "You are a worker.",
    systemPromptMode: "append",
    denyTools: ["pmux_spawn"],
    autoExit: true,
    interactive: false,
    ...overrides,
  };
  writeLaunchRecord(getLaunchRecordFile(sessionPath), record);
  return record;
}

/** The global agent dir the supervisor reads roles from in these tests. */
function agentsDir(env: TestEnv): string {
  return join(env.dir, "agent", "agents");
}

describe("surface precedence", () => {
  it("spawns a floating role as a float and records the role's surface", async () => {
    await withHarness(async (h, env) => {
      writeAgentFile(agentsDir(env), "float-role", "surface: float", "You float.");

      const running = await h.supervisor.spawn(
        { name: "Reviewer", task: "review it", agent: "float-role" },
        env.ctx,
      );

      assert.deepEqual(h.surfaces, [{ name: "Reviewer", placement: "float" }]);
      const record = readLaunchRecord(getLaunchRecordFile(running.sessionFile));
      assert.equal(record?.surface, "float");
    });
  });

  it("ignores a stray surface parameter and keeps the role's float", async () => {
    await withHarness(async (h, env) => {
      writeAgentFile(agentsDir(env), "float-role", "surface: float", "You float.");

      // A call may still carry a stray `surface` key; the supervisor must not
      // read it, so the role's value decides and the record keeps it.
      const running = await h.supervisor.spawn(
        { name: "Reviewer", task: "review it", agent: "float-role", surface: "pane" } as never,
        env.ctx,
      );

      assert.deepEqual(h.surfaces, [{ name: "Reviewer", placement: "float" }]);
      const record = readLaunchRecord(getLaunchRecordFile(running.sessionFile));
      assert.equal(record?.surface, "float");
    });
  });

  it("lets the role's pane beat a tab default", async () => {
    await withHarness(async (h, env) => {
      writeAgentFile(agentsDir(env), "pane-role", "surface: pane", "You split.");

      await h.supervisor.spawn({ name: "Worker", task: "build it", agent: "pane-role" }, env.ctx, {
        fallback: "tab",
      });

      assert.deepEqual(h.surfaces, [{ name: "Worker", placement: "pane" }]);
    });
  });

  it("falls back to the default when the role's surface value is invalid", async () => {
    await withHarness(async (h, env) => {
      writeAgentFile(agentsDir(env), "odd-role", "surface: window", "You are odd.");

      const running = await h.supervisor.spawn(
        { name: "Worker", task: "build it", agent: "odd-role" },
        env.ctx,
        { fallback: "tab" },
      );

      assert.deepEqual(h.surfaces, [{ name: "Worker", placement: "tab" }]);
      const record = readLaunchRecord(getLaunchRecordFile(running.sessionFile));
      assert.ok(record);
      assert.equal("surface" in record, false);
    });
  });

  it("ignores a stray surface parameter and uses the default when the role names none", async () => {
    await withHarness(async (h, env) => {
      // A call may still carry a stray `surface` key; the supervisor must not
      // read it, so the configured default decides and the record holds none.
      const running = await h.supervisor.spawn(
        { name: "Scout", task: "look around", agent: "plain-role", surface: "float" } as never,
        env.ctx,
        { fallback: "tab" },
      );

      assert.deepEqual(h.surfaces, [{ name: "Scout", placement: "tab" }]);
      const record = readLaunchRecord(getLaunchRecordFile(running.sessionFile));
      assert.ok(record);
      assert.equal("surface" in record, false);
    });
  });
});

describe("supervisor resume", () => {
  it("restores the role configuration from the launch record", async () => {
    await withHarness(async (h, env) => {
      const repoDir = join(env.dir, "repo");
      mkdirSync(repoDir, { recursive: true });
      const sessionPath = join(env.dir, "child.jsonl");
      writePiSession(sessionPath);
      writeRecord(sessionPath, { cwd: repoDir });

      const result = await h.supervisor.resume(
        { sessionPath, message: "Continue the work" },
        env.ctx,
      );

      // The pane is named after the record, not a resume default.
      assert.deepEqual(h.surfaces, [{ name: "Worker", placement: "pane" }]);
      assert.equal(h.runs.length, 1);
      assert.equal(result.content[0].text, 'Session "Worker" resumed.');
      assert.equal(result.details.name, "Worker");

      const spec = readLaunchSpec(result.details.launchScriptFile as string);
      assert.equal(spec.command, "pi");
      assert.equal(spec.name, "Worker");
      assert.equal(spec.cwd, repoDir);
      assert.equal(spec.sessionFile, sessionPath);
      assert.equal(spec.title, "Worker — Continue the work");

      // Denied tools and the agent come from the record.
      assert.equal(spec.env.PI_DENY_TOOLS, "pmux_spawn");
      assert.equal(spec.env.PI_PMUX_AGENT, "worker");
      assert.equal(spec.env.PI_PMUX_NAME, "Worker");
      assert.equal(spec.env.PI_PMUX_SESSION, sessionPath);
      assert.equal(spec.env.PI_PMUX_AUTO_EXIT, "1");
      assert.equal(flagValue(spec.args, "--model"), "test-model");
      assert.equal(flagValue(spec.args, "--tools"), "read,bash,caller_ping,pmux_done,pmux_message");

      // The role prompt goes back in as a file, as the record's mode selects.
      const syspromptPath = flagValue(spec.args, "--append-system-prompt");
      assert.ok(syspromptPath);
      assert.equal(readFileSync(syspromptPath, "utf8"), "You are a worker.");
      assert.equal(flagValue(spec.args, "--system-prompt"), undefined);

      // The prompt file holds the messaging hint and then the message.
      const promptArg = spec.args.at(-1) ?? "";
      assert.match(promptArg, /^@.*pmux-resume.*\.md$/);
      const prompt = readFileSync(promptArg.slice(1), "utf8");
      assert.match(prompt, /You can message `parent` with pmux_message/);
      assert.ok(prompt.indexOf("You can message") < prompt.indexOf("Continue the work"));

      assert.equal(h.supervisor.running()[0].interactive, false);
    });
  });

  it("restores the role's float surface from the record", async () => {
    await withHarness(async (h, env) => {
      const sessionPath = join(env.dir, "child.jsonl");
      writePiSession(sessionPath);
      writeRecord(sessionPath, { surface: "float" });

      await h.supervisor.resume({ sessionPath, message: "Continue the work" }, env.ctx);

      // The record's surface applies; there is no per-call value to beat it.
      assert.deepEqual(h.surfaces, [{ name: "Worker", placement: "float" }]);
    });
  });

  it("uses the configured default when the record holds no surface", async () => {
    await withHarness(async (h, env) => {
      const sessionPath = join(env.dir, "child.jsonl");
      writePiSession(sessionPath);
      writeRecord(sessionPath);

      await h.supervisor.resume({ sessionPath, message: "Continue the work" }, env.ctx, {
        fallback: "tab",
      });

      assert.deepEqual(h.surfaces, [{ name: "Worker", placement: "tab" }]);
    });
  });

  it("passes the role prompt with --system-prompt when the record replaces it", async () => {
    await withHarness(async (h, env) => {
      const sessionPath = join(env.dir, "child.jsonl");
      writePiSession(sessionPath);
      writeRecord(sessionPath, { systemPromptMode: "replace", cwd: undefined });

      const result = await h.supervisor.resume({ sessionPath }, env.ctx);
      const spec = readLaunchSpec(result.details.launchScriptFile as string);

      const syspromptPath = flagValue(spec.args, "--system-prompt");
      assert.ok(syspromptPath);
      assert.equal(readFileSync(syspromptPath, "utf8"), "You are a worker.");
      assert.equal(flagValue(spec.args, "--append-system-prompt"), undefined);
      // No message given: no prompt is sent.
      assert.equal(
        spec.args.some((arg) => arg.startsWith("@")),
        false,
      );
    });
  });

  it("uses the record's auto-exit and interactive values when autoExit is absent", async () => {
    await withHarness(async (h, env) => {
      const sessionPath = join(env.dir, "child.jsonl");
      writePiSession(sessionPath);
      writeRecord(sessionPath, { autoExit: false, interactive: true });

      const result = await h.supervisor.resume({ sessionPath }, env.ctx);
      const spec = readLaunchSpec(result.details.launchScriptFile as string);

      assert.equal("PI_PMUX_AUTO_EXIT" in spec.env, false);
      assert.equal(h.supervisor.running()[0].interactive, true);
    });
  });

  it("makes the run interactive when autoExit is false", async () => {
    await withHarness(async (h, env) => {
      const sessionPath = join(env.dir, "child.jsonl");
      writePiSession(sessionPath);
      writeRecord(sessionPath, { autoExit: true, interactive: false });

      const result = await h.supervisor.resume({ sessionPath, autoExit: false }, env.ctx);
      const spec = readLaunchSpec(result.details.launchScriptFile as string);

      assert.equal("PI_PMUX_AUTO_EXIT" in spec.env, false);
      assert.equal(h.supervisor.running()[0].interactive, true);
    });
  });

  it("names a running sibling before the resume message", async () => {
    await withHarness(async (h, env) => {
      const sessionPath = join(env.dir, "child.jsonl");
      writePiSession(sessionPath);
      writeRecord(sessionPath, { cwd: undefined });
      await h.supervisor.spawn(
        { name: "Reviewer", task: "review the work", agent: "plain-role" },
        env.ctx,
      );

      const result = await h.supervisor.resume(
        { sessionPath, message: "Address the review findings" },
        env.ctx,
      );
      const spec = readLaunchSpec(result.details.launchScriptFile as string);
      const prompt = readFileSync((spec.args.at(-1) ?? "").slice(1), "utf8");

      assert.match(prompt, /You can message `parent`, `Reviewer` with pmux_message/);
      assert.ok(prompt.indexOf("`Reviewer`") < prompt.indexOf("Address the review findings"));
    });
  });

  it("falls back to a plain pi resume when there is no launch record", async () => {
    await withHarness(async (h, env) => {
      const sessionPath = join(env.dir, "child.jsonl");
      writePiSession(sessionPath);

      const result = await h.supervisor.resume(
        { sessionPath, message: "Continue the work" },
        env.ctx,
      );

      assert.deepEqual(h.surfaces, [{ name: "Resume", placement: "pane" }]);
      assert.equal(result.details.name, "Resume");
      assert.match(result.content[0].text, /No launch record was found/);
      assert.match(result.content[0].text, /role configuration was not restored/);

      const spec = readLaunchSpec(result.details.launchScriptFile as string);
      assert.equal("PI_PMUX_AGENT" in spec.env, false);
      assert.equal("PI_DENY_TOOLS" in spec.env, false);
      assert.equal(spec.env.PI_PMUX_AUTO_EXIT, "1");
    });
  });

  it("falls back when the launch record is invalid and honours autoExit false", async () => {
    await withHarness(async (h, env) => {
      const sessionPath = join(env.dir, "child.jsonl");
      writePiSession(sessionPath);
      writeFileSync(getLaunchRecordFile(sessionPath), '{"version": 1, "backend": ');

      const result = await h.supervisor.resume({ sessionPath, autoExit: false }, env.ctx);

      assert.deepEqual(h.surfaces, [{ name: "Resume", placement: "pane" }]);
      assert.match(result.content[0].text, /No launch record was found/);
      assert.match(result.content[0].text, /role configuration was not restored/);

      const spec = readLaunchSpec(result.details.launchScriptFile as string);
      assert.equal("PI_PMUX_AUTO_EXIT" in spec.env, false);
      assert.equal(h.supervisor.running()[0].interactive, true);
    });
  });

  it("keeps the session-file error when neither a record nor a session file exists", async () => {
    await withHarness(async (h, env) => {
      const sessionPath = join(env.dir, "absent.jsonl");

      const result = await h.supervisor.resume({ sessionPath, message: "Continue" }, env.ctx);

      assert.equal(result.content[0].text, `Error: session file not found: ${sessionPath}`);
      assert.deepEqual(result.details, { error: "session not found" });
      assert.deepEqual(h.surfaces, []);
      assert.deepEqual(h.runs, []);
      assert.deepEqual(h.supervisor.running(), []);
    });
  });

  it("resumes a Claude Code child from its record without a session file", async () => {
    await withHarness(async (h, env) => {
      const sessionPath = join(env.dir, "claude-child.jsonl");
      writeRecord(sessionPath, { backend: "claude", claudeSessionId: "session-abc" });

      const result = await h.supervisor.resume(
        { sessionPath, message: "Continue the work" },
        env.ctx,
      );

      assert.equal(result.details.status, "started");
      assert.equal(result.details.name, "Worker");
      assert.deepEqual(h.surfaces, [{ name: "Worker", placement: "pane" }]);
      // The pi-style session file is not required and never created.
      assert.equal(existsSync(sessionPath), false);

      const spec = readLaunchSpec(result.details.launchScriptFile as string);
      assert.equal(spec.command, "claude");
      assert.deepEqual(spec.args.slice(-3), ["--resume", "session-abc", "Continue the work"]);
      assert.ok(spec.env.PI_CLAUDE_SENTINEL?.startsWith(tmpdir()));

      const [running] = h.supervisor.running();
      assert.equal(running.cli, "claude");
      assert.equal(running.entryCountBefore, 0);
      assert.equal(running.sentinelFile, spec.env.PI_CLAUDE_SENTINEL);
    });
  });

  it("returns an error and creates no surface when a Claude record has no session id", async () => {
    await withHarness(async (h, env) => {
      const sessionPath = join(env.dir, "claude-child.jsonl");
      writeRecord(sessionPath, { backend: "claude" });

      const result = await h.supervisor.resume({ sessionPath, message: "Continue" }, env.ctx);

      assert.match(result.content[0].text, /has no Claude Code session id/);
      assert.deepEqual(result.details, {
        error: "claude session id missing",
        sessionPath,
      });
      assert.deepEqual(h.surfaces, []);
      assert.deepEqual(h.runs, []);
      assert.deepEqual(h.supervisor.running(), []);
    });
  });
});

describe("model fallback", () => {
  /** Every `.launch.json` under `root`; the record a spawn writes lives
   * beside the child session file, so a tree walk says whether one exists. */
  function allLaunchRecordFiles(root: string): string[] {
    const found: string[] = [];
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".launch.json")) found.push(full);
      }
    };
    walk(root);
    return found;
  }

  it("declares the fallback parameter as an optional boolean", () => {
    assert.equal(
      Value.Check(SubagentParams, { name: "S", agent: "r", task: "t", fallback: true }),
      true,
    );
    assert.equal(
      Value.Check(SubagentParams, { name: "S", agent: "r", task: "t", fallback: false }),
      true,
    );
  });

  it("spawns the role on its model-fallback when fallback is true", async () => {
    await withHarness(async (h, env) => {
      writeAgentFile(
        agentsDir(env),
        "fb-role",
        "model: hyper/glm-5.1\nmodel-fallback: opencode-go/glm-5.3-flash\ntools: read,bash",
        "You have a fallback.",
      );

      const running = await h.supervisor.spawn(
        { name: "Scout", task: "survey the repo", agent: "fb-role", fallback: true },
        env.ctx,
      );

      // The record holds the fallback model, and the other role values apply
      // as before.
      const record = readLaunchRecord(getLaunchRecordFile(running.sessionFile));
      assert.ok(record);
      assert.equal(record.model, "opencode-go/glm-5.3-flash");
      assert.equal(record.tools, "read,bash");
      assert.equal(
        flagValue(readLaunchSpec(running.launchScriptFile as string).args, "--model"),
        "opencode-go/glm-5.3-flash",
      );
    });
  });

  it("spawns the role's own model without the parameter or with a false one", async () => {
    await withHarness(async (h, env) => {
      writeAgentFile(
        agentsDir(env),
        "fb-role",
        "model: hyper/glm-5.1\nmodel-fallback: opencode-go/glm-5.3-flash",
        "You have a fallback.",
      );

      const withoutFlag = await h.supervisor.spawn(
        { name: "Scout", task: "survey the repo", agent: "fb-role" },
        env.ctx,
      );
      const withoutRecord = readLaunchRecord(getLaunchRecordFile(withoutFlag.sessionFile));
      assert.ok(withoutRecord);
      assert.equal(withoutRecord.model, "hyper/glm-5.1");

      const falseFlag = await h.supervisor.spawn(
        { name: "Scout2", task: "survey again", agent: "fb-role", fallback: false },
        env.ctx,
      );
      const falseRecord = readLaunchRecord(getLaunchRecordFile(falseFlag.sessionFile));
      assert.ok(falseRecord);
      assert.equal(falseRecord.model, "hyper/glm-5.1");
    });
  });

  it("refuses a fallback on a role without model-fallback, and writes nothing", async () => {
    await withHarness(async (h, env) => {
      writeAgentFile(agentsDir(env), "no-fb-role", "model: hyper/glm-5.1", "You have no fallback.");

      await assert.rejects(
        h.supervisor.spawn(
          { name: "Scout", task: "survey the repo", agent: "no-fb-role", fallback: true },
          env.ctx,
        ),
        /role 'no-fb-role' has no model-fallback/,
      );

      // No pane and no record: the error throws before both.
      assert.deepEqual(h.surfaces, []);
      assert.deepEqual(allLaunchRecordFiles(env.dir), []);
    });
  });

  it("refuses fallback together with a model override, and writes nothing", async () => {
    await withHarness(async (h, env) => {
      writeAgentFile(
        agentsDir(env),
        "fb-role",
        "model: hyper/glm-5.1\nmodel-fallback: opencode-go/glm-5.3-flash",
        "You have a fallback.",
      );

      await assert.rejects(
        h.supervisor.spawn(
          {
            name: "Scout",
            task: "survey the repo",
            agent: "fb-role",
            model: "other/model",
            fallback: true,
          },
          env.ctx,
        ),
        /fallback conflicts with model/,
      );

      assert.deepEqual(h.surfaces, []);
      assert.deepEqual(allLaunchRecordFiles(env.dir), []);
    });
  });

  it("resumes a fallback spawn on the record's model, and takes no fallback parameter", async () => {
    await withHarness(async (h, env) => {
      writeAgentFile(
        agentsDir(env),
        "fb-role",
        "model: hyper/glm-5.1\nmodel-fallback: opencode-go/glm-5.3-flash",
        "You have a fallback.",
      );
      const spawned = await h.supervisor.spawn(
        { name: "Scout", task: "survey the repo", agent: "fb-role", fallback: true },
        env.ctx,
      );

      // A stray `fallback` key on the resume params is not a parameter: the
      // record's model still decides.
      const result = await h.supervisor.resume(
        { sessionPath: spawned.sessionFile, fallback: true } as ResumeParams,
        env.ctx,
      );

      const record = readLaunchRecord(getLaunchRecordFile(spawned.sessionFile));
      assert.ok(record);
      assert.equal(record.model, "opencode-go/glm-5.3-flash");
      const spec = readLaunchSpec(result.details.launchScriptFile as string);
      assert.equal(flagValue(spec.args, "--model"), "opencode-go/glm-5.3-flash");
    });
  });
});

describe("supervisor watcher", () => {
  it("keeps the session summary when the pane is already gone (pi)", async () => {
    await withHarness(
      async (h, env) => {
        const running = await h.supervisor.spawn(
          { name: "Scout", task: "survey", agent: "plain-role" },
          env.ctx,
        );
        writeFileSync(
          running.sessionFile,
          [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]
            .map((entry) => JSON.stringify(entry))
            .join("\n") + "\n",
        );

        h.polls.finish({ reason: "done", exitCode: 0 });
        await waitFor(() => h.sent.length === 1, "the result steer");

        assert.deepEqual(h.closed, [running.surface]);
        assert.equal(h.sent[0].message.customType, "pmux_result");
        assert.match(h.sent[0].message.content, /Here is my plan\.\.\./);
        assert.match(h.sent[0].message.content, /Resume: pmux_resume/);
        assert.doesNotMatch(h.sent[0].message.content, /pi --session/);
        assert.doesNotMatch(h.sent[0].message.content, /Subagent cancelled/);
        assert.deepEqual(h.supervisor.running(), []);
      },
      { closeSurfaceThrows: true },
    );
  });

  it("keeps the sentinel summary when the pane is already gone (claude)", async () => {
    await withHarness(
      async (h, env) => {
        writeAgentFile(
          join(env.dir, "agent", "agents"),
          "claude-role",
          "cli: claude",
          "You are Claude.",
        );
        const running = await h.supervisor.spawn(
          { name: "Scout", task: "survey", agent: "claude-role" },
          env.ctx,
        );
        writeFileSync(running.sentinelFile as string, "All checks pass.\n");

        h.polls.finish({ reason: "done", exitCode: 0 });
        await waitFor(() => h.sent.length === 1, "the result steer");

        assert.deepEqual(h.closed, [running.surface]);
        assert.equal(h.sent[0].message.customType, "pmux_result");
        assert.match(h.sent[0].message.content, /All checks pass\./);
        assert.equal(h.supervisor.running().length, 0);
      },
      { closeSurfaceThrows: true },
    );
  });

  it("stores the Claude session id in the record and returns the session file", async () => {
    const previousHome = process.env.HOME;
    await withHarness(async (h, env) => {
      process.env.HOME = join(env.dir, "home");
      try {
        writeAgentFile(
          join(env.dir, "agent", "agents"),
          "claude-role",
          "cli: claude",
          "You are Claude.",
        );
        const running = await h.supervisor.spawn(
          { name: "Scout", task: "survey", agent: "claude-role" },
          env.ctx,
        );

        // A Claude Code transcript named after its session id, as the hook
        // records it. The copied file lands under the fake HOME.
        const sessionId = "8a1b2c3d-0000-4000-8000-123456789abc";
        const transcriptPath = join(env.dir, "claude", `${sessionId}.jsonl`);
        mkdirSync(dirname(transcriptPath), { recursive: true });
        writeFileSync(transcriptPath, '{"type":"user","message":{"content":"survey"}}\n');
        writeFileSync(`${running.sentinelFile as string}.transcript`, `${transcriptPath}\n`);
        writeFileSync(running.sentinelFile as string, "All checks pass.\n");

        h.polls.finish({ reason: "done", exitCode: 0 });
        await waitFor(() => h.sent.length === 1, "the result steer");

        // The record keeps the id without the transcript extension.
        const record = readLaunchRecord(getLaunchRecordFile(running.sessionFile));
        assert.ok(record);
        assert.equal(record.claudeSessionId, sessionId);
        assert.equal(record.backend, "claude");
        assert.equal(record.agent, "claude-role");
        assert.equal(record.name, "Scout");

        assert.equal(
          existsSync(
            join(env.dir, "home", ".pi", "agent", "sessions", "claude-code", `${sessionId}.jsonl`),
          ),
          true,
        );

        // The result names the record-adjacent session path for pmux_resume.
        const { message } = h.sent[0];
        assert.equal(message.details?.sessionFile, running.sessionFile);
        assert.equal(message.details?.claudeSessionId, sessionId);
        assert.ok(message.content.includes(`Session: ${running.sessionFile}`));
        assert.ok(message.content.includes(`Resume: pmux_resume ${running.sessionFile}`));
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      }
    });
  });

  it("sends one pmux_handoff steer for a handoff result", async () => {
    await withHarness(async (h, env) => {
      const realNow = Date.now;
      let nowMs = 1_000;
      Date.now = () => nowMs;
      try {
        writeAgentFile(
          join(env.dir, "agent", "agents"),
          "worker",
          "model: test-model",
          "You are a worker.",
        );
        const running = await h.supervisor.spawn(
          { name: "Worker", task: "implement rows 3.x", agent: "worker" },
          env.ctx,
        );

        nowMs = 81_000;
        h.polls.finish({
          reason: "handoff",
          exitCode: 0,
          handoff: { message: "Goal: X. Done: A. Left: B." },
        });
        await waitFor(() => h.sent.length === 1, "the handoff steer");

        assert.equal(h.sent.length, 1);
        const { message, options } = h.sent[0];
        assert.equal(message.customType, "pmux_handoff");
        assert.deepEqual(options, { triggerTurn: true, deliverAs: "steer" });
        assert.match(
          message.content,
          /Sub-agent "Worker" handed off at the context alert \(1m 20s\)\. The task is not complete\./,
        );
        assert.match(message.content, /Goal: X\. Done: A\. Left: B\./);
        assert.match(
          message.content,
          /Start a new subagent with this handoff in its task\. Do not resume this session\./,
        );
        assert.ok(message.content.includes(`Session: ${running.sessionFile}`));
        // No `Resume:` line — a handoff tells the parent to start a NEW subagent.
        assert.doesNotMatch(message.content, /Resume:/);
        assert.equal(message.details?.name, "Worker");
        assert.equal(message.details?.task, "implement rows 3.x");
        assert.equal(message.details?.agent, "worker");
      } finally {
        Date.now = realNow;
      }
    });
  });

  it("ends a cancelled run quietly: the pane closes and the parent gets no message", async () => {
    await withHarness(async (h, env) => {
      writeAgentFile(
        join(env.dir, "agent", "agents"),
        "worker",
        "model: test-model",
        "You are a worker.",
      );
      const running = await h.supervisor.spawn(
        { name: "Worker", task: "implement rows 5.x", agent: "worker" },
        env.ctx,
      );

      h.polls.finish({ reason: "cancelled", exitCode: 0 });
      await waitFor(() => h.supervisor.running().length === 0, "the run to leave the registry");

      assert.deepEqual(h.closed, [running.surface]);
      assert.deepEqual(h.sent, []);
    });
  });

  it("summarises a resumed child from the entries written after the resume", async () => {
    await withHarness(async (h, env) => {
      const sessionPath = join(env.dir, "child.jsonl");
      writePiSession(sessionPath);
      writeRecord(sessionPath);

      await h.supervisor.resume({ sessionPath, message: "Continue the work" }, env.ctx);
      appendPiSession(sessionPath, [
        {
          type: "message",
          id: "user-002",
          parentId: "asst-001",
          message: { role: "user", content: [{ type: "text", text: "Continue" }] },
        },
        {
          type: "message",
          id: "asst-002",
          parentId: "user-002",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "The follow-up result." }],
          },
        },
      ]);

      h.polls.finish({ reason: "done", exitCode: 0 });
      await waitFor(() => h.sent.length === 1, "the resumed result steer");

      assert.equal(h.sent[0].message.customType, "pmux_result");
      assert.match(h.sent[0].message.content, /The follow-up result\./);
      assert.doesNotMatch(h.sent[0].message.content, /Here is my plan/);
    });
  });

  it("carries the agent in a resumed child's ping details", async () => {
    await withHarness(async (h, env) => {
      const sessionPath = join(env.dir, "child.jsonl");
      writePiSession(sessionPath);
      writeRecord(sessionPath);

      await h.supervisor.resume({ sessionPath, message: "Continue the work" }, env.ctx);
      h.polls.finish({
        reason: "ping",
        exitCode: 0,
        ping: { name: "Worker", message: "Need a decision" },
      });
      await waitFor(() => h.sent.length === 1, "the resumed ping steer");

      const { message } = h.sent[0];
      assert.equal(message.customType, "pmux_ping");
      assert.equal(message.details?.name, "Worker");
      assert.equal(message.details?.task, "Continue the work");
      assert.equal(message.details?.agent, "worker");
    });
  });

  it("carries name, task and agent in a delivery error", async () => {
    await withHarness(
      async (h, env) => {
        writeAgentFile(
          join(env.dir, "agent", "agents"),
          "worker",
          "model: test-model",
          "You are a worker.",
        );
        const running = await h.supervisor.spawn(
          { name: "Worker", task: "implement rows 4.x", agent: "worker" },
          env.ctx,
        );
        writePiSession(running.sessionFile);

        h.polls.finish({ reason: "done", exitCode: 0 });
        await waitFor(() => h.sent.length === 1, "the error steer");

        const { message } = h.sent[0];
        assert.equal(message.customType, "pmux_result");
        assert.match(message.content, /Sub-agent "Worker" error: send failed/);
        assert.equal(message.details?.name, "Worker");
        assert.equal(message.details?.task, "implement rows 4.x");
        assert.equal(message.details?.agent, "worker");
      },
      { failSendOnce: (message) => message.customType === "pmux_result" },
    );
  });
});

describe("supervisor interrupt", () => {
  it("resolves interrupt targets by exact id and reports name ambiguity", async () => {
    await withHarness(async (h, env) => {
      await h.supervisor.spawn({ name: "Worker", task: "", agent: "plain-role" }, env.ctx);
      await h.supervisor.spawn({ name: "Worker", task: "", agent: "plain-role" }, env.ctx);
      const scout = await h.supervisor.spawn(
        { name: "Scout", task: "", agent: "plain-role" },
        env.ctx,
      );

      const byId = h.supervisor.interrupt({ id: scout.id, name: "Worker" });
      assert.match(byId.content[0].text, /Interrupt requested for subagent "Scout"\./);

      const ambiguous = h.supervisor.interrupt({ name: "Worker" });
      assert.match(ambiguous.content[0].text, /Ambiguous subagent name/);
    });
  });

  it("returns an explicit error when Escape delivery fails", async () => {
    await withHarness(async (h, env) => {
      const running = await h.supervisor.spawn(
        { name: "Worker", task: "", agent: "plain-role" },
        env.ctx,
      );

      const result = h.supervisor.interrupt({ name: "Worker" }, () => {
        throw new Error("mux write failed");
      });

      assert.match(result.content[0].text, /Failed to send Escape/);
      assert.equal(running.abortController?.signal.aborted, false);
      assert.equal("interruptRequested" in running, false);
    });
  });

  it("leaves status unchanged when Escape delivery fails in the tool path", async () => {
    await withHarness(async (h, env) => {
      const running = await h.supervisor.spawn(
        { name: "Worker", task: "", agent: "plain-role" },
        env.ctx,
      );
      running.statusState = observeStatus(
        createStatusState({ source: "pi", startTimeMs: 0 }),
        activeObservation(),
        5_000,
      );

      const result = withMockedNow(20_000, () =>
        h.supervisor.interrupt({ name: "Worker" }, () => {
          throw new Error("mux write failed");
        }),
      );

      assert.match(result.content[0].text, /Failed to send Escape/);
      assert.equal(classifyStatus(running.statusState, 20_000).kind, "active");
    });
  });

  it("sends Escape without aborting or mutating running state", async () => {
    await withHarness(async (h, env) => {
      const running = await h.supervisor.spawn(
        { name: "Worker", task: "", agent: "plain-role" },
        env.ctx,
      );
      let sentSurface = "";

      const result = h.supervisor.interrupt({ name: "Worker" }, (surface: string) => {
        sentSurface = surface;
      });

      assert.match(result.content[0].text, /Interrupt requested for subagent "Worker"\./);
      assert.equal(sentSurface, running.surface);
      assert.equal(running.abortController?.signal.aborted, false);
      assert.equal("interruptRequested" in running, false);
    });
  });

  it("refreshes the latest activity snapshot before forcing local interrupt waiting", async () => {
    await withHarness(async (h, env) => {
      const running = await h.supervisor.spawn(
        { name: "Worker", task: "", agent: "plain-role" },
        env.ctx,
      );
      writeFileSync(
        running.activityFile as string,
        `${JSON.stringify({
          version: 1,
          runningChildId: running.id,
          createdAt: 1_000,
          updatedAt: 19_000,
          sequence: 7,
          latestEvent: "tool_execution_start",
          phase: "active",
          agentActive: true,
          turnActive: true,
          providerActive: false,
          toolActive: true,
          activeScope: "tool",
          activeSince: 19_000,
          toolName: "bash",
        })}\n`,
      );

      withMockedNow(20_000, () => h.supervisor.interrupt({ name: "Worker" }, () => {}));

      const snapshot: StatusSnapshot = classifyStatus(running.statusState, 20_000);
      assert.equal(snapshot.kind, "waiting");
      assert.equal(snapshot.activityLabel, "interrupted");
      assert.equal(running.statusState.lastActivityAtMs, 20_000);
      assert.equal(running.statusState.lastActivitySequence, 7);
      assert.equal(running.statusState.localOverrideSequence, 7);
    });
  });

  it("acknowledges Pi-backed interrupt requests and forces local status waiting", async () => {
    await withHarness(async (h, env) => {
      const running = await h.supervisor.spawn(
        { name: "Worker", task: "", agent: "plain-role" },
        env.ctx,
      );
      running.statusState = observeStatus(
        createStatusState({ source: "pi", startTimeMs: 0 }),
        activeObservation(),
        5_000,
      );

      const result = withMockedNow(20_000, () =>
        h.supervisor.interrupt({ name: "Worker" }, () => {}),
      );

      assert.equal(result.content[0].text, 'Interrupt requested for subagent "Worker".');
      assert.deepEqual(result.details, {
        id: running.id,
        name: "Worker",
        status: "interrupt_requested",
      });
      const snapshot = classifyStatus(running.statusState, 20_000);
      assert.equal(snapshot.kind, "waiting");
      assert.equal(snapshot.activityLabel, "interrupted");
      assert.equal(
        h.supervisor.running().some((agent) => agent.id === running.id),
        true,
      );
    });
  });

  it("sends Escape again for repeated interrupt requests", async () => {
    await withHarness(async (h, env) => {
      const running = await h.supervisor.spawn(
        { name: "Worker", task: "", agent: "plain-role" },
        env.ctx,
      );
      const surfaces: string[] = [];

      h.supervisor.interrupt({ name: "Worker" }, (surface: string) => surfaces.push(surface));
      h.supervisor.interrupt({ name: "Worker" }, (surface: string) => surfaces.push(surface));

      assert.deepEqual(surfaces, [running.surface, running.surface]);
      assert.equal(
        h.supervisor.running().some((agent) => agent.id === running.id),
        true,
      );
    });
  });

  it("rejects Claude-backed interrupt requests before delivery", async () => {
    await withHarness(async (h, env) => {
      writeAgentFile(
        join(env.dir, "agent", "agents"),
        "claude-role",
        "cli: claude",
        "You are Claude.",
      );
      const running = await h.supervisor.spawn(
        { name: "Worker", task: "", agent: "claude-role" },
        env.ctx,
      );
      let delivered = false;

      const result = h.supervisor.interrupt({ name: "Worker" }, () => {
        delivered = true;
      });

      assert.equal(delivered, false);
      assert.match(result.content[0].text, /currently supported only for Pi-backed subagents/i);
      assert.deepEqual(result.details, {
        error: "claude interrupt unsupported",
        id: running.id,
        name: "Worker",
      });
    });
  });
});

describe("supervisor roster", () => {
  it("builds the roster from the running map after add and remove", async () => {
    await withHarness(async (h, env) => {
      writeAgentFile(
        join(env.dir, "agent", "agents"),
        "claude-role",
        "cli: claude",
        "You are Claude.",
      );
      const worker = await h.supervisor.spawn(
        { name: "Worker", task: "", agent: "plain-role" },
        env.ctx,
      );
      const scout = await h.supervisor.spawn(
        { name: "Scout", task: "", agent: "claude-role" },
        env.ctx,
      );

      assert.deepEqual(rosterChildren(env), [
        { id: worker.id, name: "Worker", pane: "24", cli: "pi" },
        { id: scout.id, name: "Scout", pane: "25", cli: "claude" },
      ]);

      h.polls.finish({ reason: "done", exitCode: 0 });
      await waitFor(() => h.supervisor.running().length === 1, "the worker to leave");

      assert.deepEqual(rosterChildren(env), [
        { id: scout.id, name: "Scout", pane: "25", cli: "claude" },
      ]);
    });
  });
});

describe("supervisor shutdown", () => {
  it("aborts its watchers and clears its intervals on shutdown", async () => {
    await withHarness(
      async (h, env) => {
        const created: unknown[] = [];
        const cleared: unknown[] = [];
        const realSetInterval = globalThis.setInterval;
        const realClearInterval = globalThis.clearInterval;
        globalThis.setInterval = ((fn: any, ms: any) => {
          const handle = realSetInterval(fn, ms);
          created.push(handle);
          return handle;
        }) as typeof globalThis.setInterval;
        globalThis.clearInterval = ((handle: any) => {
          cleared.push(handle);
          return realClearInterval(handle);
        }) as typeof globalThis.clearInterval;

        try {
          const running: RunningSubagent = await h.supervisor.spawn(
            { name: "Worker", task: "", agent: "plain-role" },
            env.ctx,
          );
          assert.equal(created.length, 2);
          assert.equal(running.abortController?.signal.aborted, false);

          h.supervisor.shutdown();

          assert.equal(h.supervisor.isShutdown, true);
          assert.deepEqual(h.supervisor.running(), []);
          assert.equal(running.abortController?.signal.aborted, true);
          assert.deepEqual(
            created.filter((handle) => !cleared.includes(handle)),
            [],
          );
        } finally {
          globalThis.setInterval = realSetInterval;
          globalThis.clearInterval = realClearInterval;
        }
      },
      { ui: true },
    );
  });

  it("starts a second supervisor empty and with a live poll signal", async () => {
    await withHarness(async (h, env) => {
      h.supervisor.shutdown();
      assert.equal(h.supervisor.isShutdown, true);

      const pollSignals: boolean[] = [];
      const second = h.newSupervisor({
        pollForExit: (_surface, signal) => {
          pollSignals.push(signal.aborted);
          return new Promise<PollResult>((resolve) => {
            signal.addEventListener("abort", () => resolve({ reason: "done", exitCode: 0 }), {
              once: true,
            });
          });
        },
      });

      try {
        assert.deepEqual(second.supervisor.running(), []);
        assert.equal(second.supervisor.getAbortController().signal.aborted, false);

        await second.supervisor.spawn({ name: "Scout", task: "", agent: "plain-role" }, env.ctx);
        assert.deepEqual(pollSignals, [false]);
      } finally {
        second.supervisor.shutdown();
      }
    });
  });
});
