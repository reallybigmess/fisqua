/**
 * Authority operations ledger helper
 *
 * This module owns the single write path into `authority_operations` —
 * the append-only ledger of irreversible authority mutations (entity /
 * place / vocabulary_term merge, split, delete). Every authority
 * mutation site composes its ledger row through `logAuthorityOperation`
 * and embeds the returned statement in the SAME `db.batch([...])` as the
 * mutation itself, so the ledger row and the mutation commit atomically:
 * a merge that moves junction rows and the ledger row recording it land
 * together or not at all, and no mutation can succeed while its ledger
 * row is lost.
 *
 * ## Returns a batch item, not a promise
 *
 * `logAuthorityOperation` returns an un-awaited Drizzle insert builder
 * (a `BatchItem<"sqlite">`), mirroring the audit insert composed by
 * `withAuditLog`. The caller does its reads first, computes the `detail`
 * payload, then submits `db.batch([...mutationStatements, ledgerRow])`.
 * The ledger row is safe in any batch position: source_id / target_id
 * carry no foreign key, and federation_id / user_id reference rows that
 * already exist before the batch runs.
 *
 * ## detail payload convention
 *
 *   - merge:  `{ movedLinks, droppedLinks: [...full conflict-deleted
 *              junction rows...] }` — the droppedLinks capture is the
 *              fix for the silent junction deletion; the caller reads the
 *              conflicting rows before the batch and passes their full
 *              content here so nothing is destroyed without landing in
 *              the ledger.
 *   - split:  `{ movedLinks }`.
 *   - delete: `{ snapshot: <full row of the deleted record> }`.
 *
 * `detail` is JSON-stringified onto the TEXT column; `null`/`undefined`
 * write SQL NULL, not the string `"null"`.
 *
 * ## Helper owns the id and the clock
 *
 * `id` is a fresh `crypto.randomUUID()`; `created_at` defaults to
 * `Date.now()` (epoch ms) unless the caller injects `now` (vocabulary
 * sites keep their own second-precision `now` for other columns, so they
 * pass `Date.now()` here explicitly — the ledger is always epoch ms).
 *
 * @version v0.4.2
 */

import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { BatchItem } from "drizzle-orm/batch";
import { authorityOperations } from "../db/schema";

export interface AuthorityOperationParams {
  federationId: string;
  recordType: "entity" | "place" | "vocabulary_term";
  /**
   * resolve (per-entity creation provenance) and separate (refuted
   * merge / do-not-relink) are reserved for the pipeline provenance
   * backfill (spec §10); the admin routes write only merge/split/delete.
   */
  operation: "merge" | "split" | "delete" | "resolve" | "separate";
  /** merge: the loser · split: the parent · delete: the deleted record. */
  sourceId: string;
  /** merge: the winner · split: the new record · delete: NULL. */
  targetId?: string | null;
  userId: string;
  /** Structured JSON payload; see the module header for the shape per operation. */
  detail?: Record<string, unknown> | null;
  /** Clock override (epoch ms). Defaults to `Date.now()`. */
  now?: number;
}

/**
 * Build the ledger insert for one authority operation. Returns the
 * un-awaited insert builder to embed in the caller's `db.batch([...])`
 * alongside the mutation it records — see the module header.
 */
export function logAuthorityOperation(
  db: DrizzleD1Database<any>,
  params: AuthorityOperationParams,
): BatchItem<"sqlite"> {
  const detailJson =
    params.detail === undefined || params.detail === null
      ? null
      : JSON.stringify(params.detail);

  return db.insert(authorityOperations).values({
    id: crypto.randomUUID(),
    federationId: params.federationId,
    recordType: params.recordType,
    operation: params.operation,
    sourceId: params.sourceId,
    targetId: params.targetId ?? null,
    userId: params.userId,
    detail: detailJson,
    createdAt: params.now ?? Date.now(),
  });
}
