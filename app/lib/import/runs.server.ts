/**
 * Import runs — read surfaces for the stewardship record
 *
 * This module deals with the READ side of `stewardship_runs` behind the
 * imports run list and run detail (imports spec §5; stewardship record
 * spec §5 stage 1). Every query is tenant-scoped: a run row carries a
 * first-class `tenant_id`, so the list and detail filter on it directly —
 * one tenant can never read another's runs even by guessing a run id (the
 * detail returns null, the route 404s).
 *
 * These are pure reads; they mutate nothing and journal nothing. The write
 * path (mint + Workflow steps) lives in `commit.server.ts`.
 *
 * @version v0.6.0
 */

import { and, desc, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { importProfiles, importUploads, stewardshipRuns, tenants } from "../../db/schema";
import { federationLeadTenantId } from "./profiles.server";

/** The list-row projection — no `users.*` / artefact bodies leak in. */
export interface RunListRow {
  id: string;
  kind: "import" | "revert";
  message: string;
  status: "pending" | "running" | "complete" | "error";
  userId: string;
  recordCounts: string | null;
  stepsCompleted: number;
  totalSteps: number;
  createdAt: number;
  completedAt: number | null;
}

/** A minimal reference to a run linked by revert (either direction). */
export interface LinkedRun {
  id: string;
  kind: "import" | "revert";
  message: string;
  status: "pending" | "running" | "complete" | "error";
}

/** The detail projection — the envelope plus artefact + profile pointers. */
export interface RunDetail extends RunListRow {
  justification: string | null;
  profileId: string | null;
  profileVersion: number | null;
  profileName: string | null;
  sourceArtifact: string | null;
  reportArtifact: string | null;
  workflowInstanceId: string | null;
  currentStep: string | null;
  errorMessage: string | null;
  startedAt: number | null;
  /** The upload this run committed, for the source/report download links. */
  uploadId: string | null;
  /**
   * The readiness-check acceptances snapshot (design §3.5): the upload's
   * decisions as they stood at mint — which incompleteness the operator
   * knowingly accepted. Raw JSON; the detail page parses and renders it.
   */
  acceptedFindings: string | null;
  /** Revert linkage (spec §2, two-way): the run this revert compensates. */
  revertsRunId: string | null;
  /** Revert linkage: the revert run that has reverted THIS run, if any. */
  revertedByRunId: string | null;
  /** The target run (kind='revert' rows) — for the "reverts …" link. */
  revertsRun: LinkedRun | null;
  /** The reverting run (reverted rows) — for the "reverted by …" link. */
  revertedByRun: LinkedRun | null;
}

/** A tenant's stewardship runs, newest first. */
export async function listRuns(
  db: DrizzleD1Database<any>,
  tenantId: string,
): Promise<RunListRow[]> {
  return db
    .select({
      id: stewardshipRuns.id,
      kind: stewardshipRuns.kind,
      message: stewardshipRuns.message,
      status: stewardshipRuns.status,
      userId: stewardshipRuns.userId,
      recordCounts: stewardshipRuns.recordCounts,
      stepsCompleted: stewardshipRuns.stepsCompleted,
      totalSteps: stewardshipRuns.totalSteps,
      createdAt: stewardshipRuns.createdAt,
      completedAt: stewardshipRuns.completedAt,
    })
    .from(stewardshipRuns)
    .where(eq(stewardshipRuns.tenantId, tenantId))
    .orderBy(desc(stewardshipRuns.createdAt))
    .all() as Promise<RunListRow[]>;
}

/**
 * One run scoped to the tenant, or null. Joins the profile name (a plain
 * left read; the profile may have been deleted, in which case the pinned
 * `profileVersion` still tells the operator what mapping ran) and the
 * committed upload id for the artefact download links.
 */
export async function getRun(
  db: DrizzleD1Database<any>,
  tenantId: string,
  runId: string,
): Promise<RunDetail | null> {
  const run = await db
    .select()
    .from(stewardshipRuns)
    .where(and(eq(stewardshipRuns.id, runId), eq(stewardshipRuns.tenantId, tenantId)))
    .get();
  if (!run) return null;

  let profileName: string | null = null;
  if (run.profileId) {
    const profile = await db
      .select({ name: importProfiles.name })
      .from(importProfiles)
      .where(eq(importProfiles.id, run.profileId))
      .get();
    profileName = profile?.name ?? null;
  }

  const upload = await db
    .select({ id: importUploads.id })
    .from(importUploads)
    .where(and(eq(importUploads.runId, runId), eq(importUploads.tenantId, tenantId)))
    .get();

  // Two-way revert linkage. Both reads stay tenant-scoped so a linked run
  // id can never surface another tenant's run (spec §2 runs are
  // tenant-scoped); a dangling id (deleted target) simply resolves null.
  const linked = async (id: string | null): Promise<LinkedRun | null> => {
    if (!id) return null;
    const row = await db
      .select({
        id: stewardshipRuns.id,
        kind: stewardshipRuns.kind,
        message: stewardshipRuns.message,
        status: stewardshipRuns.status,
      })
      .from(stewardshipRuns)
      .where(and(eq(stewardshipRuns.id, id), eq(stewardshipRuns.tenantId, tenantId)))
      .get();
    return (row as LinkedRun | undefined) ?? null;
  };
  const [revertsRun, revertedByRun] = await Promise.all([
    linked(run.revertsRunId),
    linked(run.revertedByRunId),
  ]);

  return {
    id: run.id,
    kind: run.kind,
    message: run.message,
    status: run.status,
    userId: run.userId,
    recordCounts: run.recordCounts,
    stepsCompleted: run.stepsCompleted,
    totalSteps: run.totalSteps,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    justification: run.justification,
    profileId: run.profileId,
    profileVersion: run.profileVersion,
    profileName,
    sourceArtifact: run.sourceArtifact,
    reportArtifact: run.reportArtifact,
    workflowInstanceId: run.workflowInstanceId,
    currentStep: run.currentStep,
    errorMessage: run.errorMessage,
    startedAt: run.startedAt,
    uploadId: upload?.id ?? null,
    acceptedFindings: run.acceptedFindings,
    revertsRunId: run.revertsRunId,
    revertedByRunId: run.revertedByRunId,
    revertsRun,
    revertedByRun,
  };
}

/**
 * A profile row by id (version + bindings), for the Workflow's drift
 * backstop — TENANT-SCOPED with the same visibility rule the routes apply
 * (spec §7.3): the tenant's own profile, or a `sharedWithFederation`
 * profile owned by the tenant's federation LEAD (a member commits with a
 * shared profile legitimately). Anything else — another tenant's private
 * profile in particular — resolves to null, so this reader can never leak
 * a cross-tenant mapping even if reused outside the Workflow.
 */
export async function getProfileById(
  db: DrizzleD1Database<any>,
  tenantId: string,
  profileId: string,
): Promise<{ id: string; version: number; bindings: string } | null> {
  const row = await db
    .select({
      id: importProfiles.id,
      tenantId: importProfiles.tenantId,
      version: importProfiles.version,
      bindings: importProfiles.bindings,
      sharedWithFederation: importProfiles.sharedWithFederation,
    })
    .from(importProfiles)
    .where(eq(importProfiles.id, profileId))
    .get();
  if (!row) return null;

  const projected = { id: row.id, version: row.version, bindings: row.bindings };
  if (row.tenantId === tenantId) return projected;
  if (!row.sharedWithFederation) return null;

  // Shared visibility: valid only when the owner is the requesting
  // tenant's federation lead.
  const tenant = await db
    .select({ federationId: tenants.federationId })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .get();
  if (!tenant) return null;
  const leadTenantId = await federationLeadTenantId(db, tenant);
  return leadTenantId !== null && leadTenantId === row.tenantId ? projected : null;
}
