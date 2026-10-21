/**
 * Surface placement for a subagent pane — host independent.
 *
 * A subagent opens in the caller's window (placed automatically next to the
 * newest sibling, the dwindle rule of the tmux backend) or on its own tab.
 * The values are the same for every host; only the placement mechanics
 * differ.
 */

/**
 * Where a new subagent surface goes: a pane in the caller's window, placed
 * automatically, or its own tab.
 */
export type SurfacePlacement = "pane" | "tab";

export const DEFAULT_SURFACE_PLACEMENT: SurfacePlacement = "pane";

/**
 * Parse a placement value. The legacy `right` and `down` split choices map
 * to `pane`: the axis now comes from the target pane's shape, not from the
 * caller's choice.
 */
export function parseSurfacePlacement(value: unknown): SurfacePlacement | undefined {
  if (value === "tab") return "tab";
  return value === "pane" || value === "right" || value === "down" ? "pane" : undefined;
}

/** Split direction for `splitPane`: side by side (`right`) or stacked (`down`). */
export type SplitDirection = "right" | "down";
