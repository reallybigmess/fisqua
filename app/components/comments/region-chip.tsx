/**
 * Region Chip
 *
 * This component is the small pill that represents a region-anchored
 * comment in the outline and in the comment thread header. Clicking the
 * chip scrolls the viewer to the region and flashes the pin so the reader
 * orients immediately.
 *
 * @version v0.4.2
 */
import { useTranslation } from "react-i18next";
import { MapPin } from "lucide-react";

export type RegionChipProps = {
  commentId: string;
  /** 1-indexed page number for display (matches the outline convention). */
  pageNumber: number;
  onScrollToRegion: (commentId: string) => void;
};

/**
 * Pure function: return the i18n key + interpolation args for the chip
 * label. Exported so tests can assert the wiring independently of
 * `react-i18next`'s render-time behaviour ().
 */
export function computeChipLabelArgs(pageNumber: number): {
  key: string;
  vars: { page: number };
  defaultValue: string;
} {
  return {
 key: "regions:chip.label",
 vars: { page: pageNumber },
 defaultValue: `Región · p. ${pageNumber}`,
  };
}

/**
 * Pure function: the static className string applied to the chip button.
 * Broken out so tests can grep / assert without rendering. Matches the
 * visual spec.
 */
export function computeChipClassName(): string {
  return [
 "inline-flex items-center gap-1",
 "px-2 py-1 rounded",
 "bg-stone-100",
 "border border-stone-200",
 "text-stone-600 text-10 font-bold",
 "font-sans",
 "hover:bg-stone-200 focus:outline-none focus:ring-2 focus:ring-indigo/40",
 "transition-colors",
  ].join(" ");
}

export function RegionChip({
  commentId,
  pageNumber,
  onScrollToRegion,
}: RegionChipProps) {
  const { t } = useTranslation(["regions"]);
  const { key, vars, defaultValue } = computeChipLabelArgs(pageNumber);

  return (
 <button
 type="button"
 onClick={() => onScrollToRegion(commentId)}
 className={computeChipClassName()}
 data-testid="region-chip"
 >
 <MapPin size={10} color="#1F2E4D" aria-hidden="true" />
 <span>{t(key, { ...vars, defaultValue })}</span>
 </button>
  );
}

