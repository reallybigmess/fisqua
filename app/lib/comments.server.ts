/**
 * Comments Server Module
 *
 * This module deals with the server-side engine behind the comments
 * thread API and the comment-aware surfaces. It handles creating,
 * editing, resolving, and deleting comment threads, anchoring threads
 * to entries or regions, and joining denormalised author display
 * names so the UI renders without follow-up queries.
 *
 * @version v0.4.2
 */
import { and, eq, isNull, or } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { comments, users, volumes } from "../db/schema";
import type { WorkflowRole } from "./workflow";

/**
 * Image-region coordinates on a page-targeted comment.
 * All values are 0-1 normalised against the page image's displayed
 * dimensions so the same region survives IIIF zoom variants. A pin
 * drop is stored as `w = 0, h = 0`; a bounding box has non-zero
 * width/height.
 */
export type Region = {
  x: number;
  y: number;
  w: number;
  h: number;
};

/**
 * Discriminated target for a comment: an entry, a page
 * (optionally with image-region coordinates), or a QC flag. The DB-
 * level CHECK constraint enforces exactly-one-of at the row level;
 * `createComment` performs the matching app-level guard so invalid
 * input is rejected with a typed 400 before a write is attempted.
 */
export type CommentTarget =
  | { kind: "entry"; entryId: string }
  | { kind: "page"; pageId: string; region?: Region | null }
  | { kind: "qcFlag"; qcFlagId: string };

/**
 * Clamp a number into the closed interval [0, 1]. Used to guard region
 * coordinates before insert so malformed client input can never write
 * values outside the normalised range. `NaN` flows through unchanged --
 * callers should trust the Zod schema at the route boundary to reject
 * non-finite numbers before this helper sees them.
 */
function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Create a new comment on an entry, a page, or a QC flag.
 *
 * `target` selects which side of the exactly-one-of invariant is
 * filled; the other two columns are left `null`. `volumeId` is always
 * required and is stored denormalised so volume-scoped loads in the
 * segmentation viewer do not need to JOIN through entries, pages, or
 * flags.
 *
 * If `target.kind === "page"` and `target.region` is present, each
 * coord is clamped into [0, 1] server-side before the insert so that
 * malformed client input cannot write out-of-range REAL values. When
 * `target.region` is absent or null, all four region columns are
 * written NULL. The `qcFlag` and `entry` arms always write NULL
 * regions -- the `<interfaces>` Zod schema at the route layer rejects
 * `region + qcFlagId` and `region + entryId` before this helper sees
 * them.
 *
 * Throws a 400 `Response` if the `target.kind` field is not one of the
 * three recognised values -- a runtime belt-and-braces guard alongside
 * the DB-level CHECK constraint.
 */
export async function createComment(
  db: DrizzleD1Database<any>,
  data: {
 target: CommentTarget;
 volumeId: string;
 parentId: string | null;
 authorId: string;
 authorRole: WorkflowRole;
 text: string;
  }
): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  const now = Date.now();

  // A comment inherits its tenant from its parent volume (the denormalised
  // volumeId every comment carries). Resolve it so the row sets tenant_id
  // explicitly -- the schema has no default.
  const volumeRow = await db
    .select({ tenantId: volumes.tenantId })
    .from(volumes)
    .where(eq(volumes.id, data.volumeId))
    .get();
  if (!volumeRow) {
    throw new Response("Volume not found", { status: 404 });
  }
  const tenantId = volumeRow.tenantId;

  let entryId: string | null = null;
  let pageId: string | null = null;
  let qcFlagId: string | null = null;
  let regionX: number | null = null;
  let regionY: number | null = null;
  let regionW: number | null = null;
  let regionH: number | null = null;

  switch (data.target.kind) {
 case "entry":
 entryId = data.target.entryId;
 break;
 case "page":
 pageId = data.target.pageId;
 if (data.target.region) {
 regionX = clamp01(data.target.region.x);
 regionY = clamp01(data.target.region.y);
 regionW = clamp01(data.target.region.w);
 regionH = clamp01(data.target.region.h);
 }
 break;
 case "qcFlag":
 qcFlagId = data.target.qcFlagId;
 break;
 default: {
 const _exhaustive: never = data.target;
 throw new Response(
 "Comment must target exactly one of entry, page, or qcFlag",
 { status: 400 }
 );
 }
  }

  await db.insert(comments).values({
 id,
 tenantId,
 volumeId: data.volumeId,
 entryId,
 pageId,
 qcFlagId,
 regionX,
 regionY,
 regionW,
 regionH,
 parentId: data.parentId ?? null,
 authorId: data.authorId,
 authorRole: data.authorRole,
 text: data.text,
 createdAt: now,
 updatedAt: now,
  });

  return { id };
}

/**
 * Get all comments for an entry, ordered by createdAt ascending.
 * Includes author email + name via join with users table.
 *
 * projection extended with `qcFlagId` and the four
 * `region[XYWH]` columns so callers can render the full row shape
 * without a second query. For entry-targeted rows these columns are
 * always NULL but the explicit projection keeps the return shape
 * uniform across the three sibling helpers.
 */
export async function getCommentsForEntry(
  db: DrizzleD1Database<any>,
  entryId: string
) {
  return db
 .select({
 id: comments.id,
 entryId: comments.entryId,
 pageId: comments.pageId,
 qcFlagId: comments.qcFlagId,
 regionX: comments.regionX,
 regionY: comments.regionY,
 regionW: comments.regionW,
 regionH: comments.regionH,
 volumeId: comments.volumeId,
 parentId: comments.parentId,
 authorId: comments.authorId,
 authorRole: comments.authorRole,
 text: comments.text,
 createdAt: comments.createdAt,
 updatedAt: comments.updatedAt,
 // expose edit/resolve state so the outline
 // card can render the Editado + Resuelto chips.
 // deletedAt is filtered at the WHERE clause so it never needs
 // to reach the UI.
 editedAt: comments.editedAt,
 resolvedAt: comments.resolvedAt,
 resolvedBy: comments.resolvedBy,
 authorEmail: users.email,
 authorName: users.name,
 })
 .from(comments)
 .leftJoin(users, eq(comments.authorId, users.id))
 .where(and(eq(comments.entryId, entryId), isNull(comments.deletedAt)))
 .orderBy(comments.createdAt)
 .all();
}

/**
 * Get all comments for a page, ordered by createdAt ascending.
 * Mirrors `getCommentsForEntry` but keyed to `comments.page_id`.
 *
 * projection extended with `qcFlagId` + region columns.
 */
export async function getCommentsForPage(
  db: DrizzleD1Database<any>,
  pageId: string
) {
  return db
 .select({
 id: comments.id,
 entryId: comments.entryId,
 pageId: comments.pageId,
 qcFlagId: comments.qcFlagId,
 regionX: comments.regionX,
 regionY: comments.regionY,
 regionW: comments.regionW,
 regionH: comments.regionH,
 volumeId: comments.volumeId,
 parentId: comments.parentId,
 authorId: comments.authorId,
 authorRole: comments.authorRole,
 text: comments.text,
 createdAt: comments.createdAt,
 updatedAt: comments.updatedAt,
 editedAt: comments.editedAt,
 resolvedAt: comments.resolvedAt,
 resolvedBy: comments.resolvedBy,
 authorEmail: users.email,
 authorName: users.name,
 })
 .from(comments)
 .leftJoin(users, eq(comments.authorId, users.id))
 .where(and(eq(comments.pageId, pageId), isNull(comments.deletedAt)))
 .orderBy(comments.createdAt)
 .all();
}

/**
 * Get all comments for a QC flag, ordered by createdAt ascending
 *. Mirrors `getCommentsForPage` but keyed to
 * `comments.qc_flag_id`. Used by the unified comments panel when the
 * active selection is a QC flag.
 */
export async function getCommentsForQcFlag(
  db: DrizzleD1Database<any>,
  qcFlagId: string
) {
  return db
 .select({
 id: comments.id,
 entryId: comments.entryId,
 pageId: comments.pageId,
 qcFlagId: comments.qcFlagId,
 regionX: comments.regionX,
 regionY: comments.regionY,
 regionW: comments.regionW,
 regionH: comments.regionH,
 volumeId: comments.volumeId,
 parentId: comments.parentId,
 authorId: comments.authorId,
 authorRole: comments.authorRole,
 text: comments.text,
 createdAt: comments.createdAt,
 updatedAt: comments.updatedAt,
 editedAt: comments.editedAt,
 resolvedAt: comments.resolvedAt,
 resolvedBy: comments.resolvedBy,
 authorEmail: users.email,
 authorName: users.name,
 })
 .from(comments)
 .leftJoin(users, eq(comments.authorId, users.id))
 .where(and(eq(comments.qcFlagId, qcFlagId), isNull(comments.deletedAt)))
 .orderBy(comments.createdAt)
 .all();
}

/**
 * Get all comments for all entries, all pages, AND all QC flags of a
 * volume, ordered by createdAt ascending. Returns a flat array --
 * callers partition by inspecting `entryId` / `pageId` / `qcFlagId` on
 * each row (the three columns are XOR-disjoint).
 *
 * rewrote this to select directly on the denormalised
 * `volume_id` column. extends the projection to include
 * `qcFlagId` and the four `region[XYWH]` columns so the unified panel
 * can render every target kind for the current volume in a single
 * load.
 */
export async function getCommentsForVolume(
  db: DrizzleD1Database<any>,
  volumeId: string
) {
  return db
 .select({
 id: comments.id,
 entryId: comments.entryId,
 pageId: comments.pageId,
 qcFlagId: comments.qcFlagId,
 regionX: comments.regionX,
 regionY: comments.regionY,
 regionW: comments.regionW,
 regionH: comments.regionH,
 volumeId: comments.volumeId,
 parentId: comments.parentId,
 authorId: comments.authorId,
 authorRole: comments.authorRole,
 text: comments.text,
 createdAt: comments.createdAt,
 updatedAt: comments.updatedAt,
 editedAt: comments.editedAt,
 resolvedAt: comments.resolvedAt,
 resolvedBy: comments.resolvedBy,
 authorEmail: users.email,
 authorName: users.name,
 })
 .from(comments)
 .leftJoin(users, eq(comments.authorId, users.id))
 .where(and(eq(comments.volumeId, volumeId), isNull(comments.deletedAt)))
 .orderBy(comments.createdAt)
 .all();
}

/**
 * update a region-anchored comment's coordinates in
 * place. Only the comment's author can move their own pin (mirrors
 * `deleteComment`'s author-only gate — there is no lead override in
 * rev 4). Shape is locked: point pins stay points, box pins stay
 * boxes (w/h transitions are rejected). The comment must be region-
 * anchored — the server refuses to add a region to an entry-only or
 * qcFlag-only comment.
 *
 * Return value: the comment's `pageId`, `entryId`, `projectId`, and
 * `volumeId` so the route can run `requirePageAccess` / `logActivity`
 * without a second query. The function performs the author check and
 * shape-lock check itself; the route still calls
 * `requirePageAccess` (or `requireEntryAccess`) to prove the caller
 * has read access on the target — belt-and-braces.
 *
 * @throws Response(404) when the comment does not exist.
 * @throws Response(403) when the caller is not the author.
 * @throws Response(400) when the comment is not region-anchored.
 * @throws Response(400) when the shape would change (point ↔ box).
 */
export async function updateCommentRegion(
  db: DrizzleD1Database<any>,
  commentId: string,
  userId: string,
  region: {
 regionX: number;
 regionY: number;
 regionW?: number;
 regionH?: number;
  },
): Promise<{
  pageId: string | null;
  entryId: string | null;
  volumeId: string;
  previousRegion: {
 regionX: number | null;
 regionY: number | null;
 regionW: number | null;
 regionH: number | null;
  };
}> {
  const [comment] = await db
 .select({
 authorId: comments.authorId,
 pageId: comments.pageId,
 entryId: comments.entryId,
 volumeId: comments.volumeId,
 regionX: comments.regionX,
 regionY: comments.regionY,
 regionW: comments.regionW,
 regionH: comments.regionH,
 })
 .from(comments)
 .where(eq(comments.id, commentId))
 .limit(1)
 .all();

  if (!comment) {
 throw new Response("Comment not found", { status: 404 });
  }
  if (comment.authorId !== userId) {
 throw new Response("Only the author can move their comment", {
 status: 403,
 });
  }
  if (comment.regionX == null) {
 throw new Response(
 "Comment is not region-anchored — nothing to move",
 { status: 400 },
 );
  }
  const incomingIsBox = region.regionW != null;
  const existingIsBox = comment.regionW != null && comment.regionW > 0;
  if (incomingIsBox !== existingIsBox) {
 throw new Response(
 "Cannot change pin shape — point pins stay points, box pins stay boxes",
 { status: 400 },
 );
  }

  await db
 .update(comments)
 .set({
 regionX: region.regionX,
 regionY: region.regionY,
 regionW: region.regionW ?? null,
 regionH: region.regionH ?? null,
 updatedAt: Date.now(),
 })
 .where(eq(comments.id, commentId));

  return {
 pageId: comment.pageId,
 entryId: comment.entryId,
 volumeId: comment.volumeId,
 previousRegion: {
 regionX: comment.regionX,
 regionY: comment.regionY,
 regionW: comment.regionW,
 regionH: comment.regionH,
 },
  };
}

/**
 * task #13: update a comment's body text in place.
 * Author-only (no lead override in this revision -- leads can still
 * delete via softDeleteComment). A no-op save (newText === currentText)
 * short-circuits without touching `editedAt` so the "Editado" chip does
 * not appear for cosmetic re-submits.
 *
 * `editedAt` is set iff the text actually changed. `updatedAt` is
 * bumped on every write (including no-ops would miss it, so the early-
 * return saves a write in that case too). Coord moves (task #15) bump
 * `updatedAt` but leave `editedAt` alone -- these semantics let the UI
 * distinguish "user-edited text" from "pin moved" without a second
 * column.
 *
 * @throws Response(404) when the comment does not exist.
 * @throws Response(410) when the comment is soft-deleted.
 * @throws Response(403) when the caller is not the author.
 * @throws Response(400) when the body is empty after trim.
 */
export async function updateCommentBody(
  db: DrizzleD1Database<any>,
  commentId: string,
  userId: string,
  newText: string
): Promise<{
  pageId: string | null;
  entryId: string | null;
  volumeId: string;
  oldLength: number;
  newLength: number;
  changed: boolean;
}> {
  const trimmed = newText.trim();
  if (trimmed.length === 0) {
 throw new Response("Comment body cannot be empty", { status: 400 });
  }

  const [comment] = await db
 .select({
 authorId: comments.authorId,
 text: comments.text,
 pageId: comments.pageId,
 entryId: comments.entryId,
 volumeId: comments.volumeId,
 deletedAt: comments.deletedAt,
 })
 .from(comments)
 .where(eq(comments.id, commentId))
 .limit(1)
 .all();

  if (!comment) {
 throw new Response("Comment not found", { status: 404 });
  }

  if (comment.deletedAt !== null) {
 throw new Response("Comment already deleted", { status: 410 });
  }

  if (comment.authorId !== userId) {
 throw new Response("Only the author can edit their comment", {
 status: 403,
 });
  }

  const changed = comment.text !== trimmed;
  const oldLength = comment.text.length;
  const newLength = trimmed.length;

  if (changed) {
 const now = Date.now();
 await db
 .update(comments)
 .set({ text: trimmed, editedAt: now, updatedAt: now })
 .where(eq(comments.id, commentId));
  }

  return {
 pageId: comment.pageId,
 entryId: comment.entryId,
 volumeId: comment.volumeId,
 oldLength,
 newLength,
 changed,
  };
}

/**
 * task #13: soft-delete a comment, cascading to
 * replies when the row is a root. Sets `deletedAt` + `deletedBy`; the
 * row itself stays in the table. Read helpers above filter
 * `deleted_at IS NULL` so soft-deleted rows never reach the UI.
 *
 * Authorisation: the comment's author OR a project lead (resolved by
 * the route — this helper takes a boolean `isLead` flag since the
 * role check is cheaper to do once per request at the route layer than
 * to re-query here).
 *
 * Cascade rule: when the target row has `parent_id IS NULL` (root),
 * a single UPDATE sets `deletedAt` on the root and every reply whose
 * `parent_id = root.id`. Reply-level soft-delete affects only the one
 * row. No hard delete path in this phase.
 *
 * Return shape: `{ cascadedCount, parentId, pageId, entryId, volumeId }`
 * so the caller can log an activity row with the anchor info and the
 * reply-count without a second select.
 *
 * @throws Response(404) when the comment does not exist.
 * @throws Response(403) when the caller is neither author nor lead.
 * @throws Response(410) when the comment is already soft-deleted.
 */
export async function softDeleteComment(
  db: DrizzleD1Database<any>,
  commentId: string,
  userId: string,
  isLead: boolean
): Promise<{
  cascadedCount: number;
  parentId: string | null;
  pageId: string | null;
  entryId: string | null;
  volumeId: string;
}> {
  const [comment] = await db
 .select({
 authorId: comments.authorId,
 parentId: comments.parentId,
 pageId: comments.pageId,
 entryId: comments.entryId,
 volumeId: comments.volumeId,
 deletedAt: comments.deletedAt,
 })
 .from(comments)
 .where(eq(comments.id, commentId))
 .limit(1)
 .all();

  if (!comment) {
 throw new Response("Comment not found", { status: 404 });
  }

  if (comment.deletedAt !== null) {
 throw new Response("Comment already deleted", { status: 410 });
  }

  if (comment.authorId !== userId && !isLead) {
 throw new Response("Only the author or a project lead can delete this comment", {
 status: 403,
 });
  }

  const now = Date.now();
  const isRoot = comment.parentId === null;

  // Cascade on root: single UPDATE touching the row plus any replies
  // whose parent_id points back at it. The AND isNull(deletedAt) guard
  // keeps the update idempotent if a concurrent delete already
  // soft-deleted some replies.
  const where = isRoot
 ? and(
 isNull(comments.deletedAt),
 or(eq(comments.id, commentId), eq(comments.parentId, commentId))
 )
 : and(isNull(comments.deletedAt), eq(comments.id, commentId));

  const result: any = await db
 .update(comments)
 .set({ deletedAt: now, deletedBy: userId, updatedAt: now })
 .where(where);

  // D1 returns `{ meta: { changes } }` on run-equivalent paths. Fall
  // back to 0 when the driver doesn't expose a changes count -- callers
  // treat cascadedCount as best-effort, not load-bearing.
  const affected = Number(result?.meta?.changes ?? result?.changes ?? 0);
  const cascadedCount = isRoot ? Math.max(0, affected - 1) : 0;

  return {
 cascadedCount,
 parentId: comment.parentId,
 pageId: comment.pageId,
 entryId: comment.entryId,
 volumeId: comment.volumeId,
  };
}

/**
 * task #13: toggle a root comment's resolved state.
 * Root-only -- replies cannot be individually resolved, so a caller
 * passing a reply id gets HTTP 400. The route is responsible for the
 * asymmetric role gate (any editor may resolve; only lead may
 * un-resolve): this helper trusts the route's check and does not
 * re-derive permissions.
 *
 * Does NOT touch `editedAt` -- resolving is a workflow signal on the
 * thread, not a body edit. `updatedAt` is bumped so the outline
 * loader's revalidation sees a fresh row.
 *
 * @throws Response(404) when the comment does not exist.
 * @throws Response(410) when the comment is soft-deleted.
 * @throws Response(400) when the target is a reply (parent_id IS NOT NULL).
 */
export async function resolveComment(
  db: DrizzleD1Database<any>,
  commentId: string,
  userId: string,
  resolved: boolean
): Promise<{
  pageId: string | null;
  entryId: string | null;
  volumeId: string;
  changed: boolean;
}> {
  const [comment] = await db
 .select({
 parentId: comments.parentId,
 resolvedAt: comments.resolvedAt,
 deletedAt: comments.deletedAt,
 pageId: comments.pageId,
 entryId: comments.entryId,
 volumeId: comments.volumeId,
 })
 .from(comments)
 .where(eq(comments.id, commentId))
 .limit(1)
 .all();

  if (!comment) {
 throw new Response("Comment not found", { status: 404 });
  }

  if (comment.deletedAt !== null) {
 throw new Response("Comment already deleted", { status: 410 });
  }

  if (comment.parentId !== null) {
 throw new Response("Only root comments can be resolved", { status: 400 });
  }

  const alreadyResolved = comment.resolvedAt !== null;
  const wantResolved = resolved;

  if (alreadyResolved === wantResolved) {
 // No-op: state already matches. Don't bump anything.
 return {
 pageId: comment.pageId,
 entryId: comment.entryId,
 volumeId: comment.volumeId,
 changed: false,
 };
  }

  const now = Date.now();
  await db
 .update(comments)
 .set({
 resolvedAt: wantResolved ? now : null,
 resolvedBy: wantResolved ? userId : null,
 updatedAt: now,
 })
 .where(eq(comments.id, commentId));

  return {
 pageId: comment.pageId,
 entryId: comment.entryId,
 volumeId: comment.volumeId,
 changed: true,
  };
}

