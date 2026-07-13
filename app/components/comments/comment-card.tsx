/**
 * Comment Card
 *
 * This card is the presentational surface for one comment thread post —
 * author, timestamp, body, and, when the current user owns the comment,
 * the kebab menu with edit and delete actions. Renders the resolved badge
 * when the thread has been closed.
 *
 * @version v0.4.2
 */
import { useTranslation } from "react-i18next";
import type { CommentWithAuthor } from "../../lib/description-types";
import { RegionChip } from "./region-chip";

type CommentCardProps = {
  comment: CommentWithAuthor;
  onReply: (commentId: string) => void;
  depth: number;
  /**
 * click handler for the inline RegionChip.
 * Forwarded from OutlineEntry -> CommentThread. Chip is rendered
 * only when the comment has region coords AND the caller supplied
 * a `pageNumber` lookup. When this prop is missing, the chip still
 * renders but its click is a no-op (defence-in-depth).
 */
  onScrollToRegion?: (commentId: string) => void;
  /** 1-indexed page number for the chip label. */
  pageNumber?: number;
};

const ROLE_BADGE_STYLES: Record<string, string> = {
  cataloguer: "bg-indigo-tint text-indigo",
  reviewer: "bg-verdigris-tint text-verdigris",
  lead: "bg-indigo-tint text-indigo",
};

const ROLE_I18N_KEYS: Record<string, string> = {
  cataloguer: "roles.catalogador",
  reviewer: "roles.revisor",
  lead: "roles.lead",
};

/**
 * Pure predicate: should the inline RegionChip render above this
 * comment's body? True iff the comment row carries both region X/Y
 * coordinates AND a pageId, AND the caller supplied a 1-indexed
 * `pageNumber` to label the chip. Exported so tests can assert the
 * gate without rendering ().
 */
export function shouldRenderRegionChip(
  comment: Pick<CommentWithAuthor, "regionX" | "regionY" | "pageId">,
  pageNumber: number | undefined,
): boolean {
  // Visibility gate: the chip renders iff `regionX !== null`,
  // `regionY !== null`, `pageId !== null`, AND the caller supplied a
  // pageNumber for the label. Any of those falling through yields
  // `false` and the chip stays hidden.
  if (pageNumber == null) return false;
  if (comment.pageId == null) return false;
  if (!(comment.regionX !== null)) return false;
  if (!(comment.regionY !== null)) return false;
  return true;
}

function formatRelativeTime(timestamp: number): string {
  const rtf = new Intl.RelativeTimeFormat("es-CO", { numeric: "auto" });
  const diffMs = timestamp - Date.now();
  const diffSec = Math.round(diffMs / 1000);
  const diffMin = Math.round(diffSec / 60);
  const diffHr = Math.round(diffMin / 60);
  const diffDay = Math.round(diffHr / 24);

  if (Math.abs(diffSec) < 60) return rtf.format(diffSec, "second");
  if (Math.abs(diffMin) < 60) return rtf.format(diffMin, "minute");
  if (Math.abs(diffHr) < 24) return rtf.format(diffHr, "hour");
  return rtf.format(diffDay, "day");
}

export function CommentCard({
  comment,
  onReply,
  depth,
  onScrollToRegion,
  pageNumber,
}: CommentCardProps) {
  const { t } = useTranslation("comments");

  const isTopLevel = depth === 0;
  const cardBg = isTopLevel ? "bg-indigo-tint" : "bg-white border border-stone-200";
  const showChip = shouldRenderRegionChip(comment, pageNumber);

  return (
 <div
 className={`rounded-lg p-3 ${cardBg}`}
 style={depth > 0 ? { marginLeft: `${depth * 1.5}rem` } : undefined}
 >
 {/* Header: role badge, author, timestamp */}
 <div className="mb-1.5 flex items-center justify-between">
 <div className="flex items-center gap-2">
 <span
 className={`rounded px-2 py-0.5 font-sans text-xs font-semibold ${ROLE_BADGE_STYLES[comment.authorRole] || ROLE_BADGE_STYLES.cataloguer}`}
 >
 {t(ROLE_I18N_KEYS[comment.authorRole] || "roles.catalogador")}
 </span>
 <span className="font-sans text-xs text-stone-500">
 {comment.authorEmail}
 </span>
 </div>
 <span className="font-sans text-xs text-stone-400">
 {formatRelativeTime(comment.createdAt)}
 </span>
 </div>

 {/* Region chip -- rendered ABOVE the comment body when the
 comment is region-anchored and a page number is available. */}
 {showChip && pageNumber != null && (
 <div className="mb-2">
 <RegionChip
 commentId={comment.id}
 pageNumber={pageNumber}
 onScrollToRegion={onScrollToRegion ?? (() => {})}
 />
 </div>
 )}

 {/* Comment text */}
 <p className="font-serif text-15 italic leading-[1.6] text-stone-700">
 {comment.text}
 </p>

 {/* Reply link */}
 <button
 type="button"
 className="mt-1.5 font-sans text-xs font-semibold text-indigo hover:underline"
 onClick={() => onReply(comment.id)}
 >
 {t("responder")}
 </button>
 </div>
  );
}

