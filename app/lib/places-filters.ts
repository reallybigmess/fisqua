/**
 * Admin — places filter controls (pure helpers)
 *
 * The combined places surface drives all its filters through URL
 * params. These helpers hold the control-row semantics that need
 * DOM-free tests: the external-identifier tri-state cycle (any → has →
 * missing → any), the canonical list of filter params, the
 * any-filter-active check that shows the Reset control, and the
 * clear-everything reset that returns the URL to bare /admin/places.
 *
 * @version v0.4.3
 */

/** External-identifier presence filter state (null = any). */
export type TriState = "has" | "missing" | null;

/** One click on a tri-state chip: any → has → missing → any. */
export function nextTriState(state: TriState): TriState {
  if (state === null) return "has";
  if (state === "has") return "missing";
  return null;
}

/** Every URL param the control row owns (search + all chips + type). */
export const FILTER_PARAM_NAMES = [
  "q",
  "missingCoords",
  "reviewCoords",
  "showMerged",
  "placeType",
  "tgn",
  "hgis",
  "whg",
] as const;

/** True when any filter or search is active (empty values count as off). */
export function isAnyFilterActive(sp: URLSearchParams): boolean {
  return FILTER_PARAM_NAMES.some((name) => !!sp.get(name));
}

/**
 * The Reset control: a copy of the params with every filter (and the
 * pagination cursor) removed. With no other params in play the result
 * serialises to the bare route.
 */
export function clearFilterParams(sp: URLSearchParams): URLSearchParams {
  const params = new URLSearchParams(sp);
  for (const name of [...FILTER_PARAM_NAMES, "cursor"]) {
    params.delete(name);
  }
  return params;
}
