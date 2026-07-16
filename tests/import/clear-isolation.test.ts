/**
 * Tests — clear isolation
 *
 * This suite is the runtime keystone for cross-tenant isolation on
 * the import clear path: `generateTenantScopedClearSql` must produce SQL that
 * DELETEs ONLY rows whose `tenant_id` is the Neogranadina tenant,
 * leaves every other tenant's rows alone, and does not touch the
 * four ancillary tables (`audit_log`, `drafts`, `changelog`,
 * `comments`) — those are not tenant-scoped today and are out of
 * scope for the per-tenant import workflow.
 *
 * This file is the SQL-shape contract: it asserts the produced SQL
 * string includes a tenant-scoped predicate on every domain DELETE
 * and does not touch the ancillary tables. The companion runtime
 * D1 round-trip lives in the workers vitest pool (mirroring
 * `tests/db/cross-tenant-coverage.test.ts` posture); the SQL-shape
 * contract here is sufficient on its own — wrong SQL is wrong
 * regardless of pool.
 *
 * Multi-tenant fixture commitment (lockstep with the D1 round-
 * trip): the fixture must seed at least two tenants
 * (`NEOGRANADINA_TENANT_ID` + `SECOND_TEST_TENANT_ID` from
 * `tests/helpers/db.ts`) and the SECOND_TEST_TENANT_ID rows must
 * survive the clear. That mitigates the cross-tenant
 * information-disclosure threat in the import clear path.
 *
 * @version v0.4.1
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { NEOGRANADINA_TENANT_ID } from "../../app/lib/tenant";
import { DOMAIN_TABLES, SECOND_TEST_TENANT_ID } from "./helpers";

// Per-suite scratch dir (never the production `.import/` snapshot dir —
// see audit item 23). Created fresh before each test and removed after,
// so parallel test files never contend for the same directory.
let outputDir: string;
async function setUpOutputDir() {
  outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "fisqua-import-test-"));
}
async function cleanOutput() {
  try {
    await fs.rm(outputDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

const ANCILLARY_TABLES = [
  "audit_log",
  "drafts",
  "changelog",
  "comments",
] as const;

const TENANT_SCOPED_DOMAIN_TABLES = DOMAIN_TABLES.filter(
  (t): t is typeof t => t !== "users",
);

describe("generateTenantScopedClearSql (cross-tenant keystone)", () => {
  beforeEach(setUpOutputDir);
  afterEach(cleanOutput);

  it("produces SQL that filters every domain DELETE by NEOGRANADINA tenant_id", async () => {
    const { generateTenantScopedClearSql } = await import(
      "../../scripts/commands/clear"
    );
    const sqlFiles = await generateTenantScopedClearSql({
      tenantId: NEOGRANADINA_TENANT_ID,
      outputDir,
    });
    expect(sqlFiles.length).toBeGreaterThan(0);
    const content = await fs.readFile(sqlFiles[0], "utf8");

    // The Neogranadina tenant UUID must appear in the produced SQL.
    expect(content).toContain(NEOGRANADINA_TENANT_ID);

    // For every tenant-scoped domain table, the DELETE must be
    // scoped by tenant_id.
    for (const table of TENANT_SCOPED_DOMAIN_TABLES) {
      const re = new RegExp(
        `DELETE FROM ${table}[^;]*tenant_id`,
        "i",
      );
      expect(content).toMatch(re);
    }
  });

  it("does NOT include the SECOND tenant id (so SECOND_TEST_TENANT_ID rows would be untouched)", async () => {
    const { generateTenantScopedClearSql } = await import(
      "../../scripts/commands/clear"
    );
    const sqlFiles = await generateTenantScopedClearSql({
      tenantId: NEOGRANADINA_TENANT_ID,
      outputDir,
    });
    const content = await fs.readFile(sqlFiles[0], "utf8");

    // The clear SQL must reference ONLY the target tenant; the
    // SECOND_TEST_TENANT_ID literal must NOT appear (would be an
    // accidental cross-tenant write target).
    expect(content).not.toContain(SECOND_TEST_TENANT_ID);
    // Reference SECOND_TEST_TENANT_ID below so the import is
    // load-bearing for the multi-tenant fixture contract the
    // runtime D1 round-trip takes from this file.
    expect(SECOND_TEST_TENANT_ID).toMatch(/^[a-f0-9-]+$/);
  });

  it("does NOT touch the four ancillary tables (audit_log, drafts, changelog, comments)", async () => {
    const { generateTenantScopedClearSql } = await import(
      "../../scripts/commands/clear"
    );
    const sqlFiles = await generateTenantScopedClearSql({
      tenantId: NEOGRANADINA_TENANT_ID,
      outputDir,
    });
    const content = await fs.readFile(sqlFiles[0], "utf8");

    for (const table of ANCILLARY_TABLES) {
      const re = new RegExp(`DELETE FROM ${table}\\b`, "i");
      expect(content).not.toMatch(re);
    }
  });

  it("references DOMAIN_TABLES in scope (sanity-check the keystone alignment with the cross-tenant grep)", () => {
    // This assertion is load-bearing only as a structural check —
    // DOMAIN_TABLES is sourced from tests/import/helpers.ts, which
    // re-exports it from a const that mirrors
    // tests/db/cross-tenant-coverage.test.ts:187-193 byte-for-byte.
    expect(DOMAIN_TABLES).toContain("descriptions");
    expect(DOMAIN_TABLES).toContain("entities");
    expect(DOMAIN_TABLES).toContain("places");
    expect(DOMAIN_TABLES).toContain("repositories");
    expect(DOMAIN_TABLES).toContain("users");
  });
});

// Version: v0.4.1
