/**
 * The channel endpoint client (designs D1–D4): how a marked report pointer
 * reaches the parent's Claude channel over a Unix socket, and how the reply
 * is read.
 *
 * The endpoint is a Unix socket that the parent's Claude Code session owns
 * through the pmux-explorer channel server. Its path comes from the tmux
 * socket path and the target pane id, so both sides — the sender here, the
 * server that inherits `TMUX` from the Claude process — compute the same
 * path with no registry and no lookup. The FNV-1a 64 hash of the socket
 * path keeps the full path under the 108-byte Unix-socket limit and keeps
 * two tmux servers apart; the directory is 0700-owner-only, so the socket
 * adds no reach beyond what `send-keys` already has.
 *
 * The client sends one JSON request line and reads one JSON reply line. The
 * endpoint replies `unarmed` until Claude has proved the channel path by
 * answering the arm probe, so "the socket accepted the request" alone
 * proves nothing (design D2). `emitted` — the only positive result — still
 * is not a read receipt: the parent's `ack` stays the only one (design D4).
 */
import { connect as netConnect } from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type ChannelUnavailableReason } from "./channel-reason.ts";

/** The hard budget for the connect, the write and the reply together. */
export const CHANNEL_TIMEOUT_MS = 2000;

/** The directory name every endpoint socket lives under. */
const CHANNEL_DIR_NAME = "pmux-channel";

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const FNV_MASK = 0xffffffffffffffffn;

/**
 * FNV-1a 64 over the UTF-8 bytes, as 16-digit lowercase hex. Both sides of
 * the endpoint pin one shared test vector
 * (`/tmp/tmux-1000/default` → `79301cf9592f327a`), so the two
 * implementations cannot drift.
 */
function fnv1a64Hex(text: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of Buffer.from(text, "utf8")) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & FNV_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

function defaultUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

/**
 * The endpoint socket path for a report to a parent pane, or `null` when no
 * endpoint can exist because `TMUX` is unset or empty.
 *
 * The path names the target pane — the parent a report goes to — never the
 * caller's own pane. The tmux socket path is the first comma field of
 * `TMUX`; the rest (server pid, session id) plays no part. The directory is
 * `$XDG_RUNTIME_DIR/pmux-channel`, or `/tmp/pmux-channel-<uid>` when
 * `XDG_RUNTIME_DIR` is unset or empty.
 */
export function channelEndpointPath(args: {
  /** The process environment; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** The pane id the report is sent to, with or without its `%`. */
  targetPane: string;
  /** The uid the `/tmp` fallback directory names; defaults to this process's. */
  uid?: number;
}): string | null {
  const env = args.env ?? process.env;
  const tmux = env.TMUX;
  if (!tmux) return null;
  const socketPath = tmux.split(",")[0];
  if (!socketPath) return null;
  const dir = env.XDG_RUNTIME_DIR
    ? join(env.XDG_RUNTIME_DIR, CHANNEL_DIR_NAME)
    : join("/tmp", `${CHANNEL_DIR_NAME}-${args.uid ?? defaultUid()}`);
  const pane = args.targetPane.replace(/^%/, "");
  return join(dir, `${fnv1a64Hex(socketPath)}-${pane}.sock`);
}

/**
 * The outcome of one channel attempt. `emitted` is the only positive result.
 * The reason vocabulary (`ChannelUnavailableReason`) and its guard live in
 * `channel-reason.ts`, the module both sides of the `.sent` log share.
 */
export interface ChannelSubmitResult {
  status: "emitted" | "unavailable";
  /** Set only when `status` is `unavailable`. */
  reason?: ChannelUnavailableReason;
}

/** The arguments one channel attempt needs. */
export interface ChannelSubmitArgs {
  /** The pane id the report is sent to, with or without its `%`. */
  to: string;
  /** The report ID; stable across re-deliveries. */
  id: string;
  /**
   * The exact pointer text the verified input would type, visibility token
   * included (design D4) — one line, no report body.
   */
  text: string;
  /** The UTF-8 length of the report text, as the `notification` record keys it. */
  bytes: number;
  /** The pointer's fresh visibility token. */
  token: string;
  /** The process environment; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** The uid the `/tmp` fallback directory names; defaults to this process's. */
  uid?: number;
  /** The overall connect+write+reply budget; defaults to `CHANNEL_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/**
 * The socket surface the request needs. A real `net.Socket` satisfies it;
 * tests inject fakes through `__setChannelConnectForTests__`.
 */
export interface ChannelSocket {
  write(chunk: string, cb?: (err: Error | null | undefined) => void): void;
  on(event: "data", listener: (chunk: Buffer) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "close", listener: () => void): void;
  destroy(): void;
}

/**
 * Test seam: replaces the socket acquisition behind `submitChannel`, so a
 * test injects the connect and the timeout behavior without a real socket.
 * `null` restores the real `net.connect`.
 */
export type ChannelConnect = (args: { path: string; timeoutMs: number }) => Promise<ChannelSocket>;

let connectOverride: ChannelConnect | null = null;

export function __setChannelConnectForTests__(fn: ChannelConnect | null): void {
  connectOverride = fn;
}

/** The real socket acquisition: connect and resolve once connected. The
 * budget is enforced by the caller's timer, so the connect needs no slice
 * of it. */
function defaultConnect(args: { path: string }): Promise<ChannelSocket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(args.path);
    socket.once("error", reject);
    socket.once("connect", () => {
      // Between the resolve and the caller's own `error` listener there is a
      // microtask gap; keep a no-op listener attached so a very early error
      // cannot turn into an unhandled `'error'` event.
      socket.on("error", () => {});
      resolve(socket);
    });
  });
}

/** The one request line the endpoint receives. */
function requestLine(args: ChannelSubmitArgs): string {
  return JSON.stringify({
    v: 1,
    kind: "report",
    id: args.id,
    text: args.text,
    bytes: args.bytes,
    token: args.token,
  });
}

/** The reply shapes the endpoint's own reasons can travel in. */
const ENDPOINT_REASONS = ["unarmed", "write-failed", "invalid"] as const;

/** True when `value` is one of the reasons the endpoint's own reply carries. */
function isEndpointReason(value: unknown): value is (typeof ENDPOINT_REASONS)[number] {
  return typeof value === "string" && (ENDPOINT_REASONS as readonly string[]).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Sort one reply line into a result. Anything else is `bad-reply`. */
function interpretReply(line: string): ChannelSubmitResult {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { status: "unavailable", reason: "bad-reply" };
  }
  if (!isPlainObject(value)) return { status: "unavailable", reason: "bad-reply" };
  if (value.ok === true && value.emitted === true) return { status: "emitted" };
  if (value.ok === false && isEndpointReason(value.reason)) {
    return { status: "unavailable", reason: value.reason };
  }
  return { status: "unavailable", reason: "bad-reply" };
}

/**
 * The reason one failed connect reads as. A connect that reaches the socket
 * and is denied is `refused`; an endpoint file that vanished between the
 * existence check and the connect is the same `no-endpoint` case the check
 * covers. Any other connect error — `ENOTSOCK`, `EACCES` — has no class of
 * its own in the vocabulary, so it keeps the refused bucket; the fallback is
 * identical whatever the reason reads.
 */
function connectRejectionReason(error: unknown): ChannelUnavailableReason {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return "no-endpoint";
  return "refused";
}
/**
 * Submit one report pointer to the parent's channel endpoint.
 *
 * With no `TMUX`, or with no endpoint file at the derived path, the result
 * is `unavailable` with `no-endpoint` and no connection is attempted.
 * Otherwise the client connects, writes one request line and reads one
 * reply line, all inside the `timeoutMs` budget; a budget that runs out
 * destroys the connection and reads as `timeout`. Every transport failure
 * — a refused connect, a failed write, a reply outside the known shapes —
 * is `unavailable`, so the caller falls back to the verified input.
 */
export function submitChannel(args: ChannelSubmitArgs): Promise<ChannelSubmitResult> {
  const path = channelEndpointPath({
    ...(args.env !== undefined ? { env: args.env } : {}),
    targetPane: args.to,
    ...(args.uid !== undefined ? { uid: args.uid } : {}),
  });
  if (!path || !existsSync(path)) {
    return Promise.resolve({ status: "unavailable", reason: "no-endpoint" });
  }
  const timeoutMs = args.timeoutMs ?? CHANNEL_TIMEOUT_MS;
  const connect = connectOverride ?? defaultConnect;
  return new Promise((resolve) => {
    let settled = false;
    let socket: ChannelSocket | undefined;
    let buffer = Buffer.alloc(0);
    const finish = (result: ChannelSubmitResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(result);
    };
    const fail = (reason: ChannelUnavailableReason): void => {
      finish({ status: "unavailable", reason });
    };
    const timer = setTimeout(() => fail("timeout"), timeoutMs);
    Promise.resolve()
      .then(() => connect({ path, timeoutMs }))
      .then(
        (sock) => {
          if (settled) {
            sock.destroy();
            return;
          }
          socket = sock;
          // Any socket error after the connect — a write that never lands,
          // a reset mid-request — reads as `write-failed`.
          sock.on("error", () => fail("write-failed"));
          sock.on("data", (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);
            const newline = buffer.indexOf(0x0a);
            if (newline < 0) return;
            const line = buffer.subarray(0, newline).toString("utf8");
            finish(interpretReply(line));
          });
          sock.on("close", () => {
            // A connection that ends with no complete reply line never
            // carried one of the valid shapes.
            if (!settled) fail("bad-reply");
          });
          sock.write(`${requestLine(args)}\n`, (err) => {
            if (err) fail("write-failed");
          });
        },
        (error: unknown) => fail(connectRejectionReason(error)),
      );
  });
}
