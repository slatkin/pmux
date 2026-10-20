/**
 * Unit tests for the tmux backend.
 *
 * Every tmux call goes through the test seam, so the suite needs no tmux
 * server and never touches a real pane.
 */
import "./host-env.ts";
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  __setTmuxExecForTests__,
  agentPrompt,
  closeSurface,
  createSurface,
  isTmuxAvailable,
  namePane,
  paneExists,
  pollForExit,
  readScreen,
  runInPane,
  sendEscape,
  splitPane,
} from "../pi-extension/pmux/tmux.ts";

/** Record every tmux call and answer with `reply`. */
function stub(reply: (args: string[]) => string): string[][] {
  const calls: string[][] = [];
  __setTmuxExecForTests__((args) => {
    calls.push(args);
    return reply(args);
  });
  return calls;
}

describe("tmux backend", () => {
  afterEach(() => __setTmuxExecForTests__(null));

  it("reports availability from the tmux keys", () => {
    assert.equal(isTmuxAvailable({ TMUX: "/tmp/tmux-0/default", TMUX_PANE: "%3" }), true);
    assert.equal(isTmuxAvailable({ TMUX: "/tmp/tmux-0/default" }), false);
    assert.equal(isTmuxAvailable({ TMUX_PANE: "%3" }), false);
  });

  /** One placement-listing row; an unset `@pmux_parent` leaves an empty field. */
  function row(id: string, width: number, height: number, parent = ""): string {
    return `${id} ${width} ${height} ${parent}`;
  }

  /** Stub the placement listing with `rows`; splits yield `newPane`. */
  function stubPlacement(
    rows: string[],
    options: { newPane?: string; setOptionThrows?: boolean } = {},
  ): string[][] {
    return stub((args) => {
      if (args[0] === "list-panes") return `${rows.join("\n")}\n`;
      if (args[0] === "set-option" && options.setOptionThrows) {
        throw new Error("no such option");
      }
      return options.newPane ?? "%9";
    });
  }

  it("splits the caller's own pane when it has no living child", () => {
    const calls = stubPlacement([row("%3", 200, 50)]);
    const pane = createSurface("Scout", "pane", "%3");
    assert.equal(pane, "%9");
    assert.deepEqual(calls[0], [
      "list-panes",
      "-t",
      "%3",
      "-F",
      "#{pane_id} #{pane_width} #{pane_height} #{@pmux_parent}",
    ]);
    assert.deepEqual(calls[1], ["split-window", "-d", "-h", "-t", "%3", "-P", "-F", "#{pane_id}"]);
    // The caller's pane id, not the new pane's, becomes the parent marker.
    assert.deepEqual(calls[2], ["set-option", "-p", "-t", "%9", "@pmux_parent", "%3"]);
    // The pane is named after the subagent, which tmux shows on the border.
    assert.deepEqual(calls[3], ["select-pane", "-t", "%9", "-T", "Scout"]);
  });

  it("a later child splits the newest living child", () => {
    const calls = stubPlacement([
      row("%3", 200, 50),
      row("%5", 100, 50, "%3"),
      row("%7", 100, 25, "%3"),
    ]);
    createSurface("Scout", "pane", "%3");
    assert.deepEqual(calls[1], ["split-window", "-d", "-h", "-t", "%7", "-P", "-F", "#{pane_id}"]);
  });

  it("orders children by numeric pane id, so %10 is newer than %9", () => {
    const calls = stubPlacement([
      row("%3", 200, 50),
      row("%9", 100, 50, "%3"),
      row("%10", 100, 25, "%3"),
    ]);
    createSurface("Scout", "pane", "%3");
    assert.deepEqual(calls[1], ["split-window", "-d", "-h", "-t", "%10", "-P", "-F", "#{pane_id}"]);
  });

  it("splits the next newest child when the newest is absent from the listing", () => {
    // %7 was closed or moved to another window, so only %5 is listed.
    const calls = stubPlacement([row("%3", 200, 50), row("%5", 100, 50, "%3")]);
    createSurface("Scout", "pane", "%3");
    assert.deepEqual(calls[1], ["split-window", "-d", "-h", "-t", "%5", "-P", "-F", "#{pane_id}"]);
  });

  it("ignores a grandchild row whose @pmux_parent is another pane", () => {
    const calls = stubPlacement([
      row("%3", 200, 50),
      row("%5", 100, 50, "%3"),
      row("%8", 50, 25, "%5"),
    ]);
    createSurface("Scout", "pane", "%3");
    assert.deepEqual(calls[1], ["split-window", "-d", "-h", "-t", "%5", "-P", "-F", "#{pane_id}"]);
  });

  it("splits a wide target side by side", () => {
    const calls = stubPlacement([row("%3", 200, 50)]);
    createSurface("Scout", "pane", "%3");
    assert.equal(calls[1][2], "-h");
  });

  it("stacks below a tall target", () => {
    const calls = stubPlacement([row("%3", 49, 50)]);
    createSurface("Scout", "pane", "%3");
    assert.equal(calls[1][2], "-v");
  });

  it("splits an exact 2:1 target side by side", () => {
    const calls = stubPlacement([row("%3", 100, 50)]);
    createSurface("Scout", "pane", "%3");
    assert.equal(calls[1][2], "-h");
  });

  it("takes the axis from a child target's own shape", () => {
    const calls = stubPlacement([row("%3", 200, 50), row("%5", 49, 50, "%3")]);
    createSurface("Scout", "pane", "%3");
    assert.deepEqual(calls[1], ["split-window", "-d", "-v", "-t", "%5", "-P", "-F", "#{pane_id}"]);
  });

  it("falls back to splitting the caller side by side when the listing fails", () => {
    const calls = stub((args) => {
      if (args[0] === "list-panes") throw new Error("tmux refused");
      return "%9";
    });
    const pane = createSurface("Scout", "pane", "%3");
    assert.equal(pane, "%9");
    assert.deepEqual(calls[1], ["split-window", "-d", "-h", "-t", "%3", "-P", "-F", "#{pane_id}"]);
  });

  it("keeps the new pane when the parentage marker fails", () => {
    const calls = stubPlacement([row("%3", 200, 50)], { setOptionThrows: true });
    const pane = createSurface("Scout", "pane", "%3");
    assert.equal(pane, "%9");
    assert.deepEqual(calls[2], ["set-option", "-p", "-t", "%9", "@pmux_parent", "%3"]);
    // Naming still happens: the pane works, just without the marker.
    assert.deepEqual(calls[3], ["select-pane", "-t", "%9", "-T", "Scout"]);
  });

  it("re-tiles nothing: no layout, swap or resize call", () => {
    const calls = stubPlacement([row("%3", 200, 50), row("%5", 100, 50, "%3")]);
    createSurface("Scout", "pane", "%3");
    for (const call of calls) {
      assert.ok(
        !["select-layout", "swap-pane", "resize-pane"].includes(call[0]),
        `unexpected re-tiling call: ${call.join(" ")}`,
      );
    }
  });

  it("opens a window and restores focus for the tab placement", () => {
    const calls = stub((args) => {
      if (args[0] === "display-message") return args.includes("#{session_id}") ? "$7" : "@4";
      return "%9";
    });
    const pane = createSurface("Scout", "tab", "%3");
    assert.equal(pane, "%9");
    assert.deepEqual(calls[0], ["display-message", "-p", "-t", "%3", "#{session_id}"]);
    assert.deepEqual(calls[1], ["new-window", "-d", "-t", "$7", "-P", "-F", "#{pane_id}"]);
    assert.deepEqual(calls[2], ["display-message", "-p", "-t", "%3", "#{window_id}"]);
    assert.deepEqual(calls[3], ["select-window", "-t", "@4"]);
  });

  it("splits without naming when asked for a bare split", () => {
    const calls = stub(() => "%9");
    assert.equal(splitPane("%3", "down"), "%9");
    assert.deepEqual(calls[0], ["split-window", "-d", "-v", "-t", "%3", "-P", "-F", "#{pane_id}"]);
  });

  it("names a pane", () => {
    const calls = stub(() => "");
    namePane("%9", "Scout");
    assert.deepEqual(calls[0], ["select-pane", "-t", "%9", "-T", "Scout"]);
  });

  it("sends a command line literally and then submits it", () => {
    const calls = stub(() => "");
    runInPane("%9", "node cli.js run /tmp/spec.json");
    assert.deepEqual(calls[0], ["send-keys", "-t", "%9", "-l", "node cli.js run /tmp/spec.json"]);
    assert.deepEqual(calls[1], ["send-keys", "-t", "%9", "Enter"]);
  });

  it("reads the tail of a pane", () => {
    const calls = stub(() => "one\ntwo\nthree");
    assert.equal(readScreen("%9", 2), "two\nthree");
    assert.deepEqual(calls[0], ["capture-pane", "-p", "-t", "%9", "-S", "-2"]);
  });

  it("sends Escape to a pane", () => {
    const calls = stub(() => "");
    sendEscape("%9");
    assert.deepEqual(calls[0], ["send-keys", "-t", "%9", "Escape"]);
  });

  it("closes a pane and tolerates one that is already gone", () => {
    const calls = stub(() => "");
    closeSurface("%9");
    assert.deepEqual(calls[0], ["kill-pane", "-t", "%9"]);

    __setTmuxExecForTests__(() => {
      throw new Error("can't find pane: %9");
    });
    assert.doesNotThrow(() => closeSurface("%9"));
  });

  it("reports whether a pane still exists", () => {
    stub(() => "%9");
    assert.equal(paneExists("%9"), true);
    __setTmuxExecForTests__(() => {
      throw new Error("can't find pane");
    });
    assert.equal(paneExists("%9"), false);
  });

  it("delivers a prompt as literal text and submits it", () => {
    const calls = stub(() => "");
    const result = agentPrompt("%9", "please continue");
    assert.equal(result.submitted, true);
    assert.deepEqual(calls[0], ["send-keys", "-t", "%9", "-l", "please continue"]);
    assert.deepEqual(calls[1], ["send-keys", "-t", "%9", "Enter"]);
  });

  it("returns the done sidecar as the exit result", async () => {
    stub(() => "");
    const dir = mkdtempSync(join(tmpdir(), "pmux-tmux-"));
    const sessionFile = join(dir, "child.jsonl");
    writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
    try {
      const result = await pollForExit("%9", new AbortController().signal, {
        interval: 10,
        sessionFile,
      });
      assert.equal(result.reason, "done");
      assert.equal(result.exitCode, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the error sidecar of a crashed child as the exit result", async () => {
    stub(() => "");
    const dir = mkdtempSync(join(tmpdir(), "pmux-tmux-"));
    const sessionFile = join(dir, "child.jsonl");
    writeFileSync(
      `${sessionFile}.exit`,
      JSON.stringify({
        type: "error",
        errorMessage: "child exited with code 137",
        source: "wrapper",
        exitCode: 137,
      }),
    );
    try {
      const result = await pollForExit("%9", new AbortController().signal, {
        interval: 10,
        sessionFile,
      });
      assert.equal(result.reason, "error");
      assert.equal(result.errorMessage, "child exited with code 137");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the terminal sentinel when the pane is gone", async () => {
    stub((args) => {
      if (args[0] === "capture-pane") return "__SUBAGENT_DONE_3__";
      if (args[0] === "display-message") throw new Error("can't find pane");
      return "";
    });
    const result = await pollForExit("%9", new AbortController().signal, { interval: 10 });
    assert.equal(result.reason, "sentinel");
    assert.equal(result.exitCode, 3);
  });

  it("keeps waiting while the pane is alive, because the match may be echo", async () => {
    stub((args) => {
      if (args[0] === "capture-pane") return "__SUBAGENT_DONE_0__";
      if (args[0] === "display-message") return "%9";
      return "";
    });
    const controller = new AbortController();
    const pending = pollForExit("%9", controller.signal, { interval: 10 });
    controller.abort();
    await assert.rejects(pending, /Aborted/);
  });
});
