/**
 * Admin — Workbench sticky action bar
 *
 * The shared bottom action bar for the merge and split workbenches
 * (spec §4 surfaces). One shell, two rows: the reason input + primary
 * action sit on the first row (bottom-aligned), and the summary /
 * validation line sits on a visually separated second row.
 *
 * Positioning contract (pinned by
 * `tests/components/workbench-action-bar-layout.test.ts`):
 *
 *   - `sticky bottom-0` INSIDE the shell's scroll column — never
 *     `fixed inset-x-0`. A fixed bar spans the viewport, so it lands
 *     under the sidebar on the left and detaches from the content
 *     container's width; sticky tracks the workbench container at
 *     every viewport width and sidebar state.
 *   - opaque `bg-white` (no alpha, no backdrop-blur) + `z-20` — the
 *     app footer is an `absolute` element painted AFTER the outlet in
 *     the content column, so without an explicit z-index and an opaque
 *     background its "Fisqua vX.Y.Z" link renders through the bar. At
 *     scroll end the bar settles into flow above the shell's bottom
 *     padding, so the footer stays reachable below it.
 *   - `border border-stone-200` + top shadow — the bar must read as a
 *     surface above the scrolling content, not a compressed strip.
 *
 * @version v0.4.3
 */

import type { ReactNode } from "react";

/** Outer shell — the load-bearing positioning classes (see header). */
export const ACTION_BAR_CLASSES =
  "sticky bottom-0 z-20 mt-10 rounded-t-xl border border-stone-200 bg-white shadow-[0_-6px_16px_-8px_rgba(0,0,0,0.18)]";

/** Inner padding + vertical rhythm between the two rows. */
export const ACTION_BAR_INNER_CLASSES = "flex flex-col gap-3 px-6 py-4";

/** Second-row separator: summary/validation sits apart from the input row. */
export const ACTION_BAR_META_ROW_CLASSES =
  "flex items-center justify-between gap-4 border-t border-stone-100 pt-3";

export function WorkbenchActionBar({ children }: { children: ReactNode }) {
  return (
    <div className={ACTION_BAR_CLASSES}>
      <div className={ACTION_BAR_INNER_CLASSES}>{children}</div>
    </div>
  );
}
