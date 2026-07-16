/**
 * Reviewer Dashboard
 *
 * This component is the role-specific dashboard a reviewer lands on when
 * they sign in. It groups the volumes assigned to them as a reviewer
 * into three review-side buckets — Awaiting review (segmented by the
 * cataloguer and waiting on the reviewer's first pass, each carrying a
 * waiting-time badge so the longest-waiting volume reads first),
 * Reviewed (the reviewer has signed off but the volume is not yet
 * approved), and Approved (terminal state on the segmentation track).
 * The ordering of the buckets is deliberately weighted toward what
 * needs the reviewer's hand: the most urgent items always sit at the
 * top of the page. Like the other dashboard views, this component is
 * pure render; loaders on the parent route handle the database access.
 *
 * @version v0.4.2
 */

import { useTranslation } from "react-i18next";
import {
  VolumeStatusCard,
  daysSince,
  type VolumeCardData,
} from "./volume-status-card";

export type ReviewerGroups = {
  awaitingReview: VolumeCardData[];
  reviewed: VolumeCardData[];
  approved: VolumeCardData[];
};

type ReviewerDashboardProps = {
  groups: ReviewerGroups;
};

function WaitingBadge({ days }: { days: number }) {
  const { t } = useTranslation("dashboard");
  const urgent = days >= 3;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        urgent
          ? "bg-madder-tint text-madder-deep"
          : "bg-saffron-tint text-saffron-deep"
      }`}
    >
      {days === 0 ? t("today") : t("days_waiting", { count: days })}
    </span>
  );
}

function ReviewGroup({
  title,
  volumes,
  showWaiting,
}: {
  title: string;
  volumes: VolumeCardData[];
  showWaiting?: boolean;
}) {
  if (volumes.length === 0) return null;

  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
        {title}
        <span className="ml-2 text-xs font-normal">({volumes.length})</span>
      </h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {volumes.map((v) => (
          <div key={v.id} className="relative">
            {showWaiting && (
              <div className="absolute right-2 top-2 z-10">
                <WaitingBadge days={daysSince(v.updatedAt)} />
              </div>
            )}
            <VolumeStatusCard volume={v} />
          </div>
        ))}
      </div>
    </section>
  );
}

export function ReviewerDashboard({ groups }: ReviewerDashboardProps) {
  const { t } = useTranslation("dashboard");
  const totalVolumes =
    groups.awaitingReview.length +
    groups.reviewed.length +
    groups.approved.length;

  if (totalVolumes === 0) {
    return (
      <div className="mt-12 flex justify-center">
        <div className="mx-auto max-w-md rounded-xl bg-white p-8 shadow-sm ring-1 ring-stone-100 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-indigo-tint">
            <svg className="h-7 w-7 text-indigo" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
          </div>
          <h3 className="mt-4 font-serif text-lg font-semibold text-indigo">{t("empty.no_review_title")}</h3>
          <p className="mt-2 font-serif text-15 text-stone-500 max-w-measure mx-auto">
            {t("empty.no_review_body")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <ReviewGroup
        title={t("group.awaiting_review")}
        volumes={groups.awaitingReview}
        showWaiting
      />
      <ReviewGroup title={t("group.reviewed")} volumes={groups.reviewed} />
      <ReviewGroup title={t("group.approved")} volumes={groups.approved} />
    </div>
  );
}
