/**
 * Import commit — the write side of the stewardship record
 *
 * This module owns the step bodies the ImportCommitWorkflow drives
 * (imports spec §5; stewardship record spec §§2–3). The Workflow is a
 * THIN entrypoint (the export pattern): it sequences `step.do(...)` calls
 * over the exported functions here, each running in its own Worker
 * invocation with a fresh runtime budget. Keeping the bodies here makes
 * them unit-testable against the test D1 harness without the Workflows
 * runtime (the `pipeline.server.ts` precedent).
 *
 * ## Determinism, idempotency, and the count contract
 *
 * `loadCommitConfig` re-derives the verdicts ONCE, inside the run, from
 * the staged CSV + the profile pinned at commit time — never from the
 * advisory report artefact (spec §5). It snapshots the tenant's existing
 * reference codes at run start; that snapshot (`existingCodes`) is threaded
 * to every later step, so record assembly and create/update classification
 * are stable across batches AND retries even though the live DB changes
 * underneath.
 *
 * The terminal `record_counts` are WRITE-derived (stewardship spec §6):
 * each batch step RETURNS its executed counts — creates actually inserted,
 * updates that produced a non-empty diff, and `unchanged` rows whose
 * assembled values matched the existing row (no write, no journal row) —
 * and the Workflow sums the step returns, which the Workflows runtime
 * persists across retries, into the terminal counts. `skipped`/`rejected`
 * stay verdict-derived: no write is performed for them, so the verdict
 * predicate IS the write predicate. The recompute step's childCount
 * reconciliations are cache maintenance — journalled, but never part of
 * the operator-visible `updated` count. The plan-side counts on
 * `CommitConfig` size the batches and `totalSteps` only.
 *
 * ## Field semantics on update: blank keeps, legacyIds merge-append
 *
 * The assembled record carries only non-blank bound values (blank means
 * keep — `validate.ts`), so an update can never blank out a populated
 * field. `legacyIds` is MERGE-APPEND: imported entries are unioned into
 * the existing row's list, deduplicated by (provider, id); existing
 * entries are NEVER removed — imports never erase archived identifiers.
 * A merge that adds nothing keeps the existing serialisation verbatim so
 * the diff stays empty and no write happens.
 *
 * Every batch is safe to retry (spec §5): `db.batch([...])` is atomic in
 * D1, and each create batch first RE-READS which of its codes already
 * exist and skips them, so a batch that committed then failed before its
 * step return re-runs and inserts nothing (no double insert, no double
 * journal row). Updates re-apply idempotently — an unchanged row yields an
 * empty `computeDiff`, so nothing is written and nothing is journalled.
 *
 * ## The journal is composed in the SAME db.batch as the mutation
 *
 * Every INSERT/UPDATE on `descriptions` is paired with a
 * `composeJournalEntry` BatchItem in the enclosing scope and submitted in
 * one `db.batch` (the ledger discipline, spec §3; the journal-coverage
 * scanner polices the pairing). create rows journal a FULL snapshot
 * (`createSnapshotDiff`); update rows journal the ordinary field diff
 * (`computeDiff`) — the before-images a revert reads. `created_by` is the
 * run author; `updated_at` is bumped on every touched row (the revert
 * conflict test reads it). There are NO deletes here — imports upsert,
 * never delete (spec §5).
 *
 * ## Structural cache (spec §5)
 *
 * A created row's depth / rootDescriptionId / pathCache / position /
 * childCount are computed at INSERT from its parent (topological order
 * guarantees the parent is written first), using the same formula the
 * single-record create path uses — so they land correct in the create
 * snapshot, no separate write. The dedicated `recomputeStructuralCaches`
 * step then reconciles childCount for every affected parent (an EXISTING
 * container that gained children, chiefly) to the actual DB child count —
 * idempotent, and journalled as an ordinary update so the scanner stays
 * green and a revert restores the prior count. depth/root/path are not
 * recomputed: imports create new subtrees and never re-parent existing
 * rows (updates touch descriptive fields only).
 *
 * pathCache length is capped (spec §5's cap-and-warn lesson; no cap
 * exists elsewhere in the codebase — this is the first). A computed path
 * longer than `MAX_PATH_CACHE_LENGTH` stores the schema-default empty
 * string instead — the codebase's own fallback convention already
 * tolerates an empty pathCache (`parent.pathCache || parent.id`) — and
 * the row is counted in the run's `pathCacheCapped` tally, never failed.
 *
 * @version v0.6.0
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { descriptions, importUploads, stewardshipRuns, tenants } from "../../db/schema";
import type { DescriptionLevel, Standard } from "../standards/types";
import {
  assertRunMessage,
  composeJournalEntry,
  createSnapshotDiff,
  computeDiff,
} from "../stewardship.server";
import { decodeAndParseCsv } from "./csv";
import { fetchExistingReferenceCodes } from "./dry-run.server";
import { isDescriptionLevel } from "./identifiers";
import type { ProfileBindings } from "./profile-schema";
import type { StagingStore } from "./staging.server";
import { REQUIRED_TARGET } from "./target-fields";
import { extractParentReferenceCodes, extractReferenceCodes, validate } from "./validate";

/**
 * Rows per batch AND the chunk size for every IN()-list read in this
 * module. Every statement stays under D1's 100-bound-parameter cap: a
 * description INSERT binds ~40 columns and the paired journal insert ~9 —
 * one statement each, well under 100 — and every list-bound read (the
 * natural-key requery, the position-baseline reads, the recompute's
 * parent + grouped-count reads) binds `size + 1` (the tenant id), so
 * `size <= 99` is required and 50 leaves ample headroom. Nothing in this
 * module passes an unchunked list to `inArray`.
 */
export const IMPORT_BATCH_SIZE = 50;

/**
 * Longest pathCache the importer will store (module header: cap-and-warn).
 * UUID segments are 36 chars + a separator, so this admits ~55 levels of
 * hierarchy — far beyond any archival tree; hitting it means pathological
 * input, and the row still lands (with an empty pathCache), never fails.
 */
export const MAX_PATH_CACHE_LENGTH = 2048;

/** The run-author's write payload plus the parent linkage for one code. */
interface AssembledRecord {
  record: Record<string, unknown>;
  parentReferenceCode: string | null;
}

/** The plan + inputs every step needs; JSON-serialisable across step boundaries. */
export interface CommitConfig {
  runId: string;
  uploadId: string;
  tenantId: string;
  /** The run author — stamped into `created_by` and every journal row. */
  userId: string;
  standard: Standard;
  bindings: ProfileBindings;
  /** B2/R2 pointer to the staged source CSV (re-parsed by each step). */
  sourceArtifact: string;
  repositoryId: string;
  updateExisting: boolean;
  /** Snapshot of the tenant's existing reference codes at run start. */
  existingCodes: string[];
  /**
   * Readiness-check acceptances (design §4), read from the upload row at
   * run mint — never from client input. Rows failing required-field
   * enforcement only on these `missing_required_field:<level>:<field>`
   * classes are created honestly sparse instead of rejected, identically
   * in the plan pass and in `assembleRecords`.
   */
  acceptedClasses: string[];
  /** Codes to create, in TOPOLOGICAL order (parents before children). */
  createCodes: string[];
  /** Codes to update (order irrelevant — updates are independent). */
  updateCodes: string[];
  /** Per created code: its sibling position (existing siblings + file order). */
  positionByCode: Record<string, number>;
  /** Per created parent code: how many created children it gets (its childCount). */
  childCountByCode: Record<string, number>;
  /** Distinct non-null parent reference codes of created rows. */
  affectedParentRefCodes: string[];
  counts: RunCounts;
  totalSteps: number;
}

export interface RunCounts {
  created: number;
  updated: number;
  /** Update-verdict rows whose assembled values matched the existing row (no write). */
  unchanged: number;
  skipped: number;
  rejected: number;
  /** Created rows whose computed pathCache exceeded the cap and stored "" instead. */
  pathCacheCapped?: number;
}

export interface LoadCommitConfigParams {
  runId: string;
  uploadId: string;
  repositoryId: string;
  updateExisting: boolean;
  /** The Cloudflare Workflow instance id, recorded for dashboard correlation. */
  workflowInstanceId?: string;
}

/** Raised when a run's staged inputs cannot be resolved (a fatal config error). */
export class ImportCommitConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportCommitConfigError";
  }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The union of accepted class keys recorded on the upload's `check_decisions`
 * (design §4). Read at run mint from the upload row itself — never from
 * client input — and tolerant of an absent/corrupt column (no acceptances).
 */
function deriveAcceptedClassesFromDecisions(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const set = new Set<string>();
    for (const entry of value) {
      const keys = (entry as { classKeys?: unknown }).classKeys;
      if (Array.isArray(keys)) for (const k of keys) if (typeof k === "string") set.add(k);
    }
    return [...set];
  } catch {
    return [];
  }
}

/**
 * Load the run, upload, profile, tenant, and staged CSV; re-derive the
 * verdicts against a run-start snapshot of existing codes; compute the
 * batch plan, positions, childCounts, and counts; mark the run `running`.
 * Fatal input problems throw `ImportCommitConfigError` (the Workflow turns
 * that into a run `error`).
 */
export async function loadCommitConfig(
  db: DrizzleD1Database<any>,
  store: StagingStore,
  params: LoadCommitConfigParams,
): Promise<CommitConfig> {
  const run = await db
    .select()
    .from(stewardshipRuns)
    .where(eq(stewardshipRuns.id, params.runId))
    .get();
  if (!run) throw new ImportCommitConfigError(`stewardship run ${params.runId} not found`);
  if (run.kind !== "import") {
    throw new ImportCommitConfigError(`run ${params.runId} is not an import run`);
  }
  if (!run.sourceArtifact) {
    throw new ImportCommitConfigError(`run ${params.runId} has no source artefact`);
  }
  if (run.profileId == null || run.profileVersion == null) {
    throw new ImportCommitConfigError(`run ${params.runId} did not pin a profile version`);
  }

  const upload = await db
    .select()
    .from(importUploads)
    .where(
      and(eq(importUploads.id, params.uploadId), eq(importUploads.tenantId, run.tenantId)),
    )
    .get();
  if (!upload) throw new ImportCommitConfigError(`upload ${params.uploadId} not found`);

  const tenant = await db
    .select({ descriptiveStandard: tenants.descriptiveStandard })
    .from(tenants)
    .where(eq(tenants.id, run.tenantId))
    .get();
  if (!tenant?.descriptiveStandard) {
    throw new ImportCommitConfigError(
      `tenant ${run.tenantId} has no descriptive standard (cannot import)`,
    );
  }
  const standard = tenant.descriptiveStandard as Standard;

  // The profile bindings are read from the upload's stamped report profile;
  // the route already refused a version-drifted profile, so re-reading the
  // CURRENT profile here and comparing to the pinned version is the
  // Workflow-side backstop. The bindings themselves come from the profile
  // that produced the reviewed report.
  const { getProfileById } = await import("./runs.server");
  const profile = await getProfileById(db, run.tenantId, run.profileId);
  if (!profile) throw new ImportCommitConfigError(`profile ${run.profileId} not found`);
  if (profile.version !== run.profileVersion) {
    throw new ImportCommitConfigError(
      `profile ${run.profileId} drifted (pinned v${run.profileVersion}, now v${profile.version})`,
    );
  }
  const { parseProfileBindings } = await import("./profile-schema");
  const parsedBindings = parseProfileBindings(JSON.parse(profile.bindings));
  if (!parsedBindings.success) {
    throw new ImportCommitConfigError(`profile ${run.profileId} bindings are invalid`);
  }
  const bindings = parsedBindings.data;

  const bytes = await store.getBytes(run.sourceArtifact);
  if (!bytes) {
    throw new ImportCommitConfigError(`staged source object missing: ${run.sourceArtifact}`);
  }
  const parsed = decodeAndParseCsv(bytes);

  // Snapshot existing codes ONCE — the frozen basis for classification and
  // parent resolution across every later step. The read covers the rows'
  // own codes AND their parent codes so an "items into existing container"
  // import resolves DB parents (spec §6), matching the dry-run's read.
  const codes = extractReferenceCodes({ bindings, headers: parsed.headers, rows: parsed.rows });
  const parentCodes = extractParentReferenceCodes({
    bindings,
    headers: parsed.headers,
    rows: parsed.rows,
  });
  const existingSet = await fetchExistingReferenceCodes(db, run.tenantId, [
    ...codes,
    ...parentCodes,
  ]);

  // Acceptances travel from the upload row (design §4) — never client input.
  // The snapshot is frozen onto the config so every batch re-derives verdicts
  // under exactly the acceptances the operator recorded at the Check step.
  const acceptedClasses = deriveAcceptedClassesFromDecisions(upload.checkDecisions);

  const result = validate({
    standard,
    bindings,
    headers: parsed.headers,
    rows: parsed.rows,
    existingReferenceCodes: existingSet,
    updateExisting: params.updateExisting,
    defaults: { repositoryId: params.repositoryId },
    acceptedClasses: new Set(acceptedClasses),
  });

  const verdictByRow = new Map(result.verdicts.map((v) => [v.rowNumber, v]));
  const createCodes: string[] = [];
  const updateCodes: string[] = [];
  const parentRefByCreate = new Map<string, string | null>();
  // Walk the topological order so createCodes stays parents-before-children.
  for (const row of result.ordered) {
    const verdict = verdictByRow.get(row.rowNumber);
    if (!verdict) continue;
    if (verdict.verdict === "create") {
      createCodes.push(row.referenceCode);
      parentRefByCreate.set(row.referenceCode, row.parentReferenceCode);
    } else if (verdict.verdict === "update") {
      updateCodes.push(row.referenceCode);
    }
  }
  let skipped = 0;
  let rejected = 0;
  for (const v of result.verdicts) {
    if (v.verdict === "skip") skipped++;
    else if (v.verdict === "reject") rejected++;
  }

  // childCount for a created parent = its created children (a brand-new
  // parent has no pre-existing children, so this is its full childCount).
  const childCountByCode: Record<string, number> = {};
  for (const [, parentRef] of parentRefByCreate) {
    if (parentRef != null && parentRefByCreate.has(parentRef)) {
      childCountByCode[parentRef] = (childCountByCode[parentRef] ?? 0) + 1;
    }
  }

  // position for each created row = the existing sibling count under its
  // parent (a one-time read per existing parent / roots) plus its ordinal
  // among created siblings in topological order. Created parents have no
  // existing children, so their baseline is 0.
  const createdSet = new Set(createCodes);
  const baselineByParentKey = new Map<string, number>();
  const existingParentRefs = new Set<string>();
  let hasRoot = false;
  for (const code of createCodes) {
    const parentRef = parentRefByCreate.get(code) ?? null;
    if (parentRef == null) hasRoot = true;
    else if (!createdSet.has(parentRef)) existingParentRefs.add(parentRef);
  }
  if (hasRoot) {
    const rootCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(descriptions)
      .where(
        and(eq(descriptions.tenantId, run.tenantId), sql`${descriptions.parentId} IS NULL`),
      )
      .get();
    baselineByParentKey.set("\x00root", rootCount?.count ?? 0);
  }
  // Baselines for existing parents are read in bulk: one chunked IN()
  // read resolving reference codes to ids, then one chunked GROUPED count
  // per slice — never two sequential reads per parent, so a large
  // items-into-existing-containers import stays within both the
  // 100-bound-param cap and the per-invocation subrequest budget.
  const parentIdByRef = new Map<string, string>();
  for (const slice of chunk([...existingParentRefs], IMPORT_BATCH_SIZE)) {
    const rows = (await db
      .select({ id: descriptions.id, referenceCode: descriptions.referenceCode })
      .from(descriptions)
      .where(
        and(
          eq(descriptions.tenantId, run.tenantId),
          inArray(descriptions.referenceCode, slice),
        ),
      )
      .all()) as { id: string; referenceCode: string }[];
    for (const row of rows) parentIdByRef.set(row.referenceCode, row.id);
  }
  const baselineByParentId = new Map<string, number>();
  for (const slice of chunk([...parentIdByRef.values()], IMPORT_BATCH_SIZE)) {
    const rows = (await db
      .select({ parentId: descriptions.parentId, count: sql<number>`count(*)` })
      .from(descriptions)
      .where(
        and(eq(descriptions.tenantId, run.tenantId), inArray(descriptions.parentId, slice)),
      )
      .groupBy(descriptions.parentId)
      .all()) as { parentId: string | null; count: number }[];
    for (const row of rows) {
      if (row.parentId !== null) baselineByParentId.set(row.parentId, row.count);
    }
  }
  for (const parentRef of existingParentRefs) {
    const parentId = parentIdByRef.get(parentRef);
    baselineByParentKey.set(
      parentRef,
      parentId !== undefined ? baselineByParentId.get(parentId) ?? 0 : 0,
    );
  }
  const positionByCode: Record<string, number> = {};
  const ordinalByParentKey = new Map<string, number>();
  for (const code of createCodes) {
    const parentRef = parentRefByCreate.get(code) ?? null;
    const key = parentRef == null ? "\x00root" : parentRef;
    const baseline = baselineByParentKey.get(key) ?? 0;
    const ordinal = ordinalByParentKey.get(key) ?? 0;
    positionByCode[code] = baseline + ordinal;
    ordinalByParentKey.set(key, ordinal + 1);
  }

  const affectedParentRefCodes = [
    ...new Set(
      createCodes
        .map((c) => parentRefByCreate.get(c) ?? null)
        .filter((p): p is string => p != null),
    ),
  ];

  // Plan-side counts: they size the batches and totalSteps. The terminal
  // record_counts come from the step returns, not from here (module header).
  const counts: RunCounts = {
    created: createCodes.length,
    updated: updateCodes.length,
    unchanged: 0,
    skipped,
    rejected,
  };

  const totalSteps =
    chunk(createCodes, IMPORT_BATCH_SIZE).length +
    chunk(updateCodes, IMPORT_BATCH_SIZE).length +
    1; // the recompute step

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
    uploadId: params.uploadId,
    tenantId: run.tenantId,
    userId: run.userId,
    standard,
    bindings,
    sourceArtifact: run.sourceArtifact,
    repositoryId: params.repositoryId,
    updateExisting: params.updateExisting,
    existingCodes: [...existingSet],
    acceptedClasses,
    createCodes,
    updateCodes,
    positionByCode,
    childCountByCode,
    affectedParentRefCodes,
    counts,
    totalSteps,
  };
}

/**
 * Re-assemble the write payload for every committable row from the staged
 * CSV — a pure, DB-independent projection (the record values never depend
 * on DB state; only create/update CLASSIFICATION does, and that comes from
 * the plan). Runs against the run-start snapshot so parent resolution and
 * assembly are identical to `loadCommitConfig`, and forces `updateExisting`
 * so existing codes still yield a record for the update batches.
 */
async function assembleRecords(
  store: StagingStore,
  config: CommitConfig,
): Promise<Map<string, AssembledRecord>> {
  const bytes = await store.getBytes(config.sourceArtifact);
  if (!bytes) {
    throw new ImportCommitConfigError(`staged source object missing: ${config.sourceArtifact}`);
  }
  const parsed = decodeAndParseCsv(bytes);
  const result = validate({
    standard: config.standard,
    bindings: config.bindings,
    headers: parsed.headers,
    rows: parsed.rows,
    existingReferenceCodes: new Set(config.existingCodes),
    updateExisting: true,
    defaults: { repositoryId: config.repositoryId },
    acceptedClasses: new Set(config.acceptedClasses),
  });
  const parentByRow = new Map(
    result.ordered.map((r) => [r.rowNumber, r.parentReferenceCode]),
  );
  const byCode = new Map<string, AssembledRecord>();
  for (const v of result.verdicts) {
    if (v.verdict === "reject" || !v.record || v.referenceCode == null) continue;
    byCode.set(v.referenceCode, {
      record: v.record,
      parentReferenceCode: parentByRow.get(v.rowNumber) ?? null,
    });
  }
  return byCode;
}

/** Read which of `codes` already exist for the tenant (retry-safety read). */
async function existingCodeSet(
  db: DrizzleD1Database<any>,
  tenantId: string,
  codes: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (const slice of chunk(codes, IMPORT_BATCH_SIZE)) {
    if (slice.length === 0) continue;
    const rows = (await db
      .select({ referenceCode: descriptions.referenceCode })
      .from(descriptions)
      .where(
        and(eq(descriptions.tenantId, tenantId), inArray(descriptions.referenceCode, slice)),
      )
      .all()) as { referenceCode: string }[];
    for (const r of rows) found.add(r.referenceCode);
  }
  return found;
}

interface ParentStructural {
  id: string;
  depth: number;
  rootDescriptionId: string | null;
  pathCache: string | null;
}

/**
 * Process one CREATE batch: insert each row (server-minted id, structural
 * cache computed from its parent, `created_by` = run author) paired with a
 * full-snapshot journal row in ONE `db.batch`, then requery by natural key
 * to confirm the write (never trusting insert return values, spec §5).
 * Codes already present are skipped so a retry double-inserts nothing.
 * Returns the EXECUTED counts — the Workflow sums them into the terminal
 * record_counts (module header).
 */
export async function processCreateBatch(
  db: DrizzleD1Database<any>,
  store: StagingStore,
  config: CommitConfig,
  batchCodes: readonly string[],
): Promise<{ created: number; pathCacheCapped: number }> {
  const records = await assembleRecords(store, config);
  const already = await existingCodeSet(db, config.tenantId, batchCodes);
  const toCreate = batchCodes.filter((c) => !already.has(c));
  if (toCreate.length === 0) return { created: 0, pathCacheCapped: 0 };

  // Resolve parent structural fields: cross-batch parents live in the DB
  // (created by an earlier batch or pre-existing); intra-batch parents are
  // resolved from `memParents` as they are minted, in topological order.
  const parentRefs = [
    ...new Set(
      toCreate
        .map((c) => records.get(c)?.parentReferenceCode ?? null)
        .filter((p): p is string => p != null),
    ),
  ];
  const memParents = new Map<string, ParentStructural>();
  for (const slice of chunk(parentRefs, IMPORT_BATCH_SIZE)) {
    if (slice.length === 0) continue;
    const rows = (await db
      .select({
        referenceCode: descriptions.referenceCode,
        id: descriptions.id,
        depth: descriptions.depth,
        rootDescriptionId: descriptions.rootDescriptionId,
        pathCache: descriptions.pathCache,
      })
      .from(descriptions)
      .where(
        and(eq(descriptions.tenantId, config.tenantId), inArray(descriptions.referenceCode, slice)),
      )
      .all()) as (ParentStructural & { referenceCode: string })[];
    for (const r of rows) {
      memParents.set(r.referenceCode, {
        id: r.id,
        depth: r.depth,
        rootDescriptionId: r.rootDescriptionId,
        pathCache: r.pathCache,
      });
    }
  }

  const now = Date.now();
  const statements: unknown[] = [];
  let pathCacheCapped = 0;
  for (const code of toCreate) {
    const assembled = records.get(code);
    if (!assembled) continue;
    const parentRef = assembled.parentReferenceCode;
    const parent = parentRef != null ? memParents.get(parentRef) ?? null : null;

    const id = crypto.randomUUID();
    const depth = parent ? parent.depth + 1 : 0;
    const rootDescriptionId = parent ? parent.rootDescriptionId || parent.id : id;
    // Cap-and-warn (module header): an over-long computed path stores the
    // schema-default "" — the codebase's own `pathCache || id` fallback
    // convention tolerates it — and the row is counted, never failed.
    const rawPath = parent ? `${parent.pathCache || parent.id}/${id}` : id;
    let pathCache = rawPath;
    if (rawPath.length > MAX_PATH_CACHE_LENGTH) {
      pathCache = "";
      pathCacheCapped++;
    }
    const position = config.positionByCode[code] ?? 0;
    const childCount = config.childCountByCode[code] ?? 0;

    const boundFields: Record<string, unknown> = { ...assembled.record };
    delete boundFields.id;
    delete boundFields.repositoryId;
    delete boundFields.descriptionLevel;
    const rawLevel = typeof assembled.record.descriptionLevel === "string"
      ? assembled.record.descriptionLevel
      : "";
    const level: DescriptionLevel = isDescriptionLevel(rawLevel) ? rawLevel : "item";

    const values = {
      ...boundFields,
      id,
      tenantId: config.tenantId,
      repositoryId: config.repositoryId,
      parentId: parent ? parent.id : null,
      position,
      rootDescriptionId,
      depth,
      childCount,
      pathCache,
      descriptionLevel: level,
      referenceCode: code,
      isPublished: false,
      createdBy: config.userId,
      updatedBy: config.userId,
      createdAt: now,
      updatedAt: now,
    } as typeof descriptions.$inferInsert;

    statements.push(db.insert(descriptions).values(values));
    statements.push(
      composeJournalEntry(db, {
        recordId: id,
        recordType: "description",
        userId: config.userId,
        kind: "create",
        diff: createSnapshotDiff(values as Record<string, unknown>),
        runId: config.runId,
        now,
      }),
    );

    // Register in the in-memory parent map so a child later in THIS batch
    // resolves against the row we are about to insert.
    memParents.set(code, { id, depth, rootDescriptionId, pathCache });
  }

  if (statements.length > 0) {
    await db.batch(statements as [any, ...any[]]);
  }

  // Requery by natural key to confirm the write landed (spec §5); a
  // mismatch throws so the Workflow retries the (idempotent) batch.
  const confirmed = await existingCodeSet(db, config.tenantId, toCreate);
  for (const code of toCreate) {
    if (!confirmed.has(code)) {
      throw new Error(`create requery mismatch: ${code} not found after insert`);
    }
  }
  return { created: toCreate.length, pathCacheCapped };
}

/** The columns a create/update must never touch on the target row. */
const NON_EDITABLE_TARGETS = new Set(["id", "repositoryId", REQUIRED_TARGET]);

/** One archived source-system identifier inside the legacy_ids JSON list. */
interface LegacyIdEntry {
  provider: string;
  id: string;
  [extra: string]: unknown;
}

/**
 * MERGE-APPEND the imported legacy-id entries into the existing row's
 * list (module header): union deduplicated by (provider, id), existing
 * entries first and NEVER removed. When the merge adds nothing, the
 * existing serialisation is returned verbatim so the field diffs empty
 * and no write happens (re-import idempotency).
 */
export function mergeLegacyIds(existingJson: unknown, incomingJson: string): string {
  const parse = (json: unknown): LegacyIdEntry[] => {
    if (typeof json !== "string" || json === "") return [];
    try {
      const value = JSON.parse(json);
      return Array.isArray(value) ? (value as LegacyIdEntry[]) : [];
    } catch {
      return [];
    }
  };
  const merged = parse(existingJson);
  const seen = new Set(merged.map((e) => `${e.provider}\x00${e.id}`));
  let appended = false;
  for (const entry of parse(incomingJson)) {
    const key = `${entry.provider}\x00${entry.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
    appended = true;
  }
  if (!appended && typeof existingJson === "string" && existingJson !== "") {
    return existingJson;
  }
  return JSON.stringify(merged);
}

/**
 * Process one UPDATE batch: for each existing row, update only the bound
 * descriptive fields, bump `updated_at`, and journal the ordinary
 * before-image diff in the SAME `db.batch`. An unchanged row yields an
 * empty diff and is left untouched — so the batch is idempotent and a
 * no-op re-import writes and journals nothing. Returns EXECUTED counts:
 * `updated` = rows with a non-empty diff, `unchanged` = update-verdict
 * rows whose values already matched (module header).
 */
export async function processUpdateBatch(
  db: DrizzleD1Database<any>,
  store: StagingStore,
  config: CommitConfig,
  batchCodes: readonly string[],
): Promise<{ updated: number; unchanged: number }> {
  const records = await assembleRecords(store, config);
  const current = (await db
    .select()
    .from(descriptions)
    .where(
      and(
        eq(descriptions.tenantId, config.tenantId),
        inArray(descriptions.referenceCode, [...batchCodes]),
      ),
    )
    .all()) as Record<string, unknown>[];
  const currentByCode = new Map(current.map((r) => [r.referenceCode as string, r]));

  const now = Date.now();
  const statements: unknown[] = [];
  let updated = 0;
  let unchanged = 0;
  for (const code of batchCodes) {
    const assembled = records.get(code);
    const existing = currentByCode.get(code);
    if (!assembled || !existing) continue;

    const boundFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(assembled.record)) {
      if (NON_EDITABLE_TARGETS.has(key)) continue;
      boundFields[key] = value;
    }
    // legacyIds is merge-append, never replace (module header): the
    // journal's before-image is the existing list, the after-image the
    // merged one — an honest old → merged diff.
    if (typeof boundFields.legacyIds === "string") {
      boundFields.legacyIds = mergeLegacyIds(existing.legacyIds, boundFields.legacyIds);
    }
    const before: Record<string, unknown> = {};
    for (const key of Object.keys(boundFields)) before[key] = existing[key];
    const diff = computeDiff(before, boundFields);
    if (!diff) {
      unchanged++;
      continue; // idempotent no-op
    }

    statements.push(
      db
        .update(descriptions)
        .set({ ...boundFields, updatedBy: config.userId, updatedAt: now })
        .where(
          and(
            eq(descriptions.tenantId, config.tenantId),
            eq(descriptions.id, existing.id as string),
          ),
        ),
    );
    statements.push(
      composeJournalEntry(db, {
        recordId: existing.id as string,
        recordType: "description",
        userId: config.userId,
        kind: "update",
        diff,
        runId: config.runId,
        now,
      }),
    );
    updated++;
  }

  if (statements.length > 0) {
    await db.batch(statements as [any, ...any[]]);
  }
  return { updated, unchanged };
}

/**
 * Reconcile childCount for every parent that gained children to the ACTUAL
 * DB child count (idempotent — recompute, never increment). Each changed
 * parent is journalled as an ordinary `update` in the same `db.batch`, so
 * the scanner pairing holds and a revert restores the prior count. Parents
 * whose stored count already matches are left untouched (no diff, no
 * write). Created parents' childCounts were set correctly at INSERT, so
 * this chiefly touches EXISTING containers that received new children.
 */
export async function recomputeStructuralCaches(
  db: DrizzleD1Database<any>,
  config: CommitConfig,
): Promise<{ recomputed: number }> {
  if (config.affectedParentRefCodes.length === 0) return { recomputed: 0 };

  // Both reads are chunked at IMPORT_BATCH_SIZE (≤99 codes + the tenant id
  // per statement) so an import touching hundreds of distinct containers
  // never exceeds D1's 100-bound-parameter cap; child counts come from ONE
  // grouped query per chunk, never a query per parent.
  const parents: { id: string; referenceCode: string; childCount: number }[] = [];
  for (const slice of chunk(config.affectedParentRefCodes, IMPORT_BATCH_SIZE)) {
    const rows = (await db
      .select({
        id: descriptions.id,
        referenceCode: descriptions.referenceCode,
        childCount: descriptions.childCount,
      })
      .from(descriptions)
      .where(
        and(
          eq(descriptions.tenantId, config.tenantId),
          inArray(descriptions.referenceCode, slice),
        ),
      )
      .all()) as { id: string; referenceCode: string; childCount: number }[];
    parents.push(...rows);
  }

  const actualByParentId = new Map<string, number>();
  for (const slice of chunk(parents.map((p) => p.id), IMPORT_BATCH_SIZE)) {
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
  const statements: unknown[] = [];
  let recomputed = 0;
  for (const parent of parents) {
    const actualCount = actualByParentId.get(parent.id) ?? 0;
    if (actualCount === parent.childCount) continue;

    statements.push(
      db
        .update(descriptions)
        // updatedBy = the run author, so the row's attribution agrees with
        // the journal row this batch pairs with it.
        .set({ childCount: actualCount, updatedAt: now, updatedBy: config.userId })
        .where(
          and(eq(descriptions.tenantId, config.tenantId), eq(descriptions.id, parent.id)),
        ),
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
    recomputed++;
  }

  // Submit in bounded slices of whole update+journal PAIRS — a pair never
  // splits across batches, so effect + journal still land together.
  for (const slice of chunk(statements, IMPORT_BATCH_SIZE * 2)) {
    if (slice.length > 0) await db.batch(slice as [any, ...any[]]);
  }
  return { recomputed };
}

/** Heartbeat: mark the start of a run step (exportRuns step-tracking shape). */
export async function recordRunStepStart(
  db: DrizzleD1Database<any>,
  runId: string,
  stepName: string,
): Promise<void> {
  const now = Date.now();
  await db
    .update(stewardshipRuns)
    .set({ currentStep: stepName, currentStepStartedAt: now, currentStepCompletedAt: null, lastHeartbeatAt: now })
    .where(eq(stewardshipRuns.id, runId));
}

/** Heartbeat: mark the end of a run step and advance the completed counter. */
export async function recordRunStepEnd(
  db: DrizzleD1Database<any>,
  runId: string,
  stepName: string,
  counts: RunCounts,
): Promise<void> {
  const now = Date.now();
  await db
    .update(stewardshipRuns)
    .set({
      currentStep: stepName,
      currentStepCompletedAt: now,
      lastHeartbeatAt: now,
      stepsCompleted: sql`${stewardshipRuns.stepsCompleted} + 1`,
      recordCounts: JSON.stringify(counts),
    })
    .where(eq(stewardshipRuns.id, runId));
}

/**
 * Terminal step: write the WRITE-DERIVED counts the Workflow accumulated
 * from the step returns (module header; stewardship spec §6), mark the run
 * `complete`. The upload was flipped to `committed` at mint time
 * (`mintImportRun`).
 */
export async function finalizeRun(
  db: DrizzleD1Database<any>,
  runId: string,
  counts: RunCounts,
): Promise<void> {
  await db
    .update(stewardshipRuns)
    .set({
      status: "complete",
      completedAt: Date.now(),
      recordCounts: JSON.stringify(counts),
      currentStep: "finalize",
      currentStepCompletedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
    })
    .where(eq(stewardshipRuns.id, runId));
}

/** Failure tombstone: mark the run `error` with a human-readable message. */
export async function failRun(
  db: DrizzleD1Database<any>,
  runId: string,
  message: string,
): Promise<void> {
  await db
    .update(stewardshipRuns)
    .set({ status: "error", errorMessage: message, completedAt: Date.now() })
    .where(eq(stewardshipRuns.id, runId));
}

export interface MintImportRunInput {
  tenantId: string;
  federationId?: string | null;
  userId: string;
  message: string;
  justification?: string | null;
  profileId: string;
  profileVersion: number;
  sourceArtifact: string;
  reportArtifact: string;
  uploadId: string;
  now?: number;
}

/**
 * Mint the `stewardship_runs` row (`kind='import'`, `pending`) and flip the
 * staged upload to `committed` with the run id — atomically, in ONE
 * `db.batch`, and BOTH statements conditioned on the upload still being
 * `staged`. That condition is the double-submit mutex: two commits racing
 * past the route's status read both reach this batch, but only the first
 * sees `staged` — the loser's conditional insert selects zero rows and its
 * conditional flip matches zero rows, so it mints NOTHING. Returns null in
 * that case (the caller surfaces `alreadyCommitted` and must NOT launch a
 * Workflow); returns the run id when the mint landed. The run insert is an
 * INSERT … SELECT reading FROM the upload row itself — the select yields
 * one row while the upload is `staged` and zero rows otherwise, which is
 * the condition; `stewardship_runs` is not a journaled table, so the
 * scanner is unaffected. The empty-message guard (`assertRunMessage`,
 * spec §2) fires before any write.
 */
export async function mintImportRun(
  db: DrizzleD1Database<any>,
  input: MintImportRunInput,
): Promise<{ runId: string } | null> {
  assertRunMessage(input.message);

  const id = crypto.randomUUID();
  const now = input.now ?? Date.now();

  // The staged-guard predicate both statements share.
  const stagedUpload = and(
    eq(importUploads.id, input.uploadId),
    eq(importUploads.tenantId, input.tenantId),
    eq(importUploads.status, "staged"),
  );

  // The selection mirrors stewardship_runs' full column list (the builder
  // validates key parity with the table definition).
  const insertRun = db.insert(stewardshipRuns).select(
    db
      .select({
        id: sql`${id}`.as("id"),
        tenantId: sql`${input.tenantId}`.as("tenant_id"),
        federationId: sql`${input.federationId ?? null}`.as("federation_id"),
        kind: sql`'import'`.as("kind"),
        message: sql`${input.message}`.as("message"),
        justification: sql`${input.justification ?? null}`.as("justification"),
        userId: sql`${input.userId}`.as("user_id"),
        status: sql`'pending'`.as("status"),
        revertsRunId: sql`null`.as("reverts_run_id"),
        revertedByRunId: sql`null`.as("reverted_by_run_id"),
        profileId: sql`${input.profileId}`.as("profile_id"),
        profileVersion: sql`${input.profileVersion}`.as("profile_version"),
        sourceArtifact: sql`${input.sourceArtifact}`.as("source_artifact"),
        reportArtifact: sql`${input.reportArtifact}`.as("report_artifact"),
        recordCounts: sql`null`.as("record_counts"),
        // Audit copy of the readiness-check acceptances (0066): read
        // from the upload row inside this same INSERT-SELECT, so the
        // snapshot is atomic with the mint and can never come from
        // client input.
        acceptedFindings: sql`${importUploads.checkDecisions}`.as("accepted_findings"),
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
      .from(importUploads)
      .where(stagedUpload),
  );

  const flip = db
    .update(importUploads)
    .set({ status: "committed", runId: id, reportArtifact: input.reportArtifact, updatedAt: now })
    .where(stagedUpload);

  // Insert precedes flip so the flip's run_id FK resolves; the batch is a
  // transaction, so the two `staged` reads see one consistent snapshot and
  // the envelope + flip land together or not at all (spec §2).
  await db.batch([insertRun, flip] as [any, ...any[]]);

  const minted = await db
    .select({ id: stewardshipRuns.id })
    .from(stewardshipRuns)
    .where(eq(stewardshipRuns.id, id))
    .get();
  return minted ? { runId: id } : null;
}
