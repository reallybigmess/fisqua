/**
 * Crowdsourced Promotion
 *
 * This module deals with the server-side engine for turning a
 * reviewed crowdsourcing volume entry into a published archival
 * description. It loads the entry, validates its reference code and
 * field payload, copies the mapped fields onto a fresh `descriptions`
 * row, writes the promotion manifest to R2, and records the audit
 * trail. Batch size is capped so a single superadmin click cannot fan
 * out into an unbounded workload.
 *
 * `PromotionArgs` carries an explicit `tenantId` so the
 * request-boundary tenant from `context.get(tenantContext).id` is
 * plumbed through to `mapEntryToDescription` rather than relying on a
 * single-tenant hard-code.
 *
 * `PromotionArgs` also carries a `standard: Standard` field; each
 * per-entry mapping pass calls
 * `descriptionValidatorFor(standard, "item").safeParse(output.description)`
 * BEFORE persistence. Promotion forces `descriptionLevel: "item"`
 * (see `field-mapping.ts`), so the validator's level argument is
 * locked to `"item"` here. A standard-mismatched entry is recorded as
 * an error rather than persisted — a DACS or RAD tenant with
 * `crowdsourcing_enabled` does not produce ISAD-shaped output. The
 * validator factory is the same one the admin form save action
 * consumes.
 *
 * @version v0.4.2
 */
import { eq, and, isNull, inArray, sql, desc } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod/v4";
import {
  entries,
  descriptions,
  volumes,
  volumePages,
} from "../../db/schema";
import { mapEntryToDescription } from "./field-mapping";
import { buildDocumentManifest } from "./manifest-builder";
import { parseManifest } from "../iiif.server";
import { descriptionValidatorFor } from "../standards/validator-factory";
import type { Standard } from "../standards/types";
import type { VolumePage } from "./types";

/** D1 batch limit per established pattern in entries.server.ts */
const CHUNK_SIZE = 89;

/** Maximum entries per promotion batch */
const MAX_BATCH_SIZE = 200;

/**
 * Reference code validation: Unicode letters + digits + hyphen,
 * max 50 chars. Multilingual posture (v0.4 round 1) — `\p{L}` admits
 * Spanish/Portuguese/French/Catalan diacritics so cataloguers can
 * emit reference codes like `Tutela-Niño` without lossy ASCII fold.
 * Mirrors `scripts/commands/descriptions.ts:REFERENCE_CODE_PATTERN`.
 */
const REFERENCE_CODE_PATTERN = /^[\p{L}\p{N}-]{1,50}$/u;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromotionArgs {
  db: DrizzleD1Database<any>;
  manifestsBucket: R2Bucket;
  entries: Array<{ entryId: string; referenceCode: string }>;
  volumeId: string;
  userId: string;
  tenantId: string;
  /**
   * Active descriptive standard for the request-boundary tenant.
   * Plumbed through to `mapEntryToDescription` and used to select
   * the validator at the persistence boundary via
   * `descriptionValidatorFor(standard, "item")`.
   */
  standard: Standard;
  manifestBaseUrl: string;
}

export interface PromotionResult {
  promoted: Array<{
    entryId: string;
    descriptionId: string;
    referenceCode: string;
  }>;
  skipped: Array<{ entryId: string; referenceCode: string; reason: string }>;
  errors: Array<{ entryId: string; error: string }>;
}

export interface VolumeWithCount {
  id: string;
  name: string;
  referenceCode: string;
  promotableCount: number;
}

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

/**
 * List volumes that have at least one promotable entry:
 * type = 'item', descriptionStatus = 'approved', promotedDescriptionId IS NULL.
 *
 * Tenant-scoped: `tenantId` (the request-boundary session tenant) filters
 * both the volume scan and the per-volume entry count so the promote
 * surface never lists another tenant's volumes. Volumes inherit their
 * tenant from their project; entries from their volume -- the predicate
 * on each is the loader-layer enforcement D1 cannot provide (invariant I1).
 */
export async function getVolumesWithPromotableEntries(
  db: DrizzleD1Database<any>,
  tenantId: string,
): Promise<VolumeWithCount[]> {
  const rows = await db
    .select({
      id: volumes.id,
      name: volumes.name,
      referenceCode: volumes.referenceCode,
    })
    .from(volumes)
    .where(eq(volumes.tenantId, tenantId))
    .all();

  const result: VolumeWithCount[] = [];

  for (const vol of rows) {
    const countRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(entries)
      .where(
        and(
          eq(entries.tenantId, tenantId),
          eq(entries.volumeId, vol.id),
          eq(entries.type, "item"),
          eq(entries.descriptionStatus, "approved"),
          isNull(entries.promotedDescriptionId)
        )
      )
      .all();

    const count = countRows[0]?.count ?? 0;
    if (count > 0) {
      result.push({ ...vol, promotableCount: count });
    }
  }

  return result;
}

/**
 * Load promotable and already-promoted entries for a volume.
 */
export async function getPromotableEntries(
  db: DrizzleD1Database<any>,
  tenantId: string,
  volumeId: string
): Promise<{
  promotable: Array<typeof entries.$inferSelect>;
  alreadyPromoted: Array<typeof entries.$inferSelect>;
}> {
  const promotable = await db
    .select()
    .from(entries)
    .where(
      and(
        eq(entries.tenantId, tenantId),
        eq(entries.volumeId, volumeId),
        eq(entries.type, "item"),
        eq(entries.descriptionStatus, "approved"),
        isNull(entries.promotedDescriptionId)
      )
    )
    .orderBy(entries.position)
    .all();

  const alreadyPromoted = await db
    .select()
    .from(entries)
    .where(
      and(
        eq(entries.tenantId, tenantId),
        eq(entries.volumeId, volumeId),
        eq(entries.type, "item"),
        eq(entries.descriptionStatus, "promoted"),
        sql`${entries.promotedDescriptionId} IS NOT NULL`
      )
    )
    .orderBy(entries.position)
    .all();

  return { promotable, alreadyPromoted };
}

// ---------------------------------------------------------------------------
// Main promotion orchestration
// ---------------------------------------------------------------------------

/**
 * Promote approved entries into the description hierarchy.
 *
 * Steps (mapping-then-persist ordering):
 * a. Validate inputs (type, status, volumeId, idempotency, ref code format & uniqueness)
 * b. Load parent context (description matching volume referenceCode)
 * c. Load volume manifest and parse pages
 * d. Map entries to descriptions (pure)
 * e. Build IIIF manifests (pure)
 * f. Insert descriptions into D1 (batched)
 * g. Upload manifests to R2
 * h. Update entries (batched)
 * i. Update parent denorm cache
 * j. Return results
 */
export async function promoteEntries(
  args: PromotionArgs
): Promise<PromotionResult> {
  const { db, manifestsBucket, entries: inputEntries, volumeId, userId, tenantId, standard, manifestBaseUrl } = args;

  // Build the per-standard validator once per batch and reuse for
  // every entry. Promotion forces `descriptionLevel: "item"` in
  // `mapEntryToDescription`, so the level argument is locked here.
  const validator = descriptionValidatorFor(standard, "item");

  const promoted: PromotionResult["promoted"] = [];
  const skipped: PromotionResult["skipped"] = [];
  const errors: PromotionResult["errors"] = [];

  // batch size limit
  if (inputEntries.length > MAX_BATCH_SIZE) {
    throw new Error(
      `Batch size ${inputEntries.length} exceeds maximum of ${MAX_BATCH_SIZE}`
    );
  }

  // validate reference code format
  for (const item of inputEntries) {
    if (!REFERENCE_CODE_PATTERN.test(item.referenceCode)) {
      errors.push({
        entryId: item.entryId,
        error: `Invalid reference code format: ${item.referenceCode}`,
      });
    }
  }
  // Remove entries with invalid ref codes from further processing
  const validEntries = inputEntries.filter(
    (item) => !errors.some((e) => e.entryId === item.entryId)
  );

  if (validEntries.length === 0) {
    return { promoted, skipped, errors };
  }

  // ---- (a) Validate inputs ----

  const entryIds = validEntries.map((e) => e.entryId);
  const loadedEntries = await db
    .select()
    .from(entries)
    .where(and(eq(entries.tenantId, tenantId), inArray(entries.id, entryIds)))
    .all();

  const entryMap = new Map(loadedEntries.map((e) => [e.id, e]));
  const refCodeMap = new Map(
    validEntries.map((e) => [e.entryId, e.referenceCode])
  );

  // Validate each entry
  const toProcess: Array<{
    entry: typeof entries.$inferSelect;
    referenceCode: string;
  }> = [];

  for (const item of validEntries) {
    const entry = entryMap.get(item.entryId);
    if (!entry) {
      errors.push({ entryId: item.entryId, error: "Entry not found" });
      continue;
    }
    // verify entry belongs to volume
    if (entry.volumeId !== volumeId) {
      errors.push({
        entryId: item.entryId,
        error: "Entry does not belong to the specified volume",
      });
      continue;
    }
    // only items
    if (entry.type !== "item") {
      errors.push({
        entryId: item.entryId,
        error: `Only item entries can be promoted, got type: ${entry.type}`,
      });
      continue;
    }
    if (entry.descriptionStatus !== "approved") {
      // already promoted — skip, don't error
      if (
        entry.descriptionStatus === "promoted" &&
        entry.promotedDescriptionId
      ) {
        skipped.push({
          entryId: item.entryId,
          referenceCode: item.referenceCode,
          reason: `Already promoted -> ${entry.promotedDescriptionId}`,
        });
        continue;
      }
      errors.push({
        entryId: item.entryId,
        error: `Entry must have status 'approved', got: ${entry.descriptionStatus}`,
      });
      continue;
    }
    toProcess.push({ entry, referenceCode: item.referenceCode });
  }

  if (toProcess.length === 0) {
    return { promoted, skipped, errors };
  }

  // Check reference code uniqueness against descriptions table.
  // Defensively scope the lookup to the calling tenant. The
  // `descriptions.referenceCode` index is GLOBALLY UNIQUE today (see
  // `tests/helpers/db.ts:257`), so collision across tenants is rare
  // in practice — but the read should still tenant-filter so that if
  // the global-unique constraint is ever relaxed (a multi-tenant
  // ref-code uniqueness review), this code path continues to fail
  // loudly rather than silently mis-attributing.
  const refCodes = toProcess.map((p) => p.referenceCode);
  const existingDescs = await db
    .select({ referenceCode: descriptions.referenceCode })
    .from(descriptions)
    .where(
      and(
        eq(descriptions.tenantId, tenantId),
        inArray(descriptions.referenceCode, refCodes),
      ),
    )
    .all();

  const existingRefCodes = new Set(existingDescs.map((d) => d.referenceCode));
  const duplicateEntries = toProcess.filter((p) =>
    existingRefCodes.has(p.referenceCode)
  );
  for (const dup of duplicateEntries) {
    errors.push({
      entryId: dup.entry.id,
      error: `Duplicate reference code: ${dup.referenceCode} already exists in descriptions`,
    });
  }
  const uniqueToProcess = toProcess.filter(
    (p) => !existingRefCodes.has(p.referenceCode)
  );

  if (uniqueToProcess.length === 0) {
    return { promoted, skipped, errors };
  }

  // ---- (b) Load parent context ----

  const volume = await db
    .select()
    .from(volumes)
    .where(and(eq(volumes.tenantId, tenantId), eq(volumes.id, volumeId)))
    .get();

  if (!volume) {
    throw new Error(`Volume not found: ${volumeId}`);
  }

  // find description matching volume's referenceCode. Scope by
  // tenantId so a volume reference code that happens to collide with
  // a description in a different tenant cannot become the promotion
  // parent. The mapper at line ~417 below assigns
  // `parentDescriptionId: parentDescription.id` and writes the
  // calling tenantId to the new row; without this filter, a tenant
  // could silently graft new descriptions onto another tenant's
  // parent. Today's global-unique index on referenceCode makes the
  // collision rare, but this is defence-in-depth for the day that
  // changes (a future multi-tenant ref-code uniqueness review).
  const parentDescription = await db
    .select()
    .from(descriptions)
    .where(
      and(
        eq(descriptions.tenantId, tenantId),
        eq(descriptions.referenceCode, volume.referenceCode),
      ),
    )
    .get();

  if (!parentDescription) {
    throw new Error(
      `No description found matching volume reference code: ${volume.referenceCode}. ` +
        `The volume's parent description must exist before promotion.`
    );
  }

  // ---- (c) Load volume manifest pages ----

  const pages = await db
    .select()
    .from(volumePages)
    .where(
      and(eq(volumePages.tenantId, tenantId), eq(volumePages.volumeId, volumeId)),
    )
    .orderBy(volumePages.position)
    .all();

  const volumePageList: VolumePage[] = pages.map((p) => ({
    position: p.position,
    width: p.width,
    height: p.height,
    imageUrl: p.imageUrl,
    label: p.label ?? String(p.position),
  }));

  // If no local pages, try fetching from manifest URL
  if (volumePageList.length === 0) {
    const parsed = await parseManifest(volume.manifestUrl);
    volumePageList.push(...parsed.pages);
  }

  // ---- (d) Map entries to descriptions (pure) ----

  // Get current max position under parent
  const maxPosRows = await db
    .select({ maxPos: sql<number>`coalesce(max(${descriptions.position}), -1)` })
    .from(descriptions)
    .where(eq(descriptions.parentId, parentDescription.id))
    .all();
  let nextPosition = (maxPosRows[0]?.maxPos ?? -1) + 1;

  const mappings: Array<{
    entry: typeof entries.$inferSelect;
    descriptionId: string;
    referenceCode: string;
    descriptionData: Record<string, any>;
    manifest: object;
  }> = [];

  for (const { entry, referenceCode } of uniqueToProcess) {
    const descriptionId = crypto.randomUUID();
    const result = mapEntryToDescription(
      {
        entry,
        volumeReferenceCode: volume.referenceCode,
        assignedReferenceCode: referenceCode,
        repositoryId: parentDescription.repositoryId,
        parentDescriptionId: parentDescription.id,
        rootDescriptionId:
          parentDescription.rootDescriptionId ?? parentDescription.id,
        parentDepth: parentDescription.depth,
        parentPathCache: parentDescription.pathCache ?? "",
        userId,
        tenantId,
      },
      standard,
    );

    // Per-standard validator runs at this write boundary BEFORE
    // persistence. A miss surfaces as a per-entry error rather than
    // silently writing a standard-mismatched row.
    const parsed = validator.safeParse(result.description);
    if (!parsed.success) {
      const flat = z.flattenError(parsed.error).fieldErrors;
      const fields = Object.keys(flat).join(", ") || "validation failed";
      errors.push({
        entryId: entry.id,
        error: `Standard '${standard}' validation failed: ${fields}`,
      });
      continue;
    }

    // Set position and iiifManifestUrl
    const descData = {
      ...result.description,
      position: nextPosition++,
      iiifManifestUrl: `${manifestBaseUrl}/${referenceCode}/manifest.json`,
    };

    // ---- (e) Build manifest (pure) ----
    const manifest = buildDocumentManifest(
      result.manifestSpec,
      volumePageList,
      manifestBaseUrl
    );

    mappings.push({
      entry,
      descriptionId,
      referenceCode,
      descriptionData: descData,
      manifest,
    });
  }

  // ---- (f) Insert descriptions into D1 ----

  const now = Date.now();
  const insertStmts = mappings.map((m) =>
    db.insert(descriptions).values({
      id: m.descriptionId,
      ...m.descriptionData,
      createdAt: now,
      updatedAt: now,
    } as typeof descriptions.$inferInsert)
  );

  for (let i = 0; i < insertStmts.length; i += CHUNK_SIZE) {
    const chunk = insertStmts.slice(i, i + CHUNK_SIZE);
    await db.batch(chunk as any);
  }

  // ---- (g) Upload manifests to R2 ----

  for (const m of mappings) {
    await manifestsBucket.put(
      `${m.referenceCode}.json`,
      JSON.stringify(m.manifest),
      { httpMetadata: { contentType: "application/ld+json" } }
    );
  }

  // ---- (h) Update entries ----

  const updateStmts = mappings.map((m) =>
    db
      .update(entries)
      .set({
        promotedDescriptionId: m.descriptionId,
        descriptionStatus: "promoted" as const,
        updatedAt: now,
      })
      .where(and(eq(entries.tenantId, tenantId), eq(entries.id, m.entry.id)))
  );

  for (let i = 0; i < updateStmts.length; i += CHUNK_SIZE) {
    const chunk = updateStmts.slice(i, i + CHUNK_SIZE);
    await db.batch(chunk as any);
  }

  // ---- (i) Update parent denorm cache ----

  const promotedCount = mappings.length;
  await db
    .update(descriptions)
    .set({
      childCount: sql`${descriptions.childCount} + ${promotedCount}`,
      updatedAt: now,
    })
    .where(eq(descriptions.id, parentDescription.id));

  // ---- (j) Return results ----

  for (const m of mappings) {
    promoted.push({
      entryId: m.entry.id,
      descriptionId: m.descriptionId,
      referenceCode: m.referenceCode,
    });
  }

  return { promoted, skipped, errors };
}
