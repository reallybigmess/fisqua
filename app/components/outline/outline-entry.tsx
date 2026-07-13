/**
 * Outline Entry
 *
 * This component is one entry row inside the outline panel — reference
 * code, title pill, segmentation state, open-comments count, and the
 * resegmentation flag badge when one is pending. Expands on click to
 * reveal the inline comment thread and any region-pin chips.
 *
 * @version v0.4.2
 */
import { useState, useRef, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import type { Entry, EntryType } from "../../lib/boundary-types";
import {
  ResegmentationCard,
  type ResegmentationCardFlag,
} from "./resegmentation-card";
import {
  DEFAULT_DOCUMENT_SUBTYPES,
  OTHER_SUBTYPE_SENTINEL,
} from "../../_data/document-subtypes";

/**
 * Non-document EntryType options surfaced in the second branch of the
 * "¿Es un documento?" type picker. Order matters: leftmost button wins
 * keyboard Tab focus first. Labels are i18n-localised; the underlying
 * EntryType is Colombian Spanish / English-agnostic.
 */
const NON_DOCUMENT_TYPE_OPTIONS: readonly {
  value: Exclude<EntryType, "item">;
  labelKey: string;
}[] = [
  { value: "front_matter", labelKey: "viewer:outline.type.front_matter" },
  { value: "test_images", labelKey: "viewer:outline.type.test_images" },
  { value: "blank", labelKey: "viewer:outline.type.blank" },
  { value: "back_matter", labelKey: "viewer:outline.type.back_matter" },
];

/**
 * Pure predicate: should the header render the entry's title at all?
 * Hidden when the string is empty, whitespace-only, or the sentinel
 * "Untitled" placeholder. The expanded-card body still shows the
 * editable input regardless; this guard applies to the inline header
 * display only.
 */
export function shouldHideTitle(title: string | null | undefined): boolean {
  if (title == null) return true;
  const trimmed = title.trim();
  if (trimmed.length === 0) return true;
  if (trimmed === "Untitled") return true;
  return false;
}

type OutlineEntryProps = {
  entry: Entry;
  refCode: string;
  pageRange: string;
  depth: number;
  isLast: boolean;
  isHighlighted: boolean;
  isExpanded: boolean;
  hasChildren: boolean;
  canIndent: boolean;
  canOutdent: boolean;
  onToggle: () => void;
  onScrollTo: () => void;
  onSetType: (type: EntryType | null) => void;
  /** post-Wave-2: set the per-entry document subtype label. */
  onSetSubtype?: (subtype: string | null) => void;
  /** post-Wave-2: per-project subtype picklist (fallback: seed). */
  documentSubtypes?: readonly string[];
  onSetTitle: (title: string) => void;
  onIndent: () => void;
  onOutdent: () => void;
  volumeId?: string;
  accessLevel: "edit" | "review" | "readonly";
  onHeightChange?: () => void;
  isReviewerModified?: boolean;
  isReadonly?: boolean;
  isFirstEntry?: boolean;
  onDelete?: (entryId: string) => void;
  /** open resegmentation flag on this entry, if any. */
  openResegFlag?: ResegmentationCardFlag | null;
  /** CTA on the ResegmentationCard opens the dialog. */
  onOpenResegDialog?: (flagId: string) => void;
  /**
 * opens the mandatory-comment prompt for an
 * entry-level comment (no region). The outline panel wires this to
 * the viewer route's promptState setter, which in turn mounts the
 * CommentPrompt dialog.
 */
  onOpenCommentPrompt?: () => void;
  /**
 * count of attached comments that will be deleted
 * with this entry. When > 0 the delete-confirm surfaces the exact N
 * so the user knows what's being destroyed.
 */
  attachedCommentCount?: number;
  /**
 * count of region/point-anchored comments currently
 * resolving to this entry. These SURVIVE the entry delete
 * and re-parent on next render; shown in the confirm copy as
 * information, not warning.
 */
  anchoredCommentCount?: number;
  children?: React.ReactNode;
};

// Entry-type pills, mapped onto the Fisqua status palette by role:
//   item        -> indigo  (primary, in-progress: a real document entry)
//   blank       -> stone   (draft / unstarted)
//   front/back  -> saffron (segmented but not a document — "matter")
//   test_images -> sage    (a "reviewed-aside" — flagged out of scope)
const TYPE_BADGE_COLORS: Record<string, string> = {
  item: "bg-indigo-tint text-indigo",
  blank: "bg-stone-100 text-stone-600",
  front_matter: "bg-saffron-tint text-saffron-deep",
  back_matter: "bg-saffron-tint text-saffron-deep",
  test_images: "bg-sage-tint text-sage-deep",
};

/**
 * Pure helper: build the two i18n key lookups for the delete-confirm
 * warning. Returns the lookups (with count interpolation args) the caller
 * passes to `t(...)`. The return shape lists only the lines the copy
 * should surface for these counts — callers can join with "\n".
 *
 * Copy rules :
 * - attached > 0  → attached-warning line
 * - anchored > 0  → anchored-info line
 * - both zero → no warning lines (caller skips the dialog)
 */
export function buildDeleteWarningLines(
  attached: number,
  anchored: number,
): Array<{ key: string; vars: { count: number } }> {
  const lines: Array<{ key: string; vars: { count: number } }> = [];
  if (attached > 0) {
 lines.push({
 key: "viewer:outline.delete_with_attached_count",
 vars: { count: attached },
 });
  }
  if (anchored > 0) {
 lines.push({
 key: "viewer:outline.delete_with_anchored_remaining",
 vars: { count: anchored },
 });
  }
  return lines;
}

/**
 * Pure predicate: should the violet "Resegmentación propuesta" pill render
 * on this entry's header row? True iff an open resegmentation flag was
 * supplied. Exported for the Wave-0 option-b predicate tests.
 */
export function shouldShowResegPill(
  openResegFlag: ResegmentationCardFlag | null | undefined,
): boolean {
  return openResegFlag != null;
}

/**
 * Pure helper: return the className string for the outline card's outer
 * wrapper. Exported so tests can assert the card pattern without
 * rendering. Always includes `rounded-lg` and `border` plus the state-
 * dependent highlight / reviewer-modified tokens.
 *
 * 2026-04-18 user call: document entries (`type === "item"`) render on
 * a barely-there periwinkle tint (`#F5F7FC`) so they stand out subtly
 * from the non-document rows (front_matter / back_matter / blank /
 * test_images) which keep the white background. Reviewer-modified and
 * highlighted states still win over the type-based default.
 */
export function computeCardClassName(params: {
  isReviewerModified: boolean;
  isHighlighted: boolean;
  entryType?: EntryType | null;
}): string {
  const isDocument = params.entryType === "item";
  const typeBg = isDocument ? "bg-indigo-wash" : "bg-white";
  const base = [
 "rounded-lg",
 "border",
 typeBg,
 "transition-colors",
 "hover:border-indigo/40",
  ];
  if (params.isReviewerModified) {
 base.push("border-madder");
 base.push("bg-madder-tint");
  } else if (params.isHighlighted) {
 base.push("border-indigo");
  } else {
 base.push("border-stone-200");
  }
  return base.join(" ");
}

export function OutlineEntry({
  entry,
  refCode,
  depth,
  pageRange,
  isHighlighted,
  isExpanded,
  canIndent,
  canOutdent,
  onToggle,
  onScrollTo,
  onSetType,
  onSetSubtype,
  documentSubtypes,
  onSetTitle,
  onIndent,
  onOutdent,
  volumeId,
  accessLevel,
  onHeightChange,
  isReviewerModified,
  isFirstEntry,
  onDelete,
  openResegFlag,
  onOpenResegDialog,
  onOpenCommentPrompt,
  attachedCommentCount = 0,
  anchoredCommentCount = 0,
  children,
}: OutlineEntryProps) {
  const { t } = useTranslation(["viewer", "resegmentation", "comments"]);
  const titleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isReadonly = accessLevel === "readonly";

  // Virtualiser remeasure: NO-OP on the entry side. The outline panel
  // attaches `virtualizer.measureElement` to each row's wrapper, and
  // TanStack Virtual installs a ResizeObserver inside that call which
  // catches every height change (expand/collapse, reseg flag mount,
  // draft-comment row mount, etc.) automatically. The previous effect
  // here called `virtualizer.measure()` (a full cache reset) on every
  // render because `onHeightChange` was a fresh closure each render —
  // that was the root of the scroll-back cascade. The `onHeightChange`
  // prop is kept for API compatibility but is no longer invoked from
  // this component.
  void onHeightChange;

  const handleClick = useCallback(() => {
 onToggle();
 onScrollTo();
  }, [onToggle, onScrollTo]);

  // Two-step type picker: the cataloguer first
  // answers "¿Es un documento?". A Yes defaults to an `item` type and
  // opens the subtype picklist; a No opens the four non-document
  // options (front_matter, test_images, blank, back_matter).
  //
  // `isDocumentChoice` is a 3-state UI value:
  // * "yes" -> entry.type === "item"
  // * "no" -> entry.type is one of the non-document values
  // * null -> entry.type === null (unset)
  //
  // Kept as local UI state so toggling "Yes" before picking a subtype
  // does not commit an incomplete type to the reducer. Changing to
  // "yes" immediately commits `type = 'item'` so the expanded body
  // flows into the subtype picklist + title input reveal.
  const isDocumentChoice: "yes" | "no" | null =
 entry.type === "item" ? "yes" : entry.type == null ? null : "no";

  const [otherDraft, setOtherDraft] = useState("");

  const effectiveSubtypes =
 documentSubtypes && documentSubtypes.length > 0
 ? documentSubtypes
 : DEFAULT_DOCUMENT_SUBTYPES;

  // Dropdown selection is UI state that can differ from the stored
  // subtype. The stored subtype is written only when it is non-empty,
  // but the user needs to pick "OTRO" and have the free-text input
  // appear BEFORE anything is typed — so the select value is held
  // locally. Initialised (and reconciled) from entry.subtype: a stored
  // value that matches the picklist surfaces as that option; a stored
  // value outside the list (orphaned after a lead removed it, or a
  // cataloguer-typed "OTRO") surfaces as "OTRO"; null surfaces as "".
  const initialSubtypeSelection =
 entry.subtype != null && effectiveSubtypes.includes(entry.subtype)
 ? entry.subtype
 : entry.subtype != null
 ? OTHER_SUBTYPE_SENTINEL
 : "";
  const [selectedSubtypeInList, setSelectedSubtypeInList] = useState<string>(
 initialSubtypeSelection,
  );

  // Re-sync the local dropdown state when the stored subtype changes
  // from outside (e.g. another user's edit revalidated, entry switched
  // via virtualiser recycling, or lead removed the current term from
  // the project list).
  useEffect(() => {
 setSelectedSubtypeInList(initialSubtypeSelection);
 // Also refresh the free-text draft when the entry carries an
 // orphaned value, so the input pre-fills with that value.
 if (
 entry.subtype != null &&
 !effectiveSubtypes.includes(entry.subtype)
 ) {
 setOtherDraft(entry.subtype);
 }
 // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id, entry.subtype]);

  const handleDocumentChoice = useCallback(
 (choice: "yes" | "no") => {
 if (choice === "yes") {
 // Commit item type; subtype stays as-is (null for fresh entries).
 if (entry.type !== "item") {
 onSetType("item");
 }
 } else {
 // Leaving "yes" -> clear any stale subtype via SET_TYPE's
 // post-Wave-2 invariant (the reducer clears subtype when type
 // leaves 'item'). Default to front_matter as the first option
 // surfaced in the non-document list.
 if (entry.type === "item" || entry.type == null) {
 onSetType("front_matter");
 }
 }
 },
 [entry.type, onSetType],
  );

  const handleSubtypeSelect = useCallback(
 (e: React.ChangeEvent<HTMLSelectElement>) => {
 const value = e.target.value;
 // Update the local dropdown value unconditionally so the picker
 // keeps showing the user's choice -- including OTRO, which must
 // reveal the free-text input even before anything is typed.
 setSelectedSubtypeInList(value);
 if (value === "") {
 onSetSubtype?.(null);
 return;
 }
 if (value === OTHER_SUBTYPE_SENTINEL) {
 // Commit only when the free-text draft has content. Picking
 // OTRO with no text yet leaves entry.subtype untouched so the
 // reducer does not record an empty custom subtype.
 const clean = otherDraft.trim();
 if (clean.length > 0) onSetSubtype?.(clean);
 return;
 }
 onSetSubtype?.(value);
 },
 [onSetSubtype, otherDraft],
  );

  const handleOtherDraftChange = useCallback(
 (e: React.ChangeEvent<HTMLInputElement>) => {
 const value = e.target.value;
 setOtherDraft(value);
 const clean = value.trim();
 // The local dropdown stays on OTRO while the user types; only
 // the stored subtype changes.
 onSetSubtype?.(clean.length > 0 ? clean : null);
 },
 [onSetSubtype],
  );

  const handleNonDocTypeChoice = useCallback(
 (value: Exclude<EntryType, "item">) => {
 onSetType(value);
 },
 [onSetType],
  );

  const handleTitleChange = useCallback(
 (e: React.ChangeEvent<HTMLInputElement>) => {
 const value = e.target.value;
 if (titleTimeoutRef.current) clearTimeout(titleTimeoutRef.current);
 titleTimeoutRef.current = setTimeout(() => {
 onSetTitle(value);
 }, 400);
 },
 [onSetTitle],
  );

  const handleTitleBlur = useCallback(
 (e: React.FocusEvent<HTMLInputElement>) => {
 if (titleTimeoutRef.current) clearTimeout(titleTimeoutRef.current);
 onSetTitle(e.target.value);
 },
 [onSetTitle],
  );

  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleDeleteClick = useCallback(
 (e: React.MouseEvent) => {
 e.stopPropagation();
 if (confirmDelete) {
 // when the entry carries attached or anchored
 // comments, the second click routes through a modal confirm
 // that states both counts explicitly (what gets deleted + what
 // survives). Zero-zero keeps the existing 2-click pattern with
 // no extra interrupt.
 const warningLines = buildDeleteWarningLines(
 attachedCommentCount,
 anchoredCommentCount,
 );
 if (warningLines.length > 0 && typeof window !== "undefined") {
 const message = warningLines
 .map((line) => t(line.key, line.vars))
 .join("\n");
 if (!window.confirm(message)) {
 setConfirmDelete(false);
 return;
 }
 }
 onDelete?.(entry.id);
 setConfirmDelete(false);
 } else {
 setConfirmDelete(true);
 setTimeout(() => setConfirmDelete(false), 3000);
 }
 },
 [
 confirmDelete,
 entry.id,
 onDelete,
 attachedCommentCount,
 anchoredCommentCount,
 t,
 ],
  );

  const titleColor = isReviewerModified
 ? entry.title
 ? "text-madder-deep"
 : "italic text-madder"
 : entry.title
 ? "text-stone-800"
 : "italic text-stone-400";

  const typeLabel = entry.type ? t(`viewer:outline.type.${entry.type}`) : null;
  const showResegPill = shouldShowResegPill(openResegFlag);

  const cardClassName = computeCardClassName({
 isReviewerModified: Boolean(isReviewerModified),
 isHighlighted,
 entryType: entry.type,
  });

  return (
 <div
 className={`mb-2 ${cardClassName}`}
 style={{ marginLeft: depth * 16 }}
 >
 {/* Header row -- click target for expand / scroll. Height
 tightened 2026-04-18 afternoon to match the comment-card
 collapsed height: py-1.5, h-4 badge, 10px page range. */}
 <div
 className="flex cursor-pointer items-center gap-2 px-3 py-2"
 onClick={handleClick}
 >
 {/* Sequence badge */}
 <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-stone-200 font-sans text-10 font-medium text-stone-600">
 {entry.position + 1}
 </span>

 {/* Page range */}
 <span
 className={`shrink-0 font-sans text-10 ${
 isReviewerModified ? "text-madder" : "text-stone-500"
 }`}
 >
 {pageRange}
 </span>

 {/* Type badge -- moved before the title */}
 {entry.type && typeLabel && (
 <span
 className={`shrink-0 rounded-full px-1.5 py-0.5 font-sans text-10 font-medium ${
 isReviewerModified
 ? "bg-madder-tint text-madder-deep"
 : TYPE_BADGE_COLORS[entry.type]
 }`}
 >
 {typeLabel}
 </span>
 )}

 {/* Subtype pill -- only when type='item' AND subtype is non-null. */}
 {entry.type === "item" && entry.subtype && (
 <span
 className="shrink-0 rounded-full border border-stone-200 bg-stone-100 px-1.5 py-0.5 font-sans text-10 font-medium text-stone-700"
 title={entry.subtype}
 >
 {entry.subtype}
 </span>
 )}

 {/* Title -- hidden entirely when empty or equal to the
 "Untitled" sentinel; the body input stays the single source
 of truth for edits regardless. */}
 {!shouldHideTitle(entry.title) && (
 <span
 className={`min-w-0 truncate font-display text-xs italic ${titleColor}`}
 >
 {entry.title}
 </span>
 )}

 {/* reseg pill */}
 {showResegPill && (
 <span className="ml-2 inline-block rounded bg-violet-600 px-1.5 py-0.5 font-sans text-10 font-bold uppercase tracking-wide text-white">
 {t("resegmentation:proposed", {
 defaultValue: "Resegmentación propuesta",
 })}
 </span>
 )}

 {/* the comment-dot indicator was removed with the
 inline CommentThread. Outline comment cards render as
 standalone siblings below the entry, so a redundant dot is
 no longer informative. */}

 {/* Delete button (hidden in readonly mode and for first entry) */}
 {!isReadonly && !isFirstEntry && onDelete && (
 <button
 type="button"
 className={`shrink-0 rounded px-1 py-0.5 font-sans text-xs ${
 confirmDelete
 ? "bg-madder-tint text-madder-deep hover:bg-madder"
 : "text-stone-400 hover:text-madder-deep"
 }`}
 onClick={handleDeleteClick}
 title={
 confirmDelete
 ? t("viewer:outline.confirm_delete_tooltip")
 : t("viewer:outline.delete_boundary")
 }
 >
 {confirmDelete ? t("viewer:outline.confirm_delete") : "\u00D7"}
 </button>
 )}

 {/* Expand indicator — matches the comment-card chevron
 (2026-04-18): ChevronRight rotates 90° when expanded. */}
 <ChevronRight
 className={`ml-auto h-4 w-4 shrink-0 text-stone-400 transition-transform ${
 isExpanded ? "rotate-90" : ""
 }`}
 aria-hidden="true"
 />
 </div>

 {/* Expanded body -- always-open thread, no row split */}
 {isExpanded && (
 <div
 className="border-t border-stone-200 px-4 py-3"
 onClick={(e) => e.stopPropagation()}
 >
 {/* reseg card above metadata form */}
 {openResegFlag && (
 <ResegmentationCard
 flag={openResegFlag}
 onOpenDialog={() =>
 onOpenResegDialog?.(openResegFlag.id)
 }
 />
 )}

 <div className="space-y-3">
 {/* Two-step type picker */}
 <div>
 <div className="font-sans text-xs font-medium text-stone-500">
 {t("viewer:outline.is_document_label")}
 </div>
 <div
 className="mt-1 inline-flex overflow-hidden rounded border border-stone-300"
 role="radiogroup"
 aria-label={t("viewer:outline.is_document_label")}
 >
 <button
 type="button"
 role="radio"
 aria-checked={isDocumentChoice === "yes"}
 onClick={() => handleDocumentChoice("yes")}
 className={`px-3 py-1 font-sans text-xs ${
 isDocumentChoice === "yes"
 ? "bg-indigo text-parchment"
 : "bg-white text-stone-700 hover:bg-stone-50"
 }`}
 >
 {t("viewer:outline.is_document_yes")}
 </button>
 <button
 type="button"
 role="radio"
 aria-checked={isDocumentChoice === "no"}
 onClick={() => handleDocumentChoice("no")}
 className={`border-l border-stone-300 px-3 py-1 font-sans text-xs ${
 isDocumentChoice === "no"
 ? "bg-indigo text-parchment"
 : "bg-white text-stone-700 hover:bg-stone-50"
 }`}
 >
 {t("viewer:outline.is_document_no")}
 </button>
 </div>
 </div>

 {/* Subtype picklist (only when type = item) */}
 {isDocumentChoice === "yes" && (
 <div className="flex items-center gap-2">
 <label
 className="font-sans text-xs font-medium text-indigo"
 htmlFor={`subtype-${entry.id}`}
 >
 {t("viewer:outline.subtype_label")}
 </label>
 <select
 id={`subtype-${entry.id}`}
 className="rounded border border-stone-300 px-2 py-1 font-sans text-xs"
 value={selectedSubtypeInList}
 onChange={handleSubtypeSelect}
 >
 <option value="">
 {t("viewer:outline.subtype_unset")}
 </option>
 {effectiveSubtypes.map((s) => (
 <option key={s} value={s}>
 {s}
 </option>
 ))}
 <option value={OTHER_SUBTYPE_SENTINEL}>
 {t("viewer:outline.subtype_other")}
 </option>
 </select>
 {selectedSubtypeInList === OTHER_SUBTYPE_SENTINEL && (
 <input
 type="text"
 className="flex-1 rounded border border-stone-300 px-2 py-1 font-sans text-xs"
 placeholder={t("viewer:outline.subtype_other_placeholder")}
 value={
 otherDraft.length > 0
 ? otherDraft
 : entry.subtype &&
 !effectiveSubtypes.includes(entry.subtype)
 ? entry.subtype
 : ""
 }
 onChange={handleOtherDraftChange}
 />
 )}
 </div>
 )}

 {/* Non-document picklist (only when type is front/back/blank/test_images) */}
 {isDocumentChoice === "no" && (
 <div className="flex flex-wrap items-center gap-2">
 <span className="font-sans text-xs font-medium text-stone-500">
 {t("viewer:outline.non_doc_label")}
 </span>
 {NON_DOCUMENT_TYPE_OPTIONS.map((opt) => (
 <button
 key={opt.value}
 type="button"
 onClick={() => handleNonDocTypeChoice(opt.value)}
 aria-pressed={entry.type === opt.value}
 className={`rounded border px-2 py-1 font-sans text-xs ${
 entry.type === opt.value
 ? "border-indigo bg-indigo-tint text-indigo"
 : "border-stone-300 bg-white text-stone-700 hover:bg-stone-50"
 }`}
 >
 {t(opt.labelKey)}
 </button>
 ))}
 </div>
 )}

 {/* Title input (hidden until the cataloguer has chosen a type) */}
 {entry.type != null && (
 <div className="flex items-center gap-2">
 <label
 className="font-sans text-xs font-medium text-indigo"
 htmlFor={`title-${entry.id}`}
 >
 {t("viewer:outline.title_label")}
 </label>
 <input
 id={`title-${entry.id}`}
 type="text"
 className="flex-1 rounded border border-stone-300 px-2 py-1 font-sans text-xs"
 placeholder={t("viewer:outline.no_title")}
 defaultValue={entry.title || ""}
 onChange={handleTitleChange}
 onBlur={handleTitleBlur}
 />
 </div>
 )}

 {/* Reference code */}
 <div className="flex items-center gap-2">
 <span className="font-sans text-xs font-medium text-stone-500">
 {t("viewer:outline.ref_label")}
 </span>
 <span className="font-mono text-xs text-stone-600">
 {refCode}
 </span>
 </div>

 {/* Indent / Outdent buttons */}
 <div className="flex items-center gap-1">
 <button
 type="button"
 className="rounded border border-stone-300 px-2 py-0.5 font-sans text-xs text-stone-600 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-40"
 disabled={!canOutdent}
 onClick={onOutdent}
 title={t("viewer:outline.outdent_tooltip")}
 >
 &#8592;
 </button>
 <button
 type="button"
 className="rounded border border-stone-300 px-2 py-0.5 font-sans text-xs text-stone-600 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-40"
 disabled={!canIndent}
 onClick={onIndent}
 title={t("viewer:outline.indent_tooltip")}
 >
 &#8594;
 </button>
 <span className="ml-1 font-sans text-10 text-stone-400">
 {t("viewer:outline.level_label")}
 </span>
 </div>
 </div>

 {/* Add comment button opens the
 mandatory-comment prompt for an entry-level (no region)
 comment. Hidden in readonly mode; a missing handler also
 hides it so callers can opt out. */}
 {!isReadonly && onOpenCommentPrompt && (
 <div className="mt-3 border-t border-stone-200 pt-3">
 <button
 type="button"
 onClick={onOpenCommentPrompt}
 className="inline-flex items-center gap-1.5 font-sans text-11 font-bold text-indigo hover:underline"
 >
 <svg
 xmlns="http://www.w3.org/2000/svg"
 width="14"
 height="14"
 viewBox="0 0 24 24"
 fill="none"
 stroke="currentColor"
 strokeWidth="2"
 strokeLinecap="round"
 strokeLinejoin="round"
 aria-hidden="true"
 >
 <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
 </svg>
 {t("viewer:outline.add_comment")}
 </button>
 </div>
 )}
 </div>
 )}

 {/* Nested children */}
 {children}
 </div>
  );
}

