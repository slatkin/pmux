/**
 * The per-parent report inbox: the path rule, the entry and marker files, the
 * sender's inbox transport, the follower's pointer lines and the prune sweep.
 * Every inbox lives under a temp runtime dir; no tmux server is involved.
 */
import "./host-env.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  INBOX_MARKER,
  followInbox,
  formatPointerLine,
  inboxDirPath,
  listInboxEntries,
  liveMonitorPid,
  pendingInboxEntries,
  pruneInboxes,
  removeMonitorMarker,
  submitInboxEntry,
  writeInboxEntry,
  writeMonitorMarker,
  type InboxEntry,
} from "../pi-extension/pmux/report-inbox.ts";
import { appendReportAck, appendReportRegistration } from "../pi-extension/pmux/report-receipt.ts";
import { tempDirHelpers } from "./temp-dir.ts";

const { withTempDir } = tempDirHelpers("pmux-inbox-");

const ID = "aa".repeat(16);
const ID_B = "bb".repeat(16);
const CLI = "/pkg/pi-extension/pmux/cli.ts";
const TMUX = "/tmp/tmux-1000/default,1,0";
const DAY_MS = 86_400_000;

/** The inbox env: the shared TMUX socket and a runtime dir inside `dir`. */
function envIn(dir: string): NodeJS.ProcessEnv {
  return { TMUX, XDG_RUNTIME_DIR: join(dir, "run") };
}

/** A complete entry for `id`; the fields a test does not name get defaults. */
function entry(id: string, overrides: Partial<InboxEntry> = {}): InboxEntry {
  return {
    v: 1,
    id,
    from: "worker-a",
    session: "/s/w.jsonl",
    report: `/s/w.jsonl.${id}.report.md`,
    cli: CLI,
    at: "2026-10-28T10:00:00.000Z",
    delivery: 1,
    ...overrides,
  };
}

/** The pid of a child that has already exited, so the pid is certainly dead. */
function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid as number;
}

describe("inboxDirPath", () => {
  it("names the shared test vector under XDG_RUNTIME_DIR", () => {
    const dir = inboxDirPath({
      env: { TMUX, XDG_RUNTIME_DIR: "/run/user/1000" },
      targetPane: "%12",
    });
    assert.equal(dir, "/run/user/1000/pmux-inbox/79301cf9592f327a-12");
  });

  it("falls back to the uid directory in /tmp", () => {
    const dir = inboxDirPath({ env: { TMUX }, targetPane: "%12", uid: 1000 });
    assert.equal(dir, "/tmp/pmux-inbox-1000/79301cf9592f327a-12");
  });

  it("names the pane it was given, with or without its %", () => {
    const env = { TMUX, XDG_RUNTIME_DIR: "/run/user/1000" };
    assert.equal(inboxDirPath({ env, targetPane: "%30" }), inboxDirPath({ env, targetPane: "30" }));
    assert.ok(inboxDirPath({ env, targetPane: "%30" })!.endsWith("-30"));
  });

  it("is null when TMUX is unset or empty", () => {
    assert.equal(inboxDirPath({ env: {}, targetPane: "%12" }), null);
    assert.equal(inboxDirPath({ env: { TMUX: "" }, targetPane: "%12" }), null);
  });
});

describe("inbox entries", () => {
  it("writes atomically: one finished file, no temporary left behind", () => {
    withTempDir((dir) => {
      const inbox = join(dir, "inbox");
      writeInboxEntry(inbox, entry(ID));
      assert.deepEqual(readdirSync(inbox), [`${ID}.json`]);
      assert.deepEqual(
        listInboxEntries(inbox).map((item) => item.id),
        [ID],
      );
    });
  });

  it("skips malformed files and files whose name does not match their ID", () => {
    withTempDir((dir) => {
      const inbox = join(dir, "inbox");
      writeInboxEntry(inbox, entry(ID));
      writeFileSync(join(inbox, `${"cc".repeat(16)}.json`), "{not json");
      writeFileSync(join(inbox, `${ID_B}.json.tmp`), "{}");
      // The file is named for ID_B but holds the entry for ID: it is skipped.
      writeFileSync(join(inbox, `${ID_B}.json`), JSON.stringify(entry(ID)));
      assert.deepEqual(
        listInboxEntries(inbox).map((item) => item.id),
        [ID],
      );
    });
  });

  it("lists entries oldest first", () => {
    withTempDir((dir) => {
      const inbox = join(dir, "inbox");
      writeInboxEntry(inbox, entry(ID, { at: "2026-10-28T10:00:02.000Z" }));
      writeInboxEntry(inbox, entry(ID_B, { at: "2026-10-28T10:00:01.000Z" }));
      assert.deepEqual(
        listInboxEntries(inbox).map((item) => item.id),
        [ID_B, ID],
      );
    });
  });
});

describe("live-monitor marker", () => {
  it("reads a marker written by a live process as live", () => {
    withTempDir((dir) => {
      writeMonitorMarker(dir, process.pid);
      assert.equal(liveMonitorPid(dir), process.pid);
    });
  });

  it("treats a marker whose process is gone as absent", () => {
    withTempDir((dir) => {
      const marker = { v: 1, pid: deadPid(), at: "2026-10-28T10:00:00.000Z" };
      writeFileSync(join(dir, INBOX_MARKER), JSON.stringify(marker));
      assert.equal(liveMonitorPid(dir), null);
    });
  });

  it("treats a malformed marker as absent", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, INBOX_MARKER), "not json");
      assert.equal(liveMonitorPid(dir), null);
      writeFileSync(join(dir, INBOX_MARKER), JSON.stringify({ v: 2, pid: process.pid, at: "x" }));
      assert.equal(liveMonitorPid(dir), null);
    });
  });

  it("removes only the marker that names its own pid", () => {
    withTempDir((dir) => {
      writeMonitorMarker(dir, 4242);
      removeMonitorMarker(dir, process.pid);
      assert.equal(existsSync(join(dir, INBOX_MARKER)), true);
      removeMonitorMarker(dir, 4242);
      assert.equal(existsSync(join(dir, INBOX_MARKER)), false);
    });
  });
});

describe("submitInboxEntry", () => {
  it("is unavailable with no-inbox when TMUX is unset", () => {
    withTempDir((dir) => {
      const result = submitInboxEntry({
        env: { XDG_RUNTIME_DIR: join(dir, "run") },
        to: "%12",
        fields: { id: ID, from: "worker-a", session: "/s/w.jsonl", report: "/r", cli: CLI },
      });
      assert.deepEqual(result, { status: "unavailable", reason: "no-inbox" });
    });
  });

  it("is unavailable with unmonitored when no live marker exists, and writes nothing", () => {
    withTempDir((dir) => {
      const env = envIn(dir);
      const result = submitInboxEntry({
        env,
        to: "%12",
        fields: { id: ID, from: "worker-a", session: "/s/w.jsonl", report: "/r", cli: CLI },
      });
      assert.deepEqual(result, { status: "unavailable", reason: "unmonitored" });
      assert.equal(
        existsSync(join(inboxDirPath({ env, targetPane: "%12" })!, `${ID}.json`)),
        false,
      );
    });
  });

  it("writes the entry while monitored and counts each re-delivery up", () => {
    withTempDir((dir) => {
      const env = envIn(dir);
      const inbox = inboxDirPath({ env, targetPane: "%12" })!;
      writeMonitorMarker(inbox, process.pid);
      const fields = { id: ID, from: "worker-a", session: "/s/w.jsonl", report: "/r", cli: CLI };
      assert.deepEqual(submitInboxEntry({ env, to: "%12", fields }), { status: "delivered" });
      assert.equal(listInboxEntries(inbox)[0]!.delivery, 1);
      assert.deepEqual(submitInboxEntry({ env, to: "%12", fields }), { status: "delivered" });
      assert.equal(listInboxEntries(inbox)[0]!.delivery, 2);
      assert.equal(listInboxEntries(inbox).length, 1);
    });
  });

  it("is unavailable with write-failed when the entry path is blocked", () => {
    withTempDir((dir) => {
      const env = envIn(dir);
      const inbox = inboxDirPath({ env, targetPane: "%12" })!;
      writeMonitorMarker(inbox, process.pid);
      mkdirSync(join(inbox, `${ID}.json`), { recursive: true });
      const result = submitInboxEntry({
        env,
        to: "%12",
        fields: { id: ID, from: "worker-a", session: "/s/w.jsonl", report: "/r", cli: CLI },
      });
      assert.deepEqual(result, { status: "unavailable", reason: "write-failed" });
    });
  });
});

describe("formatPointerLine", () => {
  it("prints one line naming the report, its delivery and the shell-quoted commands", () => {
    const line = formatPointerLine(
      entry(ID, {
        from: "worker-a",
        delivery: 2,
        session: "/s/w.jsonl",
        report: `/s/with space/w.jsonl.${ID}.report.md`,
        cli: "/pkg/cli.ts",
      }),
    );
    assert.equal(
      line,
      `pmux report ${ID} from worker-a (delivery 2). ` +
        `Read '/s/with space/w.jsonl.${ID}.report.md', then run: ` +
        `node '/pkg/cli.ts' ack --session '/s/w.jsonl' --id ${ID}. ` +
        "Acknowledge only after reading.",
    );
    assert.ok(!line.includes("\n"));
  });
});

describe("retirement of acknowledged entries", () => {
  it("removes an entry whose ID is already acknowledged and returns none", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "w.jsonl");
      appendReportRegistration(sessionFile, { id: ID, to: "%12", bytes: 1, report: "/r" });
      appendReportAck(sessionFile, ID);
      const inbox = join(dir, "inbox");
      writeInboxEntry(inbox, entry(ID, { session: sessionFile }));
      assert.deepEqual(pendingInboxEntries(inbox), []);
      assert.equal(existsSync(join(inbox, `${ID}.json`)), false);
    });
  });

  it("keeps an entry whose ID is not acknowledged", () => {
    withTempDir((dir) => {
      const inbox = join(dir, "inbox");
      writeInboxEntry(inbox, entry(ID, { session: join(dir, "w.jsonl") }));
      assert.deepEqual(
        pendingInboxEntries(inbox).map((item) => item.id),
        [ID],
      );
    });
  });
});

describe("followInbox", () => {
  it("prints the backlog at once, then new and re-delivered entries on each rescan", () => {
    withTempDir((dir) => {
      const inbox = join(dir, "inbox");
      const session = join(dir, "w.jsonl");
      writeInboxEntry(inbox, entry(ID, { session, at: "2026-10-28T10:00:00.000Z" }));
      const lines: string[] = [];
      const follower = followInbox({ dir: inbox, write: (line) => lines.push(line) });
      try {
        assert.equal(lines.length, 1);
        assert.ok(lines[0]!.includes(`pmux report ${ID} from worker-a (delivery 1).`));

        writeInboxEntry(inbox, entry(ID_B, { session, at: "2026-10-28T10:00:01.000Z" }));
        follower.rescan();
        assert.equal(lines.length, 2);

        writeInboxEntry(inbox, entry(ID, { session, delivery: 2 }));
        follower.rescan();
        assert.equal(lines.length, 3);
        assert.ok(lines[2]!.includes("(delivery 2)"));

        follower.rescan();
        assert.equal(lines.length, 3, "an unchanged entry is not printed twice");
      } finally {
        follower.stop();
      }
    });
  });

  it("picks up an inbox that is created after the follower started", () => {
    withTempDir((dir) => {
      const inbox = join(dir, "later");
      const lines: string[] = [];
      const follower = followInbox({ dir: inbox, write: (line) => lines.push(line) });
      try {
        assert.deepEqual(lines, []);
        writeInboxEntry(inbox, entry(ID, { session: join(dir, "w.jsonl") }));
        follower.rescan();
        assert.equal(lines.length, 1);
      } finally {
        follower.stop();
      }
    });
  });
});

describe("pruneInboxes", () => {
  it("deletes entries past the retention, keeps fresh ones and removes an emptied inbox", () => {
    withTempDir((dir) => {
      const env = envIn(dir);
      const now = Date.now();
      const old = new Date(now - 2 * DAY_MS);
      const fresh = inboxDirPath({ env, targetPane: "%12" })!;
      const emptied = inboxDirPath({ env, targetPane: "%13" })!;
      writeInboxEntry(fresh, entry(ID));
      writeInboxEntry(fresh, entry(ID_B));
      utimesSync(join(fresh, `${ID}.json`), old, old);
      writeInboxEntry(emptied, entry(ID));
      utimesSync(join(emptied, `${ID}.json`), old, old);

      const result = pruneInboxes({ env, maxAgeMs: DAY_MS, dryRun: false, now });

      assert.deepEqual(result, { inboxes: 2, entriesDeleted: 2, dirsDeleted: 1 });
      assert.deepEqual(readdirSync(fresh), [`${ID_B}.json`]);
      assert.equal(existsSync(emptied), false);
    });
  });

  it("keeps an empty inbox that still has a live marker", () => {
    withTempDir((dir) => {
      const env = envIn(dir);
      const inbox = inboxDirPath({ env, targetPane: "%12" })!;
      mkdirSync(inbox, { recursive: true });
      writeMonitorMarker(inbox, process.pid);
      const result = pruneInboxes({ env, maxAgeMs: DAY_MS, dryRun: false });
      assert.deepEqual(result, { inboxes: 1, entriesDeleted: 0, dirsDeleted: 0 });
      assert.equal(existsSync(inbox), true);
    });
  });

  it("counts without deleting on a dry run", () => {
    withTempDir((dir) => {
      const env = envIn(dir);
      const now = Date.now();
      const inbox = inboxDirPath({ env, targetPane: "%12" })!;
      writeInboxEntry(inbox, entry(ID));
      const old = new Date(now - 2 * DAY_MS);
      utimesSync(join(inbox, `${ID}.json`), old, old);
      const result = pruneInboxes({ env, maxAgeMs: DAY_MS, dryRun: true, now });
      assert.deepEqual(result, { inboxes: 1, entriesDeleted: 1, dirsDeleted: 1 });
      assert.equal(existsSync(join(inbox, `${ID}.json`)), true);
    });
  });
});
