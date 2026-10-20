/**
 * Surface placement for a subagent pane — host independent.
 *
 * A subagent opens beside its parent (a split of the caller's pane) or on
 * its own tab. The values are the same for every host; only the split
 * mechanics differ.
 */

/**
 * Where a new subagent surface goes: a split of the caller's pane to the
 * right (side by side) or down (stacked), or its own tab.
 */
export type SurfacePlacement = "right" | "down" | "tab";

export const DEFAULT_SURFACE_PLACEMENT: SurfacePlacement = "right";

/** Parse a placement value. The legacy "pane" (auto split) means the default split. */
export function parseSurfacePlacement(value: unknown): SurfacePlacement | undefined {
  if (value === "pane") return DEFAULT_SURFACE_PLACEMENT;
  return value === "right" || value === "down" || value === "tab" ? value : undefined;
}

/** Split direction for `splitPane`: side by side (`right`) or stacked (`down`). */
export type SplitDirection = "right" | "down";
