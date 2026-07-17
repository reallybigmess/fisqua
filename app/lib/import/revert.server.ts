/**
 * Import revert — the compensating write side of the stewardship record
 *
 * This module owns the step bodies the ImportRevertWorkflow drives
 * (stewardship record spec §4). It INVERTS a target run's journal: for
 * each `changelog` row the target wrote, it applies the compensating
 * write and journals that write under the REVERT run in the same
 * `db.batch` — so a revert is itself a fully-journaled run, and reverting
 * a revert re-applies the original import (the chain stays self-consistent).
 *
 * As with `commit.server.ts`, the Workflow is a THIN entrypoint: it
 * sequences `step.do(...)` calls over the exported functions here, each
 * running in its own Worker invocation. Keeping the bodies here makes
 * them unit-testable against the test D1 harness without the Workflows
 * runtime.
 *
 * ## Reverse order — derived from journal PAYLOADS, not timestamps
 *
 * Journal rows within one commit batch share `created_at` and carry
 * random-UUID ids, so there is NO reliable intra-run total order from
 * either column (phase-5 review finding). The reverse walk therefore
 * derives a deterministic structural order from the row payloads, not
 * from the clock:
 *
 *   1. Rows are grouped by `record_id` and partitioned by the inversion
 *      each record needs, which the row `kind` fixes uniquely (an import
 *      creates OR updates a given row, never both; a revert deletes OR
 *      re-inserts OR restores it):
 *        - `create` rows  → the record was CREATED → invert by DELETE.
 *        - `delete` rows  → the record was DELETED (target was a revert)
 *                           → invert by RE-INSERT from the snapshot.
 *        - `update` rows  → the record was UPDATED → invert by RESTORING
 *                           the recorded `old` values (childCount cache
 *                           reconciliations are ordinary update rows and
 *                           restore uniformly with everything else).
 *   2. Execution order across the partitions:
 *        a. RESTORES first — independent field writes on surviving rows;
 *           no ordering constraint among them.
 *        b. DELETES next, ordered by snapshot `depth` DESC (children
 *           before parents) so a created subtree deletes leaf-first.
 *        c. RE-INSERTS next, ordered by snapshot `depth` ASC (parents
 *           before children) so a re-created subtree lands root-first.
 *        d. CONTAINER RECONCILIATION last: recompute `childCount` for the
 *           affected surviving containers to the actual DB count (the
 *           phase-5 recompute machinery, symmetric), journaled as update
 *           rows. In the clean case restore already left the count
 *           correct and this no-ops; when a child was kept (skip), it
 *           corrects the divergence honestly.
 *
 * ## Edited-since test — compare against the run's LAST touch of the row
 *
 * A row the run touched carries `updated_at` equal to the LAST moment the
 * run wrote it (an import may write a row twice — a field update, then a
 * childCount reconciliation). The edited-since test therefore compares
 * the row's current `updated_at` against the MAXIMUM `created_at` among
 * the target run's journal rows for that record (its `runTouchTime`). If
 * `current.updated_at > runTouchTime` the row was edited AFTER the run —
 * by hand, another run, or an authority op — so it is SKIPPED and counted
 * (never forced, never merged; spec §4). Equality means untouched-since:
 * revert proceeds. A compensating write bumps `updated_at` to the revert
 * clock, which is exactly what makes a second pass treat the row as
 * "edited since" — the idempotency that keeps a retry from double-writing.
 *
 * ## Deletes: children before parents, foreign children keep a container
 *
 * A created row is deleted only when it has NO surviving children the run
 * did not itself remove. Because deletes run leaf-first, by the time a
 * container is reached its own run-created descendants are already gone
 * (prior batches) or queued in the same batch. Any child STILL present
 * that is not itself being deleted in this batch is foreign (created
 * outside the run) or a run-child that was itself skipped — either way
 * the container cannot be deleted, so it is SKIPPED and counted
 * (`skippedForeignChildren`). The skip cascades: a kept child keeps its
 * ancestors.
 *
 * ## The journal is composed in the SAME db.batch as the mutation
 *
 * Every compensating mutation is paired with a `composeJournalEntry`
 * BatchItem in the enclosing scope and submitted in one `db.batch` (the
 * ledger discipline, spec §3; the journal-coverage scanner polices the
 * pairing). A DELETE journals a `delete` row with the full pre-image
 * snapshot (so a future revert can re-create the row); a RESTORE journals
 * an `update` row with the reverse diff; a RE-INSERT journals a `create`
 * row with the new-row snapshot. Deletes of descriptions exist ONLY on
 * this compensating path (spec §4 — the ruled exception to the
 * imports-never-delete rule).
 *
 * @version v0.6.0
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { BatchItem } from "drizzle-orm/batch";
import { changelog, descriptions, stewardshipRuns } from "../../db/schema";
import {
  assertRunMessage,
  composeJournalEntry,
  createSnapshotDiff,
  deleteSnapshotDiff,
  computeDiff,
} from "../stewardship.server";
import type { StagingStore } from "./staging.server";
import { stagingKey } from "./staging.server";

/**
 * Records per batch AND the chunk size for every IN()-list read in this
 * module. Each compensating statement (delete/update/insert) and its
 * paired journal insert stay well under D1's 100-bound-parameter cap;
 * every list-bound read (per-batch requeries, the container-reconcile
 * parent + grouped-count reads) binds `size + 1` (the tenant id), so
 * `size <= 99` is required and 50 mirrors the commit batch size with
 * ample headroom. Nothing in this module passes an unchunked list to
 * `inArray`.
 */
export const REVERT_BATCH_SIZE = 50;

/**
 * A D1 column value as it round-trips through the journal and the step
 * boundary — every journaled column is text or integer, so JSON primitives
 * cover it, and the type stays Workflow-serialisable.
 */
type ColumnValue = string | number | boolean | null;

/** Restore one updated row to its pre-run values. */
interface RestorePlan {
  recordId: string;
  /** Field → the run's recorded `old` value (earliest, i.e. pre-run). */
  oldValues: Record<string, ColumnValue>;
  /** Max journal `created_at` for this record in the target run. */
  runTouchTime: number;
}

/** Delete one row the run created. */
interface DeletePlan {
  recordId: string;
  /** Snapshot depth — sorts the plan leaf-first (DESC). */
  depth: number;
  runTouchTime: number;
}

/** Re-insert one row the run deleted (revert-of-revert). */
interface ReinsertPlan {
  recordId: string;
  /** The full pre-delete row, reconstructed from the delete snapshot. */
  row: Record<string, ColumnValue>;
  /** Snapshot depth — sorts the plan root-first (ASC). */
  depth: number;
}

/** The plan + inputs every step needs; JSON-serialisable across steps. */
export interface RevertConfig {
  /** The kind='revert' run this workflow drives. */
  runId: string;
  /** The run being reverted (import or an earlier revert). */
  targetRunId: string;
  tenantId: string;
  /** The revert author — stamped into every compensating journal row. */
  userId: string;
  restores: RestorePlan[];
  /** Sorted depth DESC (children before parents). */
  deletes: DeletePlan[];
  /** Sorted depth ASC (parents before children). */
  reinserts: ReinsertPlan[];
  /** Distinct parent ids of deleted + reinserted rows, for reconcile. */
  affectedParentIds: string[];
  totalSteps: number;
}

/** Write-derived revert counts (spec §4). `reverted` = deleted + restored
 *  + reinserted; `kept` = the two skip buckets. */
export interface RevertCounts {
  /** Created rows deleted (their before-image is non-existence). */
  deleted: number;
  /** Updated rows restored to their pre-run values. */
  restored: number;
  /** Deleted rows re-inserted (revert-of-revert re-applies the original). */
  reinserted: number;
  /** Rows edited since the run touched them — kept, never forced. */
  skippedEdited: number;
  /** Created containers that acquired children the run did not create. */
  skippedForeignChildren: number;
  /** Re-inserts blocked by a since-created row on the same natural key. */
  skippedConflict: number;
}

/** Raised when a revert run's inputs cannot be resolved (a fatal config error). */
export class ImportRevertConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportRevertConfigError";
  }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type FieldDiff = { old?: unknown; new?: unknown };
type DiffPayload = Record<string, FieldDiff>;

/** Parse a journal `diff` JSON into a per-field `{ old, new }` map. */
function parseDiff(json: string): DiffPayload {
  try {
    const value = JSON.parse(json);
    return value && typeof value === "object" ? (value as DiffPayload) : {};
  } catch {
    return {};
  }
}

/** The new-row snapshot ({old:null,new}) → { field: new } (a created row). */
function snapshotNew(diff: DiffPayload): Record<string, ColumnValue> {
  const row: Record<string, ColumnValue> = {};
  for (const [field, fd] of Object.entries(diff)) row[field] = fd.new as ColumnValue;
  return row;
}

/** The pre-image snapshot ({old,new:null}) → { field: old } (a deleted row). */
function snapshotOld(diff: DiffPayload): Record<string, ColumnValue> {
  const row: Record<string, ColumnValue> = {};
  for (const [field, fd] of Object.entries(diff)) row[field] = fd.old as ColumnValue;
  return row;
}

interface JournalRow {
  recordId: string;
  recordType: string;
  kind: "create" | "update" | "delete" | "link" | "unlink";
  diff: string;
  createdAt: number;
}

/**
 * Load the revert + target runs, read the target's journal, and build the
 * reverse-order plan (module header). Marks the revert run `running`.
 * Fatal problems throw `ImportRevertConfigError` (the Workflow turns that
 * into a run `error`).
 */
export async function loadRevertConfig(
  db: DrizzleD1Database<any>,
  params: { runId: string; workflowInstanceId?: string },
): Promise<RevertConfig> {
  const run = await db
    .select()
    .from(stewardshipRuns)
    .where(eq(stewardshipRuns.id, params.runId))
    .get();
  if (!run) throw new ImportRevertConfigError(`stewardship run ${params.runId} not found`);
  if (run.kind !== "revert") {
    throw new ImportRevertConfigError(`run ${params.runId} is not a revert run`);
  }
  if (!run.revertsRunId) {
    throw new ImportRevertConfigError(`revert run ${params.runId} has no target`);
  }

  const target = await db
    .select()
    .from(stewardshipRuns)
    .where(
      and(eq(stewardshipRuns.id, run.revertsRunId), eq(stewardshipRuns.tenantId, run.tenantId)),
    )
    .get();
  if (!target) {
    throw new ImportRevertConfigError(`target run ${run.revertsRunId} not found for tenant`);
  }
  if (target.status !== "complete") {
    throw new ImportRevertConfigError(`target run ${target.id} is not complete (cannot revert)`);
  }

  const rows = (await db
    .select({
      recordId: changelog.recordId,
      recordType: changelog.recordType,
      kind: changelog.kind,
      diff: changelog.diff,
      createdAt: changelog.createdAt,
    })
    .from(changelog)
    .where(eq(changelog.runId, target.id))
    .all()) as JournalRow[];

  // Group by record. The kind partitions the inversion (module header):
  // a record touched by a run is created, deleted, OR updated (one or
  // more update rows), never a mix. Only description rows are inverted in
  // this stage (imports journal descriptions only); any other record type
  // is left untouched.
  const byRecord = new Map<string, JournalRow[]>();
  for (const row of rows) {
    if (row.recordType !== "description") continue;
    const group = byRecord.get(row.recordId) ?? [];
    group.push(row);
    byRecord.set(row.recordId, group);
  }

  const restores: RestorePlan[] = [];
  const deletes: DeletePlan[] = [];
  const reinserts: ReinsertPlan[] = [];
  const affectedParentIds = new Set<string>();

  for (const [recordId, group] of byRecord) {
    const runTouchTime = group.reduce((m, r) => Math.max(m, r.createdAt), 0);
    const createRow = group.find((r) => r.kind === "create");
    const deleteRow = group.find((r) => r.kind === "delete");

    if (createRow) {
      // The run created this row → delete it. Depth + parent come from the
      // create snapshot (used only to order and to reconcile).
      const snap = snapshotNew(parseDiff(createRow.diff));
      const depth = typeof snap.depth === "number" ? snap.depth : 0;
      const parentId = typeof snap.parentId === "string" ? snap.parentId : null;
      if (parentId) affectedParentIds.add(parentId);
      deletes.push({ recordId, depth, runTouchTime });
    } else if (deleteRow) {
      // The run deleted this row (target was a revert) → re-insert it from
      // its pre-image snapshot (revert-of-revert re-applies the original).
      const row = snapshotOld(parseDiff(deleteRow.diff));
      const depth = typeof row.depth === "number" ? row.depth : 0;
      const parentId = typeof row.parentId === "string" ? row.parentId : null;
      if (parentId) affectedParentIds.add(parentId);
      reinserts.push({ recordId, row, depth });
    } else {
      // Only update rows → restore the pre-run values. Merge every update
      // row's `old` per field, earliest-wins (the value before the run
      // first touched the field). childCount reconciliations restore here
      // uniformly with real field edits.
      const ordered = [...group].sort((a, b) => a.createdAt - b.createdAt);
      const oldValues: Record<string, ColumnValue> = {};
      for (const r of ordered) {
        const diff = parseDiff(r.diff);
        for (const [field, fd] of Object.entries(diff)) {
          if (!(field in oldValues)) oldValues[field] = fd.old as ColumnValue;
        }
      }
      if (Object.keys(oldValues).length > 0) {
        restores.push({ recordId, oldValues, runTouchTime });
      }
    }
  }

  deletes.sort((a, b) => b.depth - a.depth); // leaf-first
  reinserts.sort((a, b) => a.depth - b.depth); // root-first

  const totalSteps =
    chunk(restores, REVERT_BATCH_SIZE).length +
    chunk(deletes, REVERT_BATCH_SIZE).length +
    chunk(reinserts, REVERT_BATCH_SIZE).length +
    1; // the reconcile step

  await db
    .update(stewardshipRuns)
    .set({
      status: "running",
      startedAt: Date.now(),
      workflowInstanceId: params.workflowInstanceId ?? null,
      totalSteps,
      lastHeartbeatAt: Date.now(),
    })
    .where(eq(stewardshipRuns.id, params.runId));

  return {
    runId: params.runId,
    targetRunId: target.id,
    tenantId: run.tenantId,
    userId: run.userId,
    restores,
    deletes,
    reinserts,
    affectedParentIds: [...affectedParentIds],
    totalSteps,
  };
}

/**
 * Process one RESTORE batch: for each updated row, if it was not edited
 * since the run touched it, write the recorded pre-run values back and
 * journal the reverse diff in the SAME `db.batch`. A row already at its
 * pre-run values (idempotent re-run) yields an empty diff and is left
 * untouched. Returns EXECUTED counts.
 */
export async function processRestoreBatch(
  db: DrizzleD1Database<any>,
  config: RevertConfig,
  batch: readonly RestorePlan[],
): Promise<{ restored: number; skippedEdited: number }> {
  if (batch.length === 0) return { restored: 0, skippedEdited: 0 };
  const ids = batch.map((p) => p.recordId);
  const current = (await db
    .select()
    .from(descriptions)
    .where(and(eq(descriptions.tenantId, config.tenantId), inArray(descriptions.id, ids)))
    .all()) as Record<string, unknown>[];
  const currentById = new Map(current.map((r) => [r.id as string, r]));

  const now = Date.now();
  const statements: BatchItem<"sqlite">[] = [];
  let restored = 0;
  let skippedEdited = 0;
  for (const plan of batch) {
    const row = currentById.get(plan.recordId);
    if (!row) continue; // row is gone — nothing to restore (idempotent)

    if ((row.updatedAt as number) > plan.runTouchTime) {
      skippedEdited++;
      continue; // edited after the run — never force (spec §4)
    }

    // Reverse diff: current value → pre-run value, changed fields only.
    const before: Record<string, unknown> = {};
    for (const key of Object.keys(plan.oldValues)) before[key] = row[key];
    const diff = computeDiff(before, plan.oldValues);
    if (!diff) {
      restored++;
      continue; // already at pre-run values (idempotent no-op)
    }

    statements.push(
      db
        .update(descriptions)
        .set({ ...plan.oldValues, updatedBy: config.userId, updatedAt: now })
        .where(
          and(eq(descriptions.tenantId, config.tenantId), eq(descriptions.id, plan.recordId)),
        ),
    );
    statements.push(
      composeJournalEntry(db, {
        recordId: plan.recordId,
        recordType: "description",
        userId: config.userId,
        kind: "update",
        diff,
        runId: config.runId,
        now,
      }),
    );
    restored++;
  }

  if (statements.length > 0) await db.batch(statements as [any, ...any[]]);
  return { restored, skippedEdited };
}

/**
 * Process one DELETE batch: for each row the run created, delete it —
 * unless it was edited since (skip-and-count) or has acquired surviving
 * children the run did not remove (skip-and-count as foreign-children;
 * module header). Each delete journals a full pre-image `delete` row in
 * the SAME `db.batch`, so a future revert can re-create the row. Returns
 * EXECUTED counts.
 */
export async function processDeleteBatch(
  db: DrizzleD1Database<any>,
  config: RevertConfig,
  batch: readonly DeletePlan[],
): Promise<{ deleted: number; skippedEdited: number; skippedForeignChildren: number }> {
  if (batch.length === 0) {
    return { deleted: 0, skippedEdited: 0, skippedForeignChildren: 0 };
  }
  const ids = batch.map((p) => p.recordId);
  const current = (await db
    .select()
    .from(descriptions)
    .where(and(eq(descriptions.tenantId, config.tenantId), inArray(descriptions.id, ids)))
    .all()) as Record<string, unknown>[];
  const currentById = new Map(current.map((r) => [r.id as string, r]));

  // Load the live children of every row in this batch in one read. A child
  // still present here was created outside the run (foreign) or is a
  // run-child queued in this same batch; the latter are excluded via the
  // `deletingIds` set as they are decided. Children removed by prior
  // batches are already gone and never appear.
  const childRows = (await db
    .select({ id: descriptions.id, parentId: descriptions.parentId })
    .from(descriptions)
    .where(and(eq(descriptions.tenantId, config.tenantId), inArray(descriptions.parentId, ids)))
    .all()) as { id: string; parentId: string | null }[];
  const childrenByParent = new Map<string, string[]>();
  for (const c of childRows) {
    if (!c.parentId) continue;
    const list = childrenByParent.get(c.parentId) ?? [];
    list.push(c.id);
    childrenByParent.set(c.parentId, list);
  }

  const now = Date.now();
  const statements: BatchItem<"sqlite">[] = [];
  const deletingIds = new Set<string>();
  let deleted = 0;
  let skippedEdited = 0;
  let skippedForeignChildren = 0;
  // Batch is pre-sorted leaf-first, so a child precedes its parent here.
  for (const plan of batch) {
    const row = currentById.get(plan.recordId);
    if (!row) continue; // already deleted — idempotent

    if ((row.updatedAt as number) > plan.runTouchTime) {
      skippedEdited++;
      continue; // edited after the run — never force
    }

    const children = childrenByParent.get(plan.recordId) ?? [];
    const surviving = children.filter((cid) => !deletingIds.has(cid));
    if (surviving.length > 0) {
      skippedForeignChildren++;
      continue; // foreign or kept children — cannot delete the container
    }

    statements.push(
      db
        .delete(descriptions)
        .where(
          and(eq(descriptions.tenantId, config.tenantId), eq(descriptions.id, plan.recordId)),
        ),
    );
    statements.push(
      composeJournalEntry(db, {
        recordId: plan.recordId,
        recordType: "description",
        userId: config.userId,
        kind: "delete",
        diff: deleteSnapshotDiff(row),
        runId: config.runId,
        now,
      }),
    );
    deletingIds.add(plan.recordId);
    deleted++;
  }

  if (statements.length > 0) await db.batch(statements as [any, ...any[]]);
  return { deleted, skippedEdited, skippedForeignChildren };
}

/**
 * Process one RE-INSERT batch (revert-of-revert): re-create each row the
 * run deleted from its pre-image snapshot, keeping the original id and
 * created-by. A row already present (idempotent re-run) or a since-created
 * row on the same natural key (a conflict the revert must not overwrite)
 * is skipped and counted. Each re-insert journals a `create` snapshot in
 * the SAME `db.batch`. Returns EXECUTED counts.
 */
export async function processReinsertBatch(
  db: DrizzleD1Database<any>,
  config: RevertConfig,
  batch: readonly ReinsertPlan[],
): Promise<{ reinserted: number; skippedConflict: number }> {
  if (batch.length === 0) return { reinserted: 0, skippedConflict: 0 };
  const ids = batch.map((p) => p.recordId);
  const refCodes = batch
    .map((p) => (typeof p.row.referenceCode === "string" ? p.row.referenceCode : null))
    .filter((c): c is string => c != null);

  const presentIds = new Set(
    (
      (await db
        .select({ id: descriptions.id })
        .from(descriptions)
        .where(and(eq(descriptions.tenantId, config.tenantId), inArray(descriptions.id, ids)))
        .all()) as { id: string }[]
    ).map((r) => r.id),
  );
  // Natural-key occupancy: a DIFFERENT row on the same (tenant, referenceCode)
  // blocks the re-insert (the unique index would reject it and, more to the
  // point, the revert must not clobber a record created since the delete).
  const refCodeToId = new Map<string, string>();
  if (refCodes.length > 0) {
    const rows = (await db
      .select({ id: descriptions.id, referenceCode: descriptions.referenceCode })
      .from(descriptions)
      .where(
        and(eq(descriptions.tenantId, config.tenantId), inArray(descriptions.referenceCode, refCodes)),
      )
      .all()) as { id: string; referenceCode: string }[];
    for (const r of rows) refCodeToId.set(r.referenceCode, r.id);
  }

  const now = Date.now();
  const statements: BatchItem<"sqlite">[] = [];
  let reinserted = 0;
  let skippedConflict = 0;
  for (const plan of batch) {
    if (presentIds.has(plan.recordId)) {
      reinserted++;
      continue; // already re-inserted — idempotent
    }
    const refCode = typeof plan.row.referenceCode === "string" ? plan.row.referenceCode : null;
    const occupantId = refCode != null ? refCodeToId.get(refCode) : undefined;
    if (occupantId && occupantId !== plan.recordId) {
      skippedConflict++;
      continue; // a since-created row holds this natural key
    }

    const values = {
      ...plan.row,
      id: plan.recordId,
      tenantId: config.tenantId,
      updatedBy: config.userId,
      updatedAt: now,
    } as typeof descriptions.$inferInsert;

    statements.push(db.insert(descriptions).values(values));
    statements.push(
      composeJournalEntry(db, {
        recordId: plan.recordId,
        recordType: "description",
        userId: config.userId,
        kind: "create",
        diff: createSnapshotDiff(values as Record<string, unknown>),
        runId: config.runId,
        now,
      }),
    );
    reinserted++;
  }

  if (statements.length > 0) await db.batch(statements as [any, ...any[]]);
  return { reinserted, skippedConflict };
}

/**
 * Reconcile `childCount` for every affected surviving container to the
 * ACTUAL DB child count (idempotent — recompute, never increment). Mirrors
 * `recomputeStructuralCaches` on the commit side: each changed container
 * is journaled as an ordinary `update` in the same `db.batch`, so the
 * scanner pairing holds and the count stays honest after deletes/reinserts.
 * Containers whose stored count already matches are left untouched.
 */
export async function reconcileContainers(
  db: DrizzleD1Database<any>,
  config: RevertConfig,
): Promise<{ reconciled: number }> {
  if (config.affectedParentIds.length === 0) return { reconciled: 0 };

  // Both reads are chunked at REVERT_BATCH_SIZE (≤99 ids + the tenant id
  // per statement) so a run touching hundreds of distinct containers never
  // exceeds D1's 100-bound-parameter cap; child counts come from ONE
  // grouped query per chunk, never a query per parent.
  const parents: { id: string; childCount: number }[] = [];
  for (const slice of chunk(config.affectedParentIds, REVERT_BATCH_SIZE)) {
    const rows = (await db
      .select({ id: descriptions.id, childCount: descriptions.childCount })
      .from(descriptions)
      .where(
        and(
          eq(descriptions.tenantId, config.tenantId),
          inArray(descriptions.id, slice),
        ),
      )
      .all()) as { id: string; childCount: number }[];
    parents.push(...rows);
  }

  const actualByParentId = new Map<string, number>();
  for (const slice of chunk(parents.map((p) => p.id), REVERT_BATCH_SIZE)) {
    const rows = (await db
      .select({ parentId: descriptions.parentId, count: sql<number>`count(*)` })
      .from(descriptions)
      .where(
        and(
          eq(descriptions.tenantId, config.tenantId),
          inArray(descriptions.parentId, slice),
        ),
      )
      .groupBy(descriptions.parentId)
      .all()) as { parentId: string | null; count: number }[];
    for (const row of rows) {
      if (row.parentId !== null) actualByParentId.set(row.parentId, row.count);
    }
  }

  const now = Date.now();
  const statements: BatchItem<"sqlite">[] = [];
  let reconciled = 0;
  for (const parent of parents) {
    const actualCount = actualByParentId.get(parent.id) ?? 0;
    if (actualCount === parent.childCount) continue;

    statements.push(
      db
        .update(descriptions)
        .set({ childCount: actualCount, updatedAt: now, updatedBy: config.userId })
        .where(and(eq(descriptions.tenantId, config.tenantId), eq(descriptions.id, parent.id))),
    );
    statements.push(
      composeJournalEntry(db, {
        recordId: parent.id,
        recordType: "description",
        userId: config.userId,
        kind: "update",
        diff: { childCount: { old: parent.childCount, new: actualCount } },
        runId: config.runId,
        now,
      }),
    );
    reconciled++;
  }

  // Submit in bounded slices of whole update+journal PAIRS — a pair never
  // splits across batches, so effect + journal still land together.
  for (const slice of chunk(statements, REVERT_BATCH_SIZE * 2)) {
    if (slice.length > 0) await db.batch(slice as [any, ...any[]]);
  }
  return { reconciled };
}

/**
 * Terminal step: write the WRITE-DERIVED counts the Workflow accumulated,
 * store the revert report artefact (spec §4 — "reverted N / kept M —
 * edited since import"), stamp its pointer on the run, and mark the run
 * `complete`. The target's `reverted_by_run_id` was stamped ATOMICALLY at
 * mint time (the double-submit mutex; see `mintRevertRun`), so no terminal
 * stamp is needed here.
 */
export async function finalizeRevertRun(
  db: DrizzleD1Database<any>,
  store: StagingStore,
  config: RevertConfig,
  counts: RevertCounts,
): Promise<void> {
  const reverted = counts.deleted + counts.restored + counts.reinserted;
  const kept = counts.skippedEdited + counts.skippedForeignChildren + counts.skippedConflict;
  const report = {
    kind: "revert" as const,
    runId: config.runId,
    targetRunId: config.targetRunId,
    generatedAt: Date.now(),
    reverted,
    kept,
    counts,
  };
  const reportKey = stagingKey.revertReport(config.tenantId, config.runId);
  await store.put(reportKey, JSON.stringify(report, null, 2), {
    contentType: "application/json; charset=utf-8",
  });

  await db
    .update(stewardshipRuns)
    .set({
      status: "complete",
      completedAt: Date.now(),
      recordCounts: JSON.stringify(counts),
      reportArtifact: reportKey,
      currentStep: "finalize",
      currentStepCompletedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
    })
    .where(eq(stewardshipRuns.id, config.runId));
}

export interface MintRevertRunInput {
  tenantId: string;
  userId: string;
  message: string;
  justification?: string | null;
  /** The run to revert (import or an earlier revert). */
  targetRunId: string;
  now?: number;
}

/**
 * The revertable-target predicate, shared by the conditional insert and
 * the linkage flip: the target must be this tenant's, complete, not
 * already reverted, and an import or a revert (reverting a revert is
 * allowed — it re-applies the original; spec §2).
 */
function revertableTarget(input: { tenantId: string; targetRunId: string }) {
  return and(
    eq(stewardshipRuns.id, input.targetRunId),
    eq(stewardshipRuns.tenantId, input.tenantId),
    eq(stewardshipRuns.status, "complete"),
    isNull(stewardshipRuns.revertedByRunId),
    inArray(stewardshipRuns.kind, ["import", "revert"]),
  );
}

/**
 * Mint the `kind='revert'` run (`pending`) pointing at the target and
 * stamp the target's `reverted_by_run_id` — atomically, in ONE `db.batch`,
 * and BOTH conditioned on the target still being revertable. That
 * condition is the double-submit mutex: two reverts racing past the
 * route's read both reach this batch, but only the first sees an
 * un-reverted target — the loser's conditional insert selects zero rows
 * and its conditional flip matches zero rows, so it mints NOTHING and
 * returns null (the caller surfaces `alreadyReverted` and must NOT launch
 * a Workflow). The run insert is an INSERT … SELECT reading FROM the
 * target row itself — the select yields one row while the target is
 * revertable and zero rows otherwise, which is the condition; the flip
 * then stamps the target. `assertRunMessage` (spec §2) fires before any
 * write.
 */
export async function mintRevertRun(
  db: DrizzleD1Database<any>,
  input: MintRevertRunInput,
): Promise<{ runId: string } | null> {
  assertRunMessage(input.message);

  const id = crypto.randomUUID();
  const now = input.now ?? Date.now();
  const predicate = revertableTarget(input);

  // Selection mirrors stewardship_runs' full column list (the builder
  // validates key parity with the table definition).
  const insertRun = db.insert(stewardshipRuns).select(
    db
      .select({
        id: sql`${id}`.as("id"),
        tenantId: sql`${input.tenantId}`.as("tenant_id"),
        federationId: sql`null`.as("federation_id"),
        kind: sql`'revert'`.as("kind"),
        message: sql`${input.message}`.as("message"),
        justification: sql`${input.justification ?? null}`.as("justification"),
        userId: sql`${input.userId}`.as("user_id"),
        status: sql`'pending'`.as("status"),
        revertsRunId: sql`${input.targetRunId}`.as("reverts_run_id"),
        revertedByRunId: sql`null`.as("reverted_by_run_id"),
        profileId: sql`null`.as("profile_id"),
        profileVersion: sql`null`.as("profile_version"),
        sourceArtifact: sql`null`.as("source_artifact"),
        reportArtifact: sql`null`.as("report_artifact"),
        recordCounts: sql`null`.as("record_counts"),
        // A revert accepts nothing — the acceptances belong to the
        // import run it compensates (0066).
        acceptedFindings: sql`null`.as("accepted_findings"),
        workflowInstanceId: sql`null`.as("workflow_instance_id"),
        currentStep: sql`null`.as("current_step"),
        stepsCompleted: sql`0`.as("steps_completed"),
        totalSteps: sql`0`.as("total_steps"),
        currentStepStartedAt: sql`null`.as("current_step_started_at"),
        currentStepCompletedAt: sql`null`.as("current_step_completed_at"),
        lastHeartbeatAt: sql`null`.as("last_heartbeat_at"),
        errorMessage: sql`null`.as("error_message"),
        startedAt: sql`null`.as("started_at"),
        completedAt: sql`null`.as("completed_at"),
        createdAt: sql`${now}`.as("created_at"),
      })
      .from(stewardshipRuns)
      .where(predicate),
  );

  const flip = db
    .update(stewardshipRuns)
    .set({ revertedByRunId: id })
    .where(predicate);

  // Insert precedes flip so the insert reads the target while it is still
  // un-reverted; the batch is a transaction, so both see one consistent
  // snapshot and land together or not at all (spec §2 mutability).
  await db.batch([insertRun, flip] as [any, ...any[]]);

  const minted = await db
    .select({ id: stewardshipRuns.id })
    .from(stewardshipRuns)
    .where(eq(stewardshipRuns.id, id))
    .get();
  return minted ? { runId: id } : null;
}

/**
 * Release a target's revert lock — used ONLY when the Workflow could not
 * be created at all, so nothing was applied (the commit route's
 * create-failure recovery, mirrored). Clears the target's stamp only when
 * it still points at this failed revert run, so a concurrent revert is
 * never clobbered. Not called on a step-level failure: once compensating
 * writes may have landed, the target stays stamped and the errored run is
 * the auditable record.
 */
export async function releaseRevertLock(
  db: DrizzleD1Database<any>,
  targetRunId: string,
  revertRunId: string,
): Promise<void> {
  await db
    .update(stewardshipRuns)
    .set({ revertedByRunId: null })
    .where(
      and(
        eq(stewardshipRuns.id, targetRunId),
        eq(stewardshipRuns.revertedByRunId, revertRunId),
      ),
    );
}
