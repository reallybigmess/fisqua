/**
 * Outline Item Builder
 *
 * This module deals with the pure helpers that turn a volume's
 * entries and pages into the flat outline-item list the outline panel
 * renders. It handles entry/page interleaving, resegmentation
 * placeholders, and the comment/flag counts each row surfaces.
 *
 * @version v0.3.0
 */
import type { Entry } from "./boundary-types";
import type { CommentWithAuthor } from "./description-types";

/**
 * The flat-node shape produced by outline-panel's `flattenTree`. Kept
 * structural (no import) so this module doesn't drag in React or the
 * panel's private types.
 */
export interface FlatEntryNode {
  entry: Entry;
  depth: number;
  isLast: boolean;
  hasChildren: boolean;
}

export type DraftCommentState = {
  entryId: string;
  region: {
 pageId: string;
 pageLabel?: string;
 region: { x: number; y: number; w: number; h: number };
  } | null;
};

export type OutlineItem =
  | {
 kind: "entry";
 node: FlatEntryNode;
 }
  | {
 kind: "comment";
 comment: CommentWithAuthor;
 replies: CommentWithAuthor[];
 entryId: string;
 entrySequence: number;
 }
  | {
 kind: "draft-comment";
 entryId: string;
 region: DraftCommentState["region"];
 entrySequence: number;
 };

/**
 * Interleave entry rows with their top-level comment rows.
 *
 * @param flatNodes ordered entries from `flattenTree`
 * @param commentsByEntry map keyed by entry id; values may include
 * replies (parentId !== null) — they are
 * filtered here into the parent's `replies`.
 * @returns a single flat list the virtualiser can consume directly.
 */
export function buildOutlineItems(
  flatNodes: FlatEntryNode[],
  commentsByEntry: Record<string, CommentWithAuthor[]>,
  draft?: DraftCommentState | null,
): OutlineItem[] {
  const out: OutlineItem[] = [];

  for (const node of flatNodes) {
 out.push({ kind: "entry", node });

 const bucket = commentsByEntry[node.entry.id];
 if ((!bucket || bucket.length === 0) && draft?.entryId !== node.entry.id) {
 continue;
 }
 if (!bucket || bucket.length === 0) {
 // No comments but a draft is targeting this entry.
 out.push({
 kind: "draft-comment",
 entryId: node.entry.id,
 region: draft!.region,
 entrySequence: node.entry.position + 1,
 });
 continue;
 }

 // Partition into top-levels and replies. Top-levels ordered by
 // createdAt ASC so the oldest thread appears first (matches the
 // CommentThread convention). Replies are grouped per-parent, left
 // in whatever order the loader returned them (also createdAt ASC
 // in practice because getCommentsForVolume sorts by createdAt).
 const topLevels: CommentWithAuthor[] = [];
 const repliesByParent = new Map<string, CommentWithAuthor[]>();
 for (const c of bucket) {
 if (c.parentId == null) {
 topLevels.push(c);
 } else {
 const arr = repliesByParent.get(c.parentId) ?? [];
 arr.push(c);
 repliesByParent.set(c.parentId, arr);
 }
 }
 topLevels.sort((a, b) => a.createdAt - b.createdAt);

 for (const top of topLevels) {
 out.push({
 kind: "comment",
 comment: top,
 replies: repliesByParent.get(top.id) ?? [],
 entryId: node.entry.id,
 entrySequence: node.entry.position + 1,
 });
 }

 // Draft emitted after existing comments so a new draft lands at
 // the bottom of the entry's thread list — matches chronological
 // ASC ordering and feels like a "next comment" affordance.
 if (draft?.entryId === node.entry.id) {
 out.push({
 kind: "draft-comment",
 entryId: node.entry.id,
 region: draft.region,
 entrySequence: node.entry.position + 1,
 });
 }
  }

  return out;
}

/**
 * Find the virtualiser index for a given item by key. Used by the
 * URL-state scrollToIndex effect. Returns -1 when the item is not in
 * the list (e.g. stale URL pointing at a deleted comment).
 */
export function findOutlineItemIndex(
  items: OutlineItem[],
  target: { kind: "entry"; entryId: string } | { kind: "comment"; commentId: string },
): number {
  for (let i = 0; i < items.length; i++) {
 const item = items[i];
 if (item.kind === "entry" && target.kind === "entry" && item.node.entry.id === target.entryId) {
 return i;
 }
 if (item.kind === "comment" && target.kind === "comment" && item.comment.id === target.commentId) {
 return i;
 }
  }
  return -1;
}

/**
 * Stable key for the virtualiser. Entries get `entry:<id>`, comments get
 * `comment:<id>`. Kept separate so an entry and a comment cannot collide
 * on id alone (and to match the URL-state encoding for debuggability).
 */
export function outlineItemKey(item: OutlineItem): string {
  if (item.kind === "entry") return `entry:${item.node.entry.id}`;
  if (item.kind === "draft-comment") return `draft:${item.entryId}`;
  return `comment:${item.comment.id}`;
}

