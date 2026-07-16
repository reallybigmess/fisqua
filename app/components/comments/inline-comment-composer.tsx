/**
 * Inline Comment Composer
 *
 * This component is the floating composer shown inside the IIIF viewer
 * when the operator picks a point or region to leave a comment on.
 * Collects the body and geometry and hands the payload back to the parent
 * form so persistence and re-render route through the shared fetcher.
 *
 * @version v0.4.2
 */
import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import { MapPin } from "lucide-react";

export type InlineComposerRegion = {
  pageId: string;
  pageLabel?: string;
  region: { x: number; y: number; w: number; h: number };
};

export interface InlineCommentComposerProps {
  /** Non-null for anchored composers (pin drop); null otherwise. */
  region: InlineComposerRegion | null;
  /** Owning entry id (always set — resolved upstream via when region-anchored). */
  entryId: string;
  /**
 * For reply composers: the parent comment id. The server stores the
 * reply under the parent's entry/page anchor so the thread is
 * traversable via `comments.parentId`.
 */
  parentId?: string | null;
  volumeId: string;
  /** Called after a successful submit so the caller can revalidate. */
  onCreated?: () => void;
  /** Called when the user clicks Cancel — removes the draft + pin. */
  onCancel: () => void;
  /** Optional wrapper override (reply variant uses a thinner shell). */
  className?: string;
  /** When true, autofocus the textarea on mount. Default true. */
  autoFocus?: boolean;
}

/**
 * Pure predicate: should the submit button be enabled? Requires a
 * non-empty trimmed body AND no in-flight submission.
 */
export function shouldEnableSubmit(body: string, submitting: boolean): boolean {
  if (submitting) return false;
  if (body.trim().length === 0) return false;
  return true;
}

/**
 * Pure helper: build the JSON payload for POST /api/comments. Three
 * arms match the Zod refine in api.comments.tsx:
 * - reply (parentId set + entryId set) → entry anchor + parentId
 * - anchored (region set) → pageId + region + optional parentId
 * - entry (entryId only) → entry anchor
 */
export function buildCommentSubmitPayload(args: {
  volumeId: string;
  text: string;
  entryId: string;
  region: InlineComposerRegion | null;
  parentId?: string | null;
}): {
  volumeId: string;
  text: string;
  entryId?: string;
  pageId?: string;
  region?: { x: number; y: number; w: number; h: number };
  parentId?: string;
} {
  const base: {
 volumeId: string;
 text: string;
 entryId?: string;
 pageId?: string;
 region?: { x: number; y: number; w: number; h: number };
 parentId?: string;
  } = { volumeId: args.volumeId, text: args.text.trim() };
  if (args.parentId) base.parentId = args.parentId;

  if (args.region) {
 base.pageId = args.region.pageId;
 base.region = args.region.region;
 return base;
  }
  base.entryId = args.entryId;
  return base;
}

type CreateResponse =
  | { ok: true; id: string }
  | { ok: false; error: string };

function isOk(data: unknown): data is { ok: true; id: string } {
  return (
 typeof data === "object" &&
 data !== null &&
 (data as { ok?: unknown }).ok === true
  );
}

export function InlineCommentComposer({
  region,
  entryId,
  parentId,
  volumeId,
  onCreated,
  onCancel,
  className,
  autoFocus = true,
}: InlineCommentComposerProps) {
  const { t } = useTranslation(["viewer"]);
  const fetcher = useFetcher<CreateResponse>();
  const [body, setBody] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const submitting = fetcher.state !== "idle";
  const canSubmit = shouldEnableSubmit(body, submitting);

  useEffect(() => {
 if (autoFocus) {
 requestAnimationFrame(() => textareaRef.current?.focus());
 }
  }, [autoFocus]);

  useEffect(() => {
 if (fetcher.state !== "idle" || !fetcher.data) return;
 if (isOk(fetcher.data)) {
 setBody("");
 onCreated?.();
 } else {
 const err = (fetcher.data as { error?: string }).error;
 setServerError(err ?? "error");
 }
 // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  const handleSubmit = () => {
 if (!canSubmit) return;
 const payload = buildCommentSubmitPayload({
 volumeId,
 text: body,
 entryId,
 region,
 parentId,
 });
 fetcher.submit(payload as unknown as Record<string, string>, {
 method: "POST",
 action: "/api/comments",
 encType: "application/json",
 });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
 if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
 e.preventDefault();
 handleSubmit();
 } else if (e.key === "Escape") {
 e.preventDefault();
 if (!submitting) onCancel();
 }
  };

  const wrapperClass =
 className ??
 "relative ml-9 mb-2 overflow-hidden rounded-lg border border-saffron bg-saffron-tint/40 shadow-sm";

  return (
 <div className={wrapperClass}>
 {/* Amber left connector bar signals draft state (matches the draft pin). */}
 <div
 className="absolute left-0 top-0 bottom-0 w-[3px] bg-saffron"
 aria-hidden
 />
 <div className="space-y-3 p-3 pl-4">
 {region && (
 <div className="inline-flex items-center gap-1.5 rounded border border-stone-200 bg-stone-100 px-2 py-0.5 font-sans text-10 font-bold text-stone-600">
 <MapPin className="h-2.5 w-2.5 text-indigo" aria-hidden />
 <span>
 {t("viewer:comment_prompt.region_label", {
 page: region.pageLabel ?? "?",
 })}
 </span>
 </div>
 )}
 <textarea
 ref={textareaRef}
 value={body}
 onChange={(e) => setBody(e.target.value)}
 onKeyDown={handleKeyDown}
 placeholder={t("viewer:comment_prompt.placeholder")}
 className="min-h-[72px] w-full rounded border border-stone-200 p-2 font-serif text-15 text-stone-700 placeholder:text-stone-400 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo/40"
 />
 {serverError && (
 <p className="text-xs text-indigo">
 {t("viewer:comment_prompt.error_server")}
 </p>
 )}
 <div className="flex items-center justify-end gap-2">
 <button
 type="button"
 onClick={onCancel}
 disabled={submitting}
 className="rounded-md px-3 py-1.5 font-sans text-xs font-medium text-stone-600 hover:bg-stone-100 disabled:opacity-50"
 >
 {t("viewer:comment_prompt.cancel")}
 </button>
 <button
 type="button"
 onClick={handleSubmit}
 disabled={!canSubmit}
 className="rounded-md bg-indigo px-3 py-1.5 font-sans text-xs font-semibold text-parchment hover:bg-indigo-deep disabled:opacity-50"
 >
 {t("viewer:comment_prompt.submit")}
 </button>
 </div>
 </div>
 </div>
  );
}

