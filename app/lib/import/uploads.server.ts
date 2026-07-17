/**
 * Import uploads — staged-CSV lifecycle
 *
 * This module deals with the `import_uploads` metadata rows behind
 * staged CSV files (spec §§1, 4). Each row records what the
 * upload → profile → dry-run → commit flow needs without re-fetching the
 * object from the staging store: filename, staging key, byte size, row
 * count, and the parsed header names.
 *
 * Lifecycle is `staged → committed | discarded`. Discard is a status
 * FLIP, never a DELETE (schema comment on `import_uploads`) — the flip is
 * the only path out of `staged`. A row already in `discarded` MAY then be
 * hard-deleted (design §8a ruling): a discarded upload never touched the
 * catalogue — only staged uploads can commit, so no run references it and
 * no stewardship record involves it — while a COMMITTED upload is never
 * deletable, because its staged file is the run's source of record.
 * `import_uploads` is a staging table, not journalled, so deletion writes
 * no journal entry (consistent with every other write here).
 *
 * `createUpload` is the ONLY insert path and is called after the file's
 * encoding has already validated and its bytes have already staged: an
 * encoding-rejected file stages nothing and writes no row (spec §4.1),
 * so that guard lives at the intake boundary, not here.
 *
 * @version v0.6.0
 */

import { and, desc, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { importUploads } from "../../db/schema";
import type { StagingStore } from "./staging.server";

export interface UploadRow {
  id: string;
  tenantId: string;
  userId: string;
  filename: string;
  artifactKey: string;
  byteSize: number;
  rowCount: number | null;
  headers: string | null;
  profileId: string | null;
  profileVersion: number | null;
  reportArtifact: string | null;
  /** Readiness-check cache (design §3.5): { profileId, profileVersion, computedAt, findings }. */
  checkFindings: string | null;
  /** Readiness-check acceptances (design §3.5): CheckDecision[]. */
  checkDecisions: string | null;
  status: "staged" | "committed" | "discarded";
  runId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateUploadInput {
  id: string;
  tenantId: string;
  userId: string;
  filename: string;
  artifactKey: string;
  byteSize: number;
  rowCount: number;
  headers: string[];
}

/** Insert the metadata row for an already-staged CSV. */
export async function createUpload(
  db: DrizzleD1Database<any>,
  input: CreateUploadInput,
): Promise<UploadRow> {
  const now = Date.now();
  const row = {
    id: input.id,
    tenantId: input.tenantId,
    userId: input.userId,
    filename: input.filename,
    artifactKey: input.artifactKey,
    byteSize: input.byteSize,
    rowCount: input.rowCount,
    headers: JSON.stringify(input.headers),
    profileId: null,
    profileVersion: null,
    reportArtifact: null,
    checkFindings: null,
    checkDecisions: null,
    status: "staged" as const,
    runId: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(importUploads).values(row);
  return row;
}

/** A tenant's uploads, newest first. */
export async function listUploads(
  db: DrizzleD1Database<any>,
  tenantId: string,
): Promise<UploadRow[]> {
  return db
    .select()
    .from(importUploads)
    .where(eq(importUploads.tenantId, tenantId))
    .orderBy(desc(importUploads.createdAt))
    .all() as Promise<UploadRow[]>;
}

/** One upload scoped to the tenant, or null. */
export async function getUpload(
  db: DrizzleD1Database<any>,
  tenantId: string,
  uploadId: string,
): Promise<UploadRow | null> {
  const row = (await db
    .select()
    .from(importUploads)
    .where(
      and(eq(importUploads.id, uploadId), eq(importUploads.tenantId, tenantId)),
    )
    .get()) as UploadRow | undefined;
  return row ?? null;
}

/**
 * Stamp a staged upload with its dry-run report pointer and the profile
 * the run was classified against. Tenant-scoped, so one tenant can never
 * stamp another's upload row. This is the only write the dry-run performs
 * on `import_uploads`; it touches no journalled table. Returns false when
 * the upload is missing or not the tenant's.
 */
export async function stampUploadReport(
  db: DrizzleD1Database<any>,
  tenantId: string,
  uploadId: string,
  input: { reportArtifact: string; profileId: string; profileVersion: number },
): Promise<boolean> {
  const existing = await getUpload(db, tenantId, uploadId);
  if (!existing) return false;
  await db
    .update(importUploads)
    .set({
      reportArtifact: input.reportArtifact,
      profileId: input.profileId,
      profileVersion: input.profileVersion,
      updatedAt: Date.now(),
    })
    .where(and(eq(importUploads.id, uploadId), eq(importUploads.tenantId, tenantId)));
  return true;
}

/**
 * Set the chosen mapping profile on a staged upload at the Check step
 * (design §3.1 — profile selection moved forward from the dry-run form),
 * without touching the report pointer. Tenant-scoped. Only a `staged`
 * upload's profile may be (re)selected; a committed upload's profile is
 * pinned to its run. Returns false when the upload is missing, not the
 * tenant's, or not staged.
 */
export async function setUploadProfile(
  db: DrizzleD1Database<any>,
  tenantId: string,
  uploadId: string,
  input: { profileId: string; profileVersion: number },
): Promise<boolean> {
  const existing = await getUpload(db, tenantId, uploadId);
  if (!existing || existing.status !== "staged") return false;
  await db
    .update(importUploads)
    .set({
      profileId: input.profileId,
      profileVersion: input.profileVersion,
      updatedAt: Date.now(),
    })
    .where(and(eq(importUploads.id, uploadId), eq(importUploads.tenantId, tenantId)));
  return true;
}

/**
 * Flip a staged upload to `discarded`. Only a `staged` row transitions —
 * a committed upload is part of a run's lineage and never discards.
 * Returns false when the upload is missing, not the tenant's, or not
 * currently staged.
 */
export async function discardUpload(
  db: DrizzleD1Database<any>,
  tenantId: string,
  uploadId: string,
): Promise<boolean> {
  const existing = await getUpload(db, tenantId, uploadId);
  if (!existing || existing.status !== "staged") return false;
  await db
    .update(importUploads)
    .set({ status: "discarded", updatedAt: Date.now() })
    .where(eq(importUploads.id, uploadId));
  return true;
}

export type DeleteUploadResult = "deleted" | "not_found" | "not_discarded";

/**
 * Hard-delete a DISCARDED upload: its staged object, its report artefact
 * (when one exists), then the row (design §8a ruling — module header).
 * Tenant-scoped; only `discarded` rows delete — `staged` and `committed`
 * refuse by name. Objects are deleted BEFORE the row and a missing object
 * is tolerated, so a retry after a partial failure still succeeds: while
 * any object delete fails the row survives and the delete can be re-run;
 * once the row is gone nothing dangles. The row delete predicates on
 * `status = 'discarded'` so a concurrent state change can never race a
 * non-discarded row into deletion.
 */
export async function deleteDiscardedUpload(
  db: DrizzleD1Database<any>,
  store: StagingStore,
  tenantId: string,
  uploadId: string,
): Promise<DeleteUploadResult> {
  const existing = await getUpload(db, tenantId, uploadId);
  if (!existing) return "not_found";
  if (existing.status !== "discarded") return "not_discarded";

  // An already-absent object must not block the delete (idempotency);
  // adapters that no-op on missing keys pass through, ones that throw are
  // tolerated the same way.
  try {
    await store.delete(existing.artifactKey);
  } catch {
    /* missing or already-deleted object — tolerated */
  }
  if (existing.reportArtifact) {
    try {
      await store.delete(existing.reportArtifact);
    } catch {
      /* missing or already-deleted object — tolerated */
    }
  }

  await db
    .delete(importUploads)
    .where(
      and(
        eq(importUploads.id, uploadId),
        eq(importUploads.tenantId, tenantId),
        eq(importUploads.status, "discarded"),
      ),
    );
  return "deleted";
}
