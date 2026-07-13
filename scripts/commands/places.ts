/**
 * Scripts — places importer
 *
 * This module deals with the row builder for the production import of
 * `places` from the Django catalogue dump. The COLUMNS array tracks
 * the v0.4 union schema:
 *
 *   - federation_id is mandatory at column position 2
 *     (NEOGRANADINA_FEDERATION_ID) — places are federation-scoped
 *     after migrations 0045-0048
 *   - 7 columns are dropped (0% populated in audit; gone in
 *     drizzle/0036): historical_gobernacion, historical_partido,
 *     historical_region, country_code, admin_level_1, admin_level_2,
 *     wikidata_id. Earlier colonial_*-renaming logic is also removed
 *     since the historical_* targets no longer exist.
 *   - fclass is added — 5-value GeoNames feature class (P/H/A/T/S),
 *     CHECK-enforced. 100% populated in Django.
 *   - legacy_ids JSON is built via buildLegacyIdsForPlace (one
 *     `django-zasqua` entry from the Django pk plus one `ca-place`
 *     entry per element of `ca_place_ids`); `ca_place_ids` is a JSON
 *     array because multiple CA places can collapse to one Fisqua
 *     place via merge.
 *   - nl-xxxxxx codes are deterministic across rounds, with collision
 *     fallback to `generateUniqueCodes` (~0.4% rate at production row
 *     counts).
 *   - parent_id and merged_into FK resolution kept verbatim.
 *
 * @version v0.4.3
 */
import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import type { IdMap, ImportResult } from "../lib/types";
import { escapeSql, generateInserts, writeSqlFiles } from "../lib/sql";
import { generateUniqueCodes, deterministicCode } from "../lib/codes";
import { toEpochSeconds, stringifyJsonArray, buildLegacyIdsForPlace } from "../lib/transform";
import { NEOGRANADINA_FEDERATION_ID } from "../../app/lib/tenant";

const COLUMNS = [
  "id", "federation_id",
  "place_code", "label", "display_name", "place_type", "name_variants",
  "parent_id", "latitude", "longitude", "coordinate_precision",
  // needs_geocoding dropped in 0060 — coordinate status is derived.
  "merged_into",
  "tgn_id", "hgis_id", "whg_id",
  "fclass", "legacy_ids",
  "notes", "internal_notes",
  "created_at", "updated_at",
];

/**
 * Import places from a JSON export file.
 * Two-pass approach: first generate all UUIDs, then resolve parent_id
 * and merged_into FKs. nl-xxxxxx codes are deterministic per Django pk
 * with collision fallback to fresh-uniqueness. SQL is written under
 * `outputDir` (default `.import/`, the production CLI's unchanged
 * root; tests pass a per-suite temp dir).
 */
export async function importPlaces(
  inputPath: string,
  outputDir = ".import"
): Promise<{ result: ImportResult; idMap: IdMap; skippedPks: Set<number> }> {
  const raw = await fs.readFile(inputPath, "utf8");
  const records = JSON.parse(raw) as Record<string, unknown>[];

  const idMap: IdMap = new Map();
  const errors: ImportResult["errors"] = [];
  const skippedPks = new Set<number>();

  // Pass 1: deterministic codes with collision fallback.
  const codeSet = new Set<string>();
  const codeFallbackNeeded: number[] = [];
  const codes: string[] = new Array(records.length);
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const c = deterministicCode("nl", rec.id as number);
    if (codeSet.has(c)) {
      codeFallbackNeeded.push(i);
      codes[i] = "";
    } else {
      codeSet.add(c);
      codes[i] = c;
    }
  }
  if (codeFallbackNeeded.length > 0) {
    let fallbackCodes = generateUniqueCodes("nl", codeFallbackNeeded.length * 2)
      .filter((c) => !codeSet.has(c));
    while (fallbackCodes.length < codeFallbackNeeded.length) {
      const more = generateUniqueCodes("nl", codeFallbackNeeded.length * 2)
        .filter((c) => !codeSet.has(c) && !fallbackCodes.includes(c));
      fallbackCodes = fallbackCodes.concat(more);
    }
    for (const idx of codeFallbackNeeded) {
      const c = fallbackCodes.shift()!;
      codes[idx] = c;
      codeSet.add(c);
    }
  }

  // Pass 2: build idMap so parent/merged FK resolution can find every row.
  for (let i = 0; i < records.length; i++) {
    const oldId = records[i].id as number;
    const newId = crypto.randomUUID();
    idMap.set(oldId, newId);
  }

  // Pass 3: Resolve FKs and build SQL rows
  const rows: string[][] = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const oldId = record.id as number;
    const newId = idMap.get(oldId)!;

    const createdAt = toEpochSeconds(record.created_at as string | null);
    const updatedAt = toEpochSeconds(record.updated_at as string | null);

    if (createdAt === null || updatedAt === null) {
      errors.push({
        table: "places",
        row: i,
        oldId,
        errors: ["Missing created_at or updated_at timestamp"],
      });
      idMap.delete(oldId);
      skippedPks.add(oldId);
      continue;
    }

    // Resolve parent_id FK
    let parentId: string | null = null;
    const parentOldId = record.parent_id as number | null;
    if (parentOldId !== null && parentOldId !== undefined) {
      const resolved = idMap.get(parentOldId);
      if (resolved) {
        parentId = resolved;
      } else {
        console.warn(
          `Warning: Place ${oldId} parent_id references unknown ID ${parentOldId}`
        );
      }
    }

    // Resolve merged_into FK
    let mergedInto: string | null = null;
    const mergedIntoOldId = record.merged_into as number | null;
    if (mergedIntoOldId !== null && mergedIntoOldId !== undefined) {
      const resolved = idMap.get(mergedIntoOldId);
      if (resolved) {
        mergedInto = resolved;
      } else {
        console.warn(
          `Warning: Place ${oldId} merged_into references unknown ID ${mergedIntoOldId}`
        );
      }
    }

    // legacy_ids: validated through LegacyIdsSchema.parse inside the
    // helper; a malformed seed throws and the row soft-skips here.
    let legacyIdsJson: string;
    try {
      legacyIdsJson = buildLegacyIdsForPlace(record);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      errors.push({
        table: "places",
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
      escapeSql(NEOGRANADINA_FEDERATION_ID),
      escapeSql(codes[i]),
      escapeSql(record.label),
      escapeSql(record.display_name),
      escapeSql(record.place_type ?? null),
      escapeSql(stringifyJsonArray(record.name_variants)),
      escapeSql(parentId),
      escapeSql(record.latitude ?? null),
      escapeSql(record.longitude ?? null),
      escapeSql(record.coordinate_precision ?? null),
      // 7 dropped columns absent from row body (drizzle/0036):
      // historical_*, country_code, admin_level_*, wikidata_id.
      // needs_geocoding dropped in 0060 — coordinate status is derived.
      escapeSql(mergedInto),
      escapeSql(record.tgn_id ?? null),
      escapeSql(record.hgis_id ?? null),
      escapeSql(record.whg_id ?? null),
      escapeSql((record.fclass as string | null) ?? null),
      escapeSql(legacyIdsJson),
      escapeSql((record.notes as string | null) ?? null),
      escapeSql((record.internal_notes as string | null) ?? null),
      escapeSql(createdAt),
      escapeSql(updatedAt),
    ]);
  }

  const statements = generateInserts("places", COLUMNS, rows, 100);
  const sqlFiles = await writeSqlFiles("places", statements, 50, outputDir);

  return {
    result: {
      table: "places",
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

// Version: v0.4.2
