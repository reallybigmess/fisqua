/**
 * Resegmentation Card
 *
 * This card is the inline notice shown inside an outline entry when a
 * reviewer has requested the entry be re-segmented. Surfaces the reporter,
 * the reason, and the lead-only affordance to accept or reject the
 * request.
 *
 * @version v0.4.2
 */
import { useTranslation } from "react-i18next";
import { formatIsoDateTime } from "../../lib/format-date";

export type ResegmentationCardFlag = {
  id: string;
  reporterName: string;
  /** ISO 8601 timestamp or epoch ms -- formatted via formatIsoDateTime. */
  reportedAt: string | number;
  description: string;
};

export type ResegmentationCardProps = {
  flag: ResegmentationCardFlag;
  onOpenDialog: () => void;
};

/**
 * Pure helper: format the "{reporterName} · {timestamp}" reporter line
 * that sits below the badge. Exported so tests can assert the exact
 * string shape and separator without rendering. Uses the project-wide
 * `formatIsoDateTime` so the format matches every other date in the
 * app (the single source of truth for archival-precision dates).
 */
export function formatReporterLine(flag: ResegmentationCardFlag): string {
  const ts =
 typeof flag.reportedAt === "number"
 ? formatIsoDateTime(flag.reportedAt)
 : formatIsoDateTime(Date.parse(flag.reportedAt));
  return `${flag.reporterName} · ${ts}`;
}

export function ResegmentationCard({
  flag,
  onOpenDialog,
}: ResegmentationCardProps) {
  const { t } = useTranslation(["resegmentation"]);

  return (
 <div className="mb-3 flex flex-col gap-2 rounded-lg border border-violet-100 bg-violet-50 p-4 font-sans">
 {/* badge */}
 <div>
 <span className="inline-block rounded bg-violet-600 px-2 py-0.5 text-10 font-bold uppercase tracking-wide text-white">
 {t("resegmentation:proposed", {
 defaultValue: "Resegmentación propuesta",
 })}
 </span>
 </div>

 {/* Reporter + timestamp */}
 <p className="text-xs text-stone-400">{formatReporterLine(flag)}</p>

 {/* Description */}
 <p className="text-sm leading-relaxed text-stone-700">
 {flag.description}
 </p>

 {/* Full-width burgundy CTA */}
 <button
 type="button"
 onClick={onOpenDialog}
 className="mt-2 w-full rounded bg-indigo px-4 py-2 font-sans text-sm font-semibold text-parchment transition-colors hover:bg-indigo-deep focus:outline-none focus:ring-2 focus:ring-indigo/40"
 >
 {t("resegmentation:openDialog", {
 defaultValue: "Abrir diálogo de resegmentación",
 })}
 </button>
 </div>
  );
}

