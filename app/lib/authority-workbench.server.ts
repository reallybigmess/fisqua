/**
 * Authority workbench — ledger-derived superseded status
 *
 * The merge/split workbenches (spec §4) leave the superseded record in
 * place: a merged-away record keeps its page, and both halves of a
 * split keep theirs. The status band atop those pages is DERIVED FROM
 * THE LEDGER (`authority_operations`) — there is no superseded column
 * and no new schema. This module owns that derivation: given a record
 * and an operation, it returns who performed it and when, resolving the
 * actor's display name through the federation-scoped users join.
 *
 * `mergedInto` remains the live pointer the lists and detail loaders
 * filter on; this helper only supplies the band's date + actor, read
 * from the immutable ledger row the merge/split action wrote in the
 * same batch as the mutation.
 *
 * @version v0.4.2
 */

import type { DrizzleD1Database } from "drizzle-orm/d1";

export interface OperationActor {
  /** epoch ms the operation was recorded. */
  createdAt: number;
  userId: string;
  /** Resolved display name, or null when the user row is gone. */
  userName: string | null;
  /** merge: loser · split: parent · delete: the deleted record. */
  sourceId: string;
  /** merge: winner · split: new record · delete: null. */
  targetId: string | null;
}

/**
 * Return the most recent `authority_operations` row matching the given
 * (recordType, operation, sourceId) — and optionally a specific
 * targetId — with the actor's name resolved, for the status band on a
 * superseded record. Returns `null` when no such operation exists
 * (e.g. a record whose `mergedInto` predates the ledger).
 */
export async function getOperationActor(
  db: DrizzleD1Database<any>,
  args: {
    recordType: "entity" | "place";
    operation: "merge" | "split";
    sourceId?: string;
    targetId?: string;
  },
): Promise<OperationActor | null> {
  const { and, eq, desc } = await import("drizzle-orm");
  const { authorityOperations, users } = await import("../db/schema");

  const conditions = [
    eq(authorityOperations.recordType, args.recordType),
    eq(authorityOperations.operation, args.operation),
  ];
  if (args.sourceId) {
    conditions.push(eq(authorityOperations.sourceId, args.sourceId));
  }
  if (args.targetId) {
    conditions.push(eq(authorityOperations.targetId, args.targetId));
  }

  const row = await db
    .select({
      createdAt: authorityOperations.createdAt,
      userId: authorityOperations.userId,
      sourceId: authorityOperations.sourceId,
      targetId: authorityOperations.targetId,
      userName: users.name,
    })
    .from(authorityOperations)
    .leftJoin(users, eq(users.id, authorityOperations.userId))
    .where(and(...conditions))
    .orderBy(desc(authorityOperations.createdAt))
    .limit(1)
    .get();

  if (!row) return null;
  return {
    createdAt: row.createdAt,
    userId: row.userId,
    userName: row.userName ?? null,
    sourceId: row.sourceId,
    targetId: row.targetId ?? null,
  };
}

/**
 * Return every distinct new-record id produced by split operations on
 * `sourceId` (a split parent may be split more than once over its
 * life) — the "Split into A and B" targets the band names.
 */
export async function getSplitTargets(
  db: DrizzleD1Database<any>,
  recordType: "entity" | "place",
  sourceId: string,
): Promise<string[]> {
  const { and, eq, isNotNull } = await import("drizzle-orm");
  const { authorityOperations } = await import("../db/schema");

  const rows = await db
    .select({ targetId: authorityOperations.targetId })
    .from(authorityOperations)
    .where(
      and(
        eq(authorityOperations.recordType, recordType),
        eq(authorityOperations.operation, "split"),
        eq(authorityOperations.sourceId, sourceId),
        isNotNull(authorityOperations.targetId),
      ),
    )
    .all();

  return rows.map((r) => r.targetId).filter((id): id is string => id != null);
}

/** Format an epoch-ms timestamp as an ISO calendar date (YYYY-MM-DD). */
export function bandDate(createdAt: number): string {
  return new Date(createdAt).toISOString().slice(0, 10);
}

export interface OperationHistoryRow {
  id: string;
  operation: "merge" | "split" | "delete" | "resolve" | "separate";
  /** Whether this record is the operation's source or its target. */
  direction: "source" | "target";
  /** The other record named by the operation, when one exists. */
  counterpartId: string | null;
  createdAt: number;
  userName: string | null;
  reason: string | null;
  movedLinks: number | null;
  droppedLinks: number | null;
  leftBehind: number | null;
}

/** Rows the history page renders; older operations stay in the ledger. */
export const OPERATION_HISTORY_LIMIT = 100;

/**
 * The latest ledger operations touching a record — as source OR
 * target — newest first, capped at `OPERATION_HISTORY_LIMIT`, with the
 * actor's name resolved and the `detail` JSON unpacked into the fields
 * the history page renders (reason, link counts). `total` carries the
 * uncapped count so the page can say "showing latest 100 of {n}"
 * (production backfill volume: a record can carry one resolve row plus
 * dozens of separate rows). Federation-scoped; the read-only history
 * route builds its direction-aware human titles from `operation` +
 * `direction` + the counterpart's name.
 */
export async function getOperationHistory(
  db: DrizzleD1Database<any>,
  args: {
    federationId: string;
    recordType: "entity" | "place";
    recordId: string;
  },
): Promise<{ rows: OperationHistoryRow[]; total: number }> {
  const { and, eq, or, desc, sql } = await import("drizzle-orm");
  const { authorityOperations, users } = await import("../db/schema");

  const scope = and(
    eq(authorityOperations.federationId, args.federationId),
    eq(authorityOperations.recordType, args.recordType),
    or(
      eq(authorityOperations.sourceId, args.recordId),
      eq(authorityOperations.targetId, args.recordId),
    ),
  );

  const [{ count: total }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(authorityOperations)
    .where(scope)
    .all();

  const rows = await db
    .select({
      id: authorityOperations.id,
      operation: authorityOperations.operation,
      sourceId: authorityOperations.sourceId,
      targetId: authorityOperations.targetId,
      createdAt: authorityOperations.createdAt,
      detail: authorityOperations.detail,
      userName: users.name,
    })
    .from(authorityOperations)
    .leftJoin(users, eq(users.id, authorityOperations.userId))
    .where(scope)
    .orderBy(desc(authorityOperations.createdAt))
    .limit(OPERATION_HISTORY_LIMIT)
    .all();

  const mapped = rows.map((r) => {
    let detail: Record<string, unknown> = {};
    try {
      detail = r.detail ? JSON.parse(r.detail) : {};
    } catch {
      detail = {};
    }
    const direction =
      r.sourceId === args.recordId ? ("source" as const) : ("target" as const);
    const counterpartId =
      direction === "source" ? (r.targetId ?? null) : r.sourceId;
    return {
      id: r.id,
      operation: r.operation,
      direction,
      counterpartId,
      createdAt: r.createdAt,
      userName: r.userName ?? null,
      reason: typeof detail.reason === "string" ? detail.reason : null,
      movedLinks:
        typeof detail.movedLinks === "number" ? detail.movedLinks : null,
      droppedLinks: Array.isArray(detail.droppedLinks)
        ? detail.droppedLinks.length
        : null,
      leftBehind:
        typeof detail.leftBehind === "number" ? detail.leftBehind : null,
    };
  });
  return { rows: mapped, total };
}
