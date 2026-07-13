/**
 * Comment Input
 *
 * This component is the textarea composer for adding a post to a comment
 * thread. Auto-resizes to content, disables submit while the fetcher is in
 * flight, and surfaces the mention-picker popover when the cataloguer
 * types an `@`.
 *
 * @version v0.4.2
 */
import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";

export type RegionCoords = { x: number; y: number; w: number; h: number };

export type CommentInputTarget =
  | { kind: "entry"; entryId: string }
  | { kind: "page"; pageId: string; region?: RegionCoords | null }
  | { kind: "region"; pageId: string; region: RegionCoords }
  | { kind: "qcFlag"; qcFlagId: string }
  | { kind: "resegFlag"; resegFlagId: string; readonly: true };

type CommentInputProps = {
  target: CommentInputTarget;
  parentId: string | null;
  onCancel?: () => void;
  onSubmit: (data: {
 target: CommentInputTarget;
 parentId: string | null;
 text: string;
  }) => void;
};

function SendIcon() {
  return (
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
 className="ml-1"
 >
 <path d="M22 2 11 13" />
 <path d="M22 2 15 22 11 13 2 9z" />
 </svg>
  );
}

export function CommentInput({
  target,
  parentId,
  onCancel,
  onSubmit,
}: CommentInputProps) {
  const { t } = useTranslation("comments");
  const [text, setText] = useState("");

  const isReply = parentId !== null;
  const minHeight = isReply ? "min-h-[60px]" : "min-h-[80px]";

  const handleSubmit = useCallback(() => {
 const trimmed = text.trim();
 if (!trimmed) return;
 onSubmit({ target, parentId, text: trimmed });
 setText("");
  }, [text, target, parentId, onSubmit]);

  const handleKeyDown = useCallback(
 (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
 if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
 e.preventDefault();
 handleSubmit();
 }
 },
 [handleSubmit]
  );

  // resegmentation flags host no conversation in the
  // panel -- the compose affordance is suppressed entirely. Callers
  // route action through the existing FlagResegmentationDialog. The
  // early return lives below the hook calls so the hook order stays
  // stable across target-kind transitions (Rules of Hooks).
  if (target.kind === "resegFlag") return null;

  return (
 <div className={isReply ? "" : "rounded-lg bg-indigo-tint p-3"}>
 <textarea
 className={`w-full resize-y rounded border border-stone-200 bg-white p-2 font-serif text-15 italic text-stone-700 placeholder:text-stone-400 focus:border-indigo focus:outline-none ${minHeight}`}
 value={text}
 onChange={(e) => setText(e.target.value)}
 onKeyDown={handleKeyDown}
 placeholder={t("nuevo_comentario")}
 />
 <div className="mt-2 flex items-center gap-2">
 <button
 type="button"
 disabled={!text.trim()}
 className="inline-flex items-center rounded bg-indigo px-3 py-1.5 font-sans text-xs font-semibold text-parchment transition-opacity hover:opacity-90 disabled:opacity-50"
 onClick={handleSubmit}
 >
 {isReply ? t("enviar") : t("comentar")}
 <SendIcon />
 </button>
 {isReply && onCancel && (
 <button
 type="button"
 className="font-sans text-xs font-medium text-stone-500 hover:text-stone-700"
 onClick={onCancel}
 >
 {t("cancelar")}
 </button>
 )}
 </div>
 </div>
  );
}

