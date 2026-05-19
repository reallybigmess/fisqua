#!/usr/bin/env npx tsx
/**
 * Export From MySQL
 *
 * This script connects to the locally-restored Docker MySQL instance
 * (Django backup pulled from B2 by the orchestrator), snapshots all 7
 * catalog_* tables, and writes JSON files into scripts/export_catalogacion/
 * matching the field names existing scripts/commands/*.ts already consume.
 *
 * Standalone exporter using a JSON intermediate. The exporter does
 * one job (MySQL -> JSON); the importer (scripts/import.ts) does
 * another (JSON -> SQL -> wrangler). Django stays untouched -- it has
 * been retired and adding code there is wasteful.
 *
 * Usage:
 *   npx tsx scripts/export-from-mysql.ts [--out-dir <path>]
 *
 * Connection defaults match the locally-restored audit container:
 *   host=127.0.0.1, port=3307, user=root, password=audit, database=zasqua
 *
 * Override via env vars:
 *   MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE
 *
 * Output filenames drop the catalog_ prefix to match the input shape
 * scripts/import.ts already consumes. FILE_NAMES below is the
 * explicit source-of-truth mapping.
 *
 * mysql2 connection options:
 *   timezone: "Z"          -- read all DATETIME columns as UTC (no drift)
 *   dateStrings: true      -- preserve Django date precision exactly
 *   supportBigNumbers: true, bigNumberStrings: false -- Django bigint
 *   PKs stay numeric within int53; outside that range mysql2 would
 *   return strings rather than silently rounding.
 *
 * @version v0.4.0
 */

import * as mysql from "mysql2/promise";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const TABLES = [
  "catalog_repository",
  "catalog_place",
  "catalog_entity",
  "catalog_entityfunction",
  "catalog_description",
  "catalog_descriptionentity",
  "catalog_descriptionplace",
] as const;

type Table = (typeof TABLES)[number];

const FILE_NAMES: Record<Table, string> = {
  catalog_repository: "repositories.json",
  catalog_place: "places.json",
  catalog_entity: "entities.json",
  catalog_entityfunction: "entity_functions.json",
  catalog_description: "descriptions.json",
  catalog_descriptionentity: "description_entities.json",
  catalog_descriptionplace: "description_places.json",
};

const DEFAULT_OUT_DIR = "scripts/export_catalogacion";

function getConnectionConfig(): mysql.ConnectionOptions {
  return {
    host: process.env.MYSQL_HOST ?? "127.0.0.1",
    port: Number(process.env.MYSQL_PORT ?? 3307),
    user: process.env.MYSQL_USER ?? "root",
    password: process.env.MYSQL_PASSWORD ?? "audit",
    database: process.env.MYSQL_DATABASE ?? "zasqua",
    timezone: "Z",
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
  };
}

export interface ExportResult {
  table: Table;
  rows: number;
  file: string;
}

export async function exportAll(outDir: string): Promise<ExportResult[]> {
  const conn = await mysql.createConnection(getConnectionConfig());
  await fs.mkdir(outDir, { recursive: true });

  const results: ExportResult[] = [];
  try {
    for (const table of TABLES) {
      const [rows] = await conn.query(`SELECT * FROM ${table}`);
      const file = path.join(outDir, FILE_NAMES[table]);
      await fs.writeFile(file, JSON.stringify(rows, null, 2), "utf-8");
      const rowCount = (rows as unknown[]).length;
      console.log(`exported ${rowCount} rows -> ${file}`);
      results.push({ table, rows: rowCount, file });
    }
  } finally {
    await conn.end();
  }
  return results;
}

interface ParsedArgs {
  outDir: string;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  let outDir = DEFAULT_OUT_DIR;
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--out-dir" && i + 1 < args.length) {
      const next = args[i + 1];
      if (next !== undefined) {
        outDir = next;
      }
      i++;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    }
  }
  return { outDir, help };
}

function printUsage(): void {
  console.log(
    [
      "Usage: npx tsx scripts/export-from-mysql.ts [--out-dir <path>]",
      "",
      "Snapshots the 7 Django catalog_* tables from a Docker-resident MySQL 8",
      "container into JSON files matching scripts/import.ts input shape.",
      "",
      "Options:",
      "  --out-dir <path>   Output directory (default: scripts/export_catalogacion)",
      "  -h, --help         Show this help message",
      "",
      "Connection defaults:",
      "  MYSQL_HOST=127.0.0.1  MYSQL_PORT=3307  MYSQL_USER=root",
      "  MYSQL_PASSWORD=audit  MYSQL_DATABASE=zasqua",
      "",
      "Override any of the above via environment variables.",
    ].join("\n")
  );
}

async function main(): Promise<void> {
  const { outDir, help } = parseArgs(process.argv);
  if (help) {
    printUsage();
    return;
  }
  console.log(`Exporting from MySQL -> ${outDir}`);
  const results = await exportAll(outDir);
  const total = results.reduce((sum, r) => sum + r.rows, 0);
  console.log(`Total rows exported: ${total}`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
