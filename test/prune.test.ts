import "./host-env.ts";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// Sandbox the Luvus ambient environment for the whole test process: an
// ambient Luvus session must never be reachable from an un-stubbed test.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("LUVUS_")) delete process.env[key];
}
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../pi-extension/pmux/cli.ts";
import { isSentinelFile, pruneScratch, pruneSentinels } from "../pi-extension/pmux/prune.ts";
import { __setTmuxExecForTests__ } from "../pi-extension/pmux/tmux.ts";
import { useTmuxPaneFake } from "./tmux-fakes.ts";

const DAY_MS = 86_400_000;
let workdir = "";

before(() => {
  workdir = mkdtempSync(join(tmpdir(), "prune-test-"));
});

after(() => {
  __setTmuxExecForTests__(null);
  rmSync(workdir, { recursive: true, force: true });
});

/** Write a file with an mtime `ageMs` in the past. */
function seed(dir: string, name: string, ageMs: number): string {
  const path = join(dir, name);
  writeFileSync(path, "x".repeat(16));
  const past = new Date(Date.now() - ageMs);
  utimesSync(path, past, past);
  return path;
}

describe("pruneScratch", () => {
  it("deletes old managed files and keeps fresh and foreign ones", () => {
    const dir = mkdtempSync(join(workdir, "scratch-"));
    const oldSession = seed(dir, "scout-deadbeef.jsonl", 8 * DAY_MS);
    const oldSpec = seed(dir, "scout-deadbeef.json", 8 * DAY_MS);
    const freshSession = seed(dir, "scout-cafe0001.jsonl", DAY_MS);
    const foreign = seed(dir, "notes.txt", 30 * DAY_MS);
    const result = pruneScratch(dir, { maxAgeMs: 7 * DAY_MS });
    assert.equal(existsSync(oldSession), false);
    assert.equal(existsSync(oldSpec), false);
    assert.equal(existsSync(freshSession), true);
    assert.equal(existsSync(foreign), true);
    assert.equal(result.deleted.length, 2);
    assert.equal(result.deletedBytes, 32);
  });

  it("prunes a report receipt past the retention and keeps it within it", () => {
    const dir = mkdtempSync(join(workdir, "receipt-"));
    const old = seed(dir, "scout-deadbeef.sent", 8 * DAY_MS);
    const fresh = seed(dir, "scout-cafe0001.sent", 1000);
    const result = pruneScratch(dir, { maxAgeMs: 7 * DAY_MS });
    assert.equal(result.scanned, 2);
    assert.deepEqual(result.deleted, [old]);
    assert.equal(existsSync(fresh), true);
  });

  it("prunes the launcher's artifact prompt files past the retention", () => {
    const dir = mkdtempSync(join(workdir, "artifacts-"));
    const context = join(dir, "artifacts", "abc", "context");
    const resume = join(dir, "artifacts", "abc", "pmux-resume");
    mkdirSync(context, { recursive: true });
    mkdirSync(resume, { recursive: true });
    mkdirSync(join(dir, "artifacts", "abc", "other"), { recursive: true });
    // The stamped names `writeRunContextFile` creates.
    const oldPrompt = seed(context, "w2-2026-10-21T20-15-30.md", 8 * DAY_MS);
    const oldSysprompt = seed(context, "w2-sysprompt-2026-10-21T20-15-30.md", 8 * DAY_MS);
    const oldResume = seed(resume, "w2-2026-10-21T20-15-31.md", 8 * DAY_MS);
    const freshPrompt = seed(context, "w2-2026-10-21T23-59-59.md", DAY_MS);
    // A file the launcher did not write stays: unstamped, and in another
    // folder of the same id.
    const unstamped = seed(context, "w2-notes.md", 30 * DAY_MS);
    const foreignFolderFile = seed(
      join(dir, "artifacts", "abc", "other"),
      "w2-2026-10-21T20-15-30.md",
      30 * DAY_MS,
    );
    const foreignRoot = seed(dir, "scout-deadbeef.jsonl", 8 * DAY_MS);

    const result = pruneScratch(dir, { maxAgeMs: 7 * DAY_MS });

    assert.equal(existsSync(oldPrompt), false);
    assert.equal(existsSync(oldSysprompt), false);
    assert.equal(existsSync(oldResume), false);
    assert.equal(existsSync(freshPrompt), true);
    assert.equal(existsSync(unstamped), true);
    assert.equal(existsSync(foreignFolderFile), true);
    // The top-level rule still covers its own suffixes: the receipt-shaped
    // root file was old and managed, so it went too.
    assert.equal(existsSync(foreignRoot), false);
    // `deleted` is sorted by path: the artifacts tree sorts before the root
    // file, and `w2-2…` before `w2-s…` inside the context folder.
    assert.deepEqual(result.deleted, [oldPrompt, oldSysprompt, oldResume, foreignRoot]);
  });

  it("prunes artifact files under every parent id", () => {
    const dir = mkdtempSync(join(workdir, "artifacts-ids-"));
    const first = join(dir, "artifacts", "%21", "context");
    const second = join(dir, "artifacts", "sess-abc", "context");
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    const oldFirst = seed(first, "w2-2026-10-21T20-15-30.md", 8 * DAY_MS);
    const oldSecond = seed(second, "w2-2026-10-21T20-15-30.md", 8 * DAY_MS);
    const result = pruneScratch(dir, { maxAgeMs: 7 * DAY_MS });
    assert.deepEqual(result.deleted, [oldFirst, oldSecond]);
  });

  it("lists without deleting on dry run", () => {
    const dir = mkdtempSync(join(workdir, "dry-"));
    const old = seed(dir, "scout-deadbeef.jsonl", 8 * DAY_MS);
    const result = pruneScratch(dir, { maxAgeMs: 7 * DAY_MS, dryRun: true });
    assert.equal(existsSync(old), true);
    assert.deepEqual(result.deleted, [old]);
  });

  it("recognizes only Claude sentinel names", () => {
    assert.equal(isSentinelFile("pi-claude-abc123-done"), true);
    assert.equal(isSentinelFile("pi-claude-abc123-done.transcript"), true);
    assert.equal(isSentinelFile("pi-luvus"), false);
    assert.equal(isSentinelFile("scout-deadbeef.jsonl"), false);
  });

  it("deletes only old sentinels", () => {
    const dir = mkdtempSync(join(workdir, "sentinels-"));
    const old = seed(dir, "pi-claude-abc123-done", 2 * DAY_MS);
    const oldTranscript = seed(dir, "pi-claude-abc123-done.transcript", 2 * DAY_MS);
    const fresh = seed(dir, "pi-claude-fresh99-done", 1000);
    const foreign = seed(dir, "other-done", 30 * DAY_MS);
    const result = pruneSentinels(dir, { maxAgeMs: DAY_MS });
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(oldTranscript), false);
    assert.equal(existsSync(fresh), true);
    assert.equal(existsSync(foreign), true);
    assert.equal(result.deleted.length, 2);
  });
});

describe("cli.ts prune", () => {
  it("clears a scratch dir and prints JSON", async () => {
    const dir = mkdtempSync(join(workdir, "cli-"));
    const scratch = join(dir, "scratch");
    mkdirSync(scratch, { recursive: true });
    seed(scratch, "scout-deadbeef.jsonl", 8 * DAY_MS);
    const sentinels = mkdtempSync(join(workdir, "cli-sent-"));
    const stdout: string[] = [];
    const code = await main(["prune", "--scratch", scratch, "--max-age-days", "7"], {
      env: { PATH: process.env.PATH, PI_PMUX_SENTINEL_DIR: sentinels },
      stdout: (text) => stdout.push(text),
      stderr: () => {},
      sleep: async () => {},
    });
    assert.equal(code, 0);
    const report = JSON.parse(stdout.join(""));
    assert.equal(report.deleted.length, 1);
    assert.equal(readdirSync(scratch).length, 0);
  });

  it("succeeds empty on a missing directory", async () => {
    const sentinels = mkdtempSync(join(workdir, "cli-miss-sent-"));
    const stdout: string[] = [];
    const code = await main(["prune", "--scratch", join(workdir, "no-such-dir")], {
      env: { PATH: process.env.PATH, PI_PMUX_SENTINEL_DIR: sentinels },
      stdout: (text) => stdout.push(text),
      stderr: () => {},
      sleep: async () => {},
    });
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(stdout.join("")).deleted, []);
  });

  it("rejects a negative max age", async () => {
    const sentinels = mkdtempSync(join(workdir, "cli-neg-sent-"));
    let message = "";
    try {
      await main(["prune", "--max-age-days", "-1"], {
        env: { PATH: process.env.PATH, PI_PMUX_SENTINEL_DIR: sentinels },
        stdout: () => {},
        stderr: () => {},
        sleep: async () => {},
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.match(message, /max-age-days/);
  });

  it("start removes old scratch files in the same directory", async () => {
    useTmuxPaneFake();
    const dir = mkdtempSync(join(workdir, "autoprune-"));
    const cwd = mkdtempSync(join(dir, "cwd-"));
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "agents", "worker.md"),
      "---\nmodel: test-model\n---\n\nBody.\n",
    );
    const brief = join(dir, "brief.md");
    writeFileSync(brief, "# Task\n\nDo the thing.\n");
    const scratch = join(dir, "scratch");
    mkdirSync(scratch, { recursive: true });
    const old = seed(scratch, "old-deadbeef.jsonl", 8 * DAY_MS);
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ surface: "right" }));
    const stdout: string[] = [];
    const code = await main(
      [
        "start",
        "--name",
        "scout-1",
        "--role",
        "worker",
        "--cwd",
        cwd,
        "--brief",
        brief,
        "--parent",
        "orch",
        "--scratch",
        scratch,
      ],
      {
        env: {
          PATH: process.env.PATH,
          TMUX: "/tmp/tmux-0/default",
          TMUX_PANE: "%21",
        },
        stdout: (text) => stdout.push(text),
        stderr: () => {},
        sleep: async () => {},
        configPath,
      },
    );
    assert.equal(code, 0);
    assert.equal(existsSync(old), false);
    // The fresh launch files survive the prune; the prompt now lives under
    // artifacts/<id>/context/, so the record beside the session file marks it.
    assert.ok(readdirSync(scratch).some((file) => file.endsWith(".launch.json")));
  });
});
