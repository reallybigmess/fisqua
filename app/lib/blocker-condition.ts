/**
 * Navigation Blocker Predicate
 *
 * This helper is a single-function pure predicate consumed by both
 * editor routes (description editor and segmentation viewer) when
 * wiring React Router 7's `useBlocker`. It returns true when the
 * editor has work the user would lose by navigating away — unflushed
 * edits, an in-flight save attempt, or a settled error from a failed
 * save.
 *
 * Extracted so the same definition drives both routes (no drift
 * between editors) and so it is testable without mounting React
 * Router or the editor components.
 *
 * @version v0.4.1
 */
import type { SaveStatusValue } from "../components/viewer/save-status";

/**
 * Whether the current editor state warrants blocking an outgoing
 * navigation with a confirm dialog.
 *
 *   - `hasUnsaved`: the editor has user edits that have not yet been
 *     debounced into a save attempt (the "Sin guardar" pill).
 *   - `saveStatus === "saving"`: a save is in flight; navigating away
 *     would race the response and the user might not know whether
 *     the work landed.
 *   - `saveStatus === "error"`: the last save settled to error after
 *     bounded retries; navigating away discards the unflushed work
 *     silently. The retry affordance is the right exit.
 *
 * The `"unsaved"` status alone does NOT block on its own — it is
 * already covered by `hasUnsaved` in the call sites. The `"saved"`
 * status never blocks.
 */
export function shouldBlockNavigation(
  saveStatus: SaveStatusValue,
  hasUnsaved: boolean,
): boolean {
  return hasUnsaved || saveStatus === "saving" || saveStatus === "error";
}

/* @version v0.4.1 */
