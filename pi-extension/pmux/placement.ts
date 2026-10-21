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
 * Parse a per-call or role placement value. The legacy `right` and `down`
 * split choices map to `pane`: the axis now comes from the target pane's
 * shape, not from the caller's choice.
 */
export function parseSurfacePlacement(value: unknown): SurfacePlacement | undefined {
  const mapped = value === "right" || value === "down" ? "pane" : value;
  return mapped === "pane" || mapped === "tab" || mapped === "float" ? mapped : undefined;
}

/**
 * Parse a placement default (`config.json`, `/pmux-surface`,
 * `writeSurfaceConfig`). Rejects `float`: a default never floats.
 */
export function parseSurfaceDefault(value: unknown): SurfaceDefault | undefined {
  const placement = parseSurfacePlacement(value);
  return placement === "float" ? undefined : placement;
}

/**
 * Resolve the placement for one launch: the role's surface wins over the
 * configured default. There is no per-call value.
 */
export function resolvePlacement(
  role: SurfacePlacement | undefined,
  fallback: SurfaceDefault = DEFAULT_SURFACE_PLACEMENT,
): SurfacePlacement {
  return role ?? fallback;
}

/** Split direction for `splitPane`: side by side (`right`) or stacked (`down`). */
export type SplitDirection = "right" | "down";
