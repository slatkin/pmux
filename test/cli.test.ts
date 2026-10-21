import "./host-env.ts";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Sandbox the Luvus ambient environment for the whole test process (see the
// same block in test.ts): an ambient Luvus session must never be reachable
// from an un-stubbed test.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("LUVUS_")) delete process.env[key];
}
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LAUNCH_SPEC_VERSION,
  buildPaneTitle,
  paneCommandLine,
  readLaunchSpec,
  resolvePiCommand,
  validateLaunchSpec,
  writeLaunchSpec,
  type LaunchSpec,
} from "../pi-extension/pmux/launch.ts";
import { runSpec } from "../pi-extension/pmux/run.ts";
import { main } from "../pi-extension/pmux/cli.ts";
import { __setTmuxExecForTests__ } from "../pi-extension/pmux/tmux.ts";
import { argValue, placementRow, useTmuxPaneFake } from "./tmux-fakes.ts";
import { main as shimMain } from "../skills/pmux/launch.ts";
import { tempDirHelpers } from "./temp-dir.ts";

const { withTempDir, withTempDirAsync } = tempDirHelpers("pi-test-");

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PI_STUB = join(TEST_DIR, "stubs", "pi-stub.ts");

/** Wait for a file the stub child writes, so a test can act while it runs. */
async function waitForFile(path: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface RunOutcome {
  /** Exit code returned by `runSpec` (the code the CLI exits with). */
  code: number;
  stdout: string;
  stderr: string;
  /** Grace values passed to the injected `sleep`, in order. */
  sleptMs: number[];
  /** Pane ids passed to the injected `closePane`, in order. */
  closedPanes: string[];
  /** What the stub child recorded from its own argv and environment. */
  record: { args: string[]; env: Record<string, string> } | null;
  /** `<session>.exit` contents, or null when the stub wrote none. */
  sidecar: string | null;
  /** Wake-up messages the wrapper sent, in order. */
  woken: Array<{ to: string; text: string }>;
}

interface RunCase {
  /** Spec fields merged over the stub defaults. */
  spec?: Partial<LaunchSpec>;
  /** Extra wrapper environment, merged over the test defaults. */
  env?: NodeJS.ProcessEnv;
  /** Prompt path passed to `runSpec`, if any. */
  prompt?: string;
  /** Parent wake-up override; defaults to a recorder surfaced as `woken`. */
  sendToParent?: (to: string, text: string) => void;
}

/** Run the wrapper against the stub child with every side effect recorded. */
async function runStubCase(dir: string, options: RunCase = {}): Promise<RunOutcome> {
  const recordPath = join(dir, "record.json");
  const stdout: string[] = [];
  const stderr: string[] = [];
  const sleptMs: number[] = [];
  const closedPanes: string[] = [];
  const woken: Array<{ to: string; text: string }> = [];
  const spec: LaunchSpec = {
    version: LAUNCH_SPEC_VERSION,
    name: "scout-1",
    env: {},
    command: process.execPath,
    args: [PI_STUB],
    sessionFile: join(dir, "session.jsonl"),
    ...options.spec,
  };
  const exitPath = spec.sessionFile === undefined ? undefined : `${spec.sessionFile}.exit`;

  const code = await runSpec(spec, options.prompt, {
    env: {
      PATH: process.env.PATH,
      TMUX_PANE: "%77",
      PI_STUB_RECORD: recordPath,
      PI_STUB_EXIT: exitPath,
      ...options.env,
    },
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    sleep: async (ms) => {
      sleptMs.push(ms);
    },
    closePane: (pane) => closedPanes.push(pane),
    sendToParent: options.sendToParent ?? ((to, text) => woken.push({ to, text })),
  });

  const record = existsSync(recordPath)
    ? (JSON.parse(readFileSync(recordPath, "utf8")) as RunOutcome["record"])
    : null;
  return {
    code,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
    sleptMs,
    closedPanes,
    record,
    sidecar: exitPath !== undefined && existsSync(exitPath) ? readFileSync(exitPath, "utf8") : null,
    woken,
  };
}

/** One receipt line, as the `send` subcommand writes it. */
function receiptLine(to: string): string {
  return `${JSON.stringify({ at: new Date().toISOString(), to, bytes: 4 })}\n`;
}

/** A send-mode spec whose stub child appends `line` to the receipt file. */
function sendSpecWithReceipt(receiptFile: string, line: string): Partial<LaunchSpec> {
  return {
    parent: "%12",
    report: "send",
    args: [
      "-e",
      `require("fs").appendFileSync(${JSON.stringify(receiptFile)}, ${JSON.stringify(line)})`,
    ],
  };
}

const SPEC: LaunchSpec = {
  version: LAUNCH_SPEC_VERSION,
  name: "scout-1",
  env: { PI_PMUX_SESSION: "/tmp/session.jsonl" },
  command: "pi",
  args: ["--session", "/tmp/session.jsonl"],
  closeOnDone: { graceMs: 0 },
};

describe("launch spec", () => {
  it("round-trips a spec through writeLaunchSpec and readLaunchSpec", () => {
    withTempDir((dir) => {
      const specPath = join(dir, "nested", "scout-1.json");
      writeLaunchSpec(specPath, SPEC);
      assert.deepEqual(readLaunchSpec(specPath), SPEC);
    });
  });

  it("rejects malformed JSON", () => {
    withTempDir((dir) => {
      const specPath = join(dir, "bad.json");
      writeFileSync(specPath, "{ not json");
      assert.throws(() => readLaunchSpec(specPath), /Cannot read launch spec/);
    });
  });

  it("rejects a missing command", () => {
    assert.throws(
      () => validateLaunchSpec({ version: LAUNCH_SPEC_VERSION, name: "x", env: {}, args: [] }),
      /missing command/,
    );
  });

  it("rejects an unknown version", () => {
    assert.throws(() => validateLaunchSpec({ ...SPEC, version: 2 }), /unknown version 2/);
  });

  it("rejects an unknown report mode", () => {
    assert.throws(
      () => validateLaunchSpec({ ...SPEC, report: "email" }),
      /report must be last or send/,
    );
  });

  it("reads an absent report field as last and keeps the field out", () => {
    withTempDir((dir) => {
      const specPath = join(dir, "last.json");
      writeLaunchSpec(specPath, SPEC);
      const spec = readLaunchSpec(specPath);
      assert.equal(spec.report, undefined);
      assert.equal("report" in spec, false);
    });
  });
});

describe("paneCommandLine", () => {
  it("builds the documented node command line and double-quotes every later token", () => {
    assert.equal(
      paneCommandLine("/ext/cli.ts", "/tmp/sc ratch/spec.json"),
      'node "/ext/cli.ts" "run" "/tmp/sc ratch/spec.json"',
    );
  });

  it("appends the prompt as the last token", () => {
    assert.equal(
      paneCommandLine("/ext/cli.ts", "/spec.json", "/tmp/prompt one.md"),
      'node "/ext/cli.ts" "run" "/spec.json" "/tmp/prompt one.md"',
    );
  });

  it("rejects a token with any character a supported shell would expand", () => {
    const unsafe = [
      "/tmp/a$b",
      "/tmp/a%b",
      '/tmp/a"b',
      "/tmp/a`b",
      "/tmp/a!b",
      "/tmp/a\\\\b",
      "/tmp/a\u0007b",
    ];
    for (const token of unsafe) {
      assert.throws(
        () => paneCommandLine("/ext/cli.ts", token),
        /Unsafe pane command token/,
        `expected rejection for ${JSON.stringify(token)}`,
      );
    }
  });

  it("allows single backslashes in a Windows path", () => {
    assert.equal(
      paneCommandLine("C:\\ext\\cli.ts", "C:\\spec.json"),
      'node "C:\\ext\\cli.ts" "run" "C:\\spec.json"',
    );
  });
});

describe("buildPaneTitle", () => {
  it("strips control characters and escape sequences from hostile task text", () => {
    assert.equal(
      buildPaneTitle("Scout", "Fix\x1b[2J the\x07 bug\nsecond line"),
      "Scout — Fix[2J the bug",
    );
    assert.equal(buildPaneTitle("Scout", "x".repeat(60)), "Scout — " + "x".repeat(48));
  });

  it("titles with the name alone when the task is missing or empty, and nothing for an unprintable name", () => {
    assert.equal(buildPaneTitle("Scout"), "Scout");
    assert.equal(buildPaneTitle("Scout", ""), "Scout");
    assert.equal(buildPaneTitle("Scout", "\n   \n"), "Scout");
    assert.equal(buildPaneTitle(""), "");
    assert.equal(buildPaneTitle("\x1b\x07"), "");
  });
});

describe("resolvePiCommand", () => {
  it("prefers PI_PMUX_PI_ENTRY and runs it with the current node", () => {
    assert.deepEqual(
      resolvePiCommand({
        platform: "linux",
        env: { PI_PMUX_PI_ENTRY: "/opt/pi/entry.js" },
        execPath: "/usr/bin/node",
      }),
      ["/usr/bin/node", "/opt/pi/entry.js"],
    );
  });

  it("resolves a win32 npm pi.cmd to the sibling package bin entry", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "pi.cmd"), "@echo off\n");
      const packageDir = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
      mkdirSync(join(packageDir, "dist", "bundle"), { recursive: true });
      writeFileSync(join(packageDir, "dist", "bundle", "cli.js"), "// pi entry\n");
      writeFileSync(
        join(packageDir, "package.json"),
        JSON.stringify({
          name: "@earendil-works/pi-coding-agent",
          bin: { pi: "dist/bundle/cli.js" },
        }),
      );
      assert.deepEqual(
        resolvePiCommand({
          platform: "win32",
          env: { PATH: `C:\\Windows;${dir}` },
          execPath: "C:\\node.exe",
        }),
        ["C:\\node.exe", join(packageDir, "dist", "bundle", "cli.js")],
      );
    });
  });

  it("skips a win32 pi.cmd that has no sibling pi package and falls back to pi", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "pi.cmd"), "@echo off\n");
      assert.deepEqual(
        resolvePiCommand({ platform: "win32", env: { PATH: dir }, execPath: "/node" }),
        ["pi"],
      );
    });
  });

  it("falls back to pi on posix", () => {
    assert.deepEqual(
      resolvePiCommand({ platform: "linux", env: { PATH: "/usr/bin" }, execPath: "/node" }),
      ["pi"],
    );
  });
});

describe("runSpec", () => {
  it("prints the sentinel and returns the child's code (0)", async () => {
    await withTempDirAsync(async (dir) => {
      const result = await runStubCase(dir, { env: { PI_STUB_CODE: "0" } });
      assert.equal(result.stdout, "__SUBAGENT_DONE_0__\n");
      assert.equal(result.code, 0);
      assert.deepEqual(result.record?.args, []);
    });
  });

  it("prints the sentinel and returns the child's code (1)", async () => {
    await withTempDirAsync(async (dir) => {
      const result = await runStubCase(dir, { env: { PI_STUB_CODE: "1" } });
      assert.equal(result.stdout, "__SUBAGENT_DONE_1__\n");
      assert.equal(result.code, 1);
    });
  });

  it("reports 127 and names the command when the child cannot start", async () => {
    await withTempDirAsync(async (dir) => {
      const result = await runStubCase(dir, { spec: { command: "definitely-not-a-real-pi-xyz" } });
      assert.equal(result.stdout, "__SUBAGENT_DONE_127__\n");
      assert.equal(result.code, 127);
      assert.match(result.stderr, /definitely-not-a-real-pi-xyz/);
      assert.equal(result.record, null);
    });
  });

  it("reports 128 + signal when a signal ended the child", async () => {
    await withTempDirAsync(async (dir) => {
      const result = await runStubCase(dir, { env: { PI_STUB_SIGNAL: "SIGTERM" } });
      assert.equal(result.stdout, "__SUBAGENT_DONE_143__\n");
      assert.equal(result.code, 143);
    });
  });

  it("merges spec env over the wrapper env, with PI_PMUX_SURFACE from the wrapper's pane", async () => {
    await withTempDirAsync(async (dir) => {
      const result = await runStubCase(dir, {
        env: { TMUX_PANE: "%55", PI_RUN_BASE: "base", PI_RUN_SHARED: "base" },
        spec: { env: { PI_RUN_SPEC: "spec", PI_RUN_SHARED: "spec" } },
      });
      assert.ok(result.record);
      assert.equal(result.record.env.PI_PMUX_SURFACE, "%55");
      assert.equal(result.record.env.PI_RUN_BASE, "base");
      assert.equal(result.record.env.PI_RUN_SPEC, "spec");
      assert.equal(result.record.env.PI_RUN_SHARED, "spec");
    });
  });

  it("appends the prompt as one @ argument, with no shell interpretation", async () => {
    await withTempDirAsync(async (dir) => {
      const prompt = join(dir, "a $HOME prompt.md");
      writeFileSync(prompt, "follow up\n");
      const result = await runStubCase(dir, {
        spec: { args: [PI_STUB, "--session", join(dir, "s.jsonl")] },
        prompt,
      });
      assert.deepEqual(result.record?.args, ["--session", join(dir, "s.jsonl"), `@${prompt}`]);
    });
  });

  // A skill launch carries the external-parent marker even with `parent` set:
  // the wrapper contacts nobody in last mode, and the wrapper-error sidecar
  // logic is untouched.
  it("contacts nobody when a last-mode child exits", async () => {
    await withTempDirAsync(async (dir) => {
      const result = await runStubCase(dir, {
        spec: { parent: "orch" },
        env: { PI_STUB_CODE: "0" },
      });
      assert.equal(result.stdout, "__SUBAGENT_DONE_0__\n");
      assert.equal(result.stderr, "");
      assert.deepEqual(result.closedPanes, []);
      assert.deepEqual(result.woken, []);
      // The wrapper-error sidecar logic is untouched: a child that wrote no
      // sidecar still gets the wrapper's `error` sidecar.
      const sidecar = result.sidecar ? JSON.parse(result.sidecar) : null;
      assert.equal(sidecar?.type, "error");
      assert.equal(sidecar?.source, "wrapper");
    });
  });

  // The invariance the wake-up tests guard: only a `send` spec with a parent
  // may contact the parent. A `last` spec with a parent must stay silent.
  it("contacts nobody when the spec has a parent and no report mode", async () => {
    await withTempDirAsync(async (dir) => {
      const result = await runStubCase(dir, {
        spec: { parent: "%12" },
        env: { PI_STUB_EXIT_BODY: '{"type":"done"}' },
      });
      assert.deepEqual(result.woken, []);
      assert.equal(result.stderr, "");
    });
  });

  it("wakes the parent when a send-mode child exits without a report", async () => {
    await withTempDirAsync(async (dir) => {
      const result = await runStubCase(dir, {
        spec: { parent: "%12", report: "send" },
        env: { PI_STUB_EXIT_BODY: '{"type":"done"}' },
      });
      assert.deepEqual(result.woken, [
        {
          to: "%12",
          text: `scout-1 done without sending a report. Read its last message: node <pmux-cli> last-message --session ${join(dir, "session.jsonl")}`,
        },
      ]);
    });
  });

  it("wakes the parent with state error after the wrapper sidecar when a send-mode child crashes", async () => {
    await withTempDirAsync(async (dir) => {
      const result = await runStubCase(dir, {
        spec: { parent: "%12", report: "send" },
        env: { PI_STUB_CODE: "2" },
      });
      // The wrapper wrote its own `error` sidecar first, so the wake-up names
      // that state instead of the raw exit code.
      const sidecar = result.sidecar ? JSON.parse(result.sidecar) : null;
      assert.equal(sidecar?.type, "error");
      assert.equal(sidecar?.source, "wrapper");
      assert.equal(result.woken.length, 1);
      assert.match(result.woken[0]!.text, /^scout-1 error without sending a report/);
      assert.match(result.woken[0]!.text, /last-message --session/);
    });
  });

  it("wakes the parent with the crash state when a send-mode child left a terminal status", async () => {
    await withTempDirAsync(async (dir) => {
      // A `done` status the child wrote itself is terminal, so the wrapper
      // writes no sidecar of its own and the wake-up carries the raw crash.
      writeFileSync(
        join(dir, "session.jsonl.status"),
        JSON.stringify({ status: "done", at: new Date().toISOString() }),
      );
      const result = await runStubCase(dir, {
        spec: { parent: "%12", report: "send" },
        env: { PI_STUB_CODE: "2" },
      });
      assert.equal(result.sidecar, null);
      assert.equal(result.woken.length, 1);
      assert.match(result.woken[0]!.text, /^scout-1 crashed \(code 2\) without sending a report/);
      assert.match(result.woken[0]!.text, /last-message --session/);
    });
  });

  it("quotes a ping sidecar in the wake-up", async () => {
    await withTempDirAsync(async (dir) => {
      const result = await runStubCase(dir, {
        spec: { parent: "%12", report: "send" },
        env: { PI_STUB_EXIT_BODY: '{"type":"ping","name":"w","message":"Which DB?"}' },
      });
      assert.deepEqual(result.woken, [{ to: "%12", text: "scout-1 pinged: Which DB?" }]);
    });
  });

  it("names the launch spec's child in the wake-up, not the sidecar's name", async () => {
    await withTempDirAsync(async (dir) => {
      const result = await runStubCase(dir, {
        spec: { name: "worker-a", parent: "%12", report: "send" },
        env: { PI_STUB_EXIT_BODY: '{"type":"done"}' },
      });
      assert.equal(result.woken.length, 1);
      assert.match(result.woken[0]!.text, /^worker-a done without sending a report/);
    });
  });

  it("does not wake the parent when the send-mode child reported", async () => {
    await withTempDirAsync(async (dir) => {
      // The child delivers its report while it runs, so the receipt lands
      // after the wrapper took its baseline count.
      const result = await runStubCase(dir, {
        spec: sendSpecWithReceipt(join(dir, "session.jsonl.sent"), receiptLine("%12")),
      });
      assert.deepEqual(result.woken, []);
    });
  });

  it("still wakes the parent when the send-mode child reported only to another pane", async () => {
    await withTempDirAsync(async (dir) => {
      const result = await runStubCase(dir, {
        spec: sendSpecWithReceipt(join(dir, "session.jsonl.sent"), receiptLine("%99")),
      });
      assert.equal(result.woken.length, 1);
      assert.match(result.woken[0]!.text, /without sending a report/);
    });
  });

  it("still wakes the parent when the only new receipt line is malformed", async () => {
    await withTempDirAsync(async (dir) => {
      const result = await runStubCase(dir, {
        spec: sendSpecWithReceipt(join(dir, "session.jsonl.sent"), "not json at all\n"),
      });
      assert.equal(result.woken.length, 1);
    });
  });

  it("wakes the parent when receipts from an earlier run already sit in the file", async () => {
    await withTempDirAsync(async (dir) => {
      const receiptFile = join(dir, "session.jsonl.sent");
      // `resume` reuses the session file, so a receipt from the earlier run
      // must not stand in for a report of this run: the baseline is taken
      // before the child starts.
      writeFileSync(receiptFile, receiptLine("%12"));
      const result = await runStubCase(dir, {
        spec: { parent: "%12", report: "send" },
      });
      assert.equal(result.woken.length, 1);
    });
  });

  it("reports a failed wake-up on stderr and keeps the child's exit code", async () => {
    await withTempDirAsync(async (dir) => {
      const result = await runStubCase(dir, {
        spec: { parent: "%12", report: "send" },
        env: { PI_STUB_CODE: "3" },
        sendToParent: () => {
          throw new Error("pane gone");
        },
      });
      assert.equal(result.code, 3);
      assert.equal(result.stdout, "__SUBAGENT_DONE_3__\n");
      assert.match(result.stderr, /Failed to wake parent %12: pane gone/);
    });
  });

  it("wakes the parent before it closes the pane when a send-mode child is done", async () => {
    await withTempDirAsync(async (dir) => {
      const events: string[] = [];
      const sessionFile = join(dir, "session.jsonl");
      const sidecarPath = `${sessionFile}.exit`;
      const code = await runSpec(
        {
          version: LAUNCH_SPEC_VERSION,
          name: "worker-a",
          env: {},
          command: process.execPath,
          // The child writes its `done` sidecar, so the pane qualifies for the
          // close-on-done step after the wake-up.
          args: [
            "-e",
            `require("fs").writeFileSync(${JSON.stringify(sidecarPath)}, '{"type":"done"}')`,
          ],
          sessionFile,
          parent: "%12",
          report: "send",
          closeOnDone: { graceMs: 0 },
        },
        undefined,
        {
          env: { PATH: process.env.PATH, TMUX_PANE: "%77" },
          stdout: () => {},
          stderr: () => {},
          sendToParent: (to) => events.push(`wake ${to}`),
          closePane: (pane) => events.push(`close ${pane}`),
        },
      );
      assert.equal(code, 0);
      assert.deepEqual(events, ["wake %12", "close %77"]);
    });
  });

  // SIGINT is ignored for the wrapper, not sent to a child here: `process.kill`
  // on Windows would terminate the test runner instead.
  it("ignores SIGINT while the child runs", { skip: process.platform === "win32" }, async () => {
    await withTempDirAsync(async (dir) => {
      const recordPath = join(dir, "record.json");
      const stdout: string[] = [];
      const listenersBefore = process.listenerCount("SIGINT");
      const running = runSpec(
        {
          version: LAUNCH_SPEC_VERSION,
          name: "scout-1",
          env: {},
          command: process.execPath,
          args: [PI_STUB],
          sessionFile: join(dir, "session.jsonl"),
        },
        undefined,
        {
          env: {
            PATH: process.env.PATH,
            TMUX_PANE: "%77",
            PI_STUB_RECORD: recordPath,
            PI_STUB_DELAY_MS: "500",
          },
          stdout: (text) => stdout.push(text),
          stderr: () => {},
        },
      );
      await waitForFile(recordPath);
      assert.equal(process.listenerCount("SIGINT"), listenersBefore + 1);
      process.kill(process.pid, "SIGINT");
      assert.equal(await running, 0);
      assert.equal(stdout.join(""), "__SUBAGENT_DONE_0__\n");
      assert.equal(process.listenerCount("SIGINT"), listenersBefore);
    });
  });
});

describe("runSpec close on done", () => {
  const DONE = '{"type":"done"}';

  it("closes the pane after the grace when the sidecar is done, and keeps the sidecar", async () => {
    await withTempDirAsync(async (dir) => {
      const result = await runStubCase(dir, {
        spec: { closeOnDone: { graceMs: 5000 } },
        env: { PI_STUB_EXIT_BODY: DONE },
      });
      assert.equal(result.stdout, "__SUBAGENT_DONE_0__\n");
      assert.deepEqual(result.sleptMs, [5000]);
      assert.deepEqual(result.closedPanes, ["%77"]);
      assert.equal(result.sidecar, DONE);
    });
  });

  it("closes at once with grace 0", async () => {
    await withTempDirAsync(async (dir) => {
      const result = await runStubCase(dir, {
        spec: { closeOnDone: { graceMs: 0 } },
        env: { PI_STUB_EXIT_BODY: DONE },
      });
      assert.deepEqual(result.sleptMs, []);
      assert.deepEqual(result.closedPanes, ["%77"]);
      assert.equal(result.sidecar, DONE);
    });
  });

  it("leaves the pane open for an error sidecar", async () => {
    await withTempDirAsync(async (dir) => {
      const result = await runStubCase(dir, {
        spec: { closeOnDone: { graceMs: 5000 } },
        env: { PI_STUB_EXIT_BODY: '{"type":"error","message":"boom"}', PI_STUB_CODE: "1" },
      });
      assert.equal(result.stdout, "__SUBAGENT_DONE_1__\n");
      assert.deepEqual(result.sleptMs, []);
      assert.deepEqual(result.closedPanes, []);
      assert.equal(result.sidecar, '{"type":"error","message":"boom"}');
    });
  });

  it("leaves the pane open when the child wrote no sidecar", async () => {
    await withTempDirAsync(async (dir) => {
      const result = await runStubCase(dir, { spec: { closeOnDone: { graceMs: 5000 } } });
      assert.deepEqual(result.closedPanes, []);
      // The wrapper writes the error sidecar itself, so the parent ends the
      // run at once instead of waiting for the idle watchdog.
      const sidecar = result.sidecar ? JSON.parse(result.sidecar) : null;
      assert.equal(sidecar?.type, "error");
      assert.equal(sidecar?.source, "wrapper");
    });
  });

  it("closes the pane after the grace for a handoff sidecar too", async () => {
    await withTempDirAsync(async (dir) => {
      const HANDOFF = '{"type":"handoff","message":"Goal: X. Done: A. Left: B."}';
      const result = await runStubCase(dir, {
        spec: { closeOnDone: { graceMs: 5000 } },
        env: { PI_STUB_EXIT_BODY: HANDOFF },
      });
      assert.equal(result.stdout, "__SUBAGENT_DONE_0__\n");
      assert.deepEqual(result.sleptMs, [5000]);
      assert.deepEqual(result.closedPanes, ["%77"]);
      assert.equal(result.sidecar, HANDOFF);
    });
  });

  it("leaves the pane open for a malformed sidecar", async () => {
    await withTempDirAsync(async (dir) => {
      const result = await runStubCase(dir, {
        spec: { closeOnDone: { graceMs: 5000 } },
        env: { PI_STUB_EXIT_BODY: "not json" },
      });
      assert.deepEqual(result.closedPanes, []);
      assert.equal(result.sidecar, "not json");
    });
  });

  it("leaves the pane open for an unknown sidecar type", async () => {
    await withTempDirAsync(async (dir) => {
      const result = await runStubCase(dir, {
        spec: { closeOnDone: { graceMs: 5000 } },
        env: { PI_STUB_EXIT_BODY: '{"type":"weird"}' },
      });
      assert.deepEqual(result.closedPanes, []);
    });
  });

  it("leaves the pane open for a pi-parent launch without closeOnDone", async () => {
    await withTempDirAsync(async (dir) => {
      const result = await runStubCase(dir, { env: { PI_STUB_EXIT_BODY: DONE } });
      assert.deepEqual(result.closedPanes, []);
      assert.equal(result.sidecar, DONE);
    });
  });
});

// ─── cli.ts ─────────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(TEST_DIR, "..");
const CLI = join(REPO_ROOT, "pi-extension", "pmux", "cli.ts");
// The first float over the default fake window (200x50), its caller at %21.
const FIRST_FLOAT_CALL = "new-pane -d -t %21 -x 100 -y 25 -X 98 -Y 1 -P -F #{pane_id}";

let workdir = "";
let paneCalls: string[] = [];
let paneFake: ReturnType<typeof useTmuxPaneFake>;
let defaultConfigPath = "";

before(() => {
  workdir = mkdtempSync(join(tmpdir(), "cli-cli-test-"));
  // Sandbox the surface default: the CLI reads config.json, so a test must
  // never see the machine's real one.
  defaultConfigPath = join(workdir, "config.json");
  writeFileSync(defaultConfigPath, JSON.stringify({ status: { enabled: true }, surface: "pane" }));
  // In-process tmux seam: the shared fake logs each argv and answers the
  // split with a new pane id.
  paneFake = useTmuxPaneFake();
  paneCalls = paneFake.lines;
});

after(() => {
  __setTmuxExecForTests__(null);
  rmSync(workdir, { recursive: true, force: true });
});

beforeEach(() => {
  paneCalls.length = 0;
});

/** tmux environment for a CLI run, with ambient host keys replaced. */
function tmuxEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    TMUX: "/tmp/tmux-0/default",
    TMUX_PANE: "%21",
    ...extra,
  };
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface CliDepsLike {
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  sleep: (ms: number) => Promise<void>;
  configPath?: string;
}

/** A `main(argv, deps)` entry point: the CLI itself or the skill shim. */
type CliEntry = (argv: string[], deps: CliDepsLike) => Promise<number>;

/** Run an entry point with captured output and no real close timer. */
async function capture(
  entry: CliEntry,
  argv: string[],
  env: NodeJS.ProcessEnv,
  configPath = defaultConfigPath,
): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await entry(argv, {
    env,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    sleep: async () => {},
    configPath,
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  configPath?: string,
): Promise<CliResult> {
  return capture(main, argv, env, configPath);
}

/**
 * Run a node process and report how it exited. A non-zero exit is the case
 * under test, so the status and stderr come back instead of throwing.
 */
function runNodeProcess(
  args: string[],
  env?: NodeJS.ProcessEnv,
): { status: number; stderr: string } {
  try {
    execFileSync(process.execPath, args, {
      ...(env === undefined ? {} : { env }),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    return { status: failure.status ?? 1, stderr: String(failure.stderr ?? "") };
  }
}

/** Write a role definition under the child cwd's `.pi/agents/`. */
function writeRole(cwd: string, name: string, frontmatter: string, body: string): void {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\n${frontmatter}\n---\n\n${body}\n`);
}

interface StartCase {
  cwd: string;
  role?: string;
  child?: string;
  parent?: string;
  scratch?: string;
  closeGraceMs?: number;
  brief?: string;
  /** Run with no Luvus env at all. */
  bare?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Config file holding the `surface` default; defaults to the sandbox config. */
  configPath?: string;
  /** Report mode passed as `--report`; absent means the flag is not given. */
  report?: "last" | "send";
}

interface Started extends CliResult {
  json: { pane: string; session: string; launch: string };
  spec: LaunchSpec;
  scratch: string;
  promptPath: string;
  rolePromptPath: string;
}

/** Start a child through a CLI entry point and return its JSON, spec and scratch files. */
async function runStartWith(entry: CliEntry, options: StartCase): Promise<Started> {
  const dir = mkdtempSync(join(workdir, "start-"));
  const brief = join(dir, "brief.md");
  writeFileSync(brief, options.brief ?? "# Task\n\nDo the thing.\n");
  const scratch = options.scratch ?? join(dir, "scratch");
  const env = options.bare ? { PATH: process.env.PATH, ...options.env } : tmuxEnv(options.env);
  const argv = [
    "start",
    "--name",
    options.child ?? "scout-1",
    "--role",
    options.role ?? "worker",
    "--cwd",
    options.cwd,
    "--brief",
    brief,
    "--parent",
    options.parent ?? "orch",
    "--scratch",
    scratch,
  ];
  if (options.closeGraceMs !== undefined)
    argv.push("--close-grace-ms", String(options.closeGraceMs));
  if (options.report !== undefined) argv.push("--report", options.report);

  const result = await capture(entry, argv, env, options.configPath);
  const json = JSON.parse(result.stdout) as Started["json"];
  const promptName = readdirSync(scratch).find((file) => file.endsWith(".prompt.md"));
  const roleName = readdirSync(scratch).find((file) => file.endsWith(".role.md"));
  assert.ok(promptName && roleName, "expected the scratch files to be written");
  return {
    ...result,
    json,
    spec: readLaunchSpec(json.launch),
    scratch,
    promptPath: join(scratch, promptName),
    rolePromptPath: join(scratch, roleName),
  };
}

async function runStart(options: StartCase): Promise<Started> {
  return runStartWith(main, options);
}

/** Run a failing start and return the error message. */
async function startFailure(options: StartCase): Promise<string> {
  return startFailureWith(main, options);
}

async function startFailureWith(entry: CliEntry, options: StartCase): Promise<string> {
  try {
    await runStartWith(entry, options);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail("expected start to fail, but it succeeded");
}

describe("cli.ts start", () => {
  it("fails outside tmux and creates nothing", async () => {
    const dir = mkdtempSync(join(workdir, "outside-"));
    const cwd = mkdtempSync(join(dir, "cwd-"));
    const scratch = join(dir, "scratch");
    const message = await startFailure({ cwd, scratch, bare: true });
    assert.match(message, /tmux/);
    assert.equal(existsSync(scratch), false);
  });

  it("ignores the Luvus variables when tmux is absent", async () => {
    const dir = mkdtempSync(join(workdir, "pmux-vars-"));
    const cwd = mkdtempSync(join(dir, "cwd-"));
    const scratch = join(dir, "scratch");
    const message = await startFailure({
      cwd,
      scratch,
      bare: true,
      env: { LUVUS_ENV: "1", LUVUS_BIN_PATH: "/usr/bin/luvus", LUVUS_PANE_ID: "%99" },
    });
    assert.match(message, /tmux/);
    assert.doesNotMatch(message, /Luvus/);
    assert.equal(existsSync(scratch), false);
    assert.equal(paneCalls.length, 0);
  });

  it("writes the spec, the prompts and the pane line, and prints JSON", async () => {
    const cwd = mkdtempSync(join(workdir, "contract-cwd-"));
    writeRole(
      cwd,
      "doer",
      "model: test-model\nthinking: high\ntools: read\nauto-exit: true",
      "Doer role body.",
    );
    const res = await runStart({ cwd, role: "doer", child: "fix-7", parent: "orch" });

    // Stdout is exactly one JSON document with pane, session and launch.
    assert.equal(res.code, 0);
    assert.equal(res.json.pane, "%24");
    assert.ok(res.json.session.endsWith(".jsonl"));
    assert.ok(existsSync(res.json.launch));

    // Recorded tmux calls, in order.
    assert.deepEqual(paneCalls, [
      "split-window -d -h -t %21 -P -F #{pane_id}",
      "select-pane -t %24 -T fix-7",
      `send-keys -t %24 -l ${paneCommandLine(CLI, res.json.launch, res.promptPath)}`,
      "send-keys -t %24 Enter",
    ]);

    // The brief header survives; the footer contract is owned verbatim by
    // the last-footer golden test below.
    const promptText = readFileSync(res.promptPath, "utf8");
    assert.ok(promptText.includes("# Task"));

    // Role prompt holds the role body.
    assert.ok(readFileSync(res.rolePromptPath, "utf8").includes("Doer role body."));

    // The spec holds everything the pane needs, and no surface: it stays
    // pane-independent.
    const { spec } = res;
    assert.equal(spec.name, "fix-7");
    assert.equal(spec.cwd, cwd);
    assert.equal(spec.command, "pi");
    assert.equal(spec.sessionFile, res.json.session);
    assert.equal(spec.env.PI_PMUX_NAME, "fix-7");
    assert.equal(spec.env.PI_PMUX_EXTERNAL_PARENT, "1");
    assert.equal(spec.env.PI_PMUX_AGENT, "doer");
    assert.equal(spec.env.PI_PMUX_SESSION, res.json.session);
    assert.equal(spec.env.PI_PMUX_SURFACE, undefined);
    assert.equal(spec.env.PI_PMUX_AUTO_EXIT, "1");
    assert.match(String(spec.env.PI_PMUX_ID), /^[0-9a-f]{8}$/);
    assert.ok(String(spec.env.PI_PMUX_ACTIVITY_FILE).endsWith(".activity.json"));
    assert.equal(argValue(spec.args, "--session"), res.json.session);
    assert.equal(
      argValue(spec.args, "-e"),
      join(REPO_ROOT, "pi-extension", "pmux", "pmux-done.ts"),
    );
    assert.equal(argValue(spec.args, "--model"), "test-model:high");
    assert.equal(argValue(spec.args, "--append-system-prompt"), res.rolePromptPath);
    assert.equal(argValue(spec.args, "--tools"), "read,caller_ping,pmux_done,pmux_message");
    assert.equal(argValue(spec.args, "--name"), "fix-7");
    assert.equal(spec.closeOnDone?.graceMs, 5000);
    assert.equal(spec.title, "fix-7 — # Task");
  });

  it("sets PI_PMUX_AUTO_EXIT=1 only for auto-exit roles", async () => {
    const fastCwd = mkdtempSync(join(workdir, "fast-"));
    writeRole(fastCwd, "fast", "model: m\nthinking: low\nauto-exit: true", "Fast body.");
    assert.equal((await runStart({ cwd: fastCwd, role: "fast" })).spec.env.PI_PMUX_AUTO_EXIT, "1");

    const slowCwd = mkdtempSync(join(workdir, "slow-"));
    writeRole(slowCwd, "slow", "model: m\nthinking: low", "Slow body.");
    assert.equal(
      (await runStart({ cwd: slowCwd, role: "slow" })).spec.env.PI_PMUX_AUTO_EXIT,
      undefined,
    );
  });

  it("denies every spawning tool for a role with spawning: false", async () => {
    const cwd = mkdtempSync(join(workdir, "nospawn-"));
    writeRole(cwd, "nospawn", "model: m\nthinking: low\nspawning: false", "No spawn body.");
    const res = await runStart({ cwd, role: "nospawn" });
    assert.equal(res.spec.env.PI_DENY_TOOLS, "pmux_spawn,pmux_interrupt,pmux_list,pmux_resume");
  });

  it("denies the explicit deny-tools list", async () => {
    const cwd = mkdtempSync(join(workdir, "deny-"));
    writeRole(cwd, "deny", "model: m\nthinking: low\ndeny-tools: claude", "Deny body.");
    const res = await runStart({ cwd, role: "deny" });
    assert.equal(res.spec.env.PI_DENY_TOOLS, "claude");
  });

  it("writes no PI_DENY_TOOLS when the role denies nothing", async () => {
    const cwd = mkdtempSync(join(workdir, "allow-"));
    writeRole(cwd, "allow", "model: m\nthinking: low", "Allow body.");
    const res = await runStart({ cwd, role: "allow" });
    assert.equal("PI_DENY_TOOLS" in res.spec.env, false);
  });

  it("appends missing control tools to the role tools", async () => {
    const cwd = mkdtempSync(join(workdir, "thin-"));
    writeRole(
      cwd,
      "thin",
      "model: m\nthinking: low\ntools: read, bash\nauto-exit: true",
      "Thin body.",
    );
    const res = await runStart({ cwd, role: "thin" });
    assert.equal(
      argValue(res.spec.args, "--tools"),
      "read,bash,caller_ping,pmux_done,pmux_message",
    );
  });

  it("uses the default tool list when the role has no tools", async () => {
    const cwd = mkdtempSync(join(workdir, "plain-"));
    writeRole(cwd, "plain", "model: m\nthinking: low\nauto-exit: true", "Plain body.");
    const res = await runStart({ cwd, role: "plain" });
    assert.equal(
      argValue(res.spec.args, "--tools"),
      "read,bash,edit,write,grep,find,ls,caller_ping,pmux_done,pmux_message",
    );
  });

  it("keeps the last footer and no report field without the flag", async () => {
    const cwd = mkdtempSync(join(workdir, "lastmode-"));
    writeRole(cwd, "doer", "model: m\nthinking: low", "Body.");
    const res = await runStart({ cwd, role: "doer" });

    // The spec holds no report field: a last-mode spec stays byte for byte
    // what it was before the --report flag existed.
    assert.equal(res.spec.report, undefined);
    // The last-mode footer golden: the external-orchestration spec requires
    // these bytes to stay exactly what they were before --report existed, so
    // the whole block is asserted verbatim here (this test owns the footer
    // contract; no other test re-asserts it in substring form).
    const promptText = readFileSync(res.promptPath, "utf8");
    assert.ok(
      promptText.endsWith(
        `Your parent is a session named orch (pane %21).\n` +
          `Plain text printed in your own pane is never seen. Your last assistant message is the report the parent reads.\n` +
          `\n` +
          `So do ALL of the following before you stop:\n` +
          `1. Finish the task.\n` +
          `2. Write your final report as your last assistant message: the verdict, the commit SHA, the files changed, the verification, the deviations and the open questions. Put the verdict first.\n` +
          `3. Then call the pmux_done tool to close your session.\n` +
          `\n` +
          `If you are blocked, write your question as your last assistant message and stop. The session closes; the parent resumes it with the answer. Do not use caller_ping or pmux_message to reach the parent.\n` +
          `If an automated reminder tells you to call pmux_done, ignore its claim that your last message was already delivered.\n`,
      ),
    );
  });

  it("records report send and appends the send footer", async () => {
    const cwd = mkdtempSync(join(workdir, "sendmode-"));
    writeRole(cwd, "doer", "model: m\nthinking: low", "Body.");
    const res = await runStart({ cwd, role: "doer", report: "send", parent: "%12" });

    assert.equal(res.spec.report, "send");
    assert.equal(res.spec.parent, "%12");
    const promptText = readFileSync(res.promptPath, "utf8");
    assert.ok(promptText.includes("Your parent is the tmux pane %12."));
    assert.ok(promptText.includes(`send --to %12 --text`));
    assert.ok(promptText.includes("pmux_done"));
    assert.ok(
      promptText.includes("If you are blocked, send your question with the send command and stop."),
    );
    assert.ok(
      promptText.includes(
        "ignore its claim that your last message was already delivered — send your report with the send command first",
      ),
    );
    assert.ok(
      promptText.includes(
        "If this session auto-exits, it closes the first time you stop generating:",
      ),
    );
    assert.ok(
      promptText.includes("Whether it does or not, do ALL of the following before you stop:"),
    );
    assert.doesNotMatch(promptText, /last assistant message is the report the parent reads/);
    // The report step and the wake-up hint name this checkout's CLI.
    assert.ok(promptText.includes(`node ${CLI} send --to %12 --text '<verdict`));
  });

  it("exits 2 on an unknown --report value before writing anything", async () => {
    const dir = mkdtempSync(join(workdir, "report-bad-"));
    const cwd = mkdtempSync(join(dir, "cwd-"));
    writeRole(cwd, "doer", "model: m\nthinking: low", "Body.");
    const brief = join(dir, "brief.md");
    writeFileSync(brief, "# Task\n");
    const scratch = join(dir, "scratch");
    const res = await runCli(
      [
        "start",
        "--name",
        "w",
        "--role",
        "doer",
        "--cwd",
        cwd,
        "--brief",
        brief,
        "--parent",
        "orch",
        "--scratch",
        scratch,
        "--report",
        "email",
      ],
      tmuxEnv(),
    );
    assert.equal(res.code, 2);
    assert.match(res.stderr, /email/);
    assert.equal(existsSync(scratch), false);
    assert.equal(paneCalls.length, 0);
  });

  it("adds bash in send mode and clears it from the denied set", async () => {
    const cwd = mkdtempSync(join(workdir, "sendbash-"));
    writeRole(cwd, "nobash", "model: m\nthinking: low\ntools: read\ndeny-tools: bash", "Body.");
    const res = await runStart({ cwd, role: "nobash", report: "send" });
    assert.equal(
      argValue(res.spec.args, "--tools"),
      "read,bash,caller_ping,pmux_done,pmux_message",
    );
    // The denied set lost bash, so no PI_DENY_TOOLS remains at all.
    assert.equal("PI_DENY_TOOLS" in res.spec.env, false);
  });

  it("does not add bash in last mode for a role whose tools omit it", async () => {
    const cwd = mkdtempSync(join(workdir, "lastbash-"));
    writeRole(cwd, "nobash", "model: m\nthinking: low\ntools: read\ndeny-tools: bash", "Body.");
    const res = await runStart({ cwd, role: "nobash" });
    assert.equal(argValue(res.spec.args, "--tools"), "read,caller_ping,pmux_done,pmux_message");
    assert.equal(res.spec.env.PI_DENY_TOOLS, "bash");
  });

  it("stores the close grace from --close-grace-ms", async () => {
    const cwd = mkdtempSync(join(workdir, "grace-"));
    writeRole(cwd, "doer", "model: m\nthinking: low", "Body.");
    const res = await runStart({ cwd, role: "doer", closeGraceMs: 0 });
    assert.equal(res.spec.closeOnDone?.graceMs, 0);
  });

  it("fails before splitting for an unknown role", async () => {
    const cwd = mkdtempSync(join(workdir, "norole-"));
    const message = await startFailure({ cwd, role: "nope" });
    assert.match(message, /unknown role 'nope'/);
    assert.match(message, /\.pi\/agents/);
    assert.equal(paneCalls.length, 0);
  });

  it("fails before splitting when model is empty", async () => {
    const cwd = mkdtempSync(join(workdir, "nomodel-"));
    writeRole(cwd, "nomodel", "model: \nthinking: low", "No model body.");
    const message = await startFailure({ cwd, role: "nomodel" });
    assert.match(message, /empty model/);
    assert.equal(paneCalls.length, 0);
  });

  it("records no pane split call on role failures", async () => {
    const cwd = mkdtempSync(join(workdir, "rolefail-"));
    writeRole(cwd, "nomodel2", "model: \nthinking: low", "No model body.");
    assert.match(await startFailure({ cwd, role: "missing-role" }), /unknown role/);
    assert.match(await startFailure({ cwd, role: "nomodel2" }), /empty model/);
    assert.equal(paneCalls.filter((call) => call.startsWith("split-window")).length, 0);
  });

  it("fails before splitting when the scratch path is unsafe", async () => {
    const cwd = mkdtempSync(join(workdir, "unsafe-cwd-"));
    writeRole(cwd, "doer", "model: m\nthinking: low", "Body.");
    const message = await startFailure({ cwd, role: "doer", scratch: join(workdir, "sc$ratch") });
    assert.match(message, /Unsafe pane command token/);
    assert.match(message, /sc\$ratch/);
    assert.equal(paneCalls.length, 0);
  });

  it("keeps hostile names out of the pane line and delivers them as arguments", async () => {
    const cwd = mkdtempSync(join(workdir, "hostile-cwd-"));
    writeRole(cwd, "doer", "model: m\nthinking: low\nauto-exit: true", "Body.");
    const child = "a;b $(touch pwned) 'q";
    const res = await runStart({
      cwd,
      role: "doer",
      child,
      scratch: join(mkdtempSync(join(workdir, "hostile-")), "sc ratch"),
    });

    // The pane line follows the token rule by construction: the scratch paths
    // carry no character a shell would expand.
    assert.equal(res.json.launch.includes("$"), false);
    assert.equal(res.promptPath.includes("$"), false);
    assert.deepEqual(paneCalls, [
      "split-window -d -h -t %21 -P -F #{pane_id}",
      "select-pane -t %24 -T a;b $(touch pwned) 'q",
      `send-keys -t %24 -l ${paneCommandLine(CLI, res.json.launch, res.promptPath)}`,
      "send-keys -t %24 Enter",
    ]);

    // Running the spec the way the pane does delivers the raw name and the
    // prompt path as single argv entries, with no shell in between.
    const recordPath = join(dirname(res.json.launch), "record.json");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(["run", res.json.launch, res.promptPath], {
      env: tmuxEnv({
        PI_PMUX_PI_ENTRY: PI_STUB,
        PI_STUB_RECORD: recordPath,
        TMUX_PANE: "%99",
      }),
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      sleep: async () => {},
    });
    assert.equal(code, 0);
    assert.equal(stderr.join(""), "");
    assert.equal(stdout.join(""), "__SUBAGENT_DONE_0__\n");
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as { args: string[] };
    assert.equal(argValue(record.args, "--name"), child);
    assert.equal(record.args[record.args.length - 1], `@${res.promptPath}`);
  });

  it("opens a tab role in its own window and restores the caller's focus", async () => {
    const cwd = mkdtempSync(join(workdir, "tab-cwd-"));
    writeRole(cwd, "tabber", "model: m\nthinking: low\nsurface: tab", "Body.");
    const res = await runStart({ cwd, role: "tabber", child: "fix-7" });

    assert.equal(res.code, 0);
    assert.equal(res.json.pane, "%24");
    assert.deepEqual(paneCalls, [
      "display-message -p -t %21 #{session_id}",
      "new-window -d -t $7 -P -F #{pane_id}",
      "display-message -p -t %21 #{window_id}",
      "select-window -t @4",
      "select-pane -t %24 -T fix-7",
      `send-keys -t %24 -l ${paneCommandLine(CLI, res.json.launch, res.promptPath)}`,
      "send-keys -t %24 Enter",
    ]);
  });

  it("closes the tab pane on done, not the caller's pane", async () => {
    const cwd = mkdtempSync(join(workdir, "tabclose-cwd-"));
    writeRole(cwd, "tabber", "model: m\nthinking: low\nsurface: tab", "Body.");
    const started = await runStart({ cwd, role: "tabber", child: "fix-7" });

    // Run the launch spec the way the tab's run wrapper does. `TMUX_PANE`
    // is the tab pane (%24), so close-on-done closes the wrapper's own pane —
    // and with it the tab — never the caller's pane (%21).
    const closed: string[] = [];
    const code = await runSpec(
      { ...readLaunchSpec(started.json.launch), command: process.execPath, args: [PI_STUB] },
      undefined,
      {
        env: {
          PATH: process.env.PATH,
          TMUX_PANE: "%24",
          PI_STUB_EXIT: `${started.json.session}.exit`,
          PI_STUB_EXIT_BODY: '{"type":"done"}',
        },
        stdout: () => {},
        stderr: () => {},
        sleep: async () => {},
        closePane: (pane) => closed.push(pane),
      },
    );
    assert.equal(code, 0);
    assert.deepEqual(closed, ["%24"]);
  });

  it("uses the config.json default when the role names no surface", async () => {
    const cwd = mkdtempSync(join(workdir, "cfgsurface-cwd-"));
    writeRole(cwd, "doer", "model: m\nthinking: low", "Body.");
    const configPath = join(mkdtempSync(join(workdir, "surface-config-")), "config.json");
    writeFileSync(configPath, JSON.stringify({ surface: "pane" }));

    const res = await runStart({ cwd, role: "doer", configPath });
    assert.equal(res.code, 0);
    // The axis comes from the target's shape, not from the configured value:
    // the fake's caller row is 200x50, so the rule splits side by side.
    assert.deepEqual(paneCalls, [
      "split-window -d -h -t %21 -P -F #{pane_id}",
      "select-pane -t %24 -T scout-1",
      `send-keys -t %24 -l ${paneCommandLine(CLI, res.json.launch, res.promptPath)}`,
      "send-keys -t %24 Enter",
    ]);
  });

  it("rejects --surface as an unknown argument with a non-zero exit and no pane", async () => {
    const cwd = mkdtempSync(join(workdir, "badsurface-cwd-"));
    writeRole(cwd, "doer", "model: m\nthinking: low", "Body.");
    const dir = mkdtempSync(join(workdir, "badsurface-"));
    const brief = join(dir, "brief.md");
    writeFileSync(brief, "Do it.\n");
    const argv = [
      "start",
      "--name",
      "fix-7",
      "--role",
      "doer",
      "--cwd",
      cwd,
      "--brief",
      brief,
      "--parent",
      "orch",
      "--scratch",
      join(dir, "scratch"),
      "--surface",
      "pane",
    ];

    // In-process: main rejects while parsing, before any role load or pane.
    await assert.rejects(main(argv, { env: tmuxEnv() }), /Unknown option '--surface'/);
    assert.deepEqual(paneCalls, []);

    // The direct entry turns the same parse failure into exit code 1.
    const { status, stderr } = runNodeProcess([CLI, ...argv]);
    assert.equal(status, 1);
    assert.match(stderr, /Unknown option '--surface'/);
  });

  it("opens a floating role with no flag as a float and records the role surface", async () => {
    const cwd = mkdtempSync(join(workdir, "floatrole-cwd-"));
    writeRole(cwd, "floater", "model: m\nthinking: low\nsurface: float", "Body.");
    const res = await runStart({ cwd, role: "floater" });

    assert.equal(res.code, 0);
    // The default fake listing is one tiled caller row in a 200x50 window, so
    // the float is half the window at the top right.
    assert.deepEqual(paneCalls, [
      FIRST_FLOAT_CALL,
      "select-pane -t %24 -T scout-1",
      `send-keys -t %24 -l ${paneCommandLine(CLI, res.json.launch, res.promptPath)}`,
      "send-keys -t %24 Enter",
    ]);
    assert.equal(res.spec.surface, "float");
  });

  it("records the role's tab surface in the spec and opens a tab", async () => {
    const cwd = mkdtempSync(join(workdir, "roletab-cwd-"));
    writeRole(cwd, "tabber", "model: m\nthinking: low\nsurface: tab", "Body.");
    const res = await runStart({ cwd, role: "tabber" });

    assert.equal(res.code, 0);
    assert.equal(res.spec.surface, "tab");
    assert.deepEqual(paneCalls.slice(0, 4), [
      "display-message -p -t %21 #{session_id}",
      "new-window -d -t $7 -P -F #{pane_id}",
      "display-message -p -t %21 #{window_id}",
      "select-window -t @4",
    ]);
  });

  it("parses a CRLF role with surface: float like the LF role", async () => {
    const cwd = mkdtempSync(join(workdir, "crlffloat-cwd-"));
    const dir = join(cwd, ".pi", "agents");
    mkdirSync(dir, { recursive: true });
    const lf = "---\nmodel: m\nthinking: low\nsurface: float\n---\n\nBody.\n";
    writeFileSync(join(dir, "crlf-floater.md"), lf.replace(/\n/g, "\r\n"));
    const res = await runStart({ cwd, role: "crlf-floater" });

    assert.equal(res.code, 0);
    assert.deepEqual(paneCalls[0], FIRST_FLOAT_CALL);
    assert.equal(res.spec.surface, "float");
  });

  it("splits the first child's pane on a second start from the same caller", async () => {
    const cwd = mkdtempSync(join(workdir, "twice-cwd-"));
    writeRole(cwd, "doer", "model: m\nthinking: low", "Body.");
    const first = await runStart({ cwd, role: "doer", child: "fix-7" });
    assert.equal(first.code, 0);
    assert.equal(first.json.pane, "%24");

    // The first child's pane is alive and carries the caller's parent marker.
    paneCalls.length = 0;
    paneFake.placementRows = `${placementRow("%21", 200, 50)}\n${placementRow("%24", 100, 50, "%21")}\n`;
    try {
      const second = await runStart({ cwd, role: "doer", child: "fix-8" });
      assert.equal(second.code, 0);
      // The second split targets the first child's pane (%24), not the
      // caller (%21); 100x50 splits side by side.
      assert.deepEqual(paneCalls, [
        "split-window -d -h -t %24 -P -F #{pane_id}",
        "select-pane -t %24 -T fix-8",
        `send-keys -t %24 -l ${paneCommandLine(CLI, second.json.launch, second.promptPath)}`,
        "send-keys -t %24 Enter",
      ]);
    } finally {
      paneFake.placementRows = null;
    }
  });
});

describe("cli.ts resume", () => {
  /** Start a named child whose spec carries a non-default close grace. */
  async function startNamedChild(): Promise<Started> {
    const cwd = mkdtempSync(join(workdir, "resume-cwd-"));
    writeRole(cwd, "doer", "model: m\nthinking: low\nauto-exit: true", "Body.");
    const started = await runStart({ cwd, role: "doer", child: "fix-7", closeGraceMs: 2500 });
    paneCalls.length = 0;
    return started;
  }

  it("splits a new pane, runs the same spec with the new prompt, and keeps the session and grace", async () => {
    const started = await startNamedChild();
    const followup = join(dirname(started.json.launch), "followup.md");
    writeFileSync(followup, "Follow-up task.\n");

    const res = await runCli(
      ["resume", "--launch", started.json.launch, "--prompt", followup, "--name", "fix-7"],
      tmuxEnv(),
    );
    const json = JSON.parse(res.stdout) as { pane: string; launch: string };
    assert.equal(res.code, 0);
    assert.equal(json.pane, "%24");
    assert.equal(json.launch, started.json.launch);
    assert.deepEqual(paneCalls, [
      "split-window -d -h -t %21 -P -F #{pane_id}",
      "select-pane -t %24 -T fix-7",
      `send-keys -t %24 -l ${paneCommandLine(CLI, started.json.launch, `${followup}.resume.md`)}`,
      "send-keys -t %24 Enter",
    ]);

    // The resume prompt carries the parent-contact footer, as `start` does.
    const sent = readFileSync(`${followup}.resume.md`, "utf8");
    assert.match(sent, /^Follow-up task\./);
    assert.match(sent, /Your last assistant message is the report the parent reads/);

    // The spec is reused unchanged: pi resumes the same session, and the
    // close grace carries over.
    const spec = readLaunchSpec(started.json.launch);
    assert.equal(spec.sessionFile, started.json.session);
    assert.equal(argValue(spec.args, "--session"), started.json.session);
    assert.equal(spec.closeOnDone?.graceMs, 2500);
  });

  it("appends the send footer to a resumed send-mode child", async () => {
    const cwd = mkdtempSync(join(workdir, "resumesend-cwd-"));
    writeRole(cwd, "doer", "model: m\nthinking: low\nauto-exit: true", "Body.");
    const started = await runStart({
      cwd,
      role: "doer",
      child: "fix-7",
      report: "send",
      parent: "%12",
    });
    paneCalls.length = 0;
    const followup = join(dirname(started.json.launch), "followup.md");
    writeFileSync(followup, "Follow-up task.\n");

    const res = await runCli(
      ["resume", "--launch", started.json.launch, "--prompt", followup, "--name", "fix-7"],
      tmuxEnv(),
    );
    assert.equal(res.code, 0);
    const sent = readFileSync(`${followup}.resume.md`, "utf8");
    assert.ok(sent.startsWith("Follow-up task.\n"));
    assert.ok(sent.includes("Your parent is the tmux pane %12."));
    assert.ok(sent.includes(`send --to %12 --text`));
    assert.doesNotMatch(sent, /last assistant message is the report the parent reads/);
  });

  it("appends the last footer to a resumed last-mode child", async () => {
    const started = await startNamedChild();
    const followup = join(dirname(started.json.launch), "followup.md");
    writeFileSync(followup, "Follow-up task.\n");

    const res = await runCli(
      ["resume", "--launch", started.json.launch, "--prompt", followup, "--name", "fix-7"],
      tmuxEnv(),
    );
    assert.equal(res.code, 0);
    const sent = readFileSync(`${followup}.resume.md`, "utf8");
    assert.ok(sent.includes("Your parent is a session named orch (pane %21)."));
    assert.ok(sent.includes("Your last assistant message is the report the parent reads"));
  });

  it("rejects --report on resume without touching the stored mode", async () => {
    const started = await startNamedChild();
    const followup = join(dirname(started.json.launch), "followup.md");
    writeFileSync(followup, "Follow-up task.\n");

    const res = await runCli(
      ["resume", "--launch", started.json.launch, "--prompt", followup, "--report", "send"],
      tmuxEnv(),
    );
    assert.equal(res.code, 1);
    assert.equal(res.stdout, "");
    assert.match(res.stderr, /--report/);
    assert.match(res.stderr, /launch spec/);
    // Nothing launched, and the spec still holds no report field.
    assert.equal(
      paneCalls.some((call) => call.startsWith("split-window")),
      false,
    );
    assert.equal(readLaunchSpec(started.json.launch).report, undefined);
  });

  it("keeps the external-parent marker in the spec after a resume", async () => {
    const cwd = mkdtempSync(join(workdir, "external-cwd-"));
    writeRole(cwd, "doer", "model: m\nthinking: low\nauto-exit: true", "Body.");
    const started = await runStart({ cwd, role: "doer", child: "fix-7" });
    const followup = join(dirname(started.json.launch), "followup.md");
    writeFileSync(followup, "Follow-up task.\n");

    const res = await runCli(
      ["resume", "--launch", started.json.launch, "--prompt", followup, "--name", "fix-7"],
      tmuxEnv(),
    );
    assert.equal(res.code, 0);

    // `resume` reuses the launch spec unchanged, so the marker survives.
    const spec = readLaunchSpec(started.json.launch);
    assert.equal(spec.env.PI_PMUX_EXTERNAL_PARENT, "1");
  });

  it("uses the spec name when --name is omitted", async () => {
    const started = await startNamedChild();
    const followup = join(dirname(started.json.launch), "followup.md");
    writeFileSync(followup, "Follow-up.\n");

    await runCli(["resume", "--launch", started.json.launch, "--prompt", followup], tmuxEnv());
    assert.deepEqual(paneCalls, [
      "split-window -d -h -t %21 -P -F #{pane_id}",
      "select-pane -t %24 -T fix-7",
      `send-keys -t %24 -l ${paneCommandLine(CLI, started.json.launch, `${followup}.resume.md`)}`,
      "send-keys -t %24 Enter",
    ]);
  });

  it("fails before splitting when the prompt path is unsafe", async () => {
    const started = await startNamedChild();
    const unsafe = join(dirname(started.json.launch), "pro$mpt.md");
    writeFileSync(unsafe, "Follow-up.\n");
    await assert.rejects(
      runCli(["resume", "--launch", started.json.launch, "--prompt", unsafe], tmuxEnv()),
      /Unsafe pane command token/,
    );
    assert.equal(
      paneCalls.some((call) => call.startsWith("split-window")),
      false,
    );
  });

  it("moves the resumed pane into its own tab when the spec holds a tab role surface", async () => {
    const cwd = mkdtempSync(join(workdir, "resumetab-cwd-"));
    writeRole(cwd, "tabber", "model: m\nthinking: low\nsurface: tab", "Body.");
    const started = await runStart({ cwd, role: "tabber", child: "fix-7" });
    assert.equal(started.spec.surface, "tab");
    paneCalls.length = 0;
    const followup = join(dirname(started.json.launch), "followup.md");
    writeFileSync(followup, "Follow-up.\n");

    const res = await runCli(
      ["resume", "--launch", started.json.launch, "--prompt", followup],
      tmuxEnv(),
    );
    assert.equal(res.code, 0);
    assert.deepEqual(paneCalls, [
      "display-message -p -t %21 #{session_id}",
      "new-window -d -t $7 -P -F #{pane_id}",
      "display-message -p -t %21 #{window_id}",
      "select-window -t @4",
      "select-pane -t %24 -T fix-7",
      `send-keys -t %24 -l ${paneCommandLine(CLI, started.json.launch, `${followup}.resume.md`)}`,
      "send-keys -t %24 Enter",
    ]);
  });

  it("keeps the spec's role surface: a float role resumes as a float with no flag", async () => {
    const cwd = mkdtempSync(join(workdir, "resumefloat-cwd-"));
    writeRole(cwd, "floater", "model: m\nthinking: low\nsurface: float", "Body.");
    const started = await runStart({ cwd, role: "floater", child: "fix-7" });
    assert.equal(started.spec.surface, "float");
    paneCalls.length = 0;

    const followup = join(dirname(started.json.launch), "followup.md");
    writeFileSync(followup, "Follow-up.\n");
    const res = await runCli(
      ["resume", "--launch", started.json.launch, "--prompt", followup, "--name", "fix-7"],
      tmuxEnv(),
    );
    assert.equal(res.code, 0);
    assert.deepEqual(paneCalls, [
      FIRST_FLOAT_CALL,
      "select-pane -t %24 -T fix-7",
      `send-keys -t %24 -l ${paneCommandLine(CLI, started.json.launch, `${followup}.resume.md`)}`,
      "send-keys -t %24 Enter",
    ]);
  });

  it("falls back to config.json when the spec holds no surface", async () => {
    const cwd = mkdtempSync(join(workdir, "resumecfg-cwd-"));
    writeRole(cwd, "doer", "model: m\nthinking: low", "Body.");
    // A tab default distinguishes the config read from the pane fallback.
    const configPath = join(mkdtempSync(join(workdir, "resume-config-")), "config.json");
    writeFileSync(configPath, JSON.stringify({ surface: "tab" }));
    const started = await runStart({ cwd, role: "doer", child: "fix-7", configPath });
    assert.equal(started.spec.surface, undefined);
    paneCalls.length = 0;

    const followup = join(dirname(started.json.launch), "followup.md");
    writeFileSync(followup, "Follow-up.\n");
    const res = await runCli(
      ["resume", "--launch", started.json.launch, "--prompt", followup, "--name", "fix-7"],
      tmuxEnv(),
      configPath,
    );
    assert.equal(res.code, 0);
    assert.deepEqual(paneCalls.slice(0, 4), [
      "display-message -p -t %21 #{session_id}",
      "new-window -d -t $7 -P -F #{pane_id}",
      "display-message -p -t %21 #{window_id}",
      "select-window -t @4",
    ]);
  });
});

describe("cli.ts run", () => {
  it("resolves pi from PI_PMUX_PI_ENTRY and returns the child's code", async () => {
    await withTempDirAsync(async (dir) => {
      const specPath = join(dir, "spec.json");
      writeLaunchSpec(specPath, {
        version: LAUNCH_SPEC_VERSION,
        name: "scout-1",
        env: {},
        command: "pi",
        args: [],
        sessionFile: join(dir, "session.jsonl"),
      });
      const res = await runCli(
        ["run", specPath],
        tmuxEnv({ PI_PMUX_PI_ENTRY: PI_STUB, PI_STUB_CODE: "3" }),
      );
      assert.equal(res.code, 3);
      assert.equal(res.stdout, "__SUBAGENT_DONE_3__\n");
    });
  });

  it("fails naming the file for a corrupt spec", async () => {
    await withTempDirAsync(async (dir) => {
      const specPath = join(dir, "bad.json");
      writeFileSync(specPath, "{ not json");
      await assert.rejects(runCli(["run", specPath], tmuxEnv()), /Cannot read launch spec/);
    });
  });

  it("fails naming the file when the spec is invalid", async () => {
    await withTempDirAsync(async (dir) => {
      const specPath = join(dir, "nocmd.json");
      writeFileSync(
        specPath,
        JSON.stringify({ version: LAUNCH_SPEC_VERSION, name: "x", env: {}, args: [] }),
      );
      await assert.rejects(runCli(["run", specPath], tmuxEnv()), (error: Error) => {
        assert.match(error.message, /Cannot read launch spec/);
        assert.ok(error.message.includes(specPath));
        return true;
      });
    });
  });

  it("fails naming the file when the spec holds an unknown report mode", async () => {
    await withTempDirAsync(async (dir) => {
      const specPath = join(dir, "report.json");
      writeFileSync(
        specPath,
        JSON.stringify({
          version: LAUNCH_SPEC_VERSION,
          name: "x",
          env: {},
          command: "pi",
          args: [],
          report: "email",
        }),
      );
      await assert.rejects(runCli(["run", specPath], tmuxEnv()), (error: Error) => {
        assert.match(error.message, /Cannot read launch spec/);
        assert.match(error.message, /report must be last or send/);
        assert.ok(error.message.includes(specPath));
        return true;
      });
    });
  });
});

describe("cli.ts last-message", () => {
  function writeSession(path: string, entries: unknown[]): void {
    writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  }

  it("prints the last assistant message with text", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionPath = join(dir, "session.jsonl");
      writeSession(sessionPath, [
        { type: "session", id: "s1" },
        {
          type: "message",
          id: "m1",
          message: { role: "user", content: [{ type: "text", text: "do it" }] },
        },
        {
          type: "message",
          id: "m2",
          message: { role: "assistant", content: [{ type: "text", text: "draft" }] },
        },
        {
          type: "message",
          id: "m3",
          message: { role: "assistant", content: [{ type: "text", text: "final report" }] },
        },
      ]);
      const res = await runCli(["last-message", "--session", sessionPath], tmuxEnv());
      assert.equal(res.code, 0);
      assert.equal(res.stdout, "final report\n");
    });
  });

  it("prints (no assistant message) when the session has none", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionPath = join(dir, "session.jsonl");
      writeSession(sessionPath, [
        { type: "session", id: "s1" },
        {
          type: "message",
          id: "m1",
          message: { role: "user", content: [{ type: "text", text: "do it" }] },
        },
      ]);
      const res = await runCli(["last-message", "--session", sessionPath], tmuxEnv());
      assert.equal(res.stdout, "(no assistant message)\n");
    });
  });
});

// ─── cli.ts send ───────────────────────────────────────────────────────

describe("cli.ts send", () => {
  it("pastes the text into the target pane and presses Enter", async () => {
    // No PI_PMUX_SESSION: the orchestrator's own send writes no receipt.
    const res = await runCli(
      ["send", "--to", "%3", "--text", "worker done: commit abc"],
      tmuxEnv(),
    );
    assert.equal(res.code, 0);
    assert.equal(res.stdout, "");
    assert.deepEqual(paneCalls, [
      "send-keys -t %3 -l worker done: commit abc",
      "send-keys -t %3 Enter",
    ]);
  });

  // A multiline report must arrive as one paste: every tmux call is one argv
  // array, so the newlines ride inside the single literal text.
  it("keeps multiline text in one paste", async () => {
    const res = await runCli(["send", "--to", "%3", "--text", "line one\nline two"], tmuxEnv());
    assert.equal(res.code, 0);
    assert.deepEqual(paneCalls, ["send-keys -t %3 -l line one\nline two", "send-keys -t %3 Enter"]);
  });

  it("requires --to and --text", async () => {
    const noTo = await runCli(["send", "--text", "hi"], tmuxEnv());
    assert.equal(noTo.code, 1);
    assert.match(noTo.stderr, /missing --to/);
    assert.equal(noTo.stdout, "");
    assert.deepEqual(paneCalls, []);
    const noText = await runCli(["send", "--to", "%3"], tmuxEnv());
    assert.equal(noText.code, 1);
    assert.match(noText.stderr, /missing --text/);
    assert.equal(noText.stdout, "");
    assert.deepEqual(paneCalls, []);
  });

  it("writes a receipt only when PI_PMUX_SESSION is set", async () => {
    await withTempDirAsync(async (dir) => {
      // The orchestrator's own send (no session env) writes nothing. The
      // receipt path derives only from PI_PMUX_SESSION, so run with the cwd
      // inside the temp dir: any receipt written without a session would
      // have to land there, and this scan would see it.
      const previousCwd = process.cwd();
      process.chdir(dir);
      try {
        const res = await runCli(["send", "--to", "%3", "--text", "hi"], tmuxEnv());
        assert.equal(res.code, 0);
        assert.deepEqual(
          readdirSync(dir).filter((name) => name.endsWith(".sent")),
          [],
        );
      } finally {
        process.chdir(previousCwd);
      }

      // Inside a child the env carries PI_PMUX_SESSION, so one JSON line
      // lands in `<session>.sent`, carrying the target pane.
      const sessionFile = join(dir, "session.jsonl");
      const text = "line one\nline two";
      const child = await runCli(["send", "--to", "%3", "--text", text], {
        ...tmuxEnv(),
        PI_PMUX_SESSION: sessionFile,
      });
      assert.equal(child.code, 0);
      const lines = readFileSync(`${sessionFile}.sent`, "utf8").trimEnd().split("\n");
      assert.equal(lines.length, 1);
      const receipt = JSON.parse(lines[0]) as { at: string; to: string; bytes: number };
      assert.equal(receipt.to, "%3");
      assert.equal(receipt.bytes, text.length);
      assert.match(receipt.at, /^\d{4}-\d{2}-\d{2}T/);
    });
  });

  it("still delivers when the receipt path is in a missing directory", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionFile = join(dir, "missing", "session.jsonl");
      const res = await runCli(["send", "--to", "%3", "--text", "hi"], {
        ...tmuxEnv(),
        PI_PMUX_SESSION: sessionFile,
      });
      assert.equal(res.code, 0);
      assert.deepEqual(paneCalls, ["send-keys -t %3 -l hi", "send-keys -t %3 Enter"]);
      assert.equal(existsSync(`${sessionFile}.sent`), false);
    });
  });
});

// ─── skills/pmux/launch.ts ──────────────────────────────────────────

const SHIM = join(REPO_ROOT, "skills", "pmux", "launch.ts");
const SHIM_CLI = join(REPO_ROOT, "pi-extension", "pmux", "cli.ts");
const SHIM_DONE = join(REPO_ROOT, "pi-extension", "pmux", "pmux-done.ts");
const GIT_INSTALL_RELATIVE = join("git", "github.com", "slatkin", "pmux");

interface ShimModule {
  main: CliEntry;
}

let shimImports = 0;

/**
 * Import a shim file by path. The query makes each copy a fresh module, so a
 * copied shim sees its own location rather than the shipped one.
 */
async function importShim(path: string): Promise<ShimModule> {
  return (await import(`${pathToFileURL(path).href}?shim=${++shimImports}`)) as ShimModule;
}

/** Copy the shipped shim into its own `<root>/skills/pmux/` tree. */
function copyShim(root: string): string {
  const dir = join(root, "skills", "pmux");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "launch.ts");
  copyFileSync(SHIM, path);
  return path;
}

/**
 * A fake extension root with this checkout's behaviour: a copy of
 * `pi-extension/pmux` whose `tmux.ts` re-exports the checkout's own
 * module, so this process's tmux seam still sees the pane calls. Returns the
 * resolved root.
 */
function makeInstall(root: string): string {
  mkdirSync(join(root, "pi-extension"), { recursive: true });
  cpSync(join(REPO_ROOT, "pi-extension", "pmux"), join(root, "pi-extension", "pmux"), {
    recursive: true,
  });
  const checkoutTmux = pathToFileURL(join(REPO_ROOT, "pi-extension", "pmux", "tmux.ts")).href;
  writeFileSync(
    join(root, "pi-extension", "pmux", "tmux.ts"),
    `export * from ${JSON.stringify(checkoutTmux)};\n`,
  );
  return realpathSync(root);
}

/** A child cwd holding the role in its own `.pi/agents/`. */
function startCwd(caseDir: string): string {
  const cwd = mkdtempSync(join(caseDir, "cwd-"));
  writeRole(cwd, "worker", "model: m\nthinking: low", "Body.");
  return cwd;
}

describe("skills/pmux/launch.ts", () => {
  it("prefers PI_PMUX_DIR over the checkout", async () => {
    const caseDir = mkdtempSync(join(workdir, "shim-override-"));
    const home = mkdtempSync(join(caseDir, "home-"));
    const install = makeInstall(join(caseDir, "dev-override"));
    const started = await runStartWith(shimMain, {
      cwd: startCwd(caseDir),
      env: { HOME: home, PI_PMUX_DIR: install },
    });
    // The override root wins over this checkout, so its own CLI wrote the
    // spec and its sentinel is on -e.
    assert.equal(
      argValue(started.spec.args, "-e"),
      join(install, "pi-extension", "pmux", "pmux-done.ts"),
    );
    assert.deepEqual(paneCalls, [
      "split-window -d -h -t %21 -P -F #{pane_id}",
      "select-pane -t %24 -T scout-1",
      `send-keys -t %24 -l ${paneCommandLine(join(install, "pi-extension", "pmux", "cli.ts"), started.json.launch, started.promptPath)}`,
      "send-keys -t %24 Enter",
    ]);
  });

  it("resolves the extension from the launcher's real-path checkout", async () => {
    const caseDir = mkdtempSync(join(workdir, "shim-checkout-"));
    const started = await runStartWith(shimMain, {
      cwd: startCwd(caseDir),
      env: { HOME: mkdtempSync(join(caseDir, "home-")) },
    });
    assert.equal(argValue(started.spec.args, "-e"), SHIM_DONE);
    assert.deepEqual(paneCalls, [
      "split-window -d -h -t %21 -P -F #{pane_id}",
      "select-pane -t %24 -T scout-1",
      `send-keys -t %24 -l ${paneCommandLine(SHIM_CLI, started.json.launch, started.promptPath)}`,
      "send-keys -t %24 Enter",
    ]);
  });

  it("fails naming pi install and the candidates, and records no pane call", async () => {
    const caseDir = mkdtempSync(join(workdir, "shim-missing-"));
    const copy = copyShim(caseDir);
    const shim = await importShim(copy);
    const home = mkdtempSync(join(caseDir, "home-"));
    const gitInstall = join(home, ".pi", "agent", GIT_INSTALL_RELATIVE);
    const message = await startFailureWith(shim.main, {
      cwd: startCwd(caseDir),
      env: { HOME: home },
    });
    assert.match(message, /pi install git:github\.com\/slatkin\/pmux/);
    assert.ok(message.includes(caseDir), `expected the checkout candidate in: ${message}`);
    assert.ok(message.includes(gitInstall), `expected the git install candidate in: ${message}`);
    assert.deepEqual(paneCalls, []);

    // The direct entry turns the same failure into a non-zero exit.
    const { status, stderr } = runNodeProcess([copy, "help"], {
      HOME: home,
      PATH: process.env.PATH,
    });
    assert.equal(status, 1);
    assert.match(stderr, /launch\.ts: Cannot find the pmux extension/);
    assert.deepEqual(paneCalls, []);
  });

  it("finds a pi git install under a temp HOME from a copied shim", async () => {
    const caseDir = mkdtempSync(join(workdir, "shim-git-"));
    const copy = copyShim(caseDir);
    const home = mkdtempSync(join(caseDir, "home-"));
    const install = makeInstall(join(home, ".pi", "agent", GIT_INSTALL_RELATIVE));

    // Direct entry, the way the skill runs it: `node <copy> help` finds the
    // install and runs its CLI, with no pane call.
    const help = execFileSync(process.execPath, [copy, "help"], {
      env: { HOME: home, PATH: process.env.PATH },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(help, /Usage:/);

    // A start through the copy uses the install's own CLI and sentinel.
    const shim = await importShim(copy);
    const started = await runStartWith(shim.main, {
      cwd: startCwd(caseDir),
      env: { HOME: home },
    });
    const installCli = join(install, "pi-extension", "pmux", "cli.ts");
    assert.equal(
      argValue(started.spec.args, "-e"),
      join(install, "pi-extension", "pmux", "pmux-done.ts"),
    );
    assert.deepEqual(paneCalls, [
      "split-window -d -h -t %21 -P -F #{pane_id}",
      "select-pane -t %24 -T scout-1",
      `send-keys -t %24 -l ${paneCommandLine(installCli, started.json.launch, started.promptPath)}`,
      "send-keys -t %24 Enter",
    ]);
  });
});

// ─── plugin/hooks/on-stop.js ─────────────────────────────────────────────────

const HOOK = join(REPO_ROOT, "pi-extension", "pmux", "plugin", "hooks", "on-stop.js");

interface HookOutcome {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run the stop hook the way Claude Code does: node, JSON on stdin, no shell. */
function runHook(input: string, env: NodeJS.ProcessEnv, cwd?: string): HookOutcome {
  const result = spawnSync(process.execPath, [HOOK], {
    input,
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
    ...(cwd === undefined ? {} : { cwd }),
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

/** A transcript with `userMessages` real human entries, a tool result and an assistant turn. */
function writeTranscript(path: string, userMessages: string[]): void {
  const lines = [
    ...userMessages.map((content) =>
      JSON.stringify({ type: "user", message: { role: "user", content } }),
    ),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
    }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    }),
  ];
  writeFileSync(path, `${lines.join("\n")}\n`);
}

describe("plugin/hooks/on-stop.js", () => {
  it("writes the sentinel and the transcript path for one autonomous message", () => {
    withTempDir((dir) => {
      const transcript = join(dir, "transcript.jsonl");
      writeTranscript(transcript, ["do the thing"]);
      const sentinel = join(dir, "child-done");

      const outcome = runHook(
        JSON.stringify({ transcript_path: transcript, last_assistant_message: "All done." }),
        { PI_CLAUDE_SENTINEL: sentinel },
      );

      assert.equal(outcome.status, 0);
      assert.equal(readFileSync(sentinel, "utf8"), "All done.\n");
      assert.equal(readFileSync(`${sentinel}.transcript`, "utf8"), `${transcript}\n`);
    });
  });

  it("writes only the transcript path after a second user message", () => {
    withTempDir((dir) => {
      const transcript = join(dir, "transcript.jsonl");
      writeTranscript(transcript, ["do the thing", "now do more"]);
      const sentinel = join(dir, "child-done");

      const outcome = runHook(
        JSON.stringify({ transcript_path: transcript, last_assistant_message: "All done." }),
        { PI_CLAUDE_SENTINEL: sentinel },
      );

      assert.equal(outcome.status, 0);
      assert.equal(existsSync(sentinel), false);
      assert.equal(readFileSync(`${sentinel}.transcript`, "utf8"), `${transcript}\n`);
    });
  });

  it("writes nothing when the loop guard is active", () => {
    withTempDir((dir) => {
      const transcript = join(dir, "transcript.jsonl");
      writeTranscript(transcript, ["do the thing"]);
      const sentinel = join(dir, "child-done");

      const outcome = runHook(
        JSON.stringify({
          stop_hook_active: true,
          transcript_path: transcript,
          last_assistant_message: "All done.",
        }),
        { PI_CLAUDE_SENTINEL: sentinel },
      );

      assert.equal(outcome.status, 0);
      assert.equal(existsSync(sentinel), false);
      assert.equal(existsSync(`${sentinel}.transcript`), false);
    });
  });

  it("writes nothing when PI_CLAUDE_SENTINEL is unset", () => {
    withTempDir((dir) => {
      const transcript = join(dir, "transcript.jsonl");
      writeTranscript(transcript, ["do the thing"]);
      const cwd = join(dir, "cwd");
      mkdirSync(cwd);

      const outcome = runHook(
        JSON.stringify({ transcript_path: transcript, last_assistant_message: "All done." }),
        {},
        cwd,
      );

      assert.equal(outcome.status, 0);
      assert.deepEqual(readdirSync(cwd), []);
    });
  });

  it("exits 0 and writes nothing for malformed stdin", () => {
    withTempDir((dir) => {
      const sentinel = join(dir, "child-done");

      const outcome = runHook("not json {", { PI_CLAUDE_SENTINEL: sentinel });

      assert.equal(outcome.status, 0);
      assert.equal(outcome.stderr, "");
      assert.equal(existsSync(sentinel), false);
      assert.equal(existsSync(`${sentinel}.transcript`), false);
    });
  });

  it("writes nothing when the transcript file is missing", () => {
    withTempDir((dir) => {
      const sentinel = join(dir, "child-done");

      const outcome = runHook(
        JSON.stringify({
          transcript_path: join(dir, "absent.jsonl"),
          last_assistant_message: "All done.",
        }),
        { PI_CLAUDE_SENTINEL: sentinel },
      );

      assert.equal(outcome.status, 0);
      assert.equal(existsSync(sentinel), false);
      assert.equal(existsSync(`${sentinel}.transcript`), false);
    });
  });
});
