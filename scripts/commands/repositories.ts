/**
 * Scripts — repositories importer
 *
 * This module deals with the row builder for the production import of
 * `repositories` from the Django catalogue dump. The COLUMNS array
 * tracks the v0.4 union schema:
 *
 *   - tenant_id is mandatory — every domain row has the non-null
 *     tenant FK; this importer hardcodes NEOGRANADINA_TENANT_ID from
 *     app/lib/tenant.ts at column position 2 of every INSERT
 *   - rights_text is sourced from Django `image_reproduction_text`
 *     (column rename in drizzle/0036_union_schema.sql); the legacy
 *     name does not appear in the v0.4 schema
 *   - display_title, subtitle, hero_image_url are home-page-
 *     customisation columns that import as NULL; the operator fills
 *     them via the admin UI after import — they are not present in
 *     the Django dump
 *
 * The COLUMNS array is the contract enforced by
 * `tests/import/columns-coverage.test.ts`: every column declared on
 * `app/db/schema.ts:repositories` must appear in COLUMNS in
 * declaration order. Schema-level NOT NULL FK on tenant_id is the
 * structural defence against accidental cross-tenant leak.
 *
 * No FK resolution and no code generation here — repositories carry
 * no FKs to other domain tables and the human-readable code (e.g.
 * `AHRB`, `AGN`) ships verbatim from Django.
 *
 * @version v0.4.1
 */
import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import type { IdMap, ImportResult } from "../lib/types";
import { escapeSql, generateInserts, writeSqlFiles } from "../lib/sql";
import { toEpochSeconds } from "../lib/transform";
import { NEOGRANADINA_TENANT_ID } from "../../app/lib/tenant";

const COLUMNS = [
  "id", "tenant_id",
  "code", "name", "short_name", "country_code", "country",
  "city", "address", "website", "notes",
  "rights_text",
  "display_title", "subtitle", "hero_image_url",
  "enabled", "created_at", "updated_at",
];

/**
 * Import repositories from a JSON export file.
 * Generates UUIDs for each record and produces chunked SQL INSERT files
 * under `outputDir` (default `.import/`, the production CLI's
 * unchanged root; tests pass a per-suite temp dir).
 */
export async function importRepositories(
  inputPath: string,
  outputDir = ".import"
): Promise<{ result: ImportResult; idMap: IdMap }> {
  const raw = await fs.readFile(inputPath, "utf8");
  const records = JSON.parse(raw) as Record<string, unknown>[];

  const idMap: IdMap = new Map();
  const rows: string[][] = [];
  const errors: ImportResult["errors"] = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const oldId = record.id as number;
    const newId = crypto.randomUUID();
    idMap.set(oldId, newId);

    const createdAt = toEpochSeconds(record.created_at as string | null);
    const updatedAt = toEpochSeconds(record.updated_at as string | null);

    if (createdAt === null || updatedAt === null) {
      errors.push({
        table: "repositories",
        row: i,
        oldId,
        errors: ["Missing created_at or updated_at timestamp"],
      });
      idMap.delete(oldId);
      continue;
    }

    rows.push([
      escapeSql(newId),
      escapeSql(NEOGRANADINA_TENANT_ID),
      escapeSql(record.code),
      escapeSql(record.name),
      escapeSql(record.short_name ?? null),
      escapeSql(record.country_code ?? "COL"),
      escapeSql(record.country ?? null),
      escapeSql(record.city ?? null),
      escapeSql(record.address ?? null),
      escapeSql(record.website ?? null),
      escapeSql(record.notes ?? null),
      // rights_text sourced from Django image_reproduction_text;
      // column rename in drizzle/0036_union_schema.sql.
      escapeSql((record.image_reproduction_text as string | null) ?? null),
      // Home-page customisation columns import as NULL; operator
      // fills via admin UI post-import.
      escapeSql(null),
      escapeSql(null),
      escapeSql(null),
      escapeSql(record.enabled ?? true),
      escapeSql(createdAt),
      escapeSql(updatedAt),
    ]);
  }

  const statements = generateInserts("repositories", COLUMNS, rows, 100);
  const sqlFiles = await writeSqlFiles("repositories", statements, 50, outputDir);

  return {
    result: {
      table: "repositories",
      total: records.length,
      imported: rows.length,
      skipped: errors.length,
      errors,
      sqlFiles,
    },
    idMap,
  };
}

// Version: v0.4.1
