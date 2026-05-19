/**
 * Scripts — import types
 *
 * This module deals with the shared TypeScript shapes that the import
 * pipeline produces and consumes. The row-builders and SQL writers
 * (`scripts/commands/*`) speak `IdMap`, `ImportError`, and `ImportResult`
 * — one row, one table, and one whole-table outcome respectively.
 *
 * The orchestrator (`scripts/import-neogranadina.ts`) uses
 * `RunManifest` to record the per-run shape of each end-to-end import
 * (which dump, which container, the SHA256 of the dump file,
 * before/after counts, failure summary). `FailureReport` carries the
 * per-row reasons the row-builders couldn't import a row, including
 * the cascade-skip fields (`rootCauseTable` + `cascadedFrom`) so a
 * junction row that was skipped because its parent description failed
 * gets traced back to the original cause. `CountSnapshot` is the
 * before/after counts shape stored in the run manifest, organised
 * per-tenant so cross-tenant isolation can be verified by diffing the
 * snapshots. `ClearAssertion` is the per-invariant outcome the clear
 * path produces — three invariants today
 * (non-neo-tenants-unchanged, neo-domain-zero, ancillary-unchanged),
 * each `passed: boolean` with optional `detail` for failure forensics.
 *
 * Every helper that writes legacy_ids JSON validates through
 * `app/lib/validation/legacy-ids.ts:LegacyIdsSchema.parse` before
 * stringify; see `scripts/lib/transform.ts` for the helper bodies.
 *
 * @version v0.4.0
 */

/** Map from old Django integer PK to new UUID */
export type IdMap = Map<number, string>;

/** A single validation/import error for one row.
 *
 * Junction row builders that soft-skip a row because its parent
 * description / entity / place was itself soft-skipped attach the
 * optional `rootCauseTable` and `cascadedFrom` fields so the operator
 * reading import-failures.json sees one root failure plus N cascaded
 * skips, not N+1 unrelated entries. Non-cascade failures leave both
 * fields undefined.
 */
export interface ImportError {
  table: string;
  row: number;
  oldId: number | string;
  errors: string[];
  rootCauseTable?: string;
  cascadedFrom?: number | string;
}

/** Summary result for one table's import */
export interface ImportResult {
  table: string;
  total: number;
  imported: number;
  skipped: number;
  errors: ImportError[];
  sqlFiles: string[];
}

/** Column configuration for a target table */
export interface TableConfig {
  name: string;
  columns: string[];
}

// -----------------------------------------------------------------------
// Production import (Neogranadina)
// -----------------------------------------------------------------------

/**
 * Per-run record of a production import. The orchestrator
 * (`scripts/import-neogranadina.ts`) writes this to the run-output
 * directory next to the SQL files so a re-run can prove the dump
 * being imported, when it was restored, and what counts changed.
 */
export interface RunManifest {
  runId: string;
  target: "local" | "staging" | "production";
  dumpFilename: string;
  dumpSha256: string;
  restoreTimestamp: number;
  containerName: string;
  countsBefore: CountSnapshot;
  countsAfter: CountSnapshot;
  failureSummary: { table: string; count: number }[];
}

/**
 * Per-table failure entries. Each entry includes the row index in the
 * input fixture, the Django primary key for forensics, the fields that
 * were attempted (so the reviewer can see what shape the row had), the
 * validation messages that explain the rejection, and — for cascade
 * skips — the root-cause table and the foreign key that pointed at
 * a row that itself failed.
 */
export interface FailureReport {
  [table: string]: Array<{
    rowIndex: number;
    djangoPk: number | string;
    fieldsAttempted: Record<string, unknown>;
    validationMessages: string[];
    rootCauseTable?: string;
    cascadedFrom?: number | string;
  }>;
}

/**
 * Before/after row counts taken at the run boundary. The per-tenant
 * map keyed by tenant UUID lets the orchestrator prove no
 * non-Neogranadina tenant lost or gained a domain row. Ancillary
 * tables (audit_log, drafts, changelog, comments) are not
 * tenant-scoped today; they are recorded as a flat snapshot so the
 * clear path can prove it didn't touch them.
 */
export interface CountSnapshot {
  domainByTenant: Map<string, {
    repositories: number;
    descriptions: number;
    entities: number;
    places: number;
  }>;
  ancillary: {
    audit_log: number;
    drafts: number;
    changelog: number;
    comments: number;
  };
}

/**
 * One pass/fail outcome from the clear path. The clear routine
 * (`scripts/commands/clear.ts`) emits one of these per invariant; the
 * orchestrator collects them into the run manifest and aborts the
 * import if any invariant failed.
 */
export interface ClearAssertion {
  invariant: "non-neo-tenants-unchanged" | "neo-domain-zero" | "ancillary-unchanged";
  passed: boolean;
  detail?: string;
}

// Version: v0.4.0
