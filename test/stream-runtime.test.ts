/**
 * Unit tests for the reload handover of the `/stream` runtime: the module that
 * a reload replaces must close the panes it opened, its hub and its installed
 * projection, and it must finish that teardown even when one part is gone.
 */
import "./host-env.ts";
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { retireStreamRuntime, type StreamRuntime } from "../pi-extension/luvus/index.ts";
import { __setTmuxExecForTests__ } from "../pi-extension/luvus/tmux.ts";
import type { StreamHub } from "../pi-extension/luvus/stream-state.ts";

describe("stream runtime reload teardown", () => {
  afterEach(() => __setTmuxExecForTests__(null));

  test("closes the panes, the hub and the projection of the previous load", () => {
    const closedPanes: string[] = [];
    __setTmuxExecForTests__((args) => {
      if (args[0] === "kill-pane") closedPanes.push(args[2]);
      return "";
    });

    let hubClosed = false;
    let projectionUninstalled = false;
    const previous: StreamRuntime = {
      hub: {
        close: async () => {
          hubClosed = true;
        },
      } as unknown as StreamHub,
      panes: new Map([
        ["thinking", "%101"],
        ["tools", "%102"],
      ]),
      projection: {
        uninstall: () => {
          projectionUninstalled = true;
        },
      } as any,
      tui: {},
    };

    retireStreamRuntime(previous);

    assert.deepEqual(closedPanes, ["%101", "%102"]);
    assert.equal(hubClosed, true);
    assert.equal(projectionUninstalled, true);
    assert.equal(previous.panes.size, 0);
    assert.equal(previous.hub, undefined);
  });

  test("keeps retiring the rest when one pane is already gone", () => {
    const closedPanes: string[] = [];
    __setTmuxExecForTests__((args) => {
      if (args[0] === "kill-pane") {
        if (args[2] === "%101") throw new Error("can't find pane: %101");
        closedPanes.push(args[2]);
      }
      return "";
    });

    const previous: StreamRuntime = {
      panes: new Map([
        ["thinking", "%101"],
        ["tools", "%102"],
      ]),
    };

    assert.doesNotThrow(() => retireStreamRuntime(previous));
    assert.deepEqual(closedPanes, ["%102"]);
  });

  test("accepts a missing previous runtime", () => {
    assert.doesNotThrow(() => retireStreamRuntime(undefined));
  });
});
