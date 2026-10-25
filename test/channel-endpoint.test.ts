/**
 * The channel endpoint client: the path rule against the shared pinned
 * vector, and the request/reply protocol against real Unix sockets in a
 * temp directory — with the connect seam covering the cases no socket
 * should be opened for.
 */
import "./host-env.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHANNEL_TIMEOUT_MS,
  __setChannelConnectForTests__,
  channelEndpointPath,
  submitChannel,
  type ChannelSocket,
} from "../pi-extension/pmux/channel-endpoint.ts";
import { tempDirHelpers } from "./temp-dir.ts";

const { withTempDirAsync } = tempDirHelpers("pmux-channel-");

/** The shared test vector, pinned by both repositories. */
const TMUX = "/tmp/tmux-1000/default,1,0";
const SOCKET_HASH = "79301cf9592f327a";
const TARGET = "%12";

/** A report to a parent pane in the shared vector's environment. */
function channelEnv(dir: string): NodeJS.ProcessEnv {
  return { TMUX, XDG_RUNTIME_DIR: dir };
}

/**
 * The environment of an endpoint that exists: the channel directory is
 * made, because on a real host the endpoint server owns it.
 */
function liveEndpointEnv(dir: string): NodeJS.ProcessEnv {
  mkdirSync(join(dir, "pmux-channel"), { recursive: true });
  return channelEnv(dir);
}

const ID = "ab".repeat(16);
const TOKEN = "cd".repeat(16);
const POINTER = `pmux report ${ID}. Read '/tmp/r.md'. [pmux-eom-${TOKEN}]`;

const BASE_ARGS = {
  to: TARGET,
  id: ID,
  text: POINTER,
  bytes: 42,
  token: TOKEN,
};

interface EndpointHandle {
  /** The request lines the endpoint received, one per line. */
  lines: string[];
  /** The raw request bytes, newline included. */
  raws: Buffer[];
  close(): Promise<void>;
}

/**
 * A real endpoint on `socketPath`. When `reply` returns a string, that line
 * (newline added) is written back to the sender after each request line.
 */
function startEndpoint(
  socketPath: string,
  reply?: (line: string) => string | undefined,
): Promise<EndpointHandle> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    const raws: Buffer[] = [];
    const server: Server = createServer((socket) => {
      let acc = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        acc = Buffer.concat([acc, chunk]);
        let newline = acc.indexOf(0x0a);
        while (newline >= 0) {
          const raw = acc.subarray(0, newline + 1);
          acc = acc.subarray(newline + 1);
          raws.push(raw);
          const line = raw.subarray(0, newline).toString("utf8");
          lines.push(line);
          const text = reply?.(line);
          if (typeof text === "string") socket.write(`${text}\n`);
          newline = acc.indexOf(0x0a);
        }
      });
    });
    server.listen(socketPath, () =>
      resolve({
        lines,
        raws,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      }),
    );
  });
}

describe("channelEndpointPath", () => {
  it("derives the shared vector's path", () => {
    assert.equal(
      channelEndpointPath({
        env: { TMUX, XDG_RUNTIME_DIR: "/run/user/1000" },
        targetPane: TARGET,
      }),
      `/run/user/1000/pmux-channel/${SOCKET_HASH}-12.sock`,
    );
  });

  it("falls back to /tmp/pmux-channel-<uid> without a runtime dir", () => {
    for (const XDG_RUNTIME_DIR of [undefined, ""]) {
      assert.equal(
        channelEndpointPath({
          env: { TMUX, XDG_RUNTIME_DIR },
          targetPane: TARGET,
          uid: 1000,
        }),
        `/tmp/pmux-channel-1000/${SOCKET_HASH}-12.sock`,
      );
    }
  });

  it("names the target pane, not the caller's pane", () => {
    assert.equal(
      channelEndpointPath({
        env: { TMUX, XDG_RUNTIME_DIR: "/run/user/1000", TMUX_PANE: "%30" },
        targetPane: TARGET,
      }),
      `/run/user/1000/pmux-channel/${SOCKET_HASH}-12.sock`,
    );
  });

  it("accepts a target pane without its %", () => {
    assert.equal(
      channelEndpointPath({
        env: { TMUX, XDG_RUNTIME_DIR: "/run/user/1000" },
        targetPane: "12",
      }),
      `/run/user/1000/pmux-channel/${SOCKET_HASH}-12.sock`,
    );
  });

  it("returns no path when TMUX is unset or empty", () => {
    for (const tmux of [undefined, ""]) {
      assert.equal(
        channelEndpointPath({
          env: { TMUX: tmux, XDG_RUNTIME_DIR: "/run/user/1000" },
          targetPane: TARGET,
        }),
        null,
      );
    }
  });
});

describe("submitChannel", () => {
  it("is emitted when the endpoint replies ok", async () => {
    await withTempDirAsync(async (dir) => {
      const socketPath = channelEndpointPath({ env: liveEndpointEnv(dir), targetPane: TARGET });
      assert.ok(socketPath);
      const endpoint = await startEndpoint(socketPath, () => '{"ok":true,"emitted":true}');
      try {
        const result = await submitChannel({ ...BASE_ARGS, env: liveEndpointEnv(dir) });
        assert.deepEqual(result, { status: "emitted" });
      } finally {
        await endpoint.close();
      }
    });
  });

  it("sends exactly one request line with the pointer's fields", async () => {
    await withTempDirAsync(async (dir) => {
      const socketPath = channelEndpointPath({ env: liveEndpointEnv(dir), targetPane: TARGET });
      assert.ok(socketPath);
      const endpoint = await startEndpoint(socketPath, () => '{"ok":true,"emitted":true}');
      try {
        await submitChannel({ ...BASE_ARGS, env: liveEndpointEnv(dir) });

        assert.equal(endpoint.lines.length, 1);
        assert.deepEqual(JSON.parse(endpoint.lines[0]), {
          v: 1,
          kind: "report",
          id: ID,
          text: POINTER,
          bytes: 42,
          token: TOKEN,
        });
        // One line: the JSON text and exactly one terminating newline.
        assert.deepEqual(endpoint.raws[0], Buffer.from(`${endpoint.lines[0]}\n`, "utf8"));
      } finally {
        await endpoint.close();
      }
    });
  });

  it("reads no-endpoint with no TMUX and connects to nothing", async () => {
    let connected = false;
    __setChannelConnectForTests__(async () => {
      connected = true;
      throw new Error("no connection may be attempted without a TMUX socket");
    });
    try {
      const result = await submitChannel({
        ...BASE_ARGS,
        env: { XDG_RUNTIME_DIR: "/run/user/1000" },
      });
      assert.deepEqual(result, { status: "unavailable", reason: "no-endpoint" });
      assert.equal(connected, false);
    } finally {
      __setChannelConnectForTests__(null);
    }
  });

  it("reads no-endpoint when the endpoint file does not exist", async () => {
    await withTempDirAsync(async (dir) => {
      const result = await submitChannel({ ...BASE_ARGS, env: liveEndpointEnv(dir) });
      assert.deepEqual(result, { status: "unavailable", reason: "no-endpoint" });
    });
  });

  it("reads refused on a stale socket file", async () => {
    await withTempDirAsync(async (dir) => {
      const socketPath = channelEndpointPath({ env: liveEndpointEnv(dir), targetPane: TARGET });
      assert.ok(socketPath);
      // A path that exists but listens to nothing: the connect is refused.
      writeFileSync(socketPath, "");
      const result = await submitChannel({ ...BASE_ARGS, env: liveEndpointEnv(dir) });
      assert.deepEqual(result, { status: "unavailable", reason: "refused" });
    });
  });

  it("reads unarmed", async () => {
    await withTempDirAsync(async (dir) => {
      const socketPath = channelEndpointPath({ env: liveEndpointEnv(dir), targetPane: TARGET });
      assert.ok(socketPath);
      const endpoint = await startEndpoint(socketPath, () => '{"ok":false,"reason":"unarmed"}');
      try {
        const result = await submitChannel({ ...BASE_ARGS, env: liveEndpointEnv(dir) });
        assert.deepEqual(result, { status: "unavailable", reason: "unarmed" });
      } finally {
        await endpoint.close();
      }
    });
  });

  it("reads invalid", async () => {
    await withTempDirAsync(async (dir) => {
      const socketPath = channelEndpointPath({ env: liveEndpointEnv(dir), targetPane: TARGET });
      assert.ok(socketPath);
      const endpoint = await startEndpoint(socketPath, () => '{"ok":false,"reason":"invalid"}');
      try {
        const result = await submitChannel({ ...BASE_ARGS, env: liveEndpointEnv(dir) });
        assert.deepEqual(result, { status: "unavailable", reason: "invalid" });
      } finally {
        await endpoint.close();
      }
    });
  });

  it("reads bad-reply on a line that is not one of the valid shapes", async () => {
    await withTempDirAsync(async (dir) => {
      const socketPath = channelEndpointPath({ env: liveEndpointEnv(dir), targetPane: TARGET });
      assert.ok(socketPath);
      for (const reply of [
        "not json",
        '{"ok":true,"emitted":false}',
        '{"ok":false,"reason":"mystery"}',
      ]) {
        const endpoint = await startEndpoint(socketPath, () => reply);
        try {
          const result = await submitChannel({ ...BASE_ARGS, env: liveEndpointEnv(dir) });
          assert.deepEqual(result, { status: "unavailable", reason: "bad-reply" }, reply);
        } finally {
          await endpoint.close();
        }
      }
    });
  });

  it("reads timeout when the endpoint never replies", async () => {
    // A connected endpoint that says nothing — injected through the seam, no
    // real socket: the budget runs out without waiting the real 2 seconds.
    const silent: ChannelSocket = {
      write: () => undefined,
      on: (_event, _listener) => undefined,
      destroy: () => undefined,
    };
    __setChannelConnectForTests__(async () => silent);
    try {
      await withTempDirAsync(async (dir) => {
        const socketPath = channelEndpointPath({ env: liveEndpointEnv(dir), targetPane: TARGET });
        assert.ok(socketPath);
        writeFileSync(socketPath, "");
        const start = Date.now();
        const result = await submitChannel({
          ...BASE_ARGS,
          env: liveEndpointEnv(dir),
          timeoutMs: 50,
        });
        assert.deepEqual(result, { status: "unavailable", reason: "timeout" });
        assert.ok(Date.now() - start < CHANNEL_TIMEOUT_MS);
      });
    } finally {
      __setChannelConnectForTests__(null);
    }
  });

  it("reads write-failed when the write never lands", async () => {
    let failWrite: ((err: Error | null | undefined) => void) | undefined;
    const broken: ChannelSocket = {
      write: (_chunk, cb) => {
        failWrite = cb;
        return undefined;
      },
      on: (_event, _listener) => undefined,
      destroy: () => undefined,
    };
    __setChannelConnectForTests__(async () => broken);
    try {
      await withTempDirAsync(async (dir) => {
        const socketPath = channelEndpointPath({ env: liveEndpointEnv(dir), targetPane: TARGET });
        assert.ok(socketPath);
        writeFileSync(socketPath, "");
        const pending = submitChannel({ ...BASE_ARGS, env: liveEndpointEnv(dir), timeoutMs: 500 });
        // The write callback is captured during the connect turn; fail it
        // once it is there.
        await new Promise((done) => setTimeout(done, 10));
        failWrite?.(new Error("EPIPE"));
        assert.deepEqual(await pending, { status: "unavailable", reason: "write-failed" });
      });
    } finally {
      __setChannelConnectForTests__(null);
    }
  });
});
