/**
 * Reviewer Description Tab
 *
 * This component is the description-side of the reviewer's dashboard,
 * the sibling of `ReviewerDashboard` for the description workflow. It
 * surfaces the entries currently waiting on the reviewer in four
 * buckets, weighted by urgency — Re-segmentation pending (entries the
 * reviewer has flagged back to the lead for re-segmentation; these
 * read first because they block forward motion across the team),
 * Awaiting review (entries the cataloguer has marked `described` and
 * handed off), Reviewed (the reviewer has signed off; awaiting
 * approval), and Approved (terminal). The grouping mirrors the
 * cataloguer description tab so a reviewer and a cataloguer reading
 * over each other's shoulder see the same registers in the same
 * positions. All loaders run on the parent route; this file is pure
 * render.
 *
 * @version v0.4.2
 */

import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { DescriptionStatusBadge } from "../workflow/status-badge";
import { daysSince } from "./volume-status-card";

export type ReviewerEntryCardData = {
  id: string;
  title: string | null;
  translatedTitle: string | null;
  referenceCode: string;
  volumeTitle: string;
  volumeId: string;
  projectId: string;
  startPage: number;
  endPage: number | null;
  descriptionStatus: string;
  updatedAt: number;
};

export type ResegFlagData = {
  id: string;
  volumeId: string;
  volumeTitle: string;
  referenceCode: string;
  projectId: string;
  problemType: string;
  description: string;
};

export type ReviewerDescriptionData = {
  resegFlags: ResegFlagData[];
  awaitingReview: ReviewerEntryCardData[];
  reviewed: ReviewerEntryCardData[];
  approved: ReviewerEntryCardData[];
};

type ReviewerDescriptionTabProps = {
  data: ReviewerDescriptionData;
};

function WaitingBadge({ days }: { days: number }) {
  const { t } = useTranslation("dashboard");
  const urgent = days >= 3;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        urgent
          ? "bg-indigo text-parchment"
          : "bg-saffron-tint text-saffron-deep"
      }`}
    >
      {days === 0 ? t("today") : t("days_waiting", { count: days })}
    </span>
  );
}

function ReviewerEntryCard({ entry }: { entry: ReviewerEntryCardData }) {
  const { t } = useTranslation("description");
  const displayTitle = entry.title || entry.translatedTitle || t("assignment.item");
  const pageRange = entry.endPage
    ? `pp. ${entry.startPage}-${entry.endPage}`
    : `p. ${entry.startPage}`;

  return (
    <Link
      to={`/projects/${entry.projectId}/describe/${entry.id}`}
      className="block rounded-lg border border-stone-200 p-4 hover:shadow-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-serif text-base font-semibold text-stone-900">
            {displayTitle}
          </h3>
          <p className="mt-0.5 font-mono text-xs text-stone-500">{entry.referenceCode}</p>
        </div>
        <DescriptionStatusBadge status={entry.descriptionStatus} />
      </div>
      <p className="mt-1 text-sm text-stone-500">
        {entry.volumeTitle} — {pageRange}
      </p>
    </Link>
  );
}

function ResegFlagCard({ flag }: { flag: ResegFlagData }) {
  const { t } = useTranslation(["description", "dashboard"]);

  return (
    <Link
      to={`/projects/${flag.projectId}/volumes/${flag.volumeId}`}
      className="block rounded-lg border border-saffron bg-saffron-tint p-4 hover:border-saffron hover:shadow-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-serif text-base font-semibold text-stone-900">
            {flag.volumeTitle}
          </h3>
          <p className="mt-0.5 font-mono text-xs text-stone-500">{flag.referenceCode}</p>
        </div>
        <span className="inline-flex items-center rounded-full bg-indigo px-2.5 py-0.5 text-xs font-medium text-parchment">
          {t(`description:dashboard.problem_type.${flag.problemType}`)}
        </span>
      </div>
      <div className="mt-2 rounded bg-indigo-tint px-3 py-2 text-sm text-stone-700">
        {flag.description}
      </div>
    </Link>
  );
}

export function ReviewerDescriptionTab({ data }: ReviewerDescriptionTabProps) {
  const { t } = useTranslation("dashboard");

  const totalItems =
    data.resegFlags.length +
    data.awaitingReview.length +
    data.reviewed.length +
    data.approved.length;

  if (totalItems === 0) {
    return (
      <div className="mt-12 flex justify-center">
        <div className="mx-auto max-w-md rounded-xl bg-white p-8 shadow-sm ring-1 ring-stone-100 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-indigo-tint">
            <svg className="h-7 w-7 text-indigo" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
          </div>
          <h3 className="mt-4 font-serif text-lg font-semibold text-indigo">
            {t("empty.no_description_review_title")}
          </h3>
          <p className="mt-2 font-serif text-15 text-stone-500 max-w-measure mx-auto">
            {t("empty.no_description_review_body")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Re-segmentacion pendiente (priority) */}
      {data.resegFlags.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
            {t("group.reseg_pending")}
            <span className="ml-2 text-xs font-normal">({data.resegFlags.length})</span>
          </h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.resegFlags.map((flag) => (
              <ResegFlagCard key={flag.id} flag={flag} />
            ))}
          </div>
        </section>
      )}

      {/* Esperando revision */}
      {data.awaitingReview.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
            {t("group.awaiting_review")}
            <span className="ml-2 text-xs font-normal">({data.awaitingReview.length})</span>
          </h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.awaitingReview.map((entry) => (
              <div key={entry.id} className="relative">
                <div className="absolute right-2 top-2 z-10">
                  <WaitingBadge days={daysSince(entry.updatedAt)} />
                </div>
                <ReviewerEntryCard entry={entry} />
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Revisados */}
      {data.reviewed.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
            {t("group.reviewed")}
            <span className="ml-2 text-xs font-normal">({data.reviewed.length})</span>
          </h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.reviewed.map((entry) => (
              <ReviewerEntryCard key={entry.id} entry={entry} />
            ))}
          </div>
        </section>
      )}

      {/* Aprobados */}
      {data.approved.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
            {t("group.approved")}
            <span className="ml-2 text-xs font-normal">({data.approved.length})</span>
          </h2>
          <div className="mt-3 grid gap-3 opacity-75 sm:grid-cols-2 lg:grid-cols-3">
            {data.approved.map((entry) => (
              <ReviewerEntryCard key={entry.id} entry={entry} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
