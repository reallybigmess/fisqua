/**
 * Workflow Status Badges
 *
 * This module exports the pair of badge components that label every
 * workflow status across the cataloguing surfaces. `StatusBadge`
 * renders the segmentation (volume-level) statuses — unstarted,
 * in_progress, segmented, sent_back, reviewed, approved — while
 * `DescriptionStatusBadge` renders the parallel description (per-entry)
 * statuses. The two variants pick deliberately different mappings of
 * the same six colour pairs from `app.css`, so a segmentation badge
 * never reads as a description badge or the other way around even
 * when both sit on the same screen (assignments page, dashboards,
 * outline). Both badges resolve their colour pair from a shared
 * `--*-bg` / `--*-fg` token set; this keeps the palette swappable
 * from one design pass without having to chase every badge call site.
 *
 * @version v0.4.2
 */

import { useTranslation } from "react-i18next";

// Status pairs follow README §Colour and the @theme `--*-bg` / `--*-fg`
// tokens in app.css. The two workflows pick deliberately different
// mappings of the same six pairs so segmentation states never read as
// description states (or vice versa).

/** Segmentation (volume) status styles */
export const STATUS_STYLES: Record<
  string,
  { bg: string; text: string }
> = {
  unstarted: { bg: "bg-stone-100", text: "text-stone-600" },
  in_progress: { bg: "bg-indigo-tint", text: "text-indigo" },
  segmented: { bg: "bg-saffron-tint", text: "text-saffron-deep" },
  sent_back: { bg: "bg-madder-tint", text: "text-madder-deep" },
  reviewed: { bg: "bg-sage-tint", text: "text-sage-deep" },
  approved: { bg: "bg-verdigris-tint", text: "text-verdigris-deep" },
};

/** Description (per-entry) status styles -- distinct palette from segmentation */
export const DESCRIPTION_STATUS_STYLES: Record<
  string,
  { bg: string; text: string }
> = {
  unassigned: { bg: "bg-stone-100", text: "text-stone-600" },
  assigned: { bg: "bg-indigo-tint", text: "text-indigo" },
  in_progress: { bg: "bg-saffron-tint", text: "text-saffron-deep" },
  described: { bg: "bg-sage-tint", text: "text-sage-deep" },
  reviewed: { bg: "bg-sage-tint", text: "text-sage-deep" },
  approved: { bg: "bg-verdigris-tint", text: "text-verdigris-deep" },
  sent_back: { bg: "bg-madder-tint", text: "text-madder-deep" },
};

// One shape, one size, one style — only the colour pair varies.
// README §4.4: rounded-full px-2.5 py-0.5 text-11 font-sans
// font-semibold tracking-[0.02em] uppercase.
const BADGE_SHAPE =
  "inline-flex items-center rounded-full px-2.5 py-0.5 font-sans text-11 font-semibold uppercase tracking-[0.02em]";

type StatusBadgeProps = {
  status: string;
};

/** Badge for segmentation (volume) workflow statuses */
export function StatusBadge({ status }: StatusBadgeProps) {
  const { t } = useTranslation("workflow");
  const style = STATUS_STYLES[status] ?? {
    bg: "bg-stone-100",
    text: "text-stone-600",
  };

  return (
    <span className={`${BADGE_SHAPE} ${style.bg} ${style.text}`}>
      {t(`status.${status}`)}
    </span>
  );
}

/** Badge for description (per-entry) workflow statuses */
export function DescriptionStatusBadge({ status }: StatusBadgeProps) {
  const { t } = useTranslation("description");
  const style = DESCRIPTION_STATUS_STYLES[status] ?? {
    bg: "bg-stone-100",
    text: "text-stone-600",
  };

  return (
    <span className={`${BADGE_SHAPE} ${style.bg} ${style.text}`}>
      {t(`status.${status}`)}
    </span>
  );
}
