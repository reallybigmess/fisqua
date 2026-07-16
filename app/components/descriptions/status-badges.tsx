/**
 * Status Badges
 *
 * This module deals with the pill badges for description publish status
 * (Live, Pending publish, Pending removal) used across the descriptions
 * list and edit pages.
 *
 * @version v0.4.2
 */

import { useTranslation } from "react-i18next";

// ---------------------------------------------------------------------------
// Publish status computation
// ---------------------------------------------------------------------------

export type PublishStatus =
  | "live"
  | "pending_publish"
  | "pending_removal"
  | "unpublished";

export function getPublishStatus(
  isPublished: boolean,
  lastExportedAt: number | null,
  updatedAt: number
): PublishStatus {
  if (isPublished && lastExportedAt && lastExportedAt >= updatedAt)
    return "live";
  if (isPublished && (!lastExportedAt || lastExportedAt < updatedAt))
    return "pending_publish";
  if (!isPublished && lastExportedAt) return "pending_removal";
  return "unpublished";
}

// ---------------------------------------------------------------------------
// Badge colour map
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<PublishStatus, string> = {
  live: "bg-verdigris-tint text-verdigris-deep",
  pending_publish: "bg-saffron-tint text-saffron-deep",
  pending_removal: "bg-indigo-tint text-indigo",
  unpublished: "bg-stone-100 text-stone-600",
};

const STATUS_KEYS: Record<PublishStatus, string> = {
  live: "live_badge",
  pending_publish: "pending_publish",
  pending_removal: "pending_removal",
  unpublished: "unpublished_badge",
};

// ---------------------------------------------------------------------------
// StatusBadge component
// ---------------------------------------------------------------------------

interface StatusBadgeProps {
  isPublished: boolean;
  lastExportedAt: number | null;
  updatedAt: number;
}

export function StatusBadge({
  isPublished,
  lastExportedAt,
  updatedAt,
}: StatusBadgeProps) {
  const { t } = useTranslation("descriptions_admin");
  const status = getPublishStatus(isPublished, lastExportedAt, updatedAt);
  const style = STATUS_STYLES[status];
  const label = t(STATUS_KEYS[status]);

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 font-sans text-11 font-semibold uppercase tracking-[0.02em] ${style}`}
    >
      {label}
    </span>
  );
}
