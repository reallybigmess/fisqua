/**
 * Tests — drizzle migration journal sanity
 *
 * This suite verifies entries 33..36 are present in drizzle/meta/_journal.json
 * with the expected tags (0034..0037), in chronological order, and
 * that each SQL file exists on disk.
 *
 * Implementation note: the cloudflare:test pool runs in a Workers
 * sandbox that does not expose Node `fs`, so the journal JSON and the
 * migration SQL are pulled in via Vite's `?raw` and JSON import
 * machinery (mirroring `tests/i18n-coverage.test.ts`). All file
 * content is fixed at module load time, which is exactly what these
 * tests want -- they are static-correctness checks on artifacts on
 * disk, not runtime state.
 *
 * @version v0.4.0
 */

import { describe, it, expect } from "vitest";
import journal from "../../drizzle/meta/_journal.json";

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

const j = journal as Journal;

// All migration SQL files, eagerly loaded as raw strings so individual
// tests can grep for known substrings without needing fs at runtime.
const migrationFiles = import.meta.glob("../../drizzle/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function findMigration(filename: string): string | undefined {
  for (const [path, content] of Object.entries(migrationFiles)) {
    if (path.endsWith(`/${filename}`)) return content;
  }
  return undefined;
}

describe("multi-tenancy migrations (0034..0037)", () => {
  it("journal contains entry for 0034_tenants_table", () => {
    const tags = j.entries.map((e) => e.tag);
    expect(tags).toContain("0034_tenants_table");
  });

  it("journal entry idx=33 / tag='0034_tenants_table' / version='6' / breakpoints=true exists", () => {
    const entry = j.entries.find((e) => e.tag === "0034_tenants_table");
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      idx: 33,
      version: "6",
      tag: "0034_tenants_table",
      breakpoints: true,
    });
    // `when` must be monotonic with the prior entry (idx=32).
    const prior = j.entries.find((e) => e.idx === 32);
    expect(prior).toBeDefined();
    expect(entry!.when).toBeGreaterThan(prior!.when);
  });

  it("0034 migration file exists on disk", () => {
    const sql = findMigration("0034_tenants_table.sql");
    expect(sql).toBeDefined();
    expect(typeof sql).toBe("string");
    expect(sql!.length).toBeGreaterThan(0);
  });

  it("0034 contains 'CREATE TABLE tenants' and INSERTs the platform + neogranadina rows", () => {
    const sql = findMigration("0034_tenants_table.sql");
    expect(sql).toBeDefined();
    expect(sql!).toContain("CREATE TABLE tenants");
    // Platform tenant locked UUID (PLATFORM_TENANT_ID).
    expect(sql!).toContain("0391baa2-0bab-44ae-ac08-9fa7eb7c6145");
    // Neogranadina tenant locked UUID (NEOGRANADINA_TENANT_ID).
    expect(sql!).toContain("c50bfa92-1223-4f00-ba15-d50c39ae3c0b");
  });

  it("journal entry idx=34 / tag='0035_domain_table_tenant_ids' / version='6' / breakpoints=true exists", () => {
    const entry = j.entries.find((e) => e.tag === "0035_domain_table_tenant_ids");
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      idx: 34,
      version: "6",
      tag: "0035_domain_table_tenant_ids",
      breakpoints: true,
    });
    // `when` must be monotonic with the prior entry (idx=33).
    const prior = j.entries.find((e) => e.idx === 33);
    expect(prior).toBeDefined();
    expect(entry!.when).toBeGreaterThan(prior!.when);
  });

  it("0035 migration file exists on disk", () => {
    const sql = findMigration("0035_domain_table_tenant_ids.sql");
    expect(sql).toBeDefined();
    expect(typeof sql).toBe("string");
    expect(sql!.length).toBeGreaterThan(0);
  });

  it("0035 defers FK enforcement and rebuilds five tables with NEOGRANADINA_TENANT_ID literal back-fill", () => {
    const sql = findMigration("0035_domain_table_tenant_ids.sql");
    expect(sql).toBeDefined();
    // FK enforcement is deferred to commit time; defer_foreign_keys
    // resets automatically at end of transaction, so there is no
    // explicit re-enable statement.
    expect((sql!.match(/PRAGMA defer_foreign_keys=ON;/g) ?? []).length).toBe(1);
    // Five sequential rebuilds: one per domain table.
    expect(
      (sql!.match(/REFERENCES tenants\(id\) ON DELETE RESTRICT/g) ?? []).length,
    ).toBe(5);
    // Five back-fill INSERTs with the locked NEOGRANADINA literal.
    expect(
      (sql!.match(/c50bfa92-1223-4f00-ba15-d50c39ae3c0b/g) ?? []).length,
    ).toBe(5);
    // Five DROP TABLE statements for the source tables.
    expect(
      (sql!.match(/DROP TABLE (users|repositories|descriptions|entities|places);/g) ?? [])
        .length,
    ).toBe(5);
    // Per-rebuild FK integrity check.
    expect(
      (sql!.match(/PRAGMA foreign_key_check;/g) ?? []).length,
    ).toBe(5);
    // FTS5 trigger re-CREATEs for the three FTS-indexed tables.
    expect(
      (sql!.match(/CREATE TRIGGER IF NOT EXISTS descriptions_fts_a/g) ?? []).length,
    ).toBe(3);
    expect(
      (sql!.match(/CREATE TRIGGER IF NOT EXISTS entities_fts_a/g) ?? []).length,
    ).toBe(3);
    expect(
      (sql!.match(/CREATE TRIGGER IF NOT EXISTS places_fts_a/g) ?? []).length,
    ).toBe(3);
  });

  it("journal entry idx=35 / tag='0036_union_schema' / version='6' / breakpoints=true exists", () => {
    const entry = j.entries.find((e) => e.tag === "0036_union_schema");
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      idx: 35,
      version: "6",
      tag: "0036_union_schema",
      breakpoints: true,
    });
    // `when` must be monotonic with the prior entry (idx=34).
    const prior = j.entries.find((e) => e.idx === 34);
    expect(prior).toBeDefined();
    expect(entry!.when).toBeGreaterThan(prior!.when);
  });

  it("0036 migration file exists on disk", () => {
    const sql = findMigration("0036_union_schema.sql");
    expect(sql).toBeDefined();
    expect(typeof sql).toBe("string");
    expect(sql!.length).toBeGreaterThan(0);
  });

  it("0036 contains the 9 column drops + 6 column adds + 3 legacyIds adds + FTS5 trigger re-CREATEs", () => {
    const sql = findMigration("0036_union_schema.sql");
    expect(sql).toBeDefined();

    // File-scope FK suspension wraps the entire file.
    expect((sql!.match(/PRAGMA foreign_keys=OFF;/g) ?? []).length).toBe(1);
    expect((sql!.match(/PRAGMA foreign_keys=ON;/g) ?? []).length).toBe(1);

    // Three rebuilt tables: descriptions, entities, places.
    expect(
      (sql!.match(/^DROP TABLE descriptions;/m) ?? []).length,
    ).toBe(1);
    expect((sql!.match(/^DROP TABLE entities;/m) ?? []).length).toBe(1);
    expect((sql!.match(/^DROP TABLE places;/m) ?? []).length).toBe(1);

    // One PRAGMA foreign_key_check per rebuild (defensive). The
    // narrative header also names it once in prose.
    expect((sql!.match(/^PRAGMA foreign_key_check;/gm) ?? []).length).toBe(3);

    // 9 confirmed-dead columns must NOT appear as column declarations
    // (TEXT) in any _new CREATE. They may still appear as substrings of
    // an INSERT or comment narrative; the safest fingerprint is the
    // exact `<col> TEXT` shape used in CREATE TABLE bodies.
    expect(sql!).not.toMatch(/^\s+historical_gobernacion TEXT/m);
    expect(sql!).not.toMatch(/^\s+historical_partido TEXT/m);
    expect(sql!).not.toMatch(/^\s+historical_region TEXT/m);
    expect(sql!).not.toMatch(/^\s+admin_level_1 TEXT/m);
    expect(sql!).not.toMatch(/^\s+admin_level_2 TEXT/m);
    expect(sql!).not.toMatch(/^\s+legal_status TEXT/m);
    expect(sql!).not.toMatch(/^\s+related_materials TEXT/m);
    // country_code and wikidata_id are dropped on places only — not
    // globally — so a structural fingerprint check is the safest. The
    // 0036 places_new table has neither, but other tables (e.g.
    // repositories.country_code) keep them. Inspect by counting
    // occurrences as TEXT column declarations (no cross-table reuse
    // happens inside 0036 itself).
    expect((sql!.match(/^\s+country_code TEXT/gm) ?? []).length).toBe(0);
    expect((sql!.match(/^\s+wikidata_id TEXT/gm) ?? []).length).toBe(1); // entities.wikidata_id only

    // 6 + 3 added columns appear in the file.
    expect((sql!.match(/publication_title/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect((sql!.match(/dbe_id/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect((sql!.match(/legacy_ids/g) ?? []).length).toBeGreaterThanOrEqual(3);

    // fclass with the bounded GeoNames CHECK.
    expect(sql!).toContain(
      "CHECK (fclass IS NULL OR fclass IN ('P','H','A','T','S'))",
    );

    // FTS5 trigger re-CREATEs after each rebuild (3 per indexed table).
    expect(
      (sql!.match(/CREATE TRIGGER IF NOT EXISTS descriptions_fts_a/g) ?? []).length,
    ).toBe(3);
    expect(
      (sql!.match(/CREATE TRIGGER IF NOT EXISTS entities_fts_a/g) ?? []).length,
    ).toBe(3);
    expect(
      (sql!.match(/CREATE TRIGGER IF NOT EXISTS places_fts_a/g) ?? []).length,
    ).toBe(3);

    // DACS/RAD union additions land as column declarations.
    expect(sql!).toMatch(/admin_biog_history TEXT/);
    expect(sql!).toMatch(/preferred_citation TEXT/);
    expect(sql!).toMatch(/acquisition_info TEXT/);
    expect(sql!).toMatch(/system_of_arrangement TEXT/);
    expect(sql!).toMatch(/physical_characteristics TEXT/);
  });

  it("journal entry idx=36 / tag='0037_audit_log' / version='6' / breakpoints=true exists", () => {
    const entry = j.entries.find((e) => e.tag === "0037_audit_log");
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      idx: 36,
      version: "6",
      tag: "0037_audit_log",
      breakpoints: true,
    });
    // `when` must be monotonic with the prior entry (idx=35).
    const prior = j.entries.find((e) => e.idx === 35);
    expect(prior).toBeDefined();
    expect(entry!.when).toBeGreaterThan(prior!.when);
  });

  it("0037 migration file exists on disk", () => {
    const sql = findMigration("0037_audit_log.sql");
    expect(sql).toBeDefined();
    expect(typeof sql).toBe("string");
    expect(sql!.length).toBeGreaterThan(0);
  });

  it("0037 contains audit_log CREATE TABLE + 2 immutability triggers + bounded action CHECK", () => {
    const sql = findMigration("0037_audit_log.sql");
    expect(sql).toBeDefined();

    // CREATE TABLE audit_log appears exactly once.
    expect((sql!.match(/CREATE TABLE audit_log/g) ?? []).length).toBe(1);

    // Mixed FK delete behaviours:
    expect(sql!).toContain(
      "actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL",
    );
    expect(sql!).toContain("actor_user_id_text TEXT NOT NULL");
    expect(sql!).toContain(
      "actor_tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT",
    );
    expect(sql!).toContain(
      "target_tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT",
    );

    // All seven bounded actions appear in the action CHECK enum.
    for (const action of [
      "'create_tenant'",
      "'soft_disable_tenant'",
      "'reset_superadmin'",
      "'login_as'",
      "'edit_on_behalf'",
      "'set_capability'",
      "'set_quota'",
    ]) {
      expect(sql!).toContain(action);
    }

    // Three indexes with created_at DESC ordering.
    expect(sql!).toContain(
      "CREATE INDEX audit_log_target_tenant_idx ON audit_log(target_tenant_id, created_at DESC);",
    );
    expect(sql!).toContain(
      "CREATE INDEX audit_log_actor_user_idx    ON audit_log(actor_user_id, created_at DESC);",
    );
    expect(sql!).toContain(
      "CREATE INDEX audit_log_created_idx       ON audit_log(created_at DESC);",
    );

    // Exactly two CREATE TRIGGER statements with the bare RAISE form
    // (workers-sdk #4326 trigger-parser quirk avoidance — bare RAISE
    // form required).
    expect((sql!.match(/CREATE TRIGGER /g) ?? []).length).toBe(2);
    expect(sql!).toMatch(
      /CREATE TRIGGER audit_log_no_update[\s\S]*BEFORE UPDATE ON audit_log/,
    );
    expect(sql!).toMatch(
      /CREATE TRIGGER audit_log_no_delete[\s\S]*BEFORE DELETE ON audit_log/,
    );
    // The two RAISE(ABORT) messages -- exact strings the test in
    // tests/db/audit-log.test.ts asserts on.
    expect(sql!).toContain("RAISE(ABORT, 'audit_log is append-only')");
    expect(sql!).toContain("RAISE(ABORT, 'audit_log is immutable')");
  });

  it("journal contains entries for 0034..0037 in idx range 33..36", () => {
    const expected = [
      { idx: 33, tag: "0034_tenants_table" },
      { idx: 34, tag: "0035_domain_table_tenant_ids" },
      { idx: 35, tag: "0036_union_schema" },
      { idx: 36, tag: "0037_audit_log" },
    ];
    for (const { idx, tag } of expected) {
      const entry = j.entries.find((e) => e.tag === tag);
      expect(entry).toBeDefined();
      expect(entry!.idx).toBe(idx);
    }
    // `when` is monotonically increasing across the four entries.
    const whens = expected.map(
      ({ tag }) => j.entries.find((e) => e.tag === tag)!.when,
    );
    for (let i = 1; i < whens.length; i++) {
      expect(whens[i]).toBeGreaterThan(whens[i - 1]);
    }
  });
});
