/**
 * Where a component's per-user runtime directory lives: the rule the feed
 * directory (`thinking-feed-file.ts`, thinking-feed D2) and the channel
 * endpoint directory (`channel-endpoint.ts`, report-channel D3) share.
 *
 * One rule, one place, so both sides — pmux here and pmux-explorer, which
 * pins the same vector — derive the same path with no registry and no
 * lookup.
 */
import { join } from "node:path";

/** This process's uid, or 0 where the platform has none. */
export function defaultUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

/**
 * The named runtime directory: `$XDG_RUNTIME_DIR/<name>`, or
 * `/tmp/<name>-<uid>` when `XDG_RUNTIME_DIR` is unset or empty. `uid` names
 * the `/tmp` fallback directory; it defaults to this process's.
 */
export function runtimeDirPath(args: {
  /** The process environment; carries `XDG_RUNTIME_DIR`. */
  env: NodeJS.ProcessEnv;
  /** The directory name, under `XDG_RUNTIME_DIR` or in `/tmp`. */
  name: string;
  /** The uid the `/tmp` fallback directory names; defaults to this process's. */
  uid?: number;
}): string {
  const runtime = args.env.XDG_RUNTIME_DIR;
  return runtime
    ? join(runtime, args.name)
    : join("/tmp", `${args.name}-${args.uid ?? defaultUid()}`);
}
