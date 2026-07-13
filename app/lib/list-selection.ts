/**
 * Admin — list row selection (pure helpers)
 *
 * The authority list surfaces own a `Set<string>` of selected row ids
 * that drives the two-row merge entry point (spec §4: list-view two-row
 * selection → "Merge…" opens the workbench with both records loaded).
 * The toggle is extracted here as a pure function so the selection
 * semantics — immutable set updates, add/remove symmetry — are testable
 * without a DOM.
 *
 * @version v0.4.3
 */

/**
 * Return a NEW set with `id` toggled: added when absent, removed when
 * present. The input set is never mutated (React state discipline).
 */
export function toggleSelection(
  prev: ReadonlySet<string>,
  id: string,
): Set<string> {
  const next = new Set(prev);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
