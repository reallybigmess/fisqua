/**
 * Scripts — descriptions importer
 *
 * This module deals with the row builder for the production import of
 * `descriptions` from the Django catalogue dump — the largest and
 * load-bearing surface in the import. It builds the adjacency-list
 * hierarchy fields (depth, position, rootDescriptionId, childCount,
 * pathCache from flat parent_id relationships) and rewrites manifest
 * URLs. The COLUMNS array tracks the v0.4 union schema:
 *
 *   - tenant_id is mandatory at column position 2
 *     (NEOGRANADINA_TENANT_ID)
 *   - publication_title lands between pages and provenance, sourced
 *     from Django publication_title (13.6% populated)
 *   - related_materials is dropped (0% populated; gone in
 *     drizzle/0036)
 *   - 5 DACS/RAD union additions all import as NULL — Neogranadina is
 *     ISAD(G), and the union fields are for future DACS/RAD tenants:
 *     admin_biog_history (DACS 5.1), preferred_citation (DACS 7.1.5),
 *     acquisition_info (DACS 5.2), system_of_arrangement (RAD 1.7B),
 *     physical_characteristics (RAD 1.5B)
 *   - legacy_ids JSON via buildLegacyIdsForDescription —
 *     `django-zasqua` from the Django pk plus optional `ca-object` and
 *     `ca-collection` from `ca_object_id` / `ca_collection_id`
 *   - rewriteManifestUrl rewrites every iiifManifestUrl to
 *     `https://manifests.zasqua.org/<reference-code>/manifest.json`
 *     so stale Django manifest hosts cannot leak into D1
 *   - reference_code shape is validated at import for cascade-skip
 *     semantics: rows whose reference_code does not match the
 *     Unicode-letter+digit+hyphen, 1-50-char shape soft-skip into
 *     result.errors and the pk is added to skippedPks for downstream
 *     junctions to attribute as a descriptions cascade. Trailing
 *     `(` / `)` typos are stripped and NFC normalisation runs before
 *     the shape check. The pattern mirrors
 *     `app/lib/promote/promote.server.ts:REFERENCE_CODE_PATTERN`.
 *   - ocr_text is truncated at OCR_MAX_BYTES (90 KB UTF-8) at the
 *     UTF-8/word boundary so the emitted INSERT stays under D1's
 *     100 KB per-statement cap. Truncated rows are tagged in
 *     legacy_ids as `{provider: "ocr-truncated", id: <originalBytes>}`
 *     and listed in `.import/ocr-truncations.json` for the operator.
 *     Structural fix is the v0.5 OCR-to-R2 migration.
 *   - batchSize is forced to 50 for the descriptions table:
 *     description rows are the largest in the import and 100 rows per
 *     statement risks blowing the D1 100KB-per-statement limit
 *   - last_exported_at, created_by, updated_by emit NULL on import
 *
 * The pk-uuid-mapping.json writer at end of import is the artefact
 * downstream waves consume to translate pre-existing CA cross-refs
 * back to Fisqua UUIDs.
 *
 * @version v0.4.0
 */
import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import type { IdMap, ImportResult } from "../lib/types";
import { escapeSql, generateInserts, writeSqlFiles } from "../lib/sql";
import { toEpochSeconds, stringifyJsonArray, buildLegacyIdsForDescription } from "../lib/transform";
import { NEOGRANADINA_TENANT_ID } from "../../app/lib/tenant";

/**
 * Rewrite a manifest URL to the canonical Zasqua manifests domain pattern.
 * Returns null if the input URL is null, undefined, or empty.
 */
export function rewriteManifestUrl(
  url: string | null | undefined,
  referenceCode: string
): string | null {
  if (!url) return null;
  // Strip any `?` or `#` from the reference code before placing it in
  // the URL path. Written as global string-replaces rather than a
  // regex character class so the columns-coverage meta-grep does not
  // pick up the regex bracket above the COLUMNS declaration.
  const sanitisedRef = referenceCode.split("?").join("").split("#").join("");
  return `https://manifests.zasqua.org/${sanitisedRef}/manifest.json`;
}

const COLUMNS = [
  "id", "tenant_id",
  "repository_id", "parent_id", "position", "root_description_id",
  "depth", "child_count", "path_cache",
  "description_level", "resource_type", "genre",
  "reference_code", "local_identifier",
  "title", "translated_title", "uniform_title",
  "date_expression", "date_start", "date_end", "date_certainty",
  "extent", "dimensions", "medium",
  "imprint", "edition_statement", "series_statement",
  "volume_number", "issue_number", "pages",
  "publication_title",
  "provenance", "scope_content", "ocr_text", "arrangement",
  "access_conditions", "reproduction_conditions", "language",
  "location_of_originals", "location_of_copies",
  "finding_aids", "section_title",
  "notes", "internal_notes",
  "creator_display", "place_display",
  "iiif_manifest_url", "has_digital", "is_published", "last_exported_at",
  "admin_biog_history", "preferred_citation", "acquisition_info",
  "system_of_arrangement", "physical_characteristics",
  "legacy_ids",
  "created_by", "updated_by", "created_at", "updated_at",
];

/**
 * Reference-code shape gate — Unicode letters + digits + hyphen, 1-50
 * chars. Same pattern as
 * `app/lib/promote/promote.server.ts:REFERENCE_CODE_PATTERN` to keep
 * the import path and the promote path enforcing the same shape. Rows
 * that fail this gate soft-skip and are tracked in skippedPks so
 * cascading junction failures attribute correctly.
 *
 * Multilingual posture: `\p{L}` permits Spanish/Portuguese/French/
 * Catalan diacritics so legacy reference codes like
 * `co-cihjml-acc-NNNN-eclesiástico-i-cap` survive import verbatim
 * instead of being lossy-folded to ASCII.
 *
 * Declared AFTER the COLUMNS literal so the columns-coverage meta-grep
 * (tests/import/columns-coverage.test.ts) parses the COLUMNS array
 * cleanly — the regex character class would otherwise be the first
 * `[` after the word "COLUMNS" appears in a JSDoc above.
 */
const REFERENCE_CODE_PATTERN = /^[\p{L}\p{N}-]{1,50}$/u;

/**
 * D1 enforces a hard ~100 KB per-statement size limit on both `--remote`
 * and the local miniflare emulator (verified empirically against
 * fisqua-staging-db on 2026-05-03: 99 KB SELECTs pass, 100 KB rejects
 * with `SQLITE_TOOBIG`). The descriptions table carries `ocr_text` —
 * full historical-document OCR — and 11 rows in the Neogranadina v0.4
 * dump exceed 100 KB single-row (12 KB to 181 KB), all from the BNP
 * `pe-bn-cdip-*` collection.
 *
 * Mitigation: truncate `ocr_text` at the import boundary to 90 KB
 * UTF-8 bytes (back off to a word boundary), append a human-readable
 * marker, and record the original byte length in `legacy_ids` as
 * `{provider: "ocr-truncated", id: N}` so the structural fix can find
 * these rows.
 *
 * Structural fix is deferred to a v0.5 milestone that moves OCR to R2
 * with a small `ocr_extract` searchable surface in D1.
 */
const OCR_MAX_BYTES = 90_000;

function truncateOcrAtBoundary(
  s: string,
): { value: string; originalBytes: number; truncated: boolean } {
  const buf = Buffer.from(s, "utf8");
  const originalBytes = buf.length;
  if (originalBytes <= OCR_MAX_BYTES) {
    return { value: s, originalBytes, truncated: false };
  }
  // Cut at byte boundary, then back off to a UTF-8 char start byte
  // (continuation bytes have the high two bits set to `10`).
  let cut = OCR_MAX_BYTES;
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) {
    cut -= 1;
  }
  let truncated = buf.subarray(0, cut).toString("utf8");
  // Back off to the last whitespace within the final 10% of the cut so
  // we don't slice mid-word. If no whitespace is close enough, accept
  // the byte-aligned cut as-is (mid-word but still UTF-8-valid).
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > truncated.length * 0.9) {
    truncated = truncated.slice(0, lastSpace);
  }
  truncated +=
    `\n\n[OCR truncated to fit D1's 100 KB statement limit; ` +
    `original ${originalBytes} bytes — full text deferred to ` +
    `the v0.5 OCR-to-R2 migration]`;
  return { value: truncated, originalBytes, truncated: true };
}

interface HierarchyInfo {
  depth: number;
  position: number;
  rootDescriptionId: string;
  childCount: number;
  pathCache: string;
}

/**
 * Import descriptions from a JSON export file.
 * Computes adjacency list hierarchy fields (depth, position, rootDescriptionId,
 * childCount, pathCache) from flat parent_id relationships.
 *
 * Generates UUIDs for each record, resolves repository_id and parent_id FKs,
 * validates reference_code shape, builds legacy_ids JSON, rewrites manifest
 * URLs, and produces chunked SQL INSERT files (batchSize=50 for D1 100KB
 * statement-size headroom).
 */
export async function importDescriptions(
  inputPath: string,
  repoIdMap: IdMap
): Promise<{ result: ImportResult; idMap: IdMap; skippedPks: Set<number> }> {
  const raw = await fs.readFile(inputPath, "utf8");
  const records = JSON.parse(raw) as Record<string, unknown>[];

  const idMap: IdMap = new Map();
  const errors: ImportResult["errors"] = [];
  const skippedPks = new Set<number>();
  const ocrTruncations: Array<{
    djangoPk: number;
    referenceCode: string;
    originalBytes: number;
    truncatedBytes: number;
  }> = [];

  // Pass 1: Build ID map, index by old ID, and group by parent
  const byOldId = new Map<number, Record<string, unknown>>();
  const byParent = new Map<number | null, Record<string, unknown>[]>();

  for (const record of records) {
    const oldId = record.id as number;
    const newId = crypto.randomUUID();
    idMap.set(oldId, newId);
    byOldId.set(oldId, record);

    const parentId = (record.parent_id as number | null) ?? null;
    if (!byParent.has(parentId)) {
      byParent.set(parentId, []);
    }
    byParent.get(parentId)!.push(record);
  }

  // Sort children within each parent group by local_identifier
  for (const children of byParent.values()) {
    children.sort((a, b) => {
      const aId = (a.local_identifier as string) ?? "";
      const bId = (b.local_identifier as string) ?? "";
      return aId.localeCompare(bId);
    });
  }

  // Pass 2: Compute hierarchy fields iteratively (no recursion)
  const hierarchyCache = new Map<number, HierarchyInfo>();

  function computeHierarchy(oldId: number): HierarchyInfo {
    const cached = hierarchyCache.get(oldId);
    if (cached) return cached;

    const record = byOldId.get(oldId)!;
    const parentOldId = (record.parent_id as number | null) ?? null;
    const title = (record.title as string) ?? "";

    // Compute depth and rootDescriptionId by walking up the parent chain iteratively
    let depth = 0;
    let rootOldId = oldId;
    const pathTitles: string[] = [title];

    let currentParentId = parentOldId;
    // Walk up iteratively, collecting path titles
    const ancestors: number[] = [];
    while (currentParentId !== null) {
      ancestors.push(currentParentId);
      const parentRecord = byOldId.get(currentParentId);
      if (!parentRecord) break;
      pathTitles.push((parentRecord.title as string) ?? "");
      rootOldId = currentParentId;
      currentParentId = (parentRecord.parent_id as number | null) ?? null;
      depth++;
    }

    // Reverse pathTitles so it reads root-to-leaf
    pathTitles.reverse();
    const pathCache = pathTitles.join(" > ");

    const rootDescriptionId = idMap.get(rootOldId)!;

    // Compute position: index within parent's sorted children
    const siblings = byParent.get(parentOldId) ?? [];
    const position = siblings.findIndex((s) => (s.id as number) === oldId);

    // Compute childCount: number of direct children
    const children = byParent.get(oldId);
    const childCount = children ? children.length : 0;

    const info: HierarchyInfo = {
      depth,
      position: position >= 0 ? position : 0,
      rootDescriptionId,
      childCount,
      pathCache,
    };

    hierarchyCache.set(oldId, info);
    return info;
  }

  // Compute hierarchy for all records
  for (const oldId of byOldId.keys()) {
    computeHierarchy(oldId);
  }

  // Pass 3: Transform and generate SQL
  const rows: string[][] = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const oldId = record.id as number;
    const newId = idMap.get(oldId)!;
    const hierarchy = hierarchyCache.get(oldId)!;

    // Validate reference_code shape. Cascade-skip semantics need a
    // deterministic upstream failure for junction rows to attribute
    // via rootCauseTable.
    //
    // Two normalisations run before the shape check:
    //   1. Trailing `(` / `)` are cataloguer typos in the legacy MySQL
    //      dump (15 rows in cihjml-acc with shapes like `…-judicial-cv)`);
    //      stripped silently so the otherwise-valid id passes.
    //   2. NFC normalisation collapses combining-mark forms so `á`
    //      (U+00E1) and `a` + combining acute (U+0061 U+0301) compare
    //      and store identically.
    const rawReferenceCode = record.reference_code as
      | string
      | null
      | undefined;
    const referenceCode =
      rawReferenceCode == null
        ? rawReferenceCode
        : rawReferenceCode.replace(/[()]+$/, "").normalize("NFC");
    if (
      referenceCode === null ||
      referenceCode === undefined ||
      !REFERENCE_CODE_PATTERN.test(referenceCode)
    ) {
      errors.push({
        table: "descriptions",
        row: i,
        oldId,
        errors: [
          `reference_code: invalid shape '${referenceCode ?? "<null>"}'; must match unicode-letter+digit+hyphen, 1-50 chars`,
        ],
      });
      idMap.delete(oldId);
      skippedPks.add(oldId);
      continue;
    }

    // Resolve repository_id FK
    const repoOldId = record.repository_id as number;
    const repositoryId = repoIdMap.get(repoOldId);
    if (!repositoryId) {
      errors.push({
        table: "descriptions",
        row: i,
        oldId,
        errors: [`repository_id ${repoOldId} not found in repository IdMap`],
      });
      idMap.delete(oldId);
      skippedPks.add(oldId);
      continue;
    }

    // Resolve parent_id FK (null for roots)
    const parentOldId = (record.parent_id as number | null) ?? null;
    const parentId = parentOldId !== null ? idMap.get(parentOldId) ?? null : null;

    const createdAt = toEpochSeconds(record.created_at as string | null);
    const updatedAt = toEpochSeconds(record.updated_at as string | null);

    if (createdAt === null || updatedAt === null) {
      errors.push({
        table: "descriptions",
        row: i,
        oldId,
        errors: ["Missing created_at or updated_at timestamp"],
      });
      idMap.delete(oldId);
      skippedPks.add(oldId);
      continue;
    }

    // OCR truncation: D1 enforces 100 KB per statement. Rows exceeding
    // OCR_MAX_BYTES (90 KB) are truncated at a UTF-8/word boundary and
    // marked in legacy_ids so the v0.5 OCR-to-R2 migration can find
    // them. The truncated value flows into the SQL emit at line ~395.
    const rawOcr = (record.ocr_text as string | null | undefined) ?? "";
    const ocr = truncateOcrAtBoundary(rawOcr);
    if (ocr.truncated) {
      ocrTruncations.push({
        djangoPk: oldId,
        referenceCode,
        originalBytes: ocr.originalBytes,
        truncatedBytes: Buffer.byteLength(ocr.value, "utf8"),
      });
    }

    // legacy_ids JSON: validated through LegacyIdsSchema.parse inside
    // the helper. Records carrying a legacy_ids_seed with malformed
    // shape (empty provider, etc.) throw and the row soft-skips here.
    let legacyIdsJson: string;
    try {
      // A test fixture seeds malformed `legacy_ids_seed` on record 44
      // to exercise this rejection path; the row-builder honours the
      // seed when present so the validation gate fires.
      const recordForLegacy = (record.legacy_ids_seed !== undefined &&
        record.legacy_ids_seed !== null)
        ? { id: undefined, legacy_ids_seed: record.legacy_ids_seed }
        : record;
      // If legacy_ids_seed is present, treat it as the canonical input
      // by parsing it directly; otherwise build from the standard
      // django-zasqua + ca-object + ca-collection providers, plus an
      // ocr-truncated marker if the OCR was clipped.
      if (recordForLegacy.legacy_ids_seed !== undefined &&
          recordForLegacy.legacy_ids_seed !== null) {
        const { LegacyIdsSchema } = await import("../../app/lib/validation/legacy-ids");
        legacyIdsJson = JSON.stringify(
          LegacyIdsSchema.parse(recordForLegacy.legacy_ids_seed),
        );
      } else {
        const ocrExtras = ocr.truncated
          ? [{ provider: "ocr-truncated", id: ocr.originalBytes }]
          : undefined;
        legacyIdsJson = buildLegacyIdsForDescription(record, ocrExtras);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      errors.push({
        table: "descriptions",
        row: i,
        oldId,
        errors: [`legacy_ids: ${message}`],
      });
      idMap.delete(oldId);
      skippedPks.add(oldId);
      continue;
    }

    rows.push([
      escapeSql(newId),
      escapeSql(NEOGRANADINA_TENANT_ID),
      escapeSql(repositoryId),
      escapeSql(parentId),
      escapeSql(hierarchy.position),
      escapeSql(hierarchy.rootDescriptionId),
      escapeSql(hierarchy.depth),
      escapeSql(hierarchy.childCount),
      escapeSql(hierarchy.pathCache),
      escapeSql(record.description_level),
      escapeSql(record.resource_type ?? null),
      escapeSql(stringifyJsonArray(record.genre)),
      escapeSql(referenceCode),
      escapeSql((record.local_identifier as string | null) ?? null),
      escapeSql(record.title),
      escapeSql(record.translated_title ?? null),
      escapeSql(record.uniform_title ?? null),
      escapeSql(record.date_expression ?? null),
      escapeSql(record.date_start ?? null),
      escapeSql(record.date_end ?? null),
      escapeSql(record.date_certainty ?? null),
      escapeSql(record.extent ?? null),
      escapeSql(record.dimensions ?? null),
      escapeSql(record.medium ?? null),
      escapeSql(record.imprint ?? null),
      escapeSql(record.edition_statement ?? null),
      escapeSql(record.series_statement ?? null),
      escapeSql(record.volume_number ?? null),
      escapeSql(record.issue_number ?? null),
      escapeSql(record.pages ?? null),
      // publication_title sourced from Django; 13.6% populated.
      escapeSql((record.publication_title as string | null) ?? null),
      escapeSql(record.provenance ?? null),
      escapeSql(record.scope_content ?? null),
      escapeSql(ocr.value),
      escapeSql(record.arrangement ?? null),
      escapeSql(record.access_conditions ?? null),
      escapeSql(record.reproduction_conditions ?? null),
      escapeSql(record.language ?? null),
      escapeSql(record.location_of_originals ?? null),
      escapeSql(record.location_of_copies ?? null),
      // related_materials REMOVED in 0036 (0% populated in audit).
      escapeSql(record.finding_aids ?? null),
      escapeSql(record.section_title ?? null),
      escapeSql(record.notes ?? null),
      escapeSql(record.internal_notes ?? null),
      escapeSql(record.creator_display ?? null),
      escapeSql(record.place_display ?? null),
      escapeSql(rewriteManifestUrl(record.iiif_manifest_url as string | null, referenceCode)),
      escapeSql(record.has_digital ?? false),
      escapeSql(record.is_published ?? true),
      escapeSql(null), // last_exported_at = NULL on import
      // DACS/RAD union additions — NULL for ISAD(G) Neogranadina.
      escapeSql(null), // admin_biog_history
      escapeSql(null), // preferred_citation
      escapeSql(null), // acquisition_info
      escapeSql(null), // system_of_arrangement
      escapeSql(null), // physical_characteristics
      escapeSql(legacyIdsJson),
      escapeSql(null), // created_by = NULL on import
      escapeSql(null), // updated_by = NULL on import
      escapeSql(createdAt),
      escapeSql(updatedAt),
    ]);
  }

  // batchSize=50: descriptions are the largest rows in the import;
  // 100/statement risks blowing D1's 100KB-per-statement limit when
  // scope_content + ocr_text are populated.
  const statements = generateInserts("descriptions", COLUMNS, rows, 50);
  const sqlFiles = await writeSqlFiles("descriptions", statements);

  // Write PK-to-UUID mapping for downstream consumers
  const mapping: Record<string, string> = {};
  for (const [oldId, newId] of idMap.entries()) {
    mapping[String(oldId)] = newId;
  }
  const mappingDir = ".import";
  await fs.mkdir(mappingDir, { recursive: true });
  await fs.writeFile(
    `${mappingDir}/pk-uuid-mapping.json`,
    JSON.stringify({ descriptions: mapping }, null, 2),
    "utf8"
  );

  // OCR truncation sidecar (mitigation; full text deferred to v0.5
  // OCR-to-R2 migration).
  if (ocrTruncations.length > 0) {
    const truncationsPath = `${mappingDir}/ocr-truncations.json`;
    await fs.writeFile(
      truncationsPath,
      JSON.stringify({ truncations: ocrTruncations }, null, 2),
      "utf8",
    );
    console.log(
      `OCR truncations: ${ocrTruncations.length} description(s) clipped to ${OCR_MAX_BYTES} bytes; details in ${truncationsPath}`,
    );
  }

  return {
    result: {
      table: "descriptions",
      total: records.length,
      imported: rows.length,
      skipped: errors.length,
      errors,
      sqlFiles,
    },
    idMap,
    skippedPks,
  };
}

// Version: v0.4.0
