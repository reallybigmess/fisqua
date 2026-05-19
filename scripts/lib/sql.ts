/**
 * Scripts — SQL helpers
 *
 * This module deals with the escape + chunked-INSERT helpers the import
 * bus speaks to. `generateInserts` accepts a `BATCH_SIZE` environment variable
 * override; when set to a positive integer, the override beats both
 * the caller-supplied batchSize and the function's default 100. The
 * scenario this exists for is the operator hitting D1's per-statement
 * 100KB limit mid-apply on a production round; setting `BATCH_SIZE=20`
 * on the next attempt halves the chunk and the failed statement
 * re-applies. The override prints a one-line confirmation to stdout
 * so the operator sees it took effect.
 *
 * @version v0.4.0
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ImportResult } from "./types";

/**
 * Escape a value for safe inclusion in a SQL statement.
 *
 * - null/undefined -> NULL
 * - boolean -> 1/0
 * - number -> string representation
 * - string -> single-quoted with internal quotes doubled
 */
export function escapeSql(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return String(value);
  // String: escape single quotes by doubling them
  const str = String(value).replace(/'/g, "''");
  return `'${str}'`;
}

/**
 * Generate batched INSERT statements.
 *
 * Order of precedence for the per-statement row count:
 *   1. `BATCH_SIZE` env var (if set to a positive integer)
 *   2. caller-supplied `batchSize` argument
 *   3. function default `100`
 *
 * The env override is the recovery knob — when D1 returns a
 * 100KB-per-statement error mid-apply, set `BATCH_SIZE=20` on the
 * next attempt and the runbook proceeds.
 *
 * @param tableName - Target table
 * @param columns - Column names
 * @param rows - Each row is an array of already-escaped SQL value strings
 * @param batchSize - Caller-supplied default (used when env is unset)
 * @returns Array of complete INSERT statements
 */
/**
 * Statement-byte budget — the largest payload we want any single
 * generated INSERT to reach before splitting into a new statement.
 * D1 enforces a hard ~100 KB per-statement cap (verified empirically
 * against fisqua-staging-db on 2026-05-03); 95 KB leaves comfortable
 * headroom for SQL prefix + delimiter overhead. Rows larger than this
 * on their own are still emitted (a single-row INSERT over budget is
 * the operator's signal that something needs upstream truncation).
 */
const STATEMENT_BUDGET_BYTES = 95_000;

export function generateInserts(
  tableName: string,
  columns: string[],
  rows: string[][],
  batchSize = 100
): string[] {
  const envBatch = process.env.BATCH_SIZE;
  let batchToUse = batchSize;
  if (envBatch !== undefined && envBatch !== "") {
    const parsed = Number.parseInt(envBatch, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      batchToUse = parsed;
      console.log(
        `[BATCH_SIZE override] generateInserts using ${batchToUse} (env)`,
      );
    }
  }
  const statements: string[] = [];
  const prefix = `INSERT INTO ${tableName} (${columns.join(", ")}) VALUES\n`;
  const prefixBytes = Buffer.byteLength(prefix, "utf8");

  let batch: string[][] = [];
  let batchBytes = prefixBytes;

  const flush = (): void => {
    if (batch.length === 0) return;
    const valueRows = batch
      .map((row) => `  (${row.join(", ")})`)
      .join(",\n");
    statements.push(`${prefix}${valueRows};`);
    batch = [];
    batchBytes = prefixBytes;
  };

  for (const row of rows) {
    // ",\n" delimiter (2 bytes) + "  (" + row + ")" — the leading
    // delimiter is overcounted on the first row of a batch, which is
    // negligible (2 bytes) and stays on the safe side of the budget.
    const tupleString = `  (${row.join(", ")})`;
    const tupleBytes = Buffer.byteLength(tupleString, "utf8") + 2;

    // Flush on either the row-count cap or the byte budget. The byte
    // budget is the load-bearing one for descriptions; the row cap is
    // the recovery knob and stays useful as a hard upper.
    if (
      batch.length > 0 &&
      (batch.length >= batchToUse || batchBytes + tupleBytes > STATEMENT_BUDGET_BYTES)
    ) {
      flush();
    }

    batch.push(row);
    batchBytes += tupleBytes;
  }
  flush();

  return statements;
}

/**
 * Write SQL statements to chunked files in an output directory.
 *
 * Each file starts with `PRAGMA defer_foreign_keys = true;` to allow
 * FK-dependent inserts within each file.
 *
 * @param tableName - Used for file naming: {tableName}-001.sql
 * @param statements - Array of SQL INSERT statements
 * @param statementsPerFile - Max statements per file (default 50)
 * @param outputDir - Output directory (default .import/)
 * @returns Array of created file paths
 */
export async function writeSqlFiles(
  tableName: string,
  statements: string[],
  statementsPerFile = 50,
  outputDir = ".import"
): Promise<string[]> {
  await fs.mkdir(outputDir, { recursive: true });

  const files: string[] = [];
  for (let i = 0; i < statements.length; i += statementsPerFile) {
    const chunk = statements.slice(i, i + statementsPerFile);
    const fileNum = Math.floor(i / statementsPerFile) + 1;
    const fileName = `${tableName}-${String(fileNum).padStart(3, "0")}.sql`;
    const filePath = path.join(outputDir, fileName);

    const content = `PRAGMA defer_foreign_keys = true;\n\n${chunk.join("\n\n")}\n`;
    await fs.writeFile(filePath, content, "utf8");
    files.push(filePath);
  }
  return files;
}

// Version: v0.4.0
