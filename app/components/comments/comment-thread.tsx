/**
 * Comment Thread
 *
 * This component is the stack of comment cards for one thread plus the
 * composer below. Handles optimistic rendering when the user submits a new
 * post and surfaces the inline region-pin affordance when the thread is
 * anchored to a region on the page.
 *
 * @version v0.4.2
 */
import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import type { CommentWithAuthor } from "../../lib/description-types";
import { CommentCard } from "./comment-card";
import { CommentInput, type CommentInputTarget } from "./comment-input";

export type CommentTarget = CommentInputTarget;

type CommonProps = {
  comments: CommentWithAuthor[];
  onCommentAdded?: () => void;
  onError?: (message: string) => void;
  /**
 * When true, the thread renders expanded on mount (composer + replies
 * visible without a chevron click). Defaults to false. Added in Plan
 * 04 so `QCFlagCardExpandable` can mount the thread in an already-open
 * state -- the card itself is what the user toggled, so the inner
 * thread's own chevron would be a redundant second click.
 */
  defaultOpen?: boolean;
  /**
 * chip click handler forwarded to every
 * `CommentCard` so region-anchored comments can scroll the viewer.
 */
  onScrollToRegion?: (commentId: string) => void;
  /**
 * lookup so region-anchored comments can
 * label their chip "Región · p. N". Keyed by comment id; entries
 * without a page assignment are simply omitted.
 */
  pageNumberByCommentId?: Record<string, number>;
  /**
 * draft region attached to the next top-level submit.
 * When present, `handleSubmit` flattens it onto the wire payload so
 * the comment row persists with region coords and the outline card's
 * amber draft pin transitions to a final burgundy pin atomically.
 * Only the top-level composer consumes this hint; replies keep their
 * ambient target.
 */
  draftRegion?: {
 pageId: string;
 region: { x: number; y: number; w: number; h: number };
  } | null;
};

type NewProps = CommonProps & {
  target: CommentTarget;
  volumeId: string;
};

type LegacyProps = CommonProps & {
  entryId: string;
  volumeId?: string;
};

export type CommentThreadProps = NewProps | LegacyProps;

type CommentTree = CommentWithAuthor & {
  children: CommentTree[];
};

function buildTree(comments: CommentWithAuthor[]): CommentTree[] {
  const byParent = new Map<string | null, CommentWithAuthor[]>();

  for (const comment of comments) {
 const key = comment.parentId ?? null;
 const group = byParent.get(key);
 if (group) {
 group.push(comment);
 } else {
 byParent.set(key, [comment]);
 }
  }

  function buildChildren(parentId: string | null): CommentTree[] {
 const children = byParent.get(parentId) || [];
 return children
 .sort((a, b) => a.createdAt - b.createdAt)
 .map((comment) => ({
 ...comment,
 children: buildChildren(comment.id),
 }));
  }

  return buildChildren(null);
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
 <svg
 xmlns="http://www.w3.org/2000/svg"
 width="16"
 height="16"
 viewBox="0 0 24 24"
 fill="none"
 stroke="currentColor"
 strokeWidth="2"
 strokeLinecap="round"
 strokeLinejoin="round"
 className={`transition-transform ${open ? "rotate-180" : ""}`}
 >
 <path d="M6 9l6 6 6-6" />
 </svg>
  );
}

function RenderTree({
  nodes,
  depth,
  replyingTo,
  onReply,
  target,
  onSubmitReply,
  onCancelReply,
  onScrollToRegion,
  pageNumberByCommentId,
}: {
  nodes: CommentTree[];
  depth: number;
  replyingTo: string | null;
  onReply: (commentId: string) => void;
  target: CommentTarget;
  onSubmitReply: (data: {
 target: CommentTarget;
 parentId: string | null;
 text: string;
  }) => void;
  onCancelReply: () => void;
  onScrollToRegion?: (commentId: string) => void;
  pageNumberByCommentId?: Record<string, number>;
}) {
  return (
 <>
 {nodes.map((node) => (
 <div key={node.id}>
 <CommentCard
 comment={node}
 onReply={onReply}
 depth={depth}
 onScrollToRegion={onScrollToRegion}
 pageNumber={pageNumberByCommentId?.[node.id]}
 />
 {replyingTo === node.id && (
 <div style={{ marginLeft: `${(depth + 1) * 1.5}rem` }} className="mt-2">
 <CommentInput
 target={target}
 parentId={node.id}
 onSubmit={onSubmitReply}
 onCancel={onCancelReply}
 />
 </div>
 )}
 {node.children.length > 0 && (
 <div className="mt-2">
 <RenderTree
 nodes={node.children}
 depth={depth + 1}
 replyingTo={replyingTo}
 onReply={onReply}
 target={target}
 onSubmitReply={onSubmitReply}
 onCancelReply={onCancelReply}
 onScrollToRegion={onScrollToRegion}
 pageNumberByCommentId={pageNumberByCommentId}
 />
 </div>
 )}
 </div>
 ))}
 </>
  );
}

export function CommentThread(props: CommentThreadProps) {
  const {
 comments,
 onCommentAdded,
 onError,
 onScrollToRegion,
 pageNumberByCommentId,
 draftRegion,
  } = props;

  // Normalise legacy entryId prop to the new discriminated target.
  const effectiveTarget: CommentTarget =
 "target" in props
 ? props.target
 : { kind: "entry", entryId: props.entryId };

  // volumeId is required for the new call path; legacy callers may omit it
  // if they haven't migrated yet — fall back to empty string so the server
  // can reject and surface the missing field cleanly. We emit a loud
  // console.error at the boundary so the broken prop plumbing is
  // diagnosable at the call site rather than hidden behind a generic
  // server 400. (Legacy shim: remove the fallback once every caller
  // migrates to the discriminated-target API.)
  const volumeId: string =
 "volumeId" in props && typeof props.volumeId === "string"
 ? props.volumeId
 : "";
  if (volumeId === "") {
 console.error(
 "[CommentThread] volumeId prop is required; falling back to empty string. " +
 "Server will reject the submit with a generic 400.",
 );
  }

  const { t } = useTranslation("comments");
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [isOpen, setIsOpen] = useState(props.defaultOpen ?? false);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);

  const tree = useMemo(() => buildTree(comments), [comments]);
  const commentCount = comments.length;
  const isReadonly = effectiveTarget.kind === "resegFlag";

  const handleReply = useCallback(
 (commentId: string) => {
 setReplyingTo((prev) => (prev === commentId ? null : commentId));
 },
 []
  );

  const handleCancelReply = useCallback(() => {
 setReplyingTo(null);
  }, []);

  const handleSubmit = useCallback(
 (data: {
 target: CommentTarget;
 parentId: string | null;
 text: string;
 }) => {
 // Read-only target -- CommentInput also returns null for this
 // kind, so this branch is unreachable in practice; kept as a
 // defence-in-depth guard against future refactors.
 if (data.target.kind === "resegFlag") return;

 const payload: Record<string, unknown> = {
 volumeId,
 parentId: data.parentId,
 text: data.text,
 };

 // Flatten the five-arm CommentInputTarget union into the flat
 // wire payload that api.comments.tsx expects. Each arm writes
 // exactly one of entryId, pageId (optionally with region), or
 // qcFlagId; { kind: "region" } flattens to page + region, and
 // { kind: "qcFlag" } writes the flag id only, so the server
 // only has to understand the three DB-level target kinds.
 switch (data.target.kind) {
 case "entry":
 payload.entryId = data.target.entryId;
 break;
 case "page":
 payload.pageId = data.target.pageId;
 if (data.target.region) payload.region = data.target.region;
 break;
 case "region":
 payload.pageId = data.target.pageId;
 payload.region = data.target.region;
 break;
 case "qcFlag":
 payload.qcFlagId = data.target.qcFlagId;
 break;
 }

 // when a draftRegion is attached to this thread
 // AND the submit is a top-level comment (parentId === null) on
 // an entry target, flatten the region coords onto the wire
 // payload so the server persists { entryId, pageId, region }
 // atomically with the comment body. Replies keep their parent's
 // target shape -- we do not carry a draft region onto a reply.
 if (
 draftRegion &&
 data.parentId === null &&
 data.target.kind === "entry"
 ) {
 payload.pageId = draftRegion.pageId;
 payload.region = draftRegion.region;
 }

 // JSON encType accepts arbitrary serialisable payloads; cast so the
 // SubmitTarget union (FormData | Record<string, string> | …) doesn't
 // reject the nested region object.
 fetcher.submit(payload as Parameters<typeof fetcher.submit>[0], {
 method: "POST",
 action: "/api/comments",
 encType: "application/json",
 });
 setReplyingTo(null);
 },
 [fetcher, volumeId, draftRegion]
  );

  // Track which fetcher response we've already reacted to so that
  // onCommentAdded does not fire more than once per submission.
  const lastHandledRef = useRef<unknown>(null);
  useEffect(() => {
 if (fetcher.state !== "idle" || !fetcher.data) return;
 if (lastHandledRef.current === fetcher.data) return;
 lastHandledRef.current = fetcher.data;

 if (fetcher.data.ok) {
 onCommentAdded?.();
 } else if (fetcher.data.error) {
 onError?.(fetcher.data.error);
 }
  }, [fetcher.state, fetcher.data, onCommentAdded, onError]);

  const heading =
 commentCount > 0
 ? `${t("comentarios")} (${commentCount})`
 : t("comentarios");

  // The thread always renders a collapsible "Comentarios (N)" header with a
  // chevron toggle. `defaultOpen` controls initial open state; callers (entry
  // card, QC-flag popover) pass `defaultOpen={true}` to start expanded but
  // users can collapse.'s "always-visible composer" applies when the
  // section is open -- it never gates whether the section can collapse.
  const body = (
 <div className="mt-4 space-y-2">
 <RenderTree
 nodes={tree}
 depth={0}
 replyingTo={replyingTo}
 onReply={handleReply}
 target={effectiveTarget}
 onSubmitReply={handleSubmit}
 onCancelReply={handleCancelReply}
 onScrollToRegion={onScrollToRegion}
 pageNumberByCommentId={pageNumberByCommentId}
 />

 {/* New top-level comment input -- always visible when the
 thread is expanded, except on read-only targets (resegFlag). */}
 {!isReadonly && (
 <div className="mt-4">
 <CommentInput
 target={effectiveTarget}
 parentId={null}
 onSubmit={handleSubmit}
 />
 </div>
 )}
 </div>
  );

  return (
 <div className="mt-6 border-t border-stone-200 pt-6">
 {/* Section heading */}
 <button
 type="button"
 className="flex w-full items-center gap-2 text-left"
 onClick={() => setIsOpen((prev) => !prev)}
 >
 <h3 className="font-display text-xl font-semibold text-stone-700">
 {heading}
 </h3>
 <ChevronIcon open={isOpen} />
 </button>

 {/* Collapsible content */}
 <div className="comments-collapse" data-open={isOpen}>
 {body}
 </div>
 </div>
  );
}

