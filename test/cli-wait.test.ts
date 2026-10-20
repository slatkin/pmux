import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../pi-extension/pmux/cli.ts";
import { statusFilePath, writeChildStatus } from "../pi-extension/pmux/status-file.ts";

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

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pmux-wait-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
