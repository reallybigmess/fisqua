#!/usr/bin/env npx tsx
/**
 * Reconcile Volume Status
 *
 * This script is a read-only forensic detector. It finds every volume
 * whose current `status` column disagrees with the `to` value in its most
 * recent `activity_log` row of event `status_changed`. Such drift is the
 * signature of an earlier non-atomic `transitionVolumeStatus` bug:
 * one of the two SQL statements landed on disk and the other did
 * not, leaving the volumes row and the audit trail permanently out
 * of step. The atomic-transition path now lands both writes inside
 * a single D1 batch so new drift cannot accrue; this script exists
 * to surface the historical residue.
 *
 * The script does NOT repair anything. It runs SELECTs against the
 * production D1 (via `wrangler d1 execute fisqua-db --remote`),
 * parses the JSON output, and writes drift-report.json +
 * drift-report.csv into a local reports folder.
 *
 * Repair of any rows the script flags is a separate operator-gated
 * step outside this script's scope. The known Apr 24 case on volume
 * `5636e0b6-1e46-4aa4-975b-7c2f62dd7b3c` — status=in_progress on
 * disk, activity_log says it went to `unstarted` — is the smoke
 * test for the query; the script's output MUST include that volume
 * id.
 *
 * Usage:
 *   npx tsx scripts/reconcile-volume-status.ts            # prod (default)
 *   npx tsx scripts/reconcile-volume-status.ts --env staging
 *   npx tsx scripts/reconcile-volume-status.ts --env prod
 *
 * Pre-flight: `wrangler` must already be authenticated against the
 * Cloudflare account that owns the `fisqua-db` D1 (production) or
 * `fisqua-staging-db` (staging). The Workers env name for the prod
 * binding is the default top-level config block in wrangler.jsonc;
 * `--env staging` selects the staging D1 instead.
 *
 * READ-ONLY contract: the script contains NO UPDATE, INSERT, or
 * DELETE statements. It composes a single SELECT and pipes the
 * result through `JSON.parse` -> drift filter -> file writes. A
 * grep over this file should not show any DML keywords outside
 * comments or string literals that document the contract.
 *
 * @version v0.4.1
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// ESM equivalent of __dirname: derive the script's own directory from
// its module URL. The script lives in `scripts/`, so the report dir
// is one level up under `.reconcile-reports/volume-status/`. The path
// is gitignored — drift reports are operator-side artefacts, never
// committed.
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = path.resolve(
  SCRIPT_DIR,
  "..",
  ".reconcile-reports",
  "volume-status",
);
const JSON_PATH = path.join(REPORT_DIR, "drift-report.json");
const CSV_PATH = path.join(REPORT_DIR, "drift-report.csv");

const KNOWN_DRIFT_VOLUME = "5636e0b6-1e46-4aa4-975b-7c2f62dd7b3c";

// Single SELECT — joins each volume against the latest status_changed
// activity_log row (via a window function over created_at DESC) and
// keeps only rows where the log's `to` disagrees with the current
// status. Volumes with no status_changed log entry at all are NOT
// returned — they are not drifted, they are simply unstarted-since-
// import.
const DRIFT_QUERY = `
SELECT v.id AS volume_id,
       v.status AS current_status,
       v.updated_at AS volumes_updated_at,
       json_extract(latest.detail, '$.to') AS expected_status,
       json_extract(latest.detail, '$.from') AS log_from_status,
       latest.created_at AS activity_log_created_at,
       latest.id AS activity_log_id
FROM volumes v
JOIN (
  SELECT id, volume_id, detail, created_at,
         ROW_NUMBER() OVER (
           PARTITION BY volume_id
           ORDER BY created_at DESC
         ) AS rn
  FROM activity_log
  WHERE event = 'status_changed' AND volume_id IS NOT NULL
) latest ON latest.volume_id = v.id AND latest.rn = 1
WHERE json_extract(latest.detail, '$.to') IS NOT NULL
  AND json_extract(latest.detail, '$.to') != v.status
ORDER BY latest.created_at DESC
`.trim();

const SUMMARY_COUNT_QUERY = `
SELECT COUNT(*) AS total_volumes FROM volumes
`.trim();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DriftRow {
  volume_id: string;
  current_status: string;
  volumes_updated_at: number;
  expected_status: string;
  log_from_status: string | null;
  activity_log_created_at: number;
  activity_log_id: string;
}

interface ReportRow extends DriftRow {
  volumes_updated_at_iso: string;
  activity_log_created_at_iso: string;
  comment: string;
}

// Cloudflare wrangler's `--json` output shape for `d1 execute`:
// an array of result-sets, each with a `results` array of rows.
interface WranglerD1Result<T> {
  results: T[];
  success?: boolean;
  meta?: unknown;
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(): { env: "prod" | "staging" } {
  const argv = process.argv.slice(2);
  const envIdx = argv.indexOf("--env");
  if (envIdx === -1) return { env: "prod" };
  const value = argv[envIdx + 1];
  if (value !== "prod" && value !== "staging") {
    throw new Error(
      `--env must be 'prod' or 'staging' (got ${JSON.stringify(value)})`,
    );
  }
  return { env: value };
}

// ---------------------------------------------------------------------------
// Wrangler invocation
// ---------------------------------------------------------------------------

/**
 * Run a SELECT against the target D1 binding via `wrangler d1 execute`
 * and return the parsed result rows. The wrangler CLI prints any
 * non-JSON status lines to stderr; stdout is pure JSON when `--json`
 * is passed.
 *
 * The binding name `fisqua-db` matches the top-level d1_databases entry
 * in wrangler.jsonc for prod. For staging, wrangler resolves the
 * `--env=staging` binding to `fisqua-staging-db`, so we pass the
 * top-level binding's database_name in both cases (wrangler treats
 * the positional `<binding-name-or-database-name>` argument as either,
 * preferring binding when ambiguous).
 */
function runQuery<T>(env: "prod" | "staging", sql: string): T[] {
  // Production lives at the top-level wrangler.jsonc config block, so
  // no --env flag is needed. Staging is selected with --env=staging
  // and gets the fisqua-staging-db database name resolved by wrangler.
  const dbName = env === "prod" ? "fisqua-db" : "fisqua-staging-db";
  const envFlag = env === "prod" ? "" : " --env=staging";

  // Collapse the SQL onto one line so shell escaping is trivial: no
  // newlines means no `\n` round-trip artefacts when JSON.stringify
  // wraps the value for the shell. We pass via --command rather than
  // --file because --file in current wrangler prints a status banner
  // to stdout (file-upload progress) AND returns aggregate metadata
  // instead of the SELECT's rows.
  const oneLineSql = sql.replace(/\s+/g, " ").trim();

  const cmd =
    `npx wrangler d1 execute ${dbName} --remote --json` +
    envFlag +
    ` --command=${JSON.stringify(oneLineSql)}`;

  const stdout = execSync(cmd, {
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
  });

  // wrangler --json prints either a single object or an array of result
  // sets depending on the call shape; for a single --command we
  // typically get an array with one entry.
  const parsed: WranglerD1Result<T> | WranglerD1Result<T>[] =
    JSON.parse(stdout);
  const firstSet = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!firstSet || !Array.isArray(firstSet.results)) {
    throw new Error(
      "Unexpected wrangler d1 execute output shape: " +
        stdout.slice(0, 500),
    );
  }
  return firstSet.results;
}

// ---------------------------------------------------------------------------
// Report building
// ---------------------------------------------------------------------------

function isoOrUnknown(epochMs: number): string {
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs)) {
    return "unknown";
  }
  try {
    return new Date(epochMs).toISOString();
  } catch {
    return "unknown";
  }
}

function buildReport(rows: DriftRow[]): ReportRow[] {
  return rows.map((row) => ({
    ...row,
    volumes_updated_at_iso: isoOrUnknown(row.volumes_updated_at),
    activity_log_created_at_iso: isoOrUnknown(row.activity_log_created_at),
    comment:
      row.volume_id === KNOWN_DRIFT_VOLUME
        ? "Known Apr 24 drift documented in CONTEXT.md; repair deferred to a separate operator-gated step"
        : "Drift surfaced by volume-status reconciliation; review before any repair",
  }));
}

function toCsv(rows: ReportRow[]): string {
  const header = [
    "volume_id",
    "current_status",
    "expected_status",
    "log_from_status",
    "volumes_updated_at_iso",
    "activity_log_created_at_iso",
    "activity_log_id",
    "comment",
  ];
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (/[",\n]/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.volume_id,
        row.current_status,
        row.expected_status,
        row.log_from_status ?? "",
        row.volumes_updated_at_iso,
        row.activity_log_created_at_iso,
        row.activity_log_id,
        row.comment,
      ]
        .map(escape)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const { env } = parseArgs();

  console.log(`[reconcile-volume-status] target: ${env}`);
  console.log("[reconcile-volume-status] querying total volumes...");

  const totalVolumes = runQuery<{ total_volumes: number }>(
    env,
    SUMMARY_COUNT_QUERY,
  );
  const total =
    totalVolumes[0]?.total_volumes ?? 0;
  console.log(`[reconcile-volume-status] volumes in D1: ${total}`);

  console.log("[reconcile-volume-status] running drift query...");
  const driftRows = runQuery<DriftRow>(env, DRIFT_QUERY);
  console.log(
    `[reconcile-volume-status] drift detected: ${driftRows.length} row(s)`,
  );

  const report = buildReport(driftRows);

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(JSON_PATH, JSON.stringify(report, null, 2) + "\n");
  fs.writeFileSync(CSV_PATH, toCsv(report));

  console.log(`[reconcile-volume-status] wrote ${JSON_PATH}`);
  console.log(`[reconcile-volume-status] wrote ${CSV_PATH}`);
  console.log("[reconcile-volume-status] drifted volume ids:");
  for (const row of report) {
    const marker =
      row.volume_id === KNOWN_DRIFT_VOLUME ? " (known Apr 24 case)" : "";
    console.log(
      `  - ${row.volume_id}: ${row.current_status} on disk vs ${row.expected_status} in log${marker}`,
    );
  }

  const knownPresent = report.some(
    (r) => r.volume_id === KNOWN_DRIFT_VOLUME,
  );
  if (!knownPresent) {
    console.warn(
      `[reconcile-volume-status] WARNING: known drift on volume ${KNOWN_DRIFT_VOLUME} is NOT in the report — the query may be wrong, or the row may have been repaired out-of-band.`,
    );
  }

  console.log(
    "[reconcile-volume-status] read-only run complete; no rows were modified",
  );
}

main();

// @version v0.4.1
