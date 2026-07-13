/**
 * Tenant-Scoped Clear + Count Snapshot + FTS Rebuild
 *
 * This module deals with the tenant-scoped clear-and-reimport that touches
 * Neogranadina's domain rows and the derived junctions only. Every DELETE filters by tenant_id. Order:
 *   descriptions    -> cascade kills description_entities + description_places
 *                      (FK ON DELETE CASCADE on the description side)
 *   entity_functions -> JOIN-DELETE through entities WHERE tenant_id
 *                      (entity_functions has no tenant_id of its own; it
 *                       inherits via entity_id FK with ON DELETE CASCADE)
 *   entities, places, repositories -> tenant-scoped DELETE
 *
 * `snapshotCounts` pre-clear + `assertPostClearInvariants` post-clear
 * is the runtime check that catches a missing WHERE tenant_id = clause
 * before any data loss. Mirrors the test-time meta-grep posture of
 * tests/db/cross-tenant-coverage.test.ts.
 *
 * Three invariants are enforced as throws; no flag disables them:
 *   (a) every non-Neogranadina tenant's domain counts unchanged
 *   (b) Neogranadina domain counts all 0 post-clear
 *   (c) ancillary tables (audit_log/drafts/changelog/comments) unchanged
 *
 * `generateFtsRebuild` emits THREE rebuild statements
 * (entities_fts + places_fts + descriptions_fts). Migration 0024 added
 * descriptions_fts after an earlier clear was written; the rebuild
 * list catches up so search is not silently broken after a
 * clear-and-reimport.
 *
 * `snapshotCounts` writes the multi-line UNION ALL SQL to a temp file
 * under .import/ and applies it via `wrangler d1 execute --file=`, not
 * `--command "..."`. Embedded newlines + single quotes in a wrangler
 * argv are fragile under macOS zsh; the temp-file path avoids the
 * hazard entirely. The temp file is deleted in finally{}.
 *
 * Target enum drives the wrangler invocation:
 *   target=local      -> fisqua-db --local
 *   target=staging    -> fisqua-staging-db --env=staging --remote
 *   target=production -> fisqua-db --remote
 * database_name is always passed explicitly.
 *
 * @version v0.4.1
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { NEOGRANADINA_TENANT_ID } from "../../app/lib/tenant";
import type { CountSnapshot, ClearAssertion } from "../lib/types";

const DEFAULT_OUTPUT_DIR = ".import";

/**
 * Generate the tenant-scoped clear SQL. Writes a single .sql file under
 * `opts.outputDir` (default `.import/`, the production CLI's unchanged
 * root; tests pass a per-suite temp dir) and returns its path in a
 * one-element array (so callers can iterate uniformly over a list of
 * generated SQL files).
 *
 * Defaults to NEOGRANADINA_TENANT_ID; the optional `tenantId` override is
 * used by tests/import/clear-isolation.test.ts so the keystone fixture can
 * pass the constant explicitly. Production callers (the import
 * orchestrator) pass nothing and inherit the Neogranadina default.
 *
 * Order matters:
 *   1. descriptions    -- cascade kills description_entities +
 *                         description_places via ON DELETE CASCADE on
 *                         their description_id FK
 *   2. entity_functions -- JOIN-DELETE through entities WHERE tenant_id
 *                         (entity_functions itself has no tenant_id)
 *   3. entities         -- tenant-scoped
 *   4. places           -- tenant-scoped
 *   5. repositories     -- tenant-scoped
 *
 * Other tenants' rows are untouched. The four ancillary tables
 * (audit_log/drafts/changelog/comments) are NOT touched; they are not
 * tenant-scoped today and live outside the per-tenant import workflow.
 */
export async function generateTenantScopedClearSql(
  opts: { tenantId?: string; outputDir?: string } = {},
): Promise<string[]> {
  const tenantId = opts.tenantId ?? NEOGRANADINA_TENANT_ID;
  const outputDir = opts.outputDir ?? DEFAULT_OUTPUT_DIR;
  await fs.mkdir(outputDir, { recursive: true });

  const sql = `PRAGMA defer_foreign_keys = true;

-- Tenant-scoped clear. Order matters -- descriptions first (cascade
-- kills description_entities + description_places); entity_functions
-- next via JOIN-DELETE (no tenant_id column); then entities, places,
-- repositories. Other tenants' rows are untouched.
DELETE FROM descriptions WHERE tenant_id = '${tenantId}';
DELETE FROM entity_functions WHERE entity_id IN (
  SELECT id FROM entities WHERE tenant_id = '${tenantId}'
);
DELETE FROM entities WHERE tenant_id = '${tenantId}';
DELETE FROM places WHERE tenant_id = '${tenantId}';
DELETE FROM repositories WHERE tenant_id = '${tenantId}';
`;

  const filePath = path.join(outputDir, "clear-001.sql");
  await fs.writeFile(filePath, sql, "utf8");
  return [filePath];
}

/**
 * Generate the FTS5 rebuild SQL. Three lines, one per FTS5 table:
 *   - entities_fts      (migration 0012)
 *   - places_fts        (migration 0012)
 *   - descriptions_fts  (migration 0024 -- the one previously missed)
 *
 * An earlier rebuild list only included the first two tables. After
 * migration 0024 added descriptions_fts the list went stale, leaving
 * search silently broken for the descriptions table after a
 * clear-and-reimport until the next row write touched the FTS
 * triggers. The current list catches up.
 *
 * Writes under `outputDir` (default `.import/`, the production CLI's
 * unchanged root; tests pass a per-suite temp dir).
 */
export async function generateFtsRebuild(
  outputDir: string = DEFAULT_OUTPUT_DIR,
): Promise<string[]> {
  await fs.mkdir(outputDir, { recursive: true });

  const sql = `INSERT INTO entities_fts(entities_fts) VALUES('rebuild');
INSERT INTO places_fts(places_fts) VALUES('rebuild');
INSERT INTO descriptions_fts(descriptions_fts) VALUES('rebuild');
`;

  const filePath = path.join(outputDir, "fts-rebuild-001.sql");
  await fs.writeFile(filePath, sql, "utf8");
  return [filePath];
}

// ---------------------------------------------------------------------------
// Cross-tenant invariant helpers: snapshotCounts + assertPostClearInvariants
// ---------------------------------------------------------------------------

export type ClearTarget = "local" | "staging" | "production";

/**
 * Build the wrangler argv tail for `d1 execute ... --file= --json` against
 * the given target. database_name + --env + --remote are each
 * constructed from the target enum -- never partial. Staging needs
 * both --env=staging AND --remote (the staging deploy's D1 lives on
 * the staging worker env, not on the default env's --remote).
 */
function buildWranglerFileArgs(target: ClearTarget, sqlFilePath: string): string {
  const dbName = target === "staging" ? "fisqua-staging-db" : "fisqua-db";
  const envFlag = target === "staging" ? " --env=staging" : "";
  const remoteFlag = target === "local" ? "--local" : "--remote";
  return `d1 execute ${dbName}${envFlag} ${remoteFlag} --file="${sqlFilePath}" --json`;
}

/**
 * Run a single SQL string against the target D1 via wrangler --file=,
 * parse the --json output, and return the rows from the first statement.
 *
 * Multi-line UNION ALL SQL via embedded shell-quoted --command is
 * fragile on macOS (zsh quoting hazards, embedded backslashes,
 * newlines in the wrangler argv). Writing SQL to a temp file under
 * `outputDir` (default `.import/`) and using --file= instead avoids
 * the hazard. The wrangler --json output shape is identical between
 * --command and --file invocations.
 *
 * Temp file is deleted in finally{} regardless of success or failure;
 * the unlink is idempotent so a missing file at cleanup is not an error.
 */
async function wranglerJsonViaFile(
  target: ClearTarget,
  sql: string,
  label: string,
  outputDir: string = DEFAULT_OUTPUT_DIR,
): Promise<unknown[]> {
  await fs.mkdir(outputDir, { recursive: true });
  const tmpPath = path.join(
    outputDir,
    `snapshot-${label}-${Date.now()}.sql`,
  );
  await fs.writeFile(tmpPath, sql, "utf8");
  try {
    const out = execSync(
      `npx wrangler ${buildWranglerFileArgs(target, tmpPath)}`,
      { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 },
    );
    // Wrangler `d1 execute --remote --file --json` prefixes its JSON
    // output with status lines (`├ Checking if file needs uploading`,
    // `│ Uploading complete`) — these are not part of the documented
    // --json contract but ship hardcoded in the file-upload path.
    // `--local` invocations don't show them. Discard everything before
    // the first JSON token so both targets parse the same way.
    const jsonStart = out.search(/[[{]/);
    if (jsonStart < 0) {
      throw new Error(
        `wrangler --json produced no JSON output for ${label}: ${out}`,
      );
    }
    const parsed = JSON.parse(out.slice(jsonStart)) as Array<{
      results?: unknown[];
    }>;
    return parsed[0]?.results ?? [];
  } finally {
    try {
      await fs.unlink(tmpPath);
    } catch {
      // idempotent: file already removed or never written
    }
  }
}

/**
 * Take a per-tenant + ancillary count snapshot of the target D1. Issues
 * at most TWO wrangler invocations per snapshot (one for the per-tenant
 * domain UNION ALL, one for the ancillary table UNION ALL). The single-
 * UNION-ALL shape is the explicit anti-chatty-assertions pattern --
 * 8 separate calls would multiply round-trip latency for no
 * information gain.
 *
 * Temp snapshot SQL files are written under `outputDir` (default
 * `.import/`, the production CLI's unchanged root; tests pass a
 * per-suite temp dir).
 */
export async function snapshotCounts(
  target: ClearTarget,
  outputDir: string = DEFAULT_OUTPUT_DIR,
): Promise<CountSnapshot> {
  // Per-tenant counts across the four tenanted domain tables. GROUP BY
  // tenant_id so tenants with zero rows in a table are simply absent
  // from the result set; assertPostClearInvariants treats absent =
  // (table-count == 0) for that tenant.
  const domainSql = `SELECT 'repositories' AS tbl, tenant_id, COUNT(*) AS cnt FROM repositories GROUP BY tenant_id
UNION ALL
SELECT 'descriptions', tenant_id, COUNT(*) FROM descriptions GROUP BY tenant_id
UNION ALL
SELECT 'entities', tenant_id, COUNT(*) FROM entities GROUP BY tenant_id
UNION ALL
SELECT 'places', tenant_id, COUNT(*) FROM places GROUP BY tenant_id;
`;
  const domainRows = (await wranglerJsonViaFile(
    target,
    domainSql,
    "domain",
    outputDir,
  )) as Array<{ tbl: string; tenant_id: string; cnt: number }>;

  const ancillarySql = `SELECT 'audit_log' AS tbl, COUNT(*) AS cnt FROM audit_log
UNION ALL SELECT 'drafts', COUNT(*) FROM drafts
UNION ALL SELECT 'changelog', COUNT(*) FROM changelog
UNION ALL SELECT 'comments', COUNT(*) FROM comments;
`;
  const ancillaryRows = (await wranglerJsonViaFile(
    target,
    ancillarySql,
    "ancillary",
    outputDir,
  )) as Array<{ tbl: string; cnt: number }>;

  const domainByTenant = new Map<
    string,
    { repositories: number; descriptions: number; entities: number; places: number }
  >();
  for (const row of domainRows) {
    const existing =
      domainByTenant.get(row.tenant_id) ??
      { repositories: 0, descriptions: 0, entities: 0, places: 0 };
    if (row.tbl === "repositories") existing.repositories = row.cnt;
    if (row.tbl === "descriptions") existing.descriptions = row.cnt;
    if (row.tbl === "entities") existing.entities = row.cnt;
    if (row.tbl === "places") existing.places = row.cnt;
    domainByTenant.set(row.tenant_id, existing);
  }

  const ancillary = { audit_log: 0, drafts: 0, changelog: 0, comments: 0 };
  for (const row of ancillaryRows) {
    if (row.tbl in ancillary) {
      (ancillary as Record<string, number>)[row.tbl] = row.cnt;
    }
  }

  return { domainByTenant, ancillary };
}

/**
 * Cross-tenant invariant runtime check. Throws on any of three
 * invariant violations; the orchestrator catches the throw and aborts
 * the run before any INSERT can corrupt cross-tenant state.
 *
 *   (a) Every non-Neogranadina tenant's domain counts unchanged --
 *       a counts diff means the clear hit rows it shouldn't have.
 *       Throw lists the offending tenant id + before/after counts.
 *   (b) Neogranadina domain counts in all four tenanted domain tables
 *       are 0 post-clear -- otherwise the clear was incomplete and
 *       re-running may produce duplicate rows.
 *   (c) Ancillary table counts (audit_log/drafts/changelog/comments)
 *       unchanged -- these tables stay intact across rounds; a diff
 *       means the clear leaked into the ancillary surface.
 *
 * Returns a ClearAssertion[] on success so the orchestrator can record
 * the per-invariant pass into the run manifest. The function never
 * returns a `passed: false` entry; failure is signalled exclusively by
 * the throw, so callers cannot accidentally silence a violation by
 * inspecting the array.
 */
export function assertPostClearInvariants(
  before: CountSnapshot,
  after: CountSnapshot,
): ClearAssertion[] {
  const results: ClearAssertion[] = [];

  // (a) every non-neogranadina tenant unchanged
  for (const [tenantId, beforeCounts] of before.domainByTenant) {
    if (tenantId === NEOGRANADINA_TENANT_ID) continue;
    const afterCounts = after.domainByTenant.get(tenantId);
    const equal =
      afterCounts !== undefined &&
      afterCounts.repositories === beforeCounts.repositories &&
      afterCounts.descriptions === beforeCounts.descriptions &&
      afterCounts.entities === beforeCounts.entities &&
      afterCounts.places === beforeCounts.places;
    if (!equal) {
      throw new Error(
        `[ABORT] Tenant ${tenantId} counts changed during clear. ` +
          `before=${JSON.stringify(beforeCounts)} ` +
          `after=${JSON.stringify(afterCounts)}. ` +
          `Cross-tenant clear suspected -- inspect manually before re-running.`,
      );
    }
  }
  results.push({ invariant: "non-neo-tenants-unchanged", passed: true });

  // (b) neogranadina domain counts all 0
  const neoAfter = after.domainByTenant.get(NEOGRANADINA_TENANT_ID);
  if (
    neoAfter &&
    (neoAfter.repositories ||
      neoAfter.descriptions ||
      neoAfter.entities ||
      neoAfter.places)
  ) {
    throw new Error(
      `[ABORT] Neogranadina clear incomplete: ${JSON.stringify(neoAfter)}. ` +
        `Re-running may produce duplicate rows.`,
    );
  }
  results.push({ invariant: "neo-domain-zero", passed: true });

  // (c) ancillary counts unchanged
  for (const key of Object.keys(before.ancillary) as Array<
    keyof CountSnapshot["ancillary"]
  >) {
    if (before.ancillary[key] !== after.ancillary[key]) {
      throw new Error(
        `[ABORT] Ancillary table ${key} count changed during clear. ` +
          `before=${before.ancillary[key]} after=${after.ancillary[key]}. ` +
          `These tables stay intact across rounds.`,
      );
    }
  }
  results.push({ invariant: "ancillary-unchanged", passed: true });

  return results;
}

// Version: v0.4.1
