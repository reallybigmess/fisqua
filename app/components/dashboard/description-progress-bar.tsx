/**
 * Description Progress Bar
 *
 * This component is the description-workflow counterpart to the
 * segmentation-workflow `StackedProgressBar`. Same visual idiom — a
 * single horizontal bar split into coloured segments proportional to
 * status counts — but it draws from the description-workflow palette so
 * the two progress bars never collide visually on a dashboard that
 * surfaces both pipelines side by side.
 *
 * @version v0.4.2
 */

import { useTranslation } from "react-i18next";

type DescriptionProgressBarProps = {
  counts: Record<string, number>;
};

const DESC_STATUS_ORDER = [
  "unassigned",
  "assigned",
  "in_progress",
  "described",
  "reviewed",
  "approved",
  "sent_back",
];

/** Map description status -> Tailwind bg class for bar segments */
const DESC_SEGMENT_COLORS: Record<string, string> = {
  unassigned: "bg-stone-500",
  assigned: "bg-indigo",
  in_progress: "bg-saffron-deep",
  described: "bg-sage-deep",
  reviewed: "bg-verdigris",
  approved: "bg-verdigris",
  sent_back: "bg-indigo",
};

export function DescriptionProgressBar({ counts }: DescriptionProgressBarProps) {
  const { t } = useTranslation("description");
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const approved = counts["approved"] ?? 0;

  if (total === 0) {
    return (
      <div className="h-1.5 w-full rounded-full bg-stone-100" />
    );
  }

  return (
    <div className="space-y-1">
      {/* Label */}
      <div className="flex items-center justify-between">
        <span className="text-13 font-semibold uppercase text-stone-500">
          {t("tabs.descripcion")}
        </span>
        <span className="text-xs text-stone-500">
          {t("progress.items_approved", { approved, total })}
        </span>
      </div>

      {/* Bar */}
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-stone-100">
        {DESC_STATUS_ORDER.map((status) => {
          const count = counts[status] ?? 0;
          if (count === 0) return null;
          const pct = (count / total) * 100;
          const label = t(`status.${status}`);
          return (
            <div
              key={status}
              className={`${DESC_SEGMENT_COLORS[status] ?? "bg-stone-300"} transition-all`}
              style={{ width: `${pct}%` }}
              title={`${label}: ${count}`}
            />
          );
        })}
      </div>
    </div>
  );
}
