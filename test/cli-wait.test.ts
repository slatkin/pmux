import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { main } from "../pi-extension/pmux/cli.ts";
import { exitSidecarPath } from "../pi-extension/pmux/exit-sidecar.ts";
import { statusFilePath, writeChildStatus } from "../pi-extension/pmux/status-file.ts";
import { tempDirHelpers } from "./temp-dir.ts";

const { withTempDirAsync: withTempDir } = tempDirHelpers("pmux-wait-");

/** One `wait` invocation with captured stdout and stderr. */
async function runWait(
  argv: string[],
  deps: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(["wait", ...argv], {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    ...deps,
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

describe("cli wait", () => {
  it("prints the status line and exits 0 when the wanted status appears", async () => {
    await withTempDir(async (dir) => {
      const sessionFile = join(dir, "child.jsonl");
      writeChildStatus(sessionFile, "done");
      // The command prints what the file holds, with one trailing newline.
      const raw = readFileSync(statusFilePath(sessionFile), "utf8");
      const result = await runWait([
        "--session",
        sessionFile,
        "--status",
        "done,blocked",
        "--timeout",
        "5",
      ]);
      assert.equal(result.code, 0);
      assert.equal(result.stdout, `${raw}\n`);
      assert.equal(JSON.parse(result.stdout).status, "done");
      assert.equal(result.stderr, "");
    });
  });

  it('times out with the last status seen, or {"status":null}', async () => {
    await withTempDir(async (dir) => {
      const sessionFile = join(dir, "child.jsonl");
      writeChildStatus(sessionFile, "working");
      const raw = readFileSync(statusFilePath(sessionFile), "utf8");
      const seen = await runWait(["--session", sessionFile, "--timeout", "0.05"]);
      assert.equal(seen.code, 2);
      assert.equal(seen.stdout, `${raw}\n`);
      assert.match(seen.stderr, /timeout/);
      assert.match(seen.stderr, /working/);

      // No status file at all: the null line and a timeout without a name.
      const missing = join(dir, "gone.jsonl");
      const none = await runWait(["--session", missing, "--timeout", "0.05"]);
      assert.equal(none.code, 2);
      assert.equal(none.stdout, `${JSON.stringify({ status: null })}\n`);
      assert.match(none.stderr, /timeout/);
      assert.match(none.stderr, /no status/);
    });
  });

  it("exits 1 with nothing on stdout for a usage error", async () => {
    await withTempDir(async (dir) => {
      const sessionFile = join(dir, "child.jsonl");
      const missingSession = await runWait(["--timeout", "5"]);
      assert.equal(missingSession.code, 1);
      assert.equal(missingSession.stdout, "");
      assert.match(missingSession.stderr, /--session/);

      const unknownStatus = await runWait([
        "--session",
        sessionFile,
        "--status",
        "finished",
        "--timeout",
        "5",
      ]);
      assert.equal(unknownStatus.code, 1);
      assert.equal(unknownStatus.stdout, "");
      assert.match(unknownStatus.stderr, /finished/);
      for (const name of ["working", "idle", "done", "blocked"]) {
        assert.match(unknownStatus.stderr, new RegExp(name));
      }

      for (const [label, arg] of [
        ["0", "--timeout=0"],
        ["-3", "--timeout=-3"],
        ["abc", "--timeout=abc"],
      ] as const) {
        const badTimeout = await runWait(["--session", sessionFile, arg]);
        assert.equal(badTimeout.code, 1, `--timeout ${label}`);
        assert.equal(badTimeout.stdout, "");
        assert.match(badTimeout.stderr, /--timeout/);
      }
    });
  });
});

describe("cli wait --signal sidecar", () => {
  /** `wait --signal sidecar` against a session file. */
  function waitSidecar(
    sessionFile: string,
    timeout = "5",
    deps: { sleep?: (ms: number) => Promise<void> } = {},
  ) {
    return runWait(["--session", sessionFile, "--signal", "sidecar", "--timeout", timeout], deps);
  }

  it("prints the interpreted sidecar and leaves it in place", async () => {
    await withTempDir(async (dir) => {
      const sessionFile = join(dir, "child.jsonl");
      const sidecar = exitSidecarPath(sessionFile);
      writeFileSync(sidecar, JSON.stringify({ type: "done" }));
      const result = await waitSidecar(sessionFile);
      assert.equal(result.code, 0);
      assert.equal(
        result.stdout,
        `${JSON.stringify({
          reason: "done",
          exitCode: 0,
          sidecar: resolve(sidecar),
        })}\n`,
      );
      assert.equal(result.stderr, "");
      // The wait is read-only: the run wrapper still reads the sidecar after
      // the child exits, so the file must survive the wait.
      assert.equal(existsSync(sidecar), true);
    });
  });

  it("a second wait reports the same exit again", async () => {
    await withTempDir(async (dir) => {
      const sessionFile = join(dir, "child.jsonl");
      const sidecar = exitSidecarPath(sessionFile);
      writeFileSync(sidecar, JSON.stringify({ type: "done" }));
      const first = await waitSidecar(sessionFile);
      const second = await waitSidecar(sessionFile);
      assert.equal(first.code, 0);
      assert.equal(second.code, 0);
      assert.equal(first.stdout, second.stdout);
      // Still read-only: the sidecar is the wrapper's to read.
      assert.equal(existsSync(sidecar), true);
    });
  });

  it("prints the ping payload of a ping sidecar", async () => {
    await withTempDir(async (dir) => {
      const sessionFile = join(dir, "child.jsonl");
      const sidecar = exitSidecarPath(sessionFile);
      writeFileSync(
        sidecar,
        JSON.stringify({ type: "ping", name: "worker", message: "need answer" }),
      );
      const result = await waitSidecar(sessionFile);
      assert.equal(result.code, 0);
      assert.deepEqual(JSON.parse(result.stdout), {
        reason: "ping",
        exitCode: 0,
        ping: { name: "worker", message: "need answer" },
        sidecar: resolve(sidecar),
      });
      assert.equal(existsSync(sidecar), true);
    });
  });

  it("times out with the null sidecar line and a message on stderr", async () => {
    await withTempDir(async (dir) => {
      const sessionFile = join(dir, "child.jsonl");
      const result = await waitSidecar(sessionFile, "0.05");
      assert.equal(result.code, 2);
      assert.equal(result.stdout, `${JSON.stringify({ sidecar: null })}\n`);
      assert.match(result.stderr, /timeout/);
      assert.match(result.stderr, /no exit sidecar/);
    });
  });

  it("picks up a sidecar that appears while it polls", async () => {
    await withTempDir(async (dir) => {
      const sessionFile = join(dir, "child.jsonl");
      const sidecar = exitSidecarPath(sessionFile);
      let polls = 0;
      const result = await waitSidecar(sessionFile, "5", {
        sleep: async () => {
          polls += 1;
          if (polls === 1) {
            writeFileSync(sidecar, JSON.stringify({ type: "done" }));
          }
        },
      });
      assert.equal(result.code, 0);
      assert.equal(
        result.stdout,
        `${JSON.stringify({
          reason: "done",
          exitCode: 0,
          sidecar: resolve(sidecar),
        })}\n`,
      );
      assert.equal(existsSync(sidecar), true);
    });
  });

  it("does not crash on a malformed sidecar", async () => {
    await withTempDir(async (dir) => {
      const sessionFile = join(dir, "child.jsonl");
      const sidecar = exitSidecarPath(sessionFile);
      writeFileSync(sidecar, "not json at all");
      const result = await waitSidecar(sessionFile);
      assert.equal(result.code, 0);
      // The file's presence is the signal; an unknown payload maps to done.
      assert.equal(
        result.stdout,
        `${JSON.stringify({
          reason: "done",
          exitCode: 0,
          sidecar: resolve(sidecar),
        })}\n`,
      );
      assert.equal(existsSync(sidecar), true);
    });
  });

  it("exits 1 with nothing on stdout for a usage error", async () => {
    await withTempDir(async (dir) => {
      const sessionFile = join(dir, "child.jsonl");
      const missingSession = await runWait(["--signal", "sidecar", "--timeout", "5"]);
      assert.equal(missingSession.code, 1);
      assert.equal(missingSession.stdout, "");
      assert.match(missingSession.stderr, /--session/);

      const badSignal = await runWait(["--session", sessionFile, "--signal", "fast"]);
      assert.equal(badSignal.code, 1);
      assert.equal(badSignal.stdout, "");
      assert.match(badSignal.stderr, /--signal/);
      assert.match(badSignal.stderr, /fast/);

      // Judged by flag presence: an explicit --status is a usage error even
      // though it matches the resolved default.
      const statusFlag = await runWait([
        "--session",
        sessionFile,
        "--signal",
        "sidecar",
        "--status",
        "done",
      ]);
      assert.equal(statusFlag.code, 1);
      assert.equal(statusFlag.stdout, "");
      assert.match(statusFlag.stderr, /--status/);

      for (const [label, arg] of [
        ["0", "--timeout=0"],
        ["-3", "--timeout=-3"],
        ["abc", "--timeout=abc"],
      ] as const) {
        const badTimeout = await runWait(["--session", sessionFile, "--signal", "sidecar", arg]);
        assert.equal(badTimeout.code, 1, `--timeout ${label}`);
        assert.equal(badTimeout.stdout, "");
        assert.match(badTimeout.stderr, /--timeout/);
      }
    });
  });

  it("--signal sidecar with no --status is not a usage error and waits", async () => {
    await withTempDir(async (dir) => {
      const sessionFile = join(dir, "child.jsonl");
      const sidecar = exitSidecarPath(sessionFile);
      let polls = 0;
      const result = await waitSidecar(sessionFile, "5", {
        sleep: async () => {
          polls += 1;
          if (polls === 1) {
            writeFileSync(sidecar, JSON.stringify({ type: "handoff" }));
          }
        },
      });
      assert.equal(result.code, 0);
      assert.deepEqual(JSON.parse(result.stdout), {
        reason: "handoff",
        exitCode: 0,
        handoff: { message: "(handoff text missing)" },
        sidecar: resolve(sidecar),
      });
    });
  });
});
