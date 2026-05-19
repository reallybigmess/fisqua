/**
 * Scripts — entities importer
 *
 * This module deals with the row builder for the production import of
 * `entities` from the Django catalogue dump. The COLUMNS array tracks
 * the v0.4 union schema:
 *
 *   - tenant_id is mandatory at column position 2
 *     (NEOGRANADINA_TENANT_ID)
 *   - primary_function_id (vocabulary FK) imports as NULL — the
 *     Django dump does not carry vocabulary-term IDs
 *   - legal_status is dropped (0% populated in audit; gone in
 *     drizzle/0036)
 *   - dbe_id is sourced from Django (75 records have it)
 *   - legacy_ids JSON is built via buildLegacyIdsForEntity (one
 *     `django-zasqua` entry from the Django pk plus optional
 *     `ca-entity` entry from `ca_entity_id`); validated through
 *     LegacyIdsSchema.parse before stringify
 *   - ne-xxxxxx codes are deterministic across rounds: SHA-256 of
 *     `${prefix}:${djangoPk}` mapped through ALPHABET. Collisions
 *     inside a single batch fall back to `generateUniqueCodes` — at
 *     production row counts (~78K) the fallback rate is ~0.4%.
 *
 * @version v0.4.0
 */
import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import type { IdMap, ImportResult } from "../lib/types";
import { escapeSql, generateInserts, writeSqlFiles } from "../lib/sql";
import { generateUniqueCodes, deterministicCode } from "../lib/codes";
import { toEpochSeconds, stringifyJsonArray, buildLegacyIdsForEntity } from "../lib/transform";
import { NEOGRANADINA_TENANT_ID } from "../../app/lib/tenant";

const COLUMNS = [
  "id", "tenant_id",
  "entity_code", "display_name", "sort_name", "surname", "given_name",
  "entity_type", "honorific", "primary_function", "primary_function_id",
  "name_variants", "dates_of_existence", "date_start", "date_end",
  "history", "functions", "sources", "merged_into",
  "wikidata_id", "viaf_id",
  "dbe_id", "legacy_ids",
  "created_at", "updated_at",
];

/**
 * Import entities from a JSON export file.
 * Generates UUIDs and deterministic ne-xxxxxx codes (with collision
 * fallback) for each record, resolves merged_into FKs, and produces
 * chunked SQL INSERT files.
 */
export async function importEntities(
  inputPath: string
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
    const c = deterministicCode("ne", rec.id as number);
    if (codeSet.has(c)) {
      codeFallbackNeeded.push(i);
      codes[i] = ""; // placeholder — filled below
    } else {
      codeSet.add(c);
      codes[i] = c;
    }
  }
  if (codeFallbackNeeded.length > 0) {
    // Fall back to fresh-uniqueness for the rare collisions.
    let fallbackCodes = generateUniqueCodes("ne", codeFallbackNeeded.length * 2)
      .filter((c) => !codeSet.has(c));
    // Defensive top-up if filtering eliminated too many candidates.
    while (fallbackCodes.length < codeFallbackNeeded.length) {
      const more = generateUniqueCodes("ne", codeFallbackNeeded.length * 2)
        .filter((c) => !codeSet.has(c) && !fallbackCodes.includes(c));
      fallbackCodes = fallbackCodes.concat(more);
    }
    for (const idx of codeFallbackNeeded) {
      const c = fallbackCodes.shift()!;
      codes[idx] = c;
      codeSet.add(c);
    }
  }

  // Pass 2: build idMap so merged_into resolution can find every row.
  const processed: Array<{
    record: Record<string, unknown>;
    newId: string;
    code: string;
    index: number;
  }> = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const oldId = record.id as number;
    const newId = crypto.randomUUID();
    idMap.set(oldId, newId);
    processed.push({ record, newId, code: codes[i], index: i });
  }

  // Pass 3: resolve merged_into and build SQL rows
  const rows: string[][] = [];

  for (const { record, newId, code, index } of processed) {
    const oldId = record.id as number;
    const createdAt = toEpochSeconds(record.created_at as string | null);
    const updatedAt = toEpochSeconds(record.updated_at as string | null);

    if (createdAt === null || updatedAt === null) {
      errors.push({
        table: "entities",
        row: index,
        oldId,
        errors: ["Missing created_at or updated_at timestamp"],
      });
      idMap.delete(oldId);
      skippedPks.add(oldId);
      continue;
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
          `Warning: Entity ${oldId} merged_into references unknown ID ${mergedIntoOldId}`
        );
      }
    }

    // legacy_ids: validated through LegacyIdsSchema.parse inside the
    // helper; a malformed seed throws and the row soft-skips here.
    let legacyIdsJson: string;
    try {
      legacyIdsJson = buildLegacyIdsForEntity(record);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      errors.push({
        table: "entities",
        row: index,
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
      escapeSql(code),
      escapeSql(record.display_name),
      escapeSql(record.sort_name),
      escapeSql(record.surname ?? null),
      escapeSql(record.given_name ?? null),
      escapeSql(record.entity_type),
      escapeSql(record.honorific ?? null),
      escapeSql(record.primary_function ?? null),
      // primary_function_id — vocabulary FK not populated from Django dump.
      escapeSql(null),
      escapeSql(stringifyJsonArray(record.name_variants)),
      escapeSql(record.dates_of_existence ?? null),
      escapeSql(record.date_start ?? null),
      escapeSql(record.date_end ?? null),
      escapeSql(record.history ?? null),
      // legal_status REMOVED in drizzle/0036.
      escapeSql(record.functions ?? null),
      escapeSql(record.sources ?? null),
      escapeSql(mergedInto),
      escapeSql(record.wikidata_id ?? null),
      escapeSql(record.viaf_id ?? null),
      escapeSql((record.dbe_id as string | null) ?? null),
      escapeSql(legacyIdsJson),
      escapeSql(createdAt),
      escapeSql(updatedAt),
    ]);
  }

  const statements = generateInserts("entities", COLUMNS, rows, 100);
  const sqlFiles = await writeSqlFiles("entities", statements);

  return {
    result: {
      table: "entities",
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
