/**
 * Backfill — Module 4: idempotent SQL generator + run report
 *
 * This module deals with serialising the pre-SQL rows into chunked,
 * re-appliable `INSERT` files plus the machine-readable artefacts the
 * integrator consumes (mapping file, run report). Nothing here applies
 * anything — `generate` writes files only; `rehearse` (in `backfill.ts`)
 * is the sole thing that touches a database, and only a local copy.
 *
 * Each statement is an `INSERT OR IGNORE … SELECT … CROSS JOIN users`
 * against a `VALUES` list. Two properties fall out of that shape, both
 * required by §10:
 *   - Idempotent — `OR IGNORE` on the deterministic PK means a
 *     re-applied file lands only the missing rows.
 *   - No-op when the acting user is absent — the `CROSS JOIN (SELECT id
 *     FROM users WHERE email = 'juan@neogranadina.org')` yields zero rows
 *     if that user does not exist, so the whole file inserts nothing
 *     rather than erroring (the 0056 email-keyed pattern). `user_id` is
 *     never hard-coded; it is resolved at apply time.
 * Values are literal SQL (via the shared `escapeSql`), so D1's ~100-bind
 * per-statement limit does not apply; statements split on a 64 KB byte
 * budget — well inside D1's ~100 KB per-statement cap, leaving headroom
 * for reasoning-heavy rows (the adversarial review measured statements
 * within ~5% of the cap under a 95 KB budget).
 *
 * BATCH SPLIT (adversarial review 2026-07-10, verdict BLOCK): only rows
 * whose every endpoint resolved via `content` or `dump` are emitted as
 * SQL. Rows touching any production UUID contested by a fingerprint
 * hypothesis are quarantined by `partitionRows` and written to
 * `deferred-fingerprint/` as JSON (never SQL) with the hand-review
 * evidence file — clearly marked NOT for apply.
 *
 * @version v0.4.2
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { escapeSql } from "../lib/sql";
import { BACKFILL_ORIGIN, BACKFILL_USER_EMAIL, PHASE_13_CREATED_AT_MS } from "./ids";
import type {
  AuthorityOperationRow,
  Bookkeeping,
  EndpointRecoveryStats,
  HandReviewEntry,
  JoinResult,
  ManualCandidate,
  MappingEntry,
  MatchedVia,
  Operation,
  RunReport,
  SeparateStats,
  SkippedDecision,
} from "./types";

const TABLE = "authority_operations";
const INSERT_COLUMNS =
  "id, federation_id, record_type, operation, source_id, target_id, user_id, detail, created_at";
/** 64 KB target ≪ D1's ~100 KB cap — see the module header. */
const STATEMENT_BUDGET_BYTES = 64_000;

function tuple(row: AuthorityOperationRow): string {
  return (
    "(" +
    [
      escapeSql(row.id),
      escapeSql(row.federation_id),
      escapeSql(row.record_type),
      escapeSql(row.operation),
      escapeSql(row.source_id),
      escapeSql(row.target_id),
      escapeSql(JSON.stringify(row.detail)),
      escapeSql(row.created_at),
    ].join(", ") +
    ")"
  );
}

function wrap(tuples: string[]): string {
  // SQLite/D1 do not support the `AS v(col, …)` column-alias list
  // (Postgres-only); VALUES columns are auto-named column1..column8. The
  // tuple order is (id, federation_id, record_type, operation, source_id,
  // target_id, detail, created_at) — user_id is NOT in the tuple; it is
  // resolved from `users` by the CROSS JOIN and spliced into position.
  return (
    `INSERT OR IGNORE INTO ${TABLE}\n  (${INSERT_COLUMNS})\n` +
    `SELECT v.column1, v.column2, v.column3, v.column4, ` +
    `v.column5, v.column6, u.id, v.column7, v.column8\n` +
    `FROM (VALUES\n  ${tuples.join(",\n  ")}\n) AS v\n` +
    `CROSS JOIN (SELECT id FROM users WHERE email = ` +
    `${escapeSql(BACKFILL_USER_EMAIL)}) AS u;`
  );
}

/**
 * Chunk rows into byte-budgeted `INSERT … SELECT … CROSS JOIN`
 * statements. A single over-budget row still emits as its own statement
 * (the operator's signal to truncate upstream), matching the production
 * generator's contract.
 */
export function generateStatements(rows: AuthorityOperationRow[]): string[] {
  const statements: string[] = [];
  let batch: string[] = [];
  let bytes = 0;
  const flush = (): void => {
    if (batch.length === 0) return;
    statements.push(wrap(batch));
    batch = [];
    bytes = 0;
  };
  for (const row of rows) {
    const t = tuple(row);
    const tBytes = Buffer.byteLength(t, "utf8") + 4;
    if (batch.length > 0 && bytes + tBytes > STATEMENT_BUDGET_BYTES) flush();
    batch.push(t);
    bytes += tBytes;
  }
  flush();
  return statements;
}

/**
 * Quarantine every row that touches a production UUID contested by a
 * fingerprint hypothesis. This is the reviewer's exclusion definition:
 * not just rows BUILT from a fingerprint mapping, but any row whose
 * production endpoint a fingerprint hypothesis also claims — until the
 * hypothesis is adjudicated, that record's ledger stays clean of
 * potentially co-attributed rows. (Merge/split `source_id` values that
 * are pipeline ids never collide with the UUID set.)
 */
export function partitionRows(
  rows: AuthorityOperationRow[],
  contestedProductionIds: Set<string>,
): { clean: AuthorityOperationRow[]; deferred: AuthorityOperationRow[] } {
  const clean: AuthorityOperationRow[] = [];
  const deferred: AuthorityOperationRow[] = [];
  for (const r of rows) {
    if (
      contestedProductionIds.has(r.source_id) ||
      (r.target_id !== null && contestedProductionIds.has(r.target_id))
    ) {
      deferred.push(r);
    } else {
      clean.push(r);
    }
  }
  return { clean, deferred };
}

export interface GenerateArtefacts {
  rows: AuthorityOperationRow[];
  join: JoinResult;
  skipped: SkippedDecision[];
  outDir: string;
  entitiesAllPath: string;
  auditLogPath: string;
  productionDb: string | null;
  statementsPerFile?: number;
  /** Integrator-pass enrichments (all optional; absent → base behaviour). */
  /**
   * The raw CONTENT join, when `join` has been enriched with fingerprint
   * and dump matches. Report `join` stats and the ambiguous/unmatched
   * lists describe the content join; the mapping file describes the
   * enriched one.
   */
  contentJoin?: JoinResult;
  matchedVia?: Map<string, MatchedVia>;
  dumpDir?: string | null;
  dataDir?: string | null;
  separateReconstruction?: SeparateStats;
  endpointRecovery?: EndpointRecoveryStats;
  redirects?: { entityRowsBuilt: number; placeMergesNotBuilt: number };
  manualCandidates?: ManualCandidate[];
  stillAmbiguous?: string[];
  droppedInPipelineList?: string[];
  noPipelineRecordList?: string[];
  /** Rows quarantined by `partitionRows` — inventoried, never emitted as SQL. */
  deferredRows?: AuthorityOperationRow[];
  contestedProductionIds?: Set<string>;
  handReview?: {
    entries: HandReviewEntry[];
    rejectedByHardening: Record<string, number>;
  };
  bookkeeping?: Bookkeeping;
  notes?: string[];
}

/**
 * Write the SQL chunk files, the mapping file, and the run report into
 * `outDir` (creating `outDir/sql/`). Returns the run report so the CLI
 * can print a summary.
 */
export async function writeArtefacts(
  a: GenerateArtefacts,
): Promise<RunReport> {
  const sqlDir = path.join(a.outDir, "sql");
  await fs.mkdir(sqlDir, { recursive: true });

  // Collapse rows that share a deterministic PK (first wins). This is not
  // data loss: an identical PK means an identical operation — e.g. a
  // TEMPORAL_SPLIT whose children chain-walk to the same surviving head
  // yields one (parent → head) pair. Deduping here keeps the emitted SQL
  // minimal and the report counts equal to what `INSERT OR IGNORE`
  // actually lands, so rehearsal verifies exactly.
  const seenId = new Set<string>();
  const rows = a.rows.filter((r) => {
    if (seenId.has(r.id)) return false;
    seenId.add(r.id);
    return true;
  });

  const statements = generateStatements(rows);
  const perFile = a.statementsPerFile ?? 20;
  const sqlFiles: RunReport["sqlFiles"] = [];
  let fileNum = 0;
  let totalBytes = 0;
  for (let i = 0; i < statements.length; i += perFile) {
    fileNum += 1;
    const chunk = statements.slice(i, i + perFile);
    const name = `authority_operations-${String(fileNum).padStart(3, "0")}.sql`;
    const header =
      `-- Provenance backfill (authorities spec §10) — generated, do NOT hand-edit.\n` +
      `-- Idempotent (INSERT OR IGNORE on deterministic PKs); no-op if\n` +
      `-- ${BACKFILL_USER_EMAIL} is absent. created_at = Phase-13 constant ` +
      `${PHASE_13_CREATED_AT_MS} (2026-04-16Z), never the run date.\n` +
      `-- detail.origin = "${BACKFILL_ORIGIN}".\n\n` +
      `PRAGMA defer_foreign_keys = true;\n\n`;
    const content = `${header}${chunk.join("\n\n")}\n`;
    const filePath = path.join(sqlDir, name);
    await fs.writeFile(filePath, content, "utf8");
    const bytes = Buffer.byteLength(content, "utf8");
    totalBytes += bytes;
    sqlFiles.push({ file: path.join("sql", name), bytes, statements: chunk.length });
  }

  // Mapping file — the seam the integrator fills for the residual. Each
  // entry records HOW it was resolved (`content` unless the enrichment
  // pass says otherwise). Fingerprint entries carry `deferred: true`:
  // they are hypotheses pending hand review, not resolutions, and no
  // emitted SQL row rests on them.
  const mapping: MappingEntry[] = [...a.join.matched.entries()].map(
    ([pipeline_entity_id, production_id]) => {
      const matched_via =
        a.matchedVia?.get(pipeline_entity_id) ?? ("content" as const);
      return {
        pipeline_entity_id,
        production_id,
        matched_via,
        ...(matched_via === "fingerprint" ? { deferred: true as const } : {}),
      };
    },
  );
  await fs.writeFile(
    path.join(a.outDir, "mapping.json"),
    JSON.stringify(mapping, null, 0),
    "utf8",
  );

  // Deferred-fingerprint quarantine: JSON rows + hand-review evidence in
  // their own directory, marked NOT for apply. No SQL is written there.
  let deferredFingerprint: RunReport["deferredFingerprint"];
  let handReviewReport: RunReport["handReview"];
  if (a.deferredRows || a.handReview) {
    const defDir = path.join(a.outDir, "deferred-fingerprint");
    await fs.mkdir(defDir, { recursive: true });
    await fs.writeFile(
      path.join(defDir, "README.md"),
      `# Deferred fingerprint batch — NOT FOR APPLY\n\n` +
        `Every row and mapping hypothesis in this directory depends on the\n` +
        `description-set fingerprint join, which the adversarial review\n` +
        `(2026-07-10) proved unsafe in its lax form. Nothing here is SQL and\n` +
        `nothing here may be applied. A human adjudicates hand-review.json\n` +
        `first; only then is a hardened fingerprint batch generated.\n`,
      "utf8",
    );
    if (a.deferredRows) {
      // Same PK dedup as the clean batch, so the deferred inventory
      // counts what a future apply would actually land.
      const seenDef = new Set<string>();
      const deferredRows = a.deferredRows.filter((r) => {
        if (seenDef.has(r.id)) return false;
        seenDef.add(r.id);
        return true;
      });
      const defCounts = { merge: 0, split: 0, separate: 0, resolve: 0 } as Record<
        Operation,
        number
      >;
      for (const r of deferredRows) defCounts[r.operation] += 1;
      await fs.writeFile(
        path.join(defDir, "rows.json"),
        JSON.stringify(
          { WARNING: "NOT FOR APPLY — fingerprint-contested rows pending hand review", rows: deferredRows },
          null,
          0,
        ),
        "utf8",
      );
      deferredFingerprint = {
        rowCounts: defCounts,
        total: deferredRows.length,
        contestedProductionIds: a.contestedProductionIds?.size ?? 0,
        mappingEntries: mapping.filter((m) => m.deferred).length,
      };
    }
    if (a.handReview) {
      const hrPath = path.join(defDir, "hand-review.json");
      await fs.writeFile(
        hrPath,
        JSON.stringify(
          {
            WARNING:
              "Hardened-fingerprint survivors — hypotheses for HUMAN adjudication, not resolutions",
            matches: a.handReview.entries,
          },
          null,
          1,
        ),
        "utf8",
      );
      handReviewReport = {
        file: path.join("deferred-fingerprint", "hand-review.json"),
        count: a.handReview.entries.length,
        rejectedByHardening: a.handReview.rejectedByHardening,
      };
    }
  }

  const matchedViaCounts: Record<MatchedVia, number> = {
    content: 0,
    fingerprint: 0,
    dump: 0,
    manual: 0,
  };
  for (const m of mapping) matchedViaCounts[m.matched_via] += 1;

  const rowCounts = { merge: 0, split: 0, separate: 0, resolve: 0 } as Record<
    Operation,
    number
  >;
  const originCounts: Record<string, number> = {};
  for (const r of rows) {
    rowCounts[r.operation] += 1;
    const origin = String(r.detail.origin ?? "unknown");
    originCounts[origin] = (originCounts[origin] ?? 0) + 1;
  }

  const skippedCounts = { merge: 0, split: 0, separate: 0, resolve: 0 };
  for (const s of a.skipped) skippedCounts[s.kind] += 1;

  const report: RunReport = {
    generatedFrom: {
      entitiesAll: a.entitiesAllPath,
      auditLog: a.auditLogPath,
      productionDb: a.productionDb,
      dumpDir: a.dumpDir ?? null,
      dataDir: a.dataDir ?? null,
    },
    createdAtConstantMs: PHASE_13_CREATED_AT_MS,
    join: (() => {
      const j = a.contentJoin ?? a.join;
      return {
        total: j.matched.size + j.ambiguous.length + j.unmatched.length,
        matched: j.matched.size,
        ambiguous: j.ambiguous.length,
        unmatched: j.unmatched.length,
      };
    })(),
    matchedVia: matchedViaCounts,
    rowCounts,
    originCounts,
    skipped: skippedCounts,
    separateReconstruction: a.separateReconstruction,
    endpointRecovery: a.endpointRecovery,
    redirects: a.redirects,
    deferredFingerprint,
    handReview: handReviewReport,
    bookkeeping: a.bookkeeping,
    notes: a.notes,
    sqlFiles,
    totalRows: rows.length,
    totalBytes,
    ambiguousList: (a.contentJoin ?? a.join).ambiguous,
    unmatchedList: (a.contentJoin ?? a.join).unmatched,
    manualCandidates: a.manualCandidates,
    stillAmbiguous: a.stillAmbiguous,
    droppedInPipelineList: a.droppedInPipelineList,
    noPipelineRecordList: a.noPipelineRecordList,
    skippedList: a.skipped,
  };
  await fs.writeFile(
    path.join(a.outDir, "run-report.json"),
    JSON.stringify(report, null, 2),
    "utf8",
  );
  return report;
}

// Version: v0.4.2
