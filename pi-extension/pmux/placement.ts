/**
 * Surface placement for a subagent pane — host independent.
 *
 * A subagent opens in the caller's window (placed automatically next to the
 * newest sibling, the dwindle rule of the tmux backend) or on its own tab.
 * The values are the same for every host; only the placement mechanics
 * differ.
 */

/**
 * Where a subagent surface goes: a pane in the caller's window, placed
 * automatically, its own tab, or a floating pane in the caller's window.
 */
export type SurfacePlacement = "pane" | "tab" | "float";

/** A persisted placement default: `float` is never a default. */
export type SurfaceDefault = "pane" | "tab";

export const DEFAULT_SURFACE_PLACEMENT: SurfaceDefault = "pane";

/**
 * The shared placement mapping: the legacy `right` and `down` split choices
 * map to `pane` (the axis now comes from the target pane's shape, not from
 * the caller's choice), then the value must be one of `allowed`. `float`
 * belongs in `allowed` only for per-call and role values, so a parser for
 * defaults that omits it can never return `float`.
 */
function parseSurface<T extends SurfacePlacement>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  const mapped = value === "right" || value === "down" ? "pane" : value;
  if (mapped !== "pane" && mapped !== "tab" && mapped !== "float") return undefined;
  return allowed.find((entry) => entry === mapped);
}

/**
 * Parse a per-call or role placement value. The legacy `right` and `down`
 * split choices map to `pane`: the axis now comes from the target pane's
 * shape, not from the caller's choice.
 */
export function parseSurfacePlacement(value: unknown): SurfacePlacement | undefined {
  return parseSurface(value, ["pane", "tab", "float"]);
}

/**
 * Parse a placement default (`config.json`, `/pmux-surface`,
 * `writeSurfaceConfig`). Rejects `float`: a default never floats.
 */
export function parseSurfaceDefault(value: unknown): SurfaceDefault | undefined {
  return parseSurface(value, ["pane", "tab"]);
}

/**
 * Resolve the placement for one launch: the per-call value wins, then the
 * role's value, then the configured default.
 */
export function resolvePlacement(
  call: SurfacePlacement | undefined,
  role: SurfacePlacement | undefined,
  fallback: SurfaceDefault,
): SurfacePlacement {
  return call ?? role ?? fallback;
}

/** Split direction for `splitPane`: side by side (`right`) or stacked (`down`). */
export type SplitDirection = "right" | "down";
