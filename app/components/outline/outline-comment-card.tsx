/**
 * Outline Comment Card
 *
 * This card is the compact comment surface rendered inside an outline
 * entry. Shares the card chrome with `CommentCard` but adapts spacing and
 * truncation to the narrower outline column.
 *
 * @version v0.4.2
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, ChevronRight, MessageSquare } from "lucide-react";
import type { CommentWithAuthor } from "../../lib/description-types";
import { RegionChip } from "../comments/region-chip";
import { InlineCommentComposer } from "../comments/inline-comment-composer";
import {
  CommentKebabMenu,
  type CommentKebabAction,
} from "../comments/comment-kebab-menu";

/**
 * Input shape: the top-level comment plus any flat list of replies
 * (replies are filtered by `parentId === comment.id` upstream — this
 * component does not walk the tree).
 */
export interface OutlineCommentCardProps {
  comment: CommentWithAuthor;
  replies: CommentWithAuthor[];
  entrySequence: number;
  /**
 * The owning entry id for this comment (attached: comment.entryId;
 * anchored: resolved upstream). Used to build reply payloads
 * since replies anchor to the same entry as the parent thread.
 */
  ownerEntryId: string;
  volumeId: string;
  isHighlighted: boolean;
  isExpanded: boolean;
  /**
 * who is looking at the card right now. Drives
 * the kebab menu's author/lead gating in 13.F. Present in 13.E as
 * pure prop plumbing -- no visual behaviour yet.
 */
  currentUserId?: string;
  currentUserIsLead?: boolean;
  /**
 * handlers. Called by the kebab menu; the parent chain
 * (outline-panel -> viewer route in 13.H) translates each into a
 * fetcher submission. Optional so legacy callers keep working -- the
 * kebab simply does not render if the handlers are not provided.
 */
  onEditComment?: (commentId: string, newText: string) => void;
  onDeleteComment?: (commentId: string) => void;
  onResolveComment?: (commentId: string, resolved: boolean) => void;
  /**
 * 1-indexed page number for the RegionChip label. Required when the
 * comment is region-anchored; ignored otherwise.
 */
  pageNumber?: number;
  onToggleExpand: () => void;
  onScrollToRegion?: (commentId: string) => void;
  onMarkSeen?: (commentId: string) => void;
  /** Virtualiser remeasure trigger — called on expand toggle. */
  onHeightChange?: () => void;
  /**
 * Fires after a reply submit succeeds so the panel/route can
 * revalidate the loader (same pattern as the entry-level draft).
 */
  onReplyCreated?: () => void;
}

/**
 * chip visibility gate. The chip renders only when the card is
 * expanded AND the comment carries region coords AND the caller supplied
 * a pageNumber. Collapsed cards hide the chip to keep the preview row
 * compact; the card's highlighted state still signals region-
 * anchoredness to the reader.
 */
export function shouldShowRegionChip(
  comment: Pick<CommentWithAuthor, "regionX" | "regionY" | "pageId">,
  isExpanded: boolean,
  pageNumber: number | undefined,
): boolean {
  if (!isExpanded) return false;
  if (pageNumber == null) return false;
  if (comment.pageId == null) return false;
  if (comment.regionX == null) return false;
  if (comment.regionY == null) return false;
  return true;
}

/**
 * Total count for the reply-count chip: parent + replies. Returns
 * `null` when there are no replies (chip is hidden in that case).
 */
export function computeReplyCountLabel(
  replies: CommentWithAuthor[],
): number | null {
  if (replies.length === 0) return null;
  return replies.length + 1;
}

/**
 * Anchoring -> header kind + i18n key (2026-04-18 user call):
 * - has region (pin / box on an image) → "Anotación" / "Annotation"
 * - no region (plain entry-level comment) → "Comentario" / "Comment"
 *
 * Role (cataloguer vs reviewer) is still communicated by the 3px left
 * connector bar colour and by the reply role labels in the thread
 * footer; the header label no longer carries role information.
 */
export function formatCommentHeader(
  hasRegion: boolean,
): { kindKey: "comment_kind_annotation" | "comment_kind_comment" } {
  return {
 kindKey: hasRegion ? "comment_kind_annotation" : "comment_kind_comment",
  };
}

/**
 * Role colour for the 3px left connector bar. Reviewer green, cataloguer
 * / lead blue. Highlighted state overrides with full burgundy.
 */
function computeConnectorClass(role: string, isHighlighted: boolean): string {
  if (isHighlighted) return "bg-indigo";
  if (role === "reviewer") return "bg-verdigris/30";
  return "bg-indigo/30";
}

/**
 * Card shell class (container). Palette branches on anchoring kind
 * (user call 2026-04-18; flipped 2026-04-18 afternoon — annotations
 * get the stronger burgundy signal, comments get the quieter cream):
 * - anchored (annotation)  → barely-there burgundy `#FDF4F5`
 * - unanchored (comment) → barely-there cream `#FBF8F1`
 * Highlighted state overrides to saturated burgundy-pink with a
 * burgundy border + ring regardless of kind, so pin-selection always
 * reads distinctly against the quiet default palette.
 */
export function computeCardShellClass(
  isHighlighted: boolean,
  hasRegion: boolean,
  isResolved: boolean = false,
): string {
  const base =
 "relative overflow-hidden rounded-lg border shadow-sm transition-colors";
  if (isHighlighted) {
 // Highlight always wins over resolved dimming so pin-selection
 // stays legible even on a resolved thread.
 return `${base} border-indigo bg-madder-tint ring-1 ring-indigo/20 scale-[1.02]`;
  }
  if (isResolved) {
 // quiet the card when the thread is closed. Stone
 // border + white-ish background disambiguates from open cards
 // without going fully grey (which would read as disabled).
 return `${base} border-stone-300 bg-white hover:border-stone-400`;
  }
  if (hasRegion) {
 return `${base} border-madder-tint bg-madder-wash hover:border-indigo/30`;
  }
  return `${base} border-parchment-deep bg-parchment hover:border-indigo/30`;
}

function formatRelativeTime(timestamp: number, locale: string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
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

export function OutlineCommentCard({
  comment,
  replies,
  entrySequence,
  ownerEntryId,
  volumeId,
  isHighlighted,
  isExpanded,
  pageNumber,
  onToggleExpand,
  onScrollToRegion,
  onMarkSeen,
  onHeightChange,
  onReplyCreated,
  currentUserId,
  currentUserIsLead,
  onEditComment,
  onDeleteComment,
  onResolveComment,
}: OutlineCommentCardProps) {
  const { t, i18n } = useTranslation(["viewer", "comments"]);
  const locale = i18n.language?.startsWith("es") ? "es-CO" : "en-US";
  const [isReplying, setIsReplying] = useState(false);
  // Task #13 local UI state.
  const [editMode, setEditMode] = useState(false);
  const [editDraft, setEditDraft] = useState(comment.text);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // `onHeightChange` is intentionally retained as a prop for API
  // compatibility but no longer invoked from this component. TanStack
  // Virtual's ResizeObserver (installed via `measureElement` on the row
  // wrapper in OutlinePanel) catches every height change automatically.
  void onHeightChange;

  const hasRegion = comment.regionX != null && comment.regionY != null;
  const { kindKey } = formatCommentHeader(hasRegion);
  const connectorClass = computeConnectorClass(comment.authorRole, isHighlighted);
  const isResolved = comment.resolvedAt != null;
  const shellClass = computeCardShellClass(
 isHighlighted,
 hasRegion,
 isResolved,
  );
  const showChip = shouldShowRegionChip(comment, isExpanded, pageNumber);
  const replyCount = computeReplyCountLabel(replies);

  const isRoot = comment.parentId == null;
  const isAuthor =
 currentUserId != null && comment.authorId === currentUserId;
  const isLead = currentUserIsLead === true;
  const isEdited = comment.editedAt != null;

  const handleToggle = () => {
 // Don't collapse the card mid-edit -- the textarea would be torn
 // down and the draft text lost.
 if (editMode) return;
 onToggleExpand();
 // Note: `onHeightChange` is intentionally not invoked here. The
 // outline panel attaches `virtualizer.measureElement` to each row,
 // which installs a ResizeObserver — height changes are picked up
 // automatically. Calling `virtualizer.measure()` here was part of
 // the scroll-back cascade (see resolved debug session
 // outline-scroll-snaps-back).
  };

  const handleKebabAction = (action: CommentKebabAction) => {
 switch (action) {
 case "edit":
 setEditDraft(comment.text);
 setEditMode(true);
 if (!isExpanded) {
 // Ensure the body area is visible so the textarea mount is
 // not hidden by a collapsed card.
 onToggleExpand();
 }
 // ResizeObserver installed via measureElement handles the
 // resulting height change.
 break;
 case "delete":
 if (isRoot && replies.length > 0) {
 setConfirmDelete(true);
 } else {
 // Leaf delete or root with no replies: a simpler confirm.
 setConfirmDelete(true);
 }
 break;
 case "resolve":
 if (onResolveComment) onResolveComment(comment.id, true);
 break;
 case "reopen":
 if (onResolveComment) onResolveComment(comment.id, false);
 break;
 }
  };

  const handleEditSave = () => {
 const trimmed = editDraft.trim();
 if (trimmed.length === 0) return;
 if (onEditComment) onEditComment(comment.id, trimmed);
 setEditMode(false);
 // ResizeObserver picks up the height change from textarea unmount.
  };

  const handleEditCancel = () => {
 setEditMode(false);
 setEditDraft(comment.text);
 // ResizeObserver picks up the height change from textarea unmount.
  };

  const handleDeleteConfirm = () => {
 if (onDeleteComment) onDeleteComment(comment.id);
 setConfirmDelete(false);
  };

  return (
 <div className="ml-9 mb-2">
 <div className={shellClass}>
 {/* 3px left connector bar */}
 <div
 className={`absolute left-0 top-0 bottom-0 w-[3px] transition-colors ${connectorClass}`}
 aria-hidden="true"
 />

 {/* Header row: toggle button + kebab as siblings so the kebab's
 click-target isn't nested inside the toggle button (nested
 interactive elements are a11y + browser-behaviour trap).
 kebab lives on the far right; the chevron
 stays at the end of the toggle button. */}
 <div className="flex w-full items-center gap-2 px-3 py-1.5">
 <button
 type="button"
 onClick={handleToggle}
 className="flex flex-1 items-center gap-2 text-left"
 aria-expanded={isExpanded}
 >
 {/* Icon box colour matches the card kind: madder-tint for
 annotations (anchored to a region pin), parchment for
 comments (anchored to the entry sequence). The icon stroke
 stays indigo on both so the kind reads at a glance. */}
 <div
 className={`shrink-0 rounded p-1 ${
 hasRegion ? "bg-madder-tint" : "bg-parchment-deep"
 }`}
 >
 <MessageSquare
 className="h-3 w-3 text-indigo"
 aria-hidden="true"
 />
 </div>
 {/* Author name — dominant element in the reading order. */}
 <span className="min-w-0 truncate font-sans text-xs font-medium text-stone-800">
 {comment.authorName ?? comment.authorEmail ?? ""}
 </span>
 {/* Kind · anchor caption: Annotations reference the image
 , comments reference the owning entry's Doc sequence. */}
 <span className="shrink-0 font-sans text-10 font-bold uppercase tracking-wider text-indigo">
 {t(`viewer:outline.${kindKey}`)} ·{" "}
 {hasRegion && pageNumber != null
 ? t("viewer:outline.comment_img_prefix", { n: pageNumber })
 : t("viewer:outline.comment_doc_prefix", { n: entrySequence })}
 </span>
 {/* small state chips. "Editado" when comment.editedAt
 is set; "Resuelto" (green) when comment.resolvedAt is set.
 Sit inline with the kind caption so the header stays one row. */}
 {isEdited && (
 <span
 className="shrink-0 font-sans text-10 font-medium uppercase tracking-wider text-stone-500"
 title={new Date(comment.editedAt!).toISOString()}
 >
 · {t("comments:comments.status.edited")}
 </span>
 )}
 {isResolved && (
 <span className="flex shrink-0 items-center gap-0.5 rounded bg-verdigris-tint px-1.5 py-0.5 font-sans text-10 font-bold text-verdigris">
 <CheckCircle2 className="h-[10px] w-[10px]" aria-hidden="true" />
 <span>{t("comments:comments.status.resolved")}</span>
 </span>
 )}
 {/* Reply-count chip lives inline (2026-04-18: was on its own
 row below, doubling card height). Only renders when there
 are replies AND the card is collapsed. */}
 {!isExpanded && replyCount != null && (
 <span className="ml-auto flex shrink-0 items-center gap-1 rounded bg-indigo/10 px-1.5 py-0.5 font-sans text-10 font-bold text-indigo">
 <MessageSquare className="h-[10px] w-[10px]" aria-hidden="true" />
 <span>{replyCount}</span>
 </span>
 )}
 <span
 className={`${replyCount != null && !isExpanded ? "" : "ml-auto"} shrink-0 font-sans text-10 font-medium text-stone-400`}
 >
 {formatRelativeTime(comment.createdAt, locale)}
 </span>
 <ChevronRight
 className={`h-4 w-4 shrink-0 text-stone-500 transition-transform ${
 isExpanded ? "rotate-90" : ""
 }`}
 aria-hidden="true"
 />
 </button>
 {/* Kebab menu. Sibling of the toggle button so click
 events on the kebab don't bubble into toggleExpand. Renders
 null when the gate helper returns no items. */}
 {(onEditComment || onDeleteComment || onResolveComment) && (
 <CommentKebabMenu
 isAuthor={isAuthor}
 isLead={isLead}
 isResolved={isResolved}
 isRoot={isRoot}
 isDeleted={false}
 onAction={handleKebabAction}
 />
 )}
 </div>
 {isExpanded && (
 <div className="space-y-3 px-4 pb-3">
 {showChip && pageNumber != null && (
 <div>
 <RegionChip
 commentId={comment.id}
 pageNumber={pageNumber}
 onScrollToRegion={onScrollToRegion ?? (() => {})}
 />
 </div>
 )}
 {editMode ? (
 <div className="space-y-2">
 <textarea
 value={editDraft}
 onChange={(e) => setEditDraft(e.target.value)}
 rows={3}
 className="w-full rounded border border-stone-200 bg-white px-3 py-2 font-serif text-15 italic leading-[1.5] text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
 aria-label={t("comments:comments.edit.aria_label")}
 />
 <div className="flex items-center justify-end gap-2">
 <button
 type="button"
 onClick={handleEditCancel}
 className="font-sans text-11 font-medium text-stone-500 hover:text-stone-700"
 >
 {t("comments:comments.edit.cancel")}
 </button>
 <button
 type="button"
 onClick={handleEditSave}
 disabled={editDraft.trim().length === 0}
 className="rounded bg-indigo px-3 py-1 font-sans text-11 font-bold text-parchment transition-colors hover:bg-indigo-deep disabled:opacity-50"
 >
 {t("comments:comments.edit.save")}
 </button>
 </div>
 </div>
 ) : (
 <p
 className={`font-serif text-15 leading-[1.5] ${
 isResolved ? "text-stone-500" : "text-stone-700"
 }`}
 >
 {comment.text}
 </p>
 )}
 </div>
 )}

 {/* Expanded thread footer: nested replies + action row */}
 {isExpanded && (
 <>
 {replies.length > 0 && (
 <div className="border-t border-stone-200/50 bg-white/50">
 <div className="bg-stone-100/30 px-4 py-2 font-sans text-10 font-bold uppercase tracking-widest text-stone-400">
 {t("viewer:outline.comment_thread_header")}
 </div>
 <ul className="divide-y divide-stone-200/30">
 {replies.map((reply) => (
 <li key={reply.id} className="p-3 pl-6">
 {/* Hierarchy: author name dominant, role as a
 smaller caption beside. Same flip as the main
 card header (2026-04-18 afternoon). */}
 <div className="mb-1 flex items-baseline justify-between gap-2">
 <div className="flex items-baseline gap-2 min-w-0">
 <span className="font-sans text-xs font-medium text-stone-800 truncate">
 {reply.authorName ?? reply.authorEmail ?? ""}
 </span>
 <span
 className={`font-sans text-10 font-bold uppercase tracking-wider shrink-0 ${
 reply.authorRole === "reviewer"
 ? "text-verdigris"
 : "text-indigo"
 }`}
 >
 {t(
 reply.authorRole === "reviewer"
 ? "comments:roles.revisor"
 : "comments:roles.catalogador",
 )}
 </span>
 </div>
 <span className="font-sans text-10 font-medium text-stone-400 shrink-0">
 {formatRelativeTime(reply.createdAt, locale)}
 </span>
 </div>
 <p className="font-serif text-15 leading-[1.5] text-stone-700">
 {reply.text}
 </p>
 </li>
 ))}
 </ul>
 </div>
 )}

 <div className="flex items-center justify-between border-t border-stone-200/30 bg-white/30 px-4 py-2">
 <div className="flex items-center gap-4">
 <button
 type="button"
 onClick={() => {
 setIsReplying((v) => !v);
 // ResizeObserver via measureElement handles the height change.
 }}
 className="font-sans text-10 font-bold uppercase tracking-wider text-indigo hover:underline"
 >
 {t("viewer:outline.comment_reply")}
 </button>
 {onMarkSeen && (
 <button
 type="button"
 onClick={() => onMarkSeen(comment.id)}
 className="font-sans text-10 font-bold uppercase tracking-wider text-stone-500 hover:underline"
 >
 {t("viewer:outline.comment_mark_seen")}
 </button>
 )}
 </div>
 </div>

 {isReplying && (
 <div className="border-t border-stone-200/30 bg-white/40 p-3 pl-6">
 <InlineCommentComposer
 region={null}
 entryId={ownerEntryId}
 parentId={comment.id}
 volumeId={volumeId}
 onCreated={() => {
 setIsReplying(false);
 onReplyCreated?.();
 // ResizeObserver handles the height change.
 }}
 onCancel={() => {
 setIsReplying(false);
 // ResizeObserver handles the height change.
 }}
 className="relative overflow-hidden rounded border border-stone-200 bg-white"
 />
 </div>
 )}
 </>
 )}
 </div>
 {/* delete confirm dialog. Renders count-aware
 copy when deleting a root with replies (mirrors entry
 delete warning). Lightweight overlay matching the existing
 dialog pattern used by RaiseFlagDialog / ResolveQcFlagDialog. */}
 {confirmDelete && (
 <div
 className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
 role="dialog"
 aria-modal="true"
 onClick={() => setConfirmDelete(false)}
 >
 <div
 className="w-full max-w-sm rounded-lg bg-white p-5 shadow-lg"
 onClick={(e) => e.stopPropagation()}
 >
 <h3 className="mb-2 font-sans text-15 font-bold text-stone-800">
 {t(
 isRoot && replies.length > 0
 ? "comments:comments.confirm.delete_root_with_replies.title"
 : "comments:comments.confirm.delete_simple.title",
 )}
 </h3>
 <p className="mb-4 font-sans text-13 text-stone-600">
 {isRoot && replies.length > 0
 ? t(
 "comments:comments.confirm.delete_root_with_replies.body",
 { count: replies.length },
 )
 : t("comments:comments.confirm.delete_simple.body")}
 </p>
 <div className="flex items-center justify-end gap-2">
 <button
 type="button"
 onClick={() => setConfirmDelete(false)}
 className="px-3 py-1 font-sans text-xs font-medium text-stone-500 hover:text-stone-700"
 >
 {t("comments:comments.confirm.delete.cancel")}
 </button>
 <button
 type="button"
 onClick={handleDeleteConfirm}
 className="rounded bg-indigo px-3 py-1 font-sans text-xs font-bold text-parchment transition-colors hover:bg-indigo-deep"
 >
 {t("comments:comments.confirm.delete.confirm")}
 </button>
 </div>
 </div>
 </div>
 )}
 </div>
  );
}

