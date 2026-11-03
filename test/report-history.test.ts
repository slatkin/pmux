/**
 * The per-pane report history (report-viewer spec): the path rule shared with
 * the inbox, the record files, the newest-first listing and the prune sweep.
 * Every history lives under a temp runtime dir; no tmux server is involved.
 */
import "./host-env.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  historyDirPath,
  listHistory,
  pruneHistory,
  writeHistoryRecord,
  type HistoryRecord,
} from "../pi-extension/pmux/report-history.ts";
import { inboxDirPath } from "../pi-extension/pmux/report-inbox.ts";
import { tempDirHelpers } from "./temp-dir.ts";

const { withTempDir } = tempDirHelpers("pmux-history-");

const ID = "aa".repeat(16);
const ID_B = "bb".repeat(16);
const TMUX = "/tmp/tmux-1000/default,1,0";
const DAY_MS = 86_400_000;

/** The history env: the shared TMUX socket and a runtime dir inside `dir`. */
function envIn(dir: string): NodeJS.ProcessEnv {
  return { TMUX, XDG_RUNTIME_DIR: join(dir, "run") };
}

/** A complete record for `id`; the fields a test does not name get defaults. */
function record(id: string, overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    v: 1,
    id,
    from: "worker-a",
    session: "/s/w.jsonl",
    report: `/s/w.jsonl.${id}.report.md`,
    at: "2026-10-28T10:00:00.000Z",
    ...overrides,
  };
}

describe("historyDirPath", () => {
  it("names the shared test vector under XDG_RUNTIME_DIR", () => {
    const dir = historyDirPath({
      env: { TMUX, XDG_RUNTIME_DIR: "/run/user/1000" },
      targetPane: "%12",
    });
    assert.equal(dir, "/run/user/1000/pmux-history/79301cf9592f327a-12");
  });

  it("keys a pane's history on the same name as its inbox", () => {
    const env = { TMUX, XDG_RUNTIME_DIR: "/run/user/1000" };
    // The report-viewer spec's "Same key as the inbox" scenario: the inbox of
    // %7 is pmux-inbox/abc-7 and its history is pmux-history/abc-7.
    const inbox = inboxDirPath({ env, targetPane: "%7" });
    const history = historyDirPath({ env, targetPane: "%7" });
    assert.equal(inbox, "/run/user/1000/pmux-inbox/79301cf9592f327a-7");
    assert.equal(history, "/run/user/1000/pmux-history/79301cf9592f327a-7");
    assert.equal(history!.split("/").at(-1), inbox!.split("/").at(-1));
  });

  it("falls back to the uid directory in /tmp", () => {
    const dir = historyDirPath({ env: { TMUX }, targetPane: "%12", uid: 1000 });
    assert.equal(dir, "/tmp/pmux-history-1000/79301cf9592f327a-12");
  });

  it("names the pane it was given, with or without its %", () => {
    const env = { TMUX, XDG_RUNTIME_DIR: "/run/user/1000" };
    assert.equal(
      historyDirPath({ env, targetPane: "%30" }),
      historyDirPath({ env, targetPane: "30" }),
    );
    assert.ok(historyDirPath({ env, targetPane: "%30" })!.endsWith("-30"));
  });

  it("is null when TMUX is unset or empty", () => {
    assert.equal(historyDirPath({ env: {}, targetPane: "%12" }), null);
    assert.equal(historyDirPath({ env: { TMUX: "" }, targetPane: "%12" }), null);
  });
});

describe("history records", () => {
  it("writes atomically into an owner-only directory it creates", () => {
    withTempDir((dir) => {
      const history = join(dir, "run", "pmux-history", "hash-12");
      writeHistoryRecord(history, record(ID));
      // One finished file, no temporary left behind.
      assert.deepEqual(readdirSync(history), [`${ID}.json`]);
      assert.equal(statSync(history).mode & 0o777, 0o700);
      assert.deepEqual(JSON.parse(readFileSync(join(history, `${ID}.json`), "utf8")), record(ID));
    });
  });

  it("lists newest first", () => {
    withTempDir((dir) => {
      const history = join(dir, "history");
      writeHistoryRecord(history, record(ID, { at: "2026-10-28T10:00:00.000Z" }));
      writeHistoryRecord(history, record(ID_B, { at: "2026-10-29T10:00:00.000Z" }));
      assert.deepEqual(
        listHistory(history).map((item) => item.id),
        [ID_B, ID],
      );
    });
  });

  it("skips malformed files and files whose name does not match their ID", () => {
    withTempDir((dir) => {
      const history = join(dir, "history");
      writeHistoryRecord(history, record(ID));
      writeFileSync(join(history, `${"cc".repeat(16)}.json`), "{not json");
      writeFileSync(join(history, `${ID_B}.json.tmp`), "{}");
      // The file is named for ID_B but holds the record for ID: it is skipped.
      writeFileSync(join(history, `${ID_B}.json`), JSON.stringify(record(ID)));
      assert.deepEqual(
        listHistory(history).map((item) => item.id),
        [ID],
      );
    });
  });

  it("lists nothing for a missing history", () => {
    withTempDir((dir) => {
      assert.deepEqual(listHistory(join(dir, "no-such-history")), []);
    });
  });
});

describe("pruneHistory", () => {
  /** Write a record file with an mtime `ageMs` in the past. */
  function seedRecord(dir: string, id: string, ageMs: number): string {
    writeHistoryRecord(dir, record(id));
    const path = join(dir, `${id}.json`);
    const past = new Date(Date.now() - ageMs);
    utimesSync(path, past, past);
    return path;
  }

  it("deletes records past the retention and keeps records within it", () => {
    withTempDir((dir) => {
      const env = envIn(dir);
      const history = historyDirPath({ env, targetPane: "%12" })!;
      const old = seedRecord(history, ID, 8 * DAY_MS);
      const fresh = seedRecord(history, ID_B, DAY_MS);
      const result = pruneHistory({ env, maxAgeMs: 7 * DAY_MS, dryRun: false });
      assert.equal(result.histories, 1);
      assert.equal(result.recordsDeleted, 1);
      // The kept record leaves the directory alive.
      assert.equal(result.dirsDeleted, 0);
      assert.equal(existsSync(old), false);
      assert.equal(existsSync(fresh), true);
    });
  });

  it("removes a history directory that holds no record", () => {
    withTempDir((dir) => {
      const env = envIn(dir);
      const emptied = historyDirPath({ env, targetPane: "%12" })!;
      const neverHeld = historyDirPath({ env, targetPane: "%13" })!;
      seedRecord(emptied, ID, 8 * DAY_MS);
      // An empty directory counts too: it holds no record.
      mkdirSync(neverHeld, { recursive: true });
      writeFileSync(join(neverHeld, ".keep"), "x");
      const result = pruneHistory({ env, maxAgeMs: 7 * DAY_MS, dryRun: false });
      assert.equal(result.recordsDeleted, 1);
      assert.equal(result.dirsDeleted, 2);
      assert.equal(existsSync(emptied), false);
      assert.equal(existsSync(neverHeld), false);
    });
  });

  it("lists without deleting on dry run", () => {
    withTempDir((dir) => {
      const env = envIn(dir);
      const history = historyDirPath({ env, targetPane: "%12" })!;
      const old = seedRecord(history, ID, 8 * DAY_MS);
      const result = pruneHistory({ env, maxAgeMs: 7 * DAY_MS, dryRun: true });
      assert.equal(result.recordsDeleted, 1);
      assert.equal(result.dirsDeleted, 1);
      assert.equal(existsSync(old), true);
      assert.equal(existsSync(history), true);
    });
  });

  it("succeeds empty on a missing root", () => {
    withTempDir((dir) => {
      const env = { TMUX, XDG_RUNTIME_DIR: join(dir, "no-such-run") };
      const result = pruneHistory({ env, maxAgeMs: DAY_MS, dryRun: false });
      assert.deepEqual(result, { histories: 0, recordsDeleted: 0, dirsDeleted: 0 });
    });
  });
});
