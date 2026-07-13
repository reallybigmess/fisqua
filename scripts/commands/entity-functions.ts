/**
 * Scripts — entity_functions importer
 *
 * This module deals with the row builder for the production import of
 * `entity_functions` from the Django catalogue dump.
 *
 * No column drift against the v0.4 schema; entity_functions inherits
 * tenant scoping via the entity_id FK with ON DELETE CASCADE, so it
 * does not carry tenant_id directly. The 12-col COLUMNS array matches
 * `app/db/schema.ts:entityFunctions` exactly.
 *
 * Soft-skip path: rows whose entity_id does not resolve in the entity
 * IdMap, or whose timestamps are missing, are recorded as errors and
 * skipped. Junction-style cascade attribution is not added here —
 * entity_functions is single-FK and there is no second FK that could
 * cascade.
 *
 * @version v0.4.1
 */
import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import type { IdMap, ImportResult } from "../lib/types";
import { escapeSql, generateInserts, writeSqlFiles } from "../lib/sql";
import { toEpochSeconds, toIsoDate } from "../lib/transform";

const COLUMNS = [
  "id", "entity_id", "honorific", "function", "date_start", "date_end",
  "date_note", "certainty", "source", "notes", "created_at", "updated_at",
];

/**
 * Import entity functions from a JSON export file.
 * Resolves entity_id FK via the provided entity IdMap.
 * Missing FK references are logged as errors and skipped. SQL is
 * written under `outputDir` (default `.import/`, the production
 * CLI's unchanged root; tests pass a per-suite temp dir).
 */
export async function importEntityFunctions(
  inputPath: string,
  entityIdMap: IdMap,
  outputDir = ".import"
): Promise<ImportResult> {
  const raw = await fs.readFile(inputPath, "utf8");
  const records = JSON.parse(raw) as Record<string, unknown>[];

  const rows: string[][] = [];
  const errors: ImportResult["errors"] = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const oldId = record.id as number;

    // Resolve entity_id FK
    const entityOldId = record.entity_id as number;
    const entityId = entityIdMap.get(entityOldId);

    if (!entityId) {
      errors.push({
        table: "entity_functions",
        row: i,
        oldId,
        errors: [
          `entity_id ${entityOldId} not found in entity IdMap`,
        ],
      });
      continue;
    }

    const createdAt = toEpochSeconds(record.created_at as string | null);
    const updatedAt = toEpochSeconds(record.updated_at as string | null);

    if (createdAt === null || updatedAt === null) {
      errors.push({
        table: "entity_functions",
        row: i,
        oldId,
        errors: ["Missing created_at or updated_at timestamp"],
      });
      continue;
    }

    const newId = crypto.randomUUID();

    rows.push([
      escapeSql(newId),
      escapeSql(entityId),
      escapeSql(record.honorific ?? null),
      escapeSql(record.function),
      escapeSql(toIsoDate(record.date_start as string | null)),
      escapeSql(toIsoDate(record.date_end as string | null)),
      escapeSql(record.date_note ?? null),
      escapeSql(record.certainty ?? "probable"),
      escapeSql(record.source ?? null),
      escapeSql(record.notes ?? null),
      escapeSql(createdAt),
      escapeSql(updatedAt),
    ]);
  }

  const statements = generateInserts("entity_functions", COLUMNS, rows, 100);
  const sqlFiles = await writeSqlFiles("entity_functions", statements, 50, outputDir);

  return {
    table: "entity_functions",
    total: records.length,
    imported: rows.length,
    skipped: errors.length,
    errors,
    sqlFiles,
  };
}

// Version: v0.4.1
