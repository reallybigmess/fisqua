/**
 * Publish Pipeline Steps
 *
 * This module deals with the individual steps the publish workflow
 * runs, one exported function per Cloudflare Workflow step. The
 * contract each function respects is narrow: read a well-defined
 * slice of D1, format it with the per-entity helpers next to this
 * file, upload a bounded set of R2 objects, and return the record
 * counts the workflow needs to record in its heartbeat row.
 *
 * Memory stays bounded to at most one fonds at a time and R2 PUTs are
 * capped at a few hundred per step, so a single Worker invocation
 * never runs out of its 128 MB / 30 s / 1000-subrequest budget. The
 * orchestration that wires these into a durable workflow — retries,
 * heartbeats, final tombstone writes — lives in
 * `app/workflows/publish-export.ts`.
 *
 * Every step takes an explicit `tenant: ExportTenant` argument so
 * every D1 read filters by `tenant.id` and every R2 key is prefixed
 * with `${tenant.slug}/`. An earlier iteration of these functions had
 * zero `tenant` references and wrote flat keys
 * (`descriptions-<ref>.json`, `entities.json`, etc.) — a Tenant A
 * superadmin could have triggered an export that read Tenant B rows
 * and overwrote Tenant B's R2 objects. The current shape closes that
 * exposure.
 *
 * @version v0.4.2
 */

import { eq, and, inArray, isNull, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";
import {
  descriptions,
  repositories,
  entities,
  places,
  descriptionEntities,
  descriptionPlaces,
  exportRuns,
  vocabularyTerms,
} from "../../db/schema";
import type { ExportStorage } from "./r2-client.server";
import type {
  EadInput,
  EadRepository,
  ExportDescription,
  ExportTenant,
} from "./types";
import { formatDescription } from "./descriptions.server";
import { formatRepositories } from "./repositories.server";
import { formatEntity } from "./entities.server";
import { formatPlace } from "./places.server";
import { generateChildrenMap } from "./children.server";
import { buildEad3 } from "./ead/builder";
import { getEadProfile } from "./ead/profiles/registry";
import { buildDcBulk } from "./dc/builder";
import { sanitiseRefForKey } from "./xml/escape";

const CHILDREN_PUT_BATCH = 50;

/**
 * Export descriptions for a single fonds: query, format, upload one per-fonds
 * R2 object, return its record count and serialized byte size.
 *
 * Memory bound: one fonds at a time.
 */
export async function exportFondsDescriptions(
  db: DrizzleD1Database<any>,
  storage: ExportStorage,
  fondsCode: string,
  tenant: ExportTenant
): Promise<{ recordCount: number; byteSize: number }> {
  const root = await db
    .select({ id: descriptions.id })
    .from(descriptions)
    .where(
      and(
        eq(descriptions.referenceCode, fondsCode),
        eq(descriptions.tenantId, tenant.id)
      )
    )
    .get();

  if (!root) {
    await storage.putObject(`${tenant.slug}/descriptions-${fondsCode}.json`, "[]");
    return { recordCount: 0, byteSize: 2 };
  }

  const fondsRows = await db
    .select()
    .from(descriptions)
    .where(
      and(
        eq(descriptions.tenantId, tenant.id),
        eq(descriptions.rootDescriptionId, root.id),
        eq(descriptions.isPublished, true)
      )
    )
    .all();

  // Build per-fonds parent/child lookups so formatDescription can resolve
  // parent_reference_code and children_level without leaking out of the fonds.
  const byId = new Map(fondsRows.map((r) => [r.id, r]));
  const childRefsByParent = new Map<string, string[]>();
  for (const row of fondsRows) {
    if (row.parentId) {
      const refs = childRefsByParent.get(row.parentId);
      if (refs) refs.push(row.referenceCode);
      else childRefsByParent.set(row.parentId, [row.referenceCode]);
    }
  }

  // Repository cache scoped to this fonds (almost always one repo per fonds).
  const repoCache = new Map<string, { code: string; country: string | null }>();
  const fondsFormatted: ExportDescription[] = [];

  for (const row of fondsRows) {
    let repo = repoCache.get(row.repositoryId);
    if (!repo) {
      const repoRow = await db
        .select({
          code: repositories.code,
          country: repositories.country,
        })
        .from(repositories)
        .where(
          and(
            eq(repositories.id, row.repositoryId),
            eq(repositories.tenantId, tenant.id)
          )
        )
        .get();
      repo = repoRow ?? { code: "", country: null };
      repoCache.set(row.repositoryId, repo);
    }

    const parentRefCode = row.parentId
      ? byId.get(row.parentId)?.referenceCode ?? null
      : null;
    const childRefs = childRefsByParent.get(row.id) ?? [];

    fondsFormatted.push(
      formatDescription(row, repo, parentRefCode, childRefs)
    );
  }

  const body = JSON.stringify(fondsFormatted);
  await storage.putObject(`${tenant.slug}/descriptions-${fondsCode}.json`, body);

  return { recordCount: fondsFormatted.length, byteSize: body.length };
}

/**
 * Export the children/{ref}.json files for a single fonds.
 *
 * Crucially, R2 PUTs are batched at CHILDREN_PUT_BATCH (50) concurrently.
 * Even the largest fonds has well under 1000 parents per step, so the
 * subrequest budget is comfortably respected. Higher concurrency would
 * give marginal speed at the cost of backpressure safety.
 *
 * Memory bound: one fonds at a time.
 * Subrequest bound: 1 root query + 1 fonds rows query + N child PUTs.
 */
export async function exportFondsChildren(
  db: DrizzleD1Database<any>,
  storage: ExportStorage,
  fondsCode: string,
  tenant: ExportTenant
): Promise<{ parentCount: number; putCount: number }> {
  const root = await db
    .select({ id: descriptions.id })
    .from(descriptions)
    .where(
      and(
        eq(descriptions.referenceCode, fondsCode),
        eq(descriptions.tenantId, tenant.id)
      )
    )
    .get();

  if (!root) return { parentCount: 0, putCount: 0 };

  const fondsRows = await db
    .select({
      id: descriptions.id,
      parentId: descriptions.parentId,
      referenceCode: descriptions.referenceCode,
      title: descriptions.title,
      descriptionLevel: descriptions.descriptionLevel,
      dateExpression: descriptions.dateExpression,
      childCount: descriptions.childCount,
      hasDigital: descriptions.hasDigital,
      position: descriptions.position,
    })
    .from(descriptions)
    .where(
      and(
        eq(descriptions.tenantId, tenant.id),
        eq(descriptions.rootDescriptionId, root.id),
        eq(descriptions.isPublished, true)
      )
    )
    .all();

  const childrenMap = generateChildrenMap(fondsRows);
  const entries = Array.from(childrenMap.entries());
  let putCount = 0;

  for (let i = 0; i < entries.length; i += CHILDREN_PUT_BATCH) {
    const slice = entries.slice(i, i + CHILDREN_PUT_BATCH);
    await Promise.all(
      slice.map(([refCode, children]) =>
        storage.putObject(
          `${tenant.slug}/children/${refCode}.json`,
          JSON.stringify(children)
        )
      )
    );
    putCount += slice.length;
  }

  return { parentCount: entries.length, putCount };
}

/**
 * Build the per-fonds row + repository slice that the EAD3 / DC builders
 * consume. Both builders walk the same data shape (`EadInput` suffices
 * for DC), so factoring the fetch keeps the two pipeline functions
 * narrow.
 *
 * Returns `null` when the fonds root cannot be resolved against
 * `(referenceCode, tenantId)`. The caller writes an empty document to R2
 * and reports `recordCount: 0` (matches the JSON pipeline's "no root → empty
 * artefact" semantics for already-empty fonds slices).
 *
 * `descriptions.legacy_ids` is stored as TEXT (JSON-encoded array) per
 * `app/db/schema.ts:733`; this helper parses each row's `legacyIds` to
 * the structured array shape `EadInput.legacyIds` expects so neither
 * builder has to repeat the parse.
 */
async function loadFondsForXml(
  db: DrizzleD1Database<any>,
  fondsCode: string,
  tenant: ExportTenant
): Promise<{
  rows: EadInput[];
  repos: Map<string, EadRepository>;
} | null> {
  const root = await db
    .select({ id: descriptions.id })
    .from(descriptions)
    .where(
      and(
        eq(descriptions.referenceCode, fondsCode),
        eq(descriptions.tenantId, tenant.id)
      )
    )
    .get();

  if (!root) return null;

  const dbRows = await db
    .select()
    .from(descriptions)
    .where(
      and(
        eq(descriptions.tenantId, tenant.id),
        eq(descriptions.rootDescriptionId, root.id),
        eq(descriptions.isPublished, true)
      )
    )
    .all();

  const rows: EadInput[] = dbRows.map((r: any) => ({
    id: r.id,
    referenceCode: r.referenceCode,
    title: r.title,
    descriptionLevel: r.descriptionLevel,
    dateExpression: r.dateExpression ?? null,
    extent: r.extent ?? null,
    creatorDisplay: r.creatorDisplay ?? null,
    scopeContent: r.scopeContent ?? null,
    accessConditions: r.accessConditions ?? null,
    language: r.language ?? null,
    placeDisplay: r.placeDisplay ?? null,
    imprint: r.imprint ?? null,
    parentReferenceCode: null, // not used by either builder at the row level
    repositoryId: r.repositoryId,
    isPublished: !!r.isPublished,
    legacyIds: parseLegacyIds(r.legacyIds),
    adminBiogHistory: r.adminBiogHistory ?? null,
    preferredCitation: r.preferredCitation ?? null,
    acquisitionInfo: r.acquisitionInfo ?? null,
    systemOfArrangement: r.systemOfArrangement ?? null,
    physicalCharacteristics: r.physicalCharacteristics ?? null,
  }));

  // Repository lookup for every unique repositoryId in the slice. The EAD3
  // builder uses the fonds row's repository for `<repository>` and the DC
  // builder uses each row's repository for `<dc:source>` + `<dc:rights>`.
  const repoIds = [...new Set(rows.map((r) => r.repositoryId))];
  const repos = new Map<string, EadRepository>();
  for (const repoId of repoIds) {
    const repo = await db
      .select({
        name: repositories.name,
        city: repositories.city,
        code: repositories.code,
        rightsText: repositories.rightsText,
      })
      .from(repositories)
      .where(
        and(
          eq(repositories.id, repoId),
          eq(repositories.tenantId, tenant.id)
        )
      )
      .get();
    if (repo) {
      repos.set(repoId, {
        name: repo.name,
        city: repo.city ?? "",
        code: repo.code,
        rightsText: repo.rightsText ?? null,
      });
    }
  }

  return { rows, repos };
}

/**
 * Per-element shape for `descriptions.legacy_ids`. The column is TEXT
 * with no CHECK constraint and the legacy-import tooling has
 * historically been the only writer, but a defensive shape validation
 * here costs ~5 lines and prevents
 * `<unitid localtype="undefined">undefined</unitid>` from ever
 * reaching the EAD3 emitter. Any element that fails the schema is
 * silently dropped from the result; if the result is empty,
 * `parseLegacyIds` returns null to match the builder's "absent -> no
 * legacy unitids" semantics.
 */
const LegacyIdEntrySchema = z.object({
  provider: z.string().min(1),
  id: z.union([z.string(), z.number()]),
});

const LegacyIdsArraySchema = z.array(z.unknown());

/**
 * Parse the JSON-encoded `legacy_ids` column into the structured array
 * shape `EadInput.legacyIds` declares. Returns `null` (not `[]`) on parse
 * failure or empty array to match the EAD3 builder's "absent → no legacy
 * unitids" semantics — the builder branches on the array being non-null
 * before iterating.
 *
 * Each element is Zod-validated before it reaches the EAD3 builder.
 * Malformed entries (missing provider,
 * non-scalar id, null entries, non-objects) are dropped rather than
 * type-cast through unchecked, which previously surfaced as the
 * literal string "undefined" inside `localtype` attributes and unitid
 * bodies.
 */
function parseLegacyIds(
  raw: unknown
): Array<{ provider: string; id: string | number }> | null {
  if (raw == null || raw === "") return null;

  let candidate: unknown;
  if (Array.isArray(raw)) {
    candidate = raw;
  } else if (typeof raw === "string") {
    try {
      candidate = JSON.parse(raw);
    } catch {
      return null;
    }
  } else {
    return null;
  }

  const arr = LegacyIdsArraySchema.safeParse(candidate);
  if (!arr.success || arr.data.length === 0) return null;

  const out: Array<{ provider: string; id: string | number }> = [];
  for (const entry of arr.data) {
    const parsed = LegacyIdEntrySchema.safeParse(entry);
    if (parsed.success) {
      out.push({ provider: parsed.data.provider, id: parsed.data.id });
    }
  }
  return out.length > 0 ? out : null;
}

/**
 * Export one fonds as an EAD3 finding-aid document under the tenant's
 * R2 prefix. Composes the pure-function `buildEad3()` emitter, the
 * per-standard profile registry, and the tenant-scoping
 * prerequisites already in this module.
 *
 * Profile selected from `tenant.descriptiveStandard`. R2 key:
 * `${tenant.slug}/ead/${sanitiseRefForKey(fondsCode)}.xml`.
 *
 * Memory bound: one fonds at a time (matches `exportFondsDescriptions`).
 */
export async function exportFondsEad(
  db: DrizzleD1Database<any>,
  storage: ExportStorage,
  fondsCode: string,
  tenant: ExportTenant
): Promise<{ recordCount: number; byteSize: number }> {
  const key = `${tenant.slug}/ead/${sanitiseRefForKey(fondsCode)}.xml`;

  const slice = await loadFondsForXml(db, fondsCode, tenant);
  if (!slice) {
    await storage.putObjectXml(key, "");
    return { recordCount: 0, byteSize: 0 };
  }

  const profile = getEadProfile(tenant.descriptiveStandard);
  const xml = buildEad3(slice.rows, slice.repos, profile, new Date().toISOString());

  await storage.putObjectXml(key, xml);
  return { recordCount: slice.rows.length, byteSize: xml.length };
}

/**
 * Export one fonds as a Dublin Core bulk file under the tenant's R2
 * prefix. Composes the pure-function `buildDcBulk()` emitter into the
 * publish pipeline.
 *
 * Wrapper: OAI-PMH 2.0 `<ListRecords>`. R2 key:
 * `${tenant.slug}/dc/${sanitiseRefForKey(fondsCode)}.xml`.
 *
 * Memory bound: one fonds at a time.
 */
export async function exportFondsDc(
  db: DrizzleD1Database<any>,
  storage: ExportStorage,
  fondsCode: string,
  tenant: ExportTenant
): Promise<{ recordCount: number; byteSize: number }> {
  const key = `${tenant.slug}/dc/${sanitiseRefForKey(fondsCode)}.xml`;

  const slice = await loadFondsForXml(db, fondsCode, tenant);
  if (!slice) {
    await storage.putObjectXml(key, "");
    return { recordCount: 0, byteSize: 0 };
  }

  // YYYY-MM-DD per OAI-PMH `<datestamp>` convention.
  const todayIso = new Date().toISOString().slice(0, 10);
  const xml = buildDcBulk(slice.rows, slice.repos, fondsCode, todayIso);

  await storage.putObjectXml(key, xml);
  return { recordCount: slice.rows.length, byteSize: xml.length };
}

/**
 * Export repositories.json. Builds repository_count via a lightweight
 * GROUP BY query — does NOT depend on allFormattedDescriptions being in
 * memory. Only the (small) set of root descriptions is fetched in full.
 */
export async function exportRepositories(
  db: DrizzleD1Database<any>,
  storage: ExportStorage,
  tenant: ExportTenant,
  memberTenantIds?: string[]
): Promise<{ count: number }> {
  // Federation publish (spec §9 step 8): read every member tenant's
  // repositories and description counts, but write the single
  // repositories.json under the publish (lead) slug. Omitted →
  // single-tenant own-publish, byte-identical to pre-step-8 behaviour.
  const tenantIds = memberTenantIds ?? [tenant.id];
  const allRepos = await db
    .select()
    .from(repositories)
    .where(
      and(
        inArray(repositories.tenantId, tenantIds),
        eq(repositories.enabled, true)
      )
    )
    .all();

  // Lightweight count: id + repositoryId + isPublished only.
  const countRows = await db
    .select({
      repositoryId: descriptions.repositoryId,
      n: sql<number>`COUNT(*)`,
    })
    .from(descriptions)
    .where(
      and(
        inArray(descriptions.tenantId, tenantIds),
        eq(descriptions.isPublished, true)
      )
    )
    .groupBy(descriptions.repositoryId)
    .all();

  const repoIdToCount = new Map(countRows.map((r) => [r.repositoryId, Number(r.n)]));
  const repoIdToCode = new Map(allRepos.map((r) => [r.id, r.code]));
  const descriptionCountByRepoCode = new Map<string, number>();
  for (const [repoId, n] of repoIdToCount) {
    const code = repoIdToCode.get(repoId);
    if (code) descriptionCountByRepoCode.set(code, n);
  }

  // Root descriptions: small set (one per fonds), safe to format in full.
  const rootRows = await db
    .select()
    .from(descriptions)
    .where(
      and(
        inArray(descriptions.tenantId, tenantIds),
        eq(descriptions.isPublished, true),
        isNull(descriptions.parentId)
      )
    )
    .all();

  const formattedRoots: ExportDescription[] = [];
  for (const row of rootRows) {
    const repo = allRepos.find((r) => r.id === row.repositoryId);
    formattedRoots.push(
      formatDescription(
        row,
        { code: repo?.code ?? "", country: repo?.country ?? null },
        null,
        []
      )
    );
  }

  const formatted = formatRepositories(
    allRepos,
    descriptionCountByRepoCode,
    formattedRoots
  );
  await storage.putObject(
    `${tenant.slug}/repositories.json`,
    JSON.stringify(formatted)
  );

  return { count: formatted.length };
}

/**
 * Export entities.json. Includes only entities linked to published
 * descriptions and not merged into another entity.
 *
 * Implementation: a single JOIN query with DISTINCT, instead of the earlier
 * two-query "collect IDs, then inArray" pattern. The old pattern blew past
 * D1's SQL variable limit (~100) once the linked-id set grew to tens of
 * thousands (SQLITE_TOOBIG at 81k IDs during Task 4 verification).
 */
export async function exportEntities(
  db: DrizzleD1Database<any>,
  storage: ExportStorage,
  tenant: ExportTenant,
  memberTenantIds?: string[]
): Promise<{ count: number }> {
  // Federation publish (spec §9 step 8): the authority set is already
  // federation-scoped (migrations 0045-0048), but which entities EXPORT
  // is driven by which are linked to PUBLISHED DESCRIPTIONS. After the
  // step-6 partition those descriptions span multiple member tenants, so
  // a lead-only join would drop entities linked solely to AHR
  // descriptions. Read across every member tenant; single value →
  // pre-step-8 behaviour.
  const tenantIds = memberTenantIds ?? [tenant.id];
  const entityRows = await db
    .selectDistinct({
      id: entities.id,
      entityCode: entities.entityCode,
      displayName: entities.displayName,
      sortName: entities.sortName,
      givenName: entities.givenName,
      surname: entities.surname,
      entityType: entities.entityType,
      honorific: entities.honorific,
      primaryFunction: entities.primaryFunction,
      primaryFunctionId: entities.primaryFunctionId,
      nameVariants: entities.nameVariants,
      datesOfExistence: entities.datesOfExistence,
      dateStart: entities.dateStart,
      dateEnd: entities.dateEnd,
      history: entities.history,
      // legal_status dropped in 0036 (0% populated); formatter emits null.
      functions: entities.functions,
      sources: entities.sources,
      wikidataId: entities.wikidataId,
      viafId: entities.viafId,
      mergedInto: entities.mergedInto,
    })
    .from(entities)
    .innerJoin(
      descriptionEntities,
      eq(descriptionEntities.entityId, entities.id)
    )
    .innerJoin(
      descriptions,
      eq(descriptionEntities.descriptionId, descriptions.id)
    )
    .where(
      and(
        // Authorities are federation-scoped (migrations 0045-0048); the export
        // reads the federation's member tenants' published descriptions joined
        // to the federation's entities. I4 guarantees each description's
        // tenant's federation equals the entity's federation.
        eq(entities.federationId, tenant.federationId),
        inArray(descriptions.tenantId, tenantIds),
        eq(descriptions.isPublished, true),
        isNull(entities.mergedInto)
      )
    )
    .all();

  // Resolve vocabulary term canonical names in a separate query to avoid
  // selectDistinct + leftJoin chain incompatibility in D1's Drizzle adapter
  const termIds = [...new Set(entityRows.map((r) => r.primaryFunctionId).filter(Boolean))] as string[];
  const termMap = new Map<string, string>();
  if (termIds.length > 0) {
    const terms = await db
      .select({ id: vocabularyTerms.id, canonical: vocabularyTerms.canonical })
      .from(vocabularyTerms)
      .where(inArray(vocabularyTerms.id, termIds))
      .all();
    for (const t of terms) termMap.set(t.id, t.canonical);
  }

  if (entityRows.length === 0) {
    await storage.putObject(`${tenant.slug}/entities.json`, "[]");
    return { count: 0 };
  }

  const formatted = entityRows.map((row) =>
    formatEntity({
      ...row,
      primaryFunctionCanonical: row.primaryFunctionId
        ? termMap.get(row.primaryFunctionId) ?? null
        : null,
    })
  );
  await storage.putObject(
    `${tenant.slug}/entities.json`,
    JSON.stringify(formatted)
  );
  return { count: formatted.length };
}

/**
 * Export places.json. Includes only places linked to published descriptions
 * and not merged into another place.
 *
 * Same JOIN-based implementation as exportEntities — see the comment there
 * for the SQLITE_TOOBIG rationale.
 */
export async function exportPlaces(
  db: DrizzleD1Database<any>,
  storage: ExportStorage,
  tenant: ExportTenant,
  memberTenantIds?: string[]
): Promise<{ count: number }> {
  // Federation publish (spec §9 step 8): same rationale as exportEntities
  // — read across every member tenant's published descriptions so places
  // linked solely to AHR descriptions are not dropped. Single value →
  // pre-step-8 behaviour.
  const tenantIds = memberTenantIds ?? [tenant.id];
  const placeRows = await db
    .selectDistinct({
      id: places.id,
      placeCode: places.placeCode,
      label: places.label,
      displayName: places.displayName,
      placeType: places.placeType,
      // fclass: 5-value GeoNames feature class (added in 0036).
      fclass: places.fclass,
      nameVariants: places.nameVariants,
      latitude: places.latitude,
      longitude: places.longitude,
      coordinatePrecision: places.coordinatePrecision,
      // historical_*, country_code, admin_level_*, wikidata_id all
      // dropped in 0036 (0% populated); the formatter emits literal
      // null for these fields to keep the export shape stable.
      tgnId: places.tgnId,
      hgisId: places.hgisId,
      whgId: places.whgId,
      mergedInto: places.mergedInto,
    })
    .from(places)
    .innerJoin(
      descriptionPlaces,
      eq(descriptionPlaces.placeId, places.id)
    )
    .innerJoin(
      descriptions,
      eq(descriptionPlaces.descriptionId, descriptions.id)
    )
    .where(
      and(
        // Federation-scoped authorities (migrations 0045-0048), joined to the
        // member tenants' published descriptions (I4 keeps the federations
        // aligned).
        eq(places.federationId, tenant.federationId),
        inArray(descriptions.tenantId, tenantIds),
        eq(descriptions.isPublished, true),
        isNull(places.mergedInto)
      )
    )
    .all();

  if (placeRows.length === 0) {
    await storage.putObject(`${tenant.slug}/places.json`, "[]");
    return { count: 0 };
  }

  const formatted = placeRows.map(formatPlace);
  await storage.putObject(
    `${tenant.slug}/places.json`,
    JSON.stringify(formatted)
  );
  return { count: formatted.length };
}

/**
 * Heartbeat helpers — write the new export_runs columns from migration 0019
 * so the operator can watch a long publish run advance through its steps.
 */
export async function recordStepStart(
  db: DrizzleD1Database<any>,
  exportId: string,
  stepName: string
): Promise<void> {
  const now = Date.now();
  await db
    .update(exportRuns)
    .set({
      currentStep: stepName,
      currentStepStartedAt: now,
      currentStepCompletedAt: null,
      lastHeartbeatAt: now,
    })
    .where(eq(exportRuns.id, exportId));
}

export async function recordStepEnd(
  db: DrizzleD1Database<any>,
  exportId: string,
  stepName: string,
  counts: Record<string, number>
): Promise<void> {
  const now = Date.now();
  await db
    .update(exportRuns)
    .set({
      currentStep: stepName,
      currentStepCompletedAt: now,
      lastHeartbeatAt: now,
      stepsCompleted: sql`${exportRuns.stepsCompleted} + 1`,
      recordCounts: JSON.stringify(counts),
    })
    .where(eq(exportRuns.id, exportId));
}
