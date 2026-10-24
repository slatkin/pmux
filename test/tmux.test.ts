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
  readPaneOption,
  readScreen,
  runInPane,
  sendEscape,
  splitPane,
  verifiedAgentPrompt,
  VERIFIED_PROMPT_POLL_MS,
} from "../pi-extension/pmux/tmux.ts";
import { argValue, placementRow } from "./tmux-fakes.ts";

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

  /** Stub the placement listing with `rows`; splits yield `%9`. */
  function stubPlacement(rows: string[], options: { setOptionThrows?: boolean } = {}): string[][] {
    return stub((args) => {
      if (args[0] === "list-panes") return `${rows.join("\n")}\n`;
      if (args[0] === "set-option" && options.setOptionThrows) {
        throw new Error("no such option");
      }
      return "%9";
    });
  }

  it("splits the caller's own pane when it has no living child", () => {
    const calls = stubPlacement([placementRow("%3", 200, 50)]);
    const pane = createSurface("Scout", "pane", "%3");
    assert.equal(pane, "%9");
    assert.deepEqual(calls[0], [
      "list-panes",
      "-t",
      "%3",
      "-F",
      "#{pane_id} #{pane_width} #{pane_height} #{pane_floating_flag} #{pane_left} " +
        "#{pane_top} #{window_width} #{window_height} #{pane-border-lines} #{@pmux_parent}",
    ]);
    assert.deepEqual(calls[1], ["split-window", "-d", "-h", "-t", "%3", "-P", "-F", "#{pane_id}"]);
    // The caller's pane id, not the new pane's, becomes the parent marker.
    assert.deepEqual(calls[2], ["set-option", "-p", "-t", "%9", "@pmux_parent", "%3"]);
    // The pane is named after the subagent, which tmux shows on the border.
    assert.deepEqual(calls[3], ["select-pane", "-t", "%9", "-T", "Scout"]);
  });

  it("a later child splits the newest living child", () => {
    const calls = stubPlacement([
      placementRow("%3", 200, 50),
      placementRow("%5", 100, 50, "%3"),
      placementRow("%7", 100, 25, "%3"),
    ]);
    createSurface("Scout", "pane", "%3");
    assert.deepEqual(calls[1], ["split-window", "-d", "-h", "-t", "%7", "-P", "-F", "#{pane_id}"]);
  });

  it("orders children by numeric pane id, so %10 is newer than %9", () => {
    const calls = stubPlacement([
      placementRow("%3", 200, 50),
      placementRow("%9", 100, 50, "%3"),
      placementRow("%10", 100, 25, "%3"),
    ]);
    createSurface("Scout", "pane", "%3");
    assert.deepEqual(calls[1], ["split-window", "-d", "-h", "-t", "%10", "-P", "-F", "#{pane_id}"]);
  });

  it("splits the next newest child when the newest is absent from the listing", () => {
    // %7 was closed or moved to another window, so only %5 is listed.
    const calls = stubPlacement([placementRow("%3", 200, 50), placementRow("%5", 100, 50, "%3")]);
    createSurface("Scout", "pane", "%3");
    assert.deepEqual(calls[1], ["split-window", "-d", "-h", "-t", "%5", "-P", "-F", "#{pane_id}"]);
  });

  it("ignores a grandchild row whose @pmux_parent is another pane", () => {
    const calls = stubPlacement([
      placementRow("%3", 200, 50),
      placementRow("%5", 100, 50, "%3"),
      placementRow("%8", 50, 25, "%5"),
    ]);
    createSurface("Scout", "pane", "%3");
    assert.deepEqual(calls[1], ["split-window", "-d", "-h", "-t", "%5", "-P", "-F", "#{pane_id}"]);
  });

  it("stacks below a tall target", () => {
    const calls = stubPlacement([placementRow("%3", 49, 50)]);
    createSurface("Scout", "pane", "%3");
    assert.equal(calls[1][2], "-v");
  });

  it("splits an exact 2:1 target side by side", () => {
    const calls = stubPlacement([placementRow("%3", 100, 50)]);
    createSurface("Scout", "pane", "%3");
    assert.equal(calls[1][2], "-h");
  });

  it("takes the axis from a child target's own shape", () => {
    const calls = stubPlacement([placementRow("%3", 200, 50), placementRow("%5", 49, 50, "%3")]);
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
    const calls = stubPlacement([placementRow("%3", 200, 50)], { setOptionThrows: true });
    const pane = createSurface("Scout", "pane", "%3");
    assert.equal(pane, "%9");
    assert.deepEqual(calls[2], ["set-option", "-p", "-t", "%9", "@pmux_parent", "%3"]);
    // Naming still happens: the pane works, just without the marker.
    assert.deepEqual(calls[3], ["select-pane", "-t", "%9", "-T", "Scout"]);
  });

  it("re-tiles nothing: no layout, swap or resize call", () => {
    const calls = stubPlacement([placementRow("%3", 200, 50), placementRow("%5", 100, 50, "%3")]);
    createSurface("Scout", "pane", "%3");
    for (const call of calls) {
      assert.ok(
        !["select-layout", "swap-pane", "resize-pane"].includes(call[0]),
        `unexpected re-tiling call: ${call.join(" ")}`,
      );
    }
  });

  it("does not split a floating child", () => {
    const calls = stubPlacement([
      placementRow("%3", 200, 50),
      placementRow("%5", 100, 50, "%3"),
      placementRow("%7", 98, 23, "%3", { floating: 1, left: 99, top: 2 }),
    ]);
    createSurface("Scout", "pane", "%3");
    assert.deepEqual(calls[1], ["split-window", "-d", "-h", "-t", "%5", "-P", "-F", "#{pane_id}"]);
  });

  it("opens the first float half the window, two columns from the right edge", () => {
    const calls = stubPlacement([placementRow("%3", 200, 50)]);
    createSurface("Scout", "float", "%3");
    assert.deepEqual(calls[1], [
      "new-pane",
      "-d",
      "-t",
      "%3",
      "-x",
      "100",
      "-y",
      "25",
      "-X",
      "98",
      "-Y",
      "1",
      "-P",
      "-F",
      "#{pane_id}",
    ]);
  });

  it("cascades the second float one row down and two columns left", () => {
    // The first float's outer box (-x 100 -y 25 -X 98 -Y 1) shows up in the
    // listing as pane_left 99, pane_top 2 with the default border.
    const calls = stubPlacement([
      placementRow("%3", 200, 50),
      placementRow("%12", 98, 23, "%3", { floating: 1, left: 99, top: 2 }),
    ]);
    createSurface("Scout", "float", "%3");
    assert.equal(argValue(calls[1], "-X"), "96");
    assert.equal(argValue(calls[1], "-Y"), "2");
  });

  it("cascades from the remaining newest float when the newest was closed", () => {
    // Unlike the second-float test above, the newest float (%12, the first
    // one spawned) is absent from the listing because it was closed, so the
    // cascade starts from the remaining newest one (%10) at its own position.
    const calls = stubPlacement([
      placementRow("%3", 200, 50),
      placementRow("%10", 98, 23, "%3", { floating: 1, left: 55, top: 7 }),
    ]);
    createSurface("Scout", "float", "%3");
    assert.equal(argValue(calls[1], "-X"), "52");
    assert.equal(argValue(calls[1], "-Y"), "7");
  });

  it("cascades from a moved float at its current position", () => {
    const calls = stubPlacement([
      placementRow("%3", 200, 50),
      placementRow("%12", 98, 23, "%3", { floating: 1, left: 41, top: 11 }),
    ]);
    createSurface("Scout", "float", "%3");
    assert.equal(argValue(calls[1], "-X"), "38");
    assert.equal(argValue(calls[1], "-Y"), "11");
  });

  it("takes a borderless float's pane_left and pane_top as the outer corner", () => {
    const calls = stubPlacement([
      placementRow("%3", 200, 50),
      placementRow("%12", 100, 25, "%3", { floating: 1, left: 41, top: 11, border: "none" }),
    ]);
    createSurface("Scout", "float", "%3");
    assert.equal(argValue(calls[1], "-X"), "39");
    assert.equal(argValue(calls[1], "-Y"), "12");
  });

  it("wraps to the first-float position when the cascade leaves the window", () => {
    // A bottom border past the last row: row 30 + height 25 > 50.
    const bottom = stubPlacement([
      placementRow("%3", 200, 50),
      placementRow("%12", 98, 23, "%3", { floating: 1, left: 99, top: 30 }),
    ]);
    createSurface("Scout", "float", "%3");
    assert.equal(argValue(bottom[1], "-X"), "98");
    assert.equal(argValue(bottom[1], "-Y"), "1");

    // A next column past the left edge: 2 - 1 - 2 < 0.
    const left = stubPlacement([
      placementRow("%3", 200, 50),
      placementRow("%12", 98, 23, "%3", { floating: 1, left: 2, top: 2 }),
    ]);
    createSurface("Scout", "float", "%3");
    assert.equal(argValue(left[1], "-X"), "98");
    assert.equal(argValue(left[1], "-Y"), "1");
  });

  it("ignores a float pmux did not open", () => {
    const calls = stubPlacement([
      placementRow("%3", 200, 50),
      placementRow("%12", 98, 23, "", { floating: 1, left: 99, top: 2 }),
    ]);
    createSurface("Scout", "float", "%3");
    assert.equal(argValue(calls[1], "-X"), "98");
    assert.equal(argValue(calls[1], "-Y"), "1");
  });

  it("cascades from a float another caller opened", () => {
    const calls = stubPlacement([
      placementRow("%3", 200, 50),
      placementRow("%12", 98, 23, "%4", { floating: 1, left: 99, top: 2 }),
    ]);
    createSurface("Scout", "float", "%3");
    assert.equal(argValue(calls[1], "-X"), "96");
    assert.equal(argValue(calls[1], "-Y"), "2");
  });

  it("tags the float with @pmux_parent and names it", () => {
    const calls = stubPlacement([placementRow("%3", 200, 50)]);
    createSurface("Scout", "float", "%3");
    assert.deepEqual(calls[2], ["set-option", "-p", "-t", "%9", "@pmux_parent", "%3"]);
    assert.deepEqual(calls[3], ["select-pane", "-t", "%9", "-T", "Scout"]);
  });

  it("splits a floating caller for the pane placement", () => {
    const calls = stubPlacement([
      placementRow("%3", 100, 25, "", { floating: 1, left: 50, top: 10 }),
    ]);
    createSurface("Scout", "pane", "%3");
    assert.deepEqual(calls[1], ["split-window", "-d", "-h", "-t", "%3", "-P", "-F", "#{pane_id}"]);
  });

  it("re-tiles nothing for a float: no layout, swap or resize call", () => {
    const calls = stubPlacement([
      placementRow("%3", 200, 50),
      placementRow("%5", 100, 50, "%3"),
      placementRow("%12", 98, 23, "%3", { floating: 1, left: 99, top: 2 }),
    ]);
    createSurface("Scout", "float", "%3");
    for (const call of calls) {
      assert.ok(
        !["select-layout", "swap-pane", "resize-pane"].includes(call[0]),
        `unexpected re-tiling call: ${call.join(" ")}`,
      );
    }
  });

  it("fails the float when the window listing fails", () => {
    stub((args) => {
      if (args[0] === "list-panes") throw new Error("tmux refused");
      return "%9";
    });
    assert.throws(() => createSurface("Scout", "float", "%3"), /window listing failed/);
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

  it("reads a pane option with show -pv", () => {
    const calls = stub((args) => {
      assert.deepEqual(args, ["show", "-pv", "-t", "%3", "@pane_session_id"]);
      return "sess-abc";
    });
    assert.equal(readPaneOption("%3", "@pane_session_id"), "sess-abc");
    assert.equal(calls.length, 1);
  });

  it("reads a pane option as null when the pane has none", () => {
    const calls = stub((args) => {
      assert.deepEqual(args, ["show", "-pv", "-t", "%3", "@pane_session_id"]);
      return "";
    });
    assert.equal(readPaneOption("%3", "@pane_session_id"), null);
    assert.equal(calls.length, 1);
  });

  it("reads a pane option as null when the read fails", () => {
    const calls = stub((args) => {
      assert.deepEqual(args, ["show", "-pv", "-t", "%3", "@pane_session_id"]);
      throw new Error("can't find pane: %3");
    });
    assert.equal(readPaneOption("%3", "@pane_session_id"), null);
    assert.equal(calls.length, 1);
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

  it("ends the poll on a cancelled sidecar", async () => {
    stub(() => "");
    const dir = mkdtempSync(join(tmpdir(), "pmux-tmux-"));
    const sessionFile = join(dir, "child.jsonl");
    writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "cancelled" }));
    try {
      const result = await pollForExit("%9", new AbortController().signal, {
        interval: 10,
        sessionFile,
      });
      assert.equal(result.reason, "cancelled");
      assert.equal(result.exitCode, 0);
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

describe("verifiedAgentPrompt", () => {
  afterEach(() => __setTmuxExecForTests__(null));

  const TOKEN = "ab".repeat(16);
  const TEXT = `pmux report ${"cd".repeat(16)}. Read '/s/w.report.md'. [pmux-eom-${TOKEN}]`;

  /** A clock the injected sleep advances, so the 2 s poll runs instantly. */
  function fakeClock() {
    let t = 0;
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
      elapsed: () => t,
    };
  }

  interface FakePane {
    calls: string[][];
    /** The current `#{pane_in_mode}` answer. */
    mode: string;
    /** The current visible screen content. */
    screen: string;
  }

  /**
   * Stub the pane the verified input talks to: `display-message` answers
   * `pane_in_mode`, `capture-pane` answers the visible screen, `send-keys`
   * is recorded. `onCall` runs after each answer so a test can flip the
   * mode or the screen mid-sequence.
   */
  function fakePane(hooks: { onCall?: (args: string[], pane: FakePane) => void } = {}): FakePane {
    const pane: FakePane = { calls: [], mode: "0", screen: "" };
    __setTmuxExecForTests__((args) => {
      pane.calls.push(args);
      // The hook runs before the answer so it can flip the mode or the
      // screen the call itself answers with — or throw the call away.
      hooks.onCall?.(args, pane);
      if (args[0] === "display-message") {
        assert.deepEqual(args, ["display-message", "-p", "-t", "%9", "#{pane_in_mode}"]);
        return `${pane.mode}\n`;
      }
      if (args[0] === "capture-pane") {
        // The visible pane only: a `-S` flag would read scrollback.
        assert.deepEqual(args, ["capture-pane", "-p", "-t", "%9"]);
        return pane.screen;
      }
      return "";
    });
    return pane;
  }

  /** Every `send-keys` call the stub recorded. */
  function sentKeys(calls: string[][]): string[][] {
    return calls.filter((args) => args[0] === "send-keys");
  }

  /**
   * The only permitted inputs are the literal typing and the one Enter: no
   * Escape, Ctrl-U or other editing key may ever reach the target pane.
   */
  function assertNoEditingKeys(calls: string[][]): void {
    for (const args of sentKeys(calls)) {
      const isTyping = args[3] === "-l";
      const isEnter = args.length === 4 && args[3] === "Enter";
      assert.ok(isTyping || isEnter, `editing key reached the pane: ${args.join(" ")}`);
    }
  }

  it("refuses a pane in a mode without touching it", async () => {
    const pane = fakePane();
    pane.mode = "1";
    const result = await verifiedAgentPrompt("%9", TEXT, TOKEN, fakeClock());
    assert.equal(result.status, "not-submitted");
    assert.equal(result.submitted, false);
    assert.equal(result.enterAttempted, false);
    // No capture, no input, no Enter.
    assert.equal(pane.calls.length, 1);
    assert.equal(pane.calls[0]![0], "display-message");
  });

  it("refuses when the token is already on the visible screen", async () => {
    const pane = fakePane();
    pane.screen = `old pointer [pmux-eom-${TOKEN}]`;
    const result = await verifiedAgentPrompt("%9", TEXT, TOKEN, fakeClock());
    assert.equal(result.status, "not-submitted");
    assert.equal(sentKeys(pane.calls).length, 0);
  });

  it("types, polls once, rechecks and sends exactly one Enter", async () => {
    const clock = fakeClock();
    const pane = fakePane({
      onCall: (args, p) => {
        // The TUI echoes the typed line: the token appears with the text.
        if (args[0] === "send-keys" && args.includes("-l")) p.screen = TEXT;
      },
    });
    const result = await verifiedAgentPrompt("%9", TEXT, TOKEN, clock);
    assert.equal(result.status, "submitted");
    assert.equal(result.submitted, true);
    assert.equal(result.enterAttempted, true);

    const sequence = pane.calls.map((args) => args[0]);
    assert.deepEqual(sequence, [
      "display-message", // baseline mode
      "capture-pane", // baseline screen
      "send-keys", // the literal typing
      "display-message", // poll: mode
      "capture-pane", // poll: token seen
      "display-message", // recheck: mode
      "capture-pane", // recheck: token still there
      "send-keys", // the one Enter
    ]);
    const keys = sentKeys(pane.calls);
    assert.equal(keys.length, 2);
    assert.deepEqual(keys[0], ["send-keys", "-t", "%9", "-l", TEXT]);
    assert.deepEqual(keys[1], ["send-keys", "-t", "%9", "Enter"]);
    assertNoEditingKeys(pane.calls);
  });

  it("returns not-submitted when the token never appears, after about 2 s", async () => {
    const clock = fakeClock();
    const sleeps: number[] = [];
    const pane = fakePane();
    const result = await verifiedAgentPrompt("%9", TEXT, TOKEN, {
      now: clock.now,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock.sleep(ms);
      },
    });
    assert.equal(result.status, "not-submitted");
    assert.equal(result.enterAttempted, false);
    // The typing went out, the Enter never did, and the poll gave up at the
    // 2 s deadline.
    const keys = sentKeys(pane.calls);
    assert.equal(keys.length, 1);
    assert.deepEqual(keys[0], ["send-keys", "-t", "%9", "-l", TEXT]);
    assert.equal(clock.elapsed(), 2000);
    // Every poll sleeps the 100 ms cadence design D4 names.
    assert.ok(
      sleeps.length > 0 && sleeps.every((ms) => ms === VERIFIED_PROMPT_POLL_MS),
      `poll sleeps should all be ${VERIFIED_PROMPT_POLL_MS} ms, got ${sleeps.join(",")}`,
    );
    assertNoEditingKeys(pane.calls);
  });

  it("returns not-submitted when the pane enters a mode mid-poll, text left alone", async () => {
    const clock = fakeClock();
    let polls = 0;
    const pane = fakePane({
      onCall: (args, p) => {
        if (args[0] === "display-message" && p.calls.length > 3) {
          polls += 1;
          if (polls === 2) p.mode = "1"; // enters copy mode after two polls
        }
      },
    });
    const result = await verifiedAgentPrompt("%9", TEXT, TOKEN, clock);
    assert.equal(result.status, "not-submitted");
    assert.equal(result.enterAttempted, false);
    // The typed text stays: no Enter and no editing key follows the refusal.
    assert.equal(sentKeys(pane.calls).length, 1);
    assertNoEditingKeys(pane.calls);
  });

  it("returns not-submitted when the token leaves the screen at the recheck", async () => {
    const clock = fakeClock();
    let tokenSeen = false;
    const pane = fakePane({
      onCall: (args, p) => {
        if (args[0] === "send-keys" && args.includes("-l")) p.screen = TEXT;
        // The token shows during the poll, then scrolls off before Enter.
        if (args[0] === "capture-pane" && p.screen === TEXT) {
          if (tokenSeen) p.screen = "prompt>";
          tokenSeen = true;
        }
      },
    });
    const result = await verifiedAgentPrompt("%9", TEXT, TOKEN, clock);
    assert.equal(result.status, "not-submitted");
    assert.equal(result.enterAttempted, false);
    assert.equal(sentKeys(pane.calls).length, 1);
    assertNoEditingKeys(pane.calls);
  });

  it("returns unknown when the Enter throws, and never retries it", async () => {
    const clock = fakeClock();
    const pane = fakePane({
      onCall: (args, p) => {
        if (args[0] === "send-keys" && args.includes("-l")) p.screen = TEXT;
        if (args[0] === "send-keys" && args.includes("Enter")) {
          throw new Error("can't find pane: %9");
        }
      },
    });
    const result = await verifiedAgentPrompt("%9", TEXT, TOKEN, clock);
    assert.equal(result.status, "unknown");
    assert.equal(result.submitted, false);
    assert.equal(result.enterAttempted, true);
    assert.match(result.error ?? "", /can't find pane/);
    // Exactly one Enter was attempted; no post-Enter capture ran.
    const enters = sentKeys(pane.calls).filter((args) => args[3] === "Enter");
    assert.equal(enters.length, 1);
    assert.equal(pane.calls.at(-1)![3], "Enter");
    assertNoEditingKeys(pane.calls);
  });

  it("refuses cleanly when the baseline checks throw", async () => {
    const clock = fakeClock();
    const pane = fakePane({
      onCall: (args) => {
        if (args[0] === "display-message") throw new Error("can't find pane: %9");
      },
    });
    const result = await verifiedAgentPrompt("%9", TEXT, TOKEN, clock);
    assert.equal(result.status, "not-submitted");
    assert.equal(result.enterAttempted, false);
    assert.equal(sentKeys(pane.calls).length, 0);
  });

  it("refuses when the typing call throws, and never sends the Enter", async () => {
    const clock = fakeClock();
    const pane = fakePane({
      onCall: (args) => {
        if (args[0] === "send-keys" && args.includes("-l")) {
          throw new Error("can't find pane: %9");
        }
      },
    });
    const result = await verifiedAgentPrompt("%9", TEXT, TOKEN, clock);
    assert.equal(result.status, "not-submitted");
    assert.equal(result.enterAttempted, false);
    // The failed typing is the only send-keys call: no Enter followed it.
    const keys = sentKeys(pane.calls);
    assert.equal(keys.length, 1);
    assert.deepEqual(keys[0], ["send-keys", "-t", "%9", "-l", TEXT]);
    assertNoEditingKeys(pane.calls);
  });
});
