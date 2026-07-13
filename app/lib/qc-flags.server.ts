/**
 * QC Flags Server Module
 *
 * This module deals with the server-side engine for the QC flag
 * lifecycle: raising a new flag against a page, listing open flags
 * for a volume or entry, resolving a flag with a reason, and joining
 * denormalised reporter / resolver display names. Every mutation is
 * behind a project-role guard; callers pass the guarded user in.
 *
 * @version v0.4.2
 */
import { eq, and, inArray, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { qcFlags, volumes } from "../db/schema";

/**
 * Problem taxonomy for a QC flag.
 *
 * - `damaged` — physically unreadable: torn, stained, faded
 * - `repeated` — duplicate of another page in the same volume
 * - `out_of_order` — page in the wrong position
 * - `missing` — gap in numbering; an expected page isn't there
 * - `blank` — intentionally blank page (informational)
 * - `other` — catch-all; `description` is required
 */
export type QcProblemType =
  | "damaged"
  | "repeated"
  | "out_of_order"
  | "missing"
  | "blank"
  | "other";

/**
 * Flag lifecycle status. New flags start `open`; leads resolve
 * to either `resolved` (action taken, issue fixed) or `wontfix` (known
 * issue, no remedy will be attempted).
 */
export type QcStatus = "open" | "resolved" | "wontfix";

/**
 * What the resolver did about the flag. `other` requires a
 * non-empty `resolverNote`; all others are self-describing.
 */
export type QcResolutionAction =
  | "retake_requested"
  | "reordered"
  | "marked_duplicate"
  | "ignored"
  | "other";

/**
 * Create a new QC flag on a specific volume page.
 *
 * Any project member (lead, reviewer, cataloguer) can raise a flag —
 * the access check is performed by the route via `requirePageAccess`.
 * Throws a 400 `Response` if `description` is blank so that the empty
 * string never reaches the DB (the CHECK constraint would also reject
 * it, but the typed error is friendlier).
 */
export async function createQcFlag(
  db: DrizzleD1Database<any>,
  data: {
 volumeId: string;
 pageId: string;
 reportedBy: string;
 problemType: QcProblemType;
 description: string;
  }
): Promise<{ id: string }> {
  if (!data.description.trim()) {
 throw new Response("description is required", { status: 400 });
  }

  const id = crypto.randomUUID();
  const now = Date.now();

  // A QC flag inherits its tenant from its parent volume. Resolve it so
  // the row sets tenant_id explicitly (the schema has no default).
  const volumeRow = await db
    .select({ tenantId: volumes.tenantId })
    .from(volumes)
    .where(eq(volumes.id, data.volumeId))
    .get();
  if (!volumeRow) {
    throw new Response("Volume not found", { status: 404 });
  }

  await db.insert(qcFlags).values({
 id,
 tenantId: volumeRow.tenantId,
 volumeId: data.volumeId,
 pageId: data.pageId,
 reportedBy: data.reportedBy,
 problemType: data.problemType,
 description: data.description,
 status: "open",
 createdAt: now,
  });

  return { id };
}

/**
 * Transition an open flag to `resolved` or `wontfix`.
 *
 * The `resolutionAction === 'other'` + empty-note pair is rejected
 * here so the error surfaces as a 400 rather than a DB CHECK failure.
 * The flag is loaded first so we can distinguish 404 (missing) from
 * 409 (already resolved) — the latter is the "two leads race" case.
 *
 * This helper intentionally does NOT perform the leads-only guard —
 * that is the route's responsibility via `requireProjectRole`. Keeping
 * the helper role-agnostic means it can also be called from background
 * scripts or admin tooling that does not go through the HTTP surface.
 */
export async function resolveQcFlag(
  db: DrizzleD1Database<any>,
  flagId: string,
  resolvedBy: string,
  status: Exclude<QcStatus, "open">,
  resolutionAction: QcResolutionAction,
  resolverNote: string | null
): Promise<void> {
  if (resolutionAction === "other" && !resolverNote?.trim()) {
 throw new Response(
 "resolver_note is required when resolution_action is 'other'",
 { status: 400 }
 );
  }

  const [flag] = await db
 .select({ id: qcFlags.id, status: qcFlags.status })
 .from(qcFlags)
 .where(eq(qcFlags.id, flagId))
 .limit(1)
 .all();

  if (!flag) {
 throw new Response("QC flag not found", { status: 404 });
  }

  if (flag.status !== "open") {
 throw new Response("QC flag is already resolved", { status: 409 });
  }

  const now = Date.now();
  await db
 .update(qcFlags)
 .set({
 status,
 resolutionAction,
 resolverNote: resolverNote?.trim() ? resolverNote.trim() : null,
 resolvedBy,
 resolvedAt: now,
 })
 .where(eq(qcFlags.id, flagId));
}

/**
 * Return all open flags on a volume, in no guaranteed order beyond
 * SQLite's default (row order). Used by the viewer loader to group
 * open flags by `pageId` for per-page badges ().
 */
export async function getOpenQcFlags(
  db: DrizzleD1Database<any>,
  volumeId: string
) {
  return db
 .select({
 id: qcFlags.id,
 pageId: qcFlags.pageId,
 problemType: qcFlags.problemType,
 description: qcFlags.description,
 reportedBy: qcFlags.reportedBy,
 createdAt: qcFlags.createdAt,
 })
 .from(qcFlags)
 .where(and(eq(qcFlags.volumeId, volumeId), eq(qcFlags.status, "open")))
 .all();
}

/**
 * Cheap COUNT of open flags on a volume. Backs the volume overview
 * badge ("N open flags") in . At the current data scale the
 * `(volume_id, status)` composite index makes this a sub-millisecond
 * query; no denormalised column is justified.
 */
export async function getOpenQcFlagCount(
  db: DrizzleD1Database<any>,
  volumeId: string
): Promise<number> {
  const row = await db
 .select({ count: sql<number>`COUNT(*)` })
 .from(qcFlags)
 .where(and(eq(qcFlags.volumeId, volumeId), eq(qcFlags.status, "open")))
 .get();
  return row?.count ?? 0;
}

/**
 * Return every flag on a volume, optionally narrowed to a subset of
 * statuses. Used by the GET branch of `/api/qc-flags` and, in ,
 * by the lead's "review resolved flags" surface.
 */
export async function getQcFlagsForVolume(
  db: DrizzleD1Database<any>,
  volumeId: string,
  opts: { statuses?: QcStatus[] } = {}
) {
  const statuses = opts.statuses ?? ["open", "resolved", "wontfix"];
  return db
 .select()
 .from(qcFlags)
 .where(
 and(eq(qcFlags.volumeId, volumeId), inArray(qcFlags.status, statuses))
 )
 .all();
}

