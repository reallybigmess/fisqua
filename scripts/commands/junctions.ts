/**
 * Scripts — junctions importer
 *
 * This module deals with the row builders for `description_entities` and
 * `description_places` — the two many-to-many junctions between descriptions
 * and entities/places. Both error surfaces have two orthogonal layers:
 *
 *   1. Cascade-skip attribution. A description that soft-skips
 *      upstream produces N junction rows that fail FK resolution;
 *      without attribution, the failure log shows N+1 unrelated
 *      entries. The junction row builders accept the `skippedPks` set
 *      the upstream description / entity / place builders return, and
 *      any FK miss whose old pk is in that set gets `rootCauseTable:
 *      <table>` + `cascadedFrom: <pk>` so the operator reads it as 1
 *      root cause + N cascades.
 *
 *   2. Dual-track role mapping. Production data carries Spanish
 *      historical roles (Testigo, Albacea, Reo, Heredero, Autor)
 *      alongside the normalised English values the schema CHECK
 *      enforces. The junction row builders write BOTH `role` (mapped
 *      English from `mapRoleEntityToCanonical` /
 *      `mapRolePlaceToCanonical`) AND `role_raw` (verbatim Spanish
 *      from Django). Unmapped values soft-skip with a structured
 *      error pointing the operator at `scripts/lib/role-map.ts`.
 *
 * The DE_COLUMNS / DP_COLUMNS arrays gain `role_raw` between
 * `role_note` and the next column. Migration `0040_role_raw.sql` adds
 * the column to both junction tables (nullable text, no CHECK).
 *
 * @version v0.4.1
 */
import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import type { IdMap, ImportResult } from "../lib/types";
import { escapeSql, generateInserts, writeSqlFiles } from "../lib/sql";
import { toEpochSeconds } from "../lib/transform";
import { mapRoleEntityToCanonical, mapRolePlaceToCanonical } from "../lib/role-map";

const DE_COLUMNS = [
  "id", "description_id", "entity_id", "role", "role_note", "role_raw", "sequence",
  "honorific", "function", "name_as_recorded", "created_at",
];

const DP_COLUMNS = [
  "id", "description_id", "place_id", "role", "role_note", "role_raw", "created_at",
];

/**
 * Import description-entity junction records from a JSON export file.
 * Resolves both description_id and entity_id FKs via their respective
 * IdMaps. Missing FK references are logged as errors and the row is
 * skipped.
 *
 * Cascade-skip attribution: an FK miss on description_id is
 * structurally a cascade from the descriptions table — the parent
 * either soft-skipped upstream or never existed in the source dump.
 * Either way the failure entry carries `rootCauseTable:
 * "descriptions"` + `cascadedFrom: <old pk>`. The `descSkippedPks`
 * / `entitySkippedPks` parameters are accepted for forward-compat —
 * future revisions may distinguish "soft-skipped upstream" from
 * "missing from dump" in the failure message — but they are not
 * required for correct attribution today.
 *
 * Dual-track role: `mapRoleEntityToCanonical` returns the canonical
 * English value mapped from the raw Django string (Spanish historical
 * roles map; English passes through). Unmapped values produce a soft-
 * skip with `validationMessages` pointing to scripts/lib/role-map.ts.
 *
 * SQL is written under `outputDir` (default `.import/`, the
 * production CLI's unchanged root; tests pass a per-suite temp dir).
 */
export async function importDescriptionEntities(
  inputPath: string,
  descIdMap: IdMap,
  entityIdMap: IdMap,
  descSkippedPks: Set<number> = new Set(),
  entitySkippedPks: Set<number> = new Set(),
  outputDir = ".import",
): Promise<ImportResult> {
  // Forward-compat parameters; referenced here so unused-arg lints stay quiet.
  void descSkippedPks;
  void entitySkippedPks;
  const raw = await fs.readFile(inputPath, "utf8");
  const records = JSON.parse(raw) as Record<string, unknown>[];

  const rows: string[][] = [];
  const errors: ImportResult["errors"] = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const oldId = record.id as number;

    // Resolve description_id FK (with cascade-skip attribution).
    // An FK miss here is structurally a cascade from descriptions:
    // either the parent description was soft-skipped upstream
    // (descSkippedPks.has(...)) or it never existed in the source
    // dump. In both cases the operator wants the failure attributed
    // to the descriptions table. The skippedPks set, when supplied,
    // refines the message; absent the set we still mark the cascade.
    const descOldId = record.description_id as number;
    const descriptionId = descIdMap.get(descOldId);
    if (!descriptionId) {
      errors.push({
        table: "description_entities",
        row: i,
        oldId,
        errors: [`description_id ${descOldId} not found in description IdMap`],
        rootCauseTable: "descriptions",
        cascadedFrom: descOldId,
      });
      continue;
    }

    // Resolve entity_id FK (with cascade-skip attribution).
    const entityOldId = record.entity_id as number;
    const entityId = entityIdMap.get(entityOldId);
    if (!entityId) {
      errors.push({
        table: "description_entities",
        row: i,
        oldId,
        errors: [`entity_id ${entityOldId} not found in entity IdMap`],
        rootCauseTable: "entities",
        cascadedFrom: entityOldId,
      });
      continue;
    }

    // Dual-track role: map Spanish→English (or passthrough English);
    // unmapped values soft-skip.
    const rawRole = String(record.role ?? "");
    const { mapped, raw: roleRaw } = mapRoleEntityToCanonical(rawRole);
    if (mapped === null) {
      errors.push({
        table: "description_entities",
        row: i,
        oldId,
        errors: [
          `role: unmapped value '${rawRole}'; add to scripts/lib/role-map.ts ENTITY_ROLE_MAP`,
        ],
      });
      continue;
    }

    const createdAt =
      toEpochSeconds(record.created_at as string | null) ??
      Math.floor(Date.now() / 1000);

    const newId = crypto.randomUUID();

    rows.push([
      escapeSql(newId),
      escapeSql(descriptionId),
      escapeSql(entityId),
      escapeSql(mapped),
      escapeSql(record.role_note ?? null),
      escapeSql(roleRaw),
      escapeSql(record.sequence ?? 0),
      escapeSql(record.honorific ?? null),
      escapeSql(record.function ?? null),
      escapeSql(record.name_as_recorded ?? null),
      escapeSql(createdAt),
    ]);
  }

  const statements = generateInserts("description_entities", DE_COLUMNS, rows, 100);
  const sqlFiles = await writeSqlFiles("description_entities", statements, 50, outputDir);

  return {
    table: "description_entities",
    total: records.length,
    imported: rows.length,
    skipped: errors.length,
    errors,
    sqlFiles,
  };
}

/**
 * Import description-place junction records from a JSON export file.
 * Resolves both description_id and place_id FKs via their respective
 * IdMaps. Missing FK references are logged as errors and the row is
 * skipped.
 *
 * See `importDescriptionEntities` for cascade-skip attribution and
 * dual-track role mapping notes — the same shape applies here with
 * `mapRolePlaceToCanonical` for the smaller place-roles enum.
 *
 * SQL is written under `outputDir` (default `.import/`, the
 * production CLI's unchanged root; tests pass a per-suite temp dir).
 */
export async function importDescriptionPlaces(
  inputPath: string,
  descIdMap: IdMap,
  placeIdMap: IdMap,
  descSkippedPks: Set<number> = new Set(),
  placeSkippedPks: Set<number> = new Set(),
  outputDir = ".import",
): Promise<ImportResult> {
  // Forward-compat parameters; referenced here so unused-arg lints stay quiet.
  void descSkippedPks;
  void placeSkippedPks;
  const raw = await fs.readFile(inputPath, "utf8");
  const records = JSON.parse(raw) as Record<string, unknown>[];

  const rows: string[][] = [];
  const errors: ImportResult["errors"] = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const oldId = record.id as number;

    // Resolve description_id FK (cascade attributed to descriptions —
    // see importDescriptionEntities for the rationale).
    const descOldId = record.description_id as number;
    const descriptionId = descIdMap.get(descOldId);
    if (!descriptionId) {
      errors.push({
        table: "description_places",
        row: i,
        oldId,
        errors: [`description_id ${descOldId} not found in description IdMap`],
        rootCauseTable: "descriptions",
        cascadedFrom: descOldId,
      });
      continue;
    }

    // Resolve place_id FK (cascade attributed to places).
    const placeOldId = record.place_id as number;
    const placeId = placeIdMap.get(placeOldId);
    if (!placeId) {
      errors.push({
        table: "description_places",
        row: i,
        oldId,
        errors: [`place_id ${placeOldId} not found in place IdMap`],
        rootCauseTable: "places",
        cascadedFrom: placeOldId,
      });
      continue;
    }

    // Dual-track role: map Spanish→English (or passthrough English);
    // unmapped values soft-skip.
    const rawRole = String(record.role ?? "");
    const { mapped, raw: roleRaw } = mapRolePlaceToCanonical(rawRole);
    if (mapped === null) {
      errors.push({
        table: "description_places",
        row: i,
        oldId,
        errors: [
          `role: unmapped value '${rawRole}'; add to scripts/lib/role-map.ts PLACE_ROLE_MAP`,
        ],
      });
      continue;
    }

    const createdAt =
      toEpochSeconds(record.created_at as string | null) ??
      Math.floor(Date.now() / 1000);

    const newId = crypto.randomUUID();

    rows.push([
      escapeSql(newId),
      escapeSql(descriptionId),
      escapeSql(placeId),
      escapeSql(mapped),
      escapeSql(record.role_note ?? null),
      escapeSql(roleRaw),
      escapeSql(createdAt),
    ]);
  }

  const statements = generateInserts("description_places", DP_COLUMNS, rows, 100);
  const sqlFiles = await writeSqlFiles("description_places", statements, 50, outputDir);

  return {
    table: "description_places",
    total: records.length,
    imported: rows.length,
    skipped: errors.length,
    errors,
    sqlFiles,
  };
}

// Version: v0.4.1
