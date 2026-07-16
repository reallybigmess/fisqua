/**
 * QC Flag Card
 *
 * This card is the presentational surface for one QC flag — problem type,
 * reporter and timestamp, the free-text description, and, for leads, the
 * resolve affordance that opens `ResolveQcFlagDialog`. Props-in, JSX-out
 * so the component can render anywhere an open QC flag needs to surface
 * (viewer sidebar, outline, manage page).
 *
 * @version v0.4.2
 */
import { useTranslation } from "react-i18next";
import { CheckCircle } from "lucide-react";
import { formatIsoDateTime } from "../../lib/format-date";

export type QcProblemType =
  | "damaged"
  | "repeated"
  | "out_of_order"
  | "missing"
  | "blank"
  | "other";

export type QcStatus = "open" | "resolved" | "wontfix";

export type QcResolutionAction =
  | "retake_requested"
  | "reordered"
  | "marked_duplicate"
  | "ignored"
  | "other";

export type QcFlagCardData = {
  id: string;
  pageId: string;
  pagePosition?: number;
  problemType: QcProblemType;
  description: string;
  status: QcStatus;
  resolutionAction: QcResolutionAction | null;
  resolverNote: string | null;
  reportedBy: string;
  reportedByName?: string;
  resolvedBy?: string | null;
  resolvedByName?: string | null;
  resolvedAt?: number | null;
  createdAt: number;
};

export type QcFlagCardProps = {
  flag: QcFlagCardData;
  /** When present, a "Resolve" button is rendered. Callers are responsible
 *  for only passing this when the viewer is a project lead. The server
 *  enforces the actual permission on PATCH /api/qc-flags. */
  onResolveClick?: () => void;
};

// Mapped onto the Fisqua status palette by role:
//   damaged / missing  -> madder    (returned/reviewer = something is broken)
//   repeated / oo      -> saffron   (segmented/partial = needs attention)
//   blank / other      -> stone     (draft/unstarted = neutral)
const PROBLEM_TYPE_CLASSES: Record<QcProblemType, string> = {
  damaged: "bg-madder-tint text-madder-deep",
  repeated: "bg-saffron-tint text-saffron-deep",
  out_of_order: "bg-saffron-tint text-saffron-deep",
  missing: "bg-madder-tint text-madder-deep",
  blank: "bg-stone-100 text-stone-600",
  other: "bg-stone-100 text-stone-600",
};

const STATUS_CLASSES: Record<QcStatus, string> = {
  open: "bg-madder-tint text-madder-deep",
  resolved: "bg-verdigris-tint text-verdigris-deep",
  wontfix: "bg-stone-100 text-stone-600",
};

export function QcFlagCard({ flag, onResolveClick }: QcFlagCardProps) {
  const { t } = useTranslation(["qc_flags"]);

  const problemTypeLabel = t(`qc_flags:card.problem_type.${flag.problemType}`);
  const statusLabel = t(`qc_flags:card.status.${flag.status}`);
  const reporterName = flag.reportedByName ?? flag.reportedBy;

  return (
 <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
 {/* Header row */}
 <div className="mb-2 flex flex-wrap items-center gap-2">
 <span
 className={`rounded px-2 py-0.5 font-sans text-xs font-semibold ${PROBLEM_TYPE_CLASSES[flag.problemType]}`}
 >
 {problemTypeLabel}
 </span>
 <span
 className={`rounded px-2 py-0.5 font-sans text-xs font-semibold ${STATUS_CLASSES[flag.status]}`}
 >
 {statusLabel}
 </span>
 <span className="ml-auto font-sans text-xs text-stone-400">
 {formatIsoDateTime(flag.createdAt)}
 </span>
 </div>

 {/* Body: reporter description */}
 <p className="mb-2 text-sm leading-relaxed text-stone-700">
 {flag.description}
 </p>

 {/* Reporter line */}
 <p className="text-xs text-stone-500">
 {t("qc_flags:card.reported_by", { name: reporterName })}
 </p>

 {/* Resolve button (open only, role gated by caller passing the callback) */}
 {flag.status === "open" && onResolveClick && (
 <div className="mt-3">
 <button
 type="button"
 onClick={onResolveClick}
 className="inline-flex items-center gap-1 rounded border-2 border-verdigris-deep px-3 py-1.5 font-sans text-sm font-semibold text-verdigris-deep transition-colors hover:bg-verdigris-tint focus:outline-none focus:ring-2 focus:ring-verdigris-deep/40"
 >
 <CheckCircle size={16} aria-hidden="true" />
 {t("qc_flags:card.resolve_button")}
 </button>
 </div>
 )}

 {/* Resolved block */}
 {flag.status !== "open" && flag.resolutionAction && (
 <div className="mt-3 rounded-lg border border-stone-100 bg-stone-50 p-3">
 <p className="text-xs font-medium text-stone-600">
 {t(
 `qc_flags:card.resolution_action.${flag.resolutionAction}`
 )}
 </p>
 {flag.resolvedBy && (
 <p className="mt-1 text-xs text-stone-500">
 {t("qc_flags:card.resolved_by", {
 name: flag.resolvedByName ?? flag.resolvedBy,
 })}
 {flag.resolvedAt
 ? ` — ${formatIsoDateTime(flag.resolvedAt)}`
 : ""}
 </p>
 )}
 {flag.resolverNote && flag.resolverNote.trim().length > 0 && (
 <blockquote className="mt-2 border-l-2 border-stone-300 pl-2 text-xs italic text-stone-600">
 {flag.resolverNote}
 </blockquote>
 )}
 </div>
 )}
 </div>
  );
}

