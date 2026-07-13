/**
 * Flag Badge
 *
 * This badge is the per-page indicator that surfaces the count of open QC
 * flags on that page. Clicking the badge opens the per-page QC panel; the
 * badge hides when there are no open flags.
 *
 * @version v0.4.2
 */
import { Flag } from "lucide-react";

export type FlagBadgeProps = {
  count: number;
  onClick?: () => void;
  "aria-label"?: string;
};

/**
 * Pure predicate: should the outer badge render?
 *
 * Rule: hide the badge when `count === 0`, otherwise show it.
 * Non-integer or negative counts (e.g. from a bad loader) also hide it
 * defensively. Exported so tests pin without rendering.
 */
export function shouldRenderFlagBadge(count: number): boolean {
  if (!Number.isFinite(count)) return false;
  if (count === 0) return false;
  return count > 0;
}

export function FlagBadge({
  count,
  onClick,
  "aria-label": ariaLabel,
}: FlagBadgeProps) {
  if (!shouldRenderFlagBadge(count)) return null;

  return (
 <button
 type="button"
 onClick={onClick}
 aria-label={ariaLabel ?? "open-flag-badge"}
 className="relative inline-flex h-8 w-8 items-center justify-center rounded-full bg-madder text-parchment transition-colors hover:bg-madder-deep focus:outline-none focus:ring-2 focus:ring-madder/40"
 >
 <Flag size={16} aria-hidden="true" />
 {/* Count bubble -- shown unconditionally once the outer badge is
 visible. No "two-or-more" gate: a single open flag
 still surfaces the exact count. */}
 <span
 className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full border border-madder bg-white px-1 font-sans text-10 font-bold text-madder-deep"
 >
 {count}
 </span>
 </button>
  );
}

