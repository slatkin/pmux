/**
 * The report artifacts under `file-ack-v1`: fresh 32-hex IDs, an immutable
 * `<session>.<id>.report.md` written through a `.report.md` temporary, and
 * the one-line pointer with its `pmux-eom-<token>` tail.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pruneScratch } from "../pi-extension/pmux/prune.ts";
import {
  buildReportPointer,
  isReportId,
  newReportId,
  newVisibilityToken,
  reportArtifactPath,
  writeReportArtifact,
  VISIBILITY_TOKEN_PREFIX,
} from "../pi-extension/pmux/report-artifact.ts";
import { tempDirHelpers } from "./temp-dir.ts";

const { withTempDir } = tempDirHelpers("pmux-artifact-");

describe("report ids", () => {
  it("mints 32 lowercase hex characters", () => {
    const id = newReportId();
    assert.equal(id.length, 32);
    assert.match(id, /^[0-9a-f]{32}$/);
    assert.equal(isReportId(id), true);
    assert.equal(isReportId(newVisibilityToken()), true);
    assert.equal(isReportId("hello"), false);
    assert.equal(isReportId(id.toUpperCase()), false);
    assert.equal(isReportId(undefined), false);
  });

  it("mints distinct IDs, so concurrent sends never share a file", () => {
    const ids = new Set(Array.from({ length: 64 }, () => newReportId()));
    assert.equal(ids.size, 64);
  });
});

describe("reportArtifactPath", () => {
  it("names the artifact <session>.<id>.report.md", () => {
    assert.equal(
      reportArtifactPath("/s/w.jsonl", "ab".repeat(16)),
      `/s/w.jsonl.${"ab".repeat(16)}.report.md`,
    );
  });
});

describe("writeReportArtifact", () => {
  it("stores UTF-8 and multiline bodies exactly as received", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "session.jsonl");
      const body = "line one\nline two — naïve 🌍\n\ntrailing\n";
      const artifact = writeReportArtifact(sessionFile, body);
      assert.equal(artifact.reportPath, reportArtifactPath(sessionFile, artifact.id));
      // No pane-input encoding: the newline and the non-ASCII bytes land as
      // they were received, so the parent reads the report verbatim.
      assert.equal(readFileSync(artifact.reportPath, "utf8"), body);
    });
  });

  it("mints a fresh ID per write, so concurrent reports coexist", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "session.jsonl");
      const first = writeReportArtifact(sessionFile, "one");
      const second = writeReportArtifact(sessionFile, "two");
      assert.notEqual(first.id, second.id);
      assert.notEqual(first.reportPath, second.reportPath);
      assert.equal(readFileSync(first.reportPath, "utf8"), "one");
      assert.equal(readFileSync(second.reportPath, "utf8"), "two");
    });
  });

  it("leaves no temporary behind once the rename lands", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "session.jsonl");
      const artifact = writeReportArtifact(sessionFile, "body");
      assert.deepEqual(readdirSync(dir).sort(), [artifact.reportPath.slice(dir.length + 1)]);
    });
  });

  it("names its temporary so prune reclaims an abandoned write", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "session.jsonl");
      // A write abandoned between the temp create and the rename leaves a
      // `<session>.<id>.tmp-<random>.report.md`; its `.report.md` suffix puts
      // it under the same prune rule as the artifacts themselves.
      const abandoned = `${sessionFile}.${newReportId()}.tmp-deadbeef.report.md`;
      writeFileSync(abandoned, "partial");
      const artifact = writeReportArtifact(sessionFile, "whole");
      const result = pruneScratch(dir, { maxAgeMs: 0, now: Date.now() + 60_000 });
      assert.deepEqual(result.deleted.sort(), [abandoned, artifact.reportPath].sort());
    });
  });

  it("throws before producing an artifact when the write fails", () => {
    withTempDir((dir) => {
      // A session file inside a missing directory makes the temp create
      // fail: the send refuses before the pane is ever touched.
      const sessionFile = join(dir, "missing", "session.jsonl");
      assert.throws(() => writeReportArtifact(sessionFile, "body"));
      assert.equal(existsSync(join(dir, "missing")), false);
    });
  });
});

describe("buildReportPointer", () => {
  it("builds the one-line pointer naming the file, the ack command and the token", () => {
    const id = "ab".repeat(16);
    const { text, token } = buildReportPointer({
      id,
      reportPath: "/tmp/pmux/w.jsonl." + id + ".report.md",
      sessionFile: "/tmp/pmux/w.jsonl",
      cliPath: "/opt/pmux/cli.ts",
    });
    assert.match(token, /^[0-9a-f]{32}$/);
    assert.equal(
      text,
      `pmux report ${id}. Read '/tmp/pmux/w.jsonl.${id}.report.md', then run: ` +
        `node '/opt/pmux/cli.ts' ack --session '/tmp/pmux/w.jsonl' --id ${id}. ` +
        `Acknowledge only after reading. [${VISIBILITY_TOKEN_PREFIX}${token}]`,
    );
    // The pointer is one input: no report body, no newline.
    assert.ok(!text.includes("\n"));
  });

  it("shell-quotes paths that hold spaces and quotes", () => {
    const id = "cd".repeat(16);
    const { text } = buildReportPointer({
      id,
      reportPath: "/tmp/my dir/w.jsonl." + id + ".report.md",
      sessionFile: "/tmp/it's a session/w.jsonl",
      cliPath: "/opt/pmux dir/cli.ts",
    });
    assert.ok(text.includes(`Read '/tmp/my dir/w.jsonl.${id}.report.md'`));
    // An embedded single quote comes out as '\'' so the command still parses.
    assert.ok(text.includes("--session '/tmp/it'\\''s a session/w.jsonl'"));
    assert.ok(text.includes("node '/opt/pmux dir/cli.ts'"));
  });

  it("mints a fresh token per build while the report ID stays stable", () => {
    const id = "ef".repeat(16);
    const args = {
      id,
      reportPath: `/s/w.jsonl.${id}.report.md`,
      sessionFile: "/s/w.jsonl",
      cliPath: "/cli.ts",
    };
    const first = buildReportPointer(args);
    const second = buildReportPointer(args);
    assert.notEqual(first.token, second.token);
    assert.notEqual(first.text, second.text);
    // The ID is stable, so a re-delivered pointer still names the same report.
    for (const pointer of [first, second]) {
      assert.ok(pointer.text.startsWith(`pmux report ${id}.`));
      assert.ok(pointer.text.endsWith(`[pmux-eom-${pointer.token}]`));
    }
  });
});
