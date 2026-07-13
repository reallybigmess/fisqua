/**
 * Tests -- repeatable
 *
 * This suite pins the current shape of the import clear + FTS rebuild
 * surfaces. Earlier tests here exercised an unscoped `generateClearSql` and a
 * two-table FTS rebuild. Both surfaces were rewritten: clear is now
 * tenant-scoped to Neogranadina and the FTS rebuild covers all
 * three FTS5 tables. This test file pins the current shape. Each
 * (a)-(g) assertion is its own `expect(...)` so a regression
 * pinpoints the missing/extra DELETE rather than collapsing into
 * one uninformative failure.
 *
 * @version v0.4.1
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { NEOGRANADINA_TENANT_ID } from "../../app/lib/tenant";

// Per-suite scratch dir (never the production `.import/` snapshot dir —
// see audit item 23).
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

describe("generateTenantScopedClearSql -- explicit shape assertions", () => {
  beforeEach(setUpOutputDir);
  afterEach(cleanOutput);

  it("emits exactly the five tenant-scoped DELETEs and no unscoped ones", async () => {
    const { generateTenantScopedClearSql } = await import(
      "../../scripts/commands/clear"
    );

    const sqlFiles = await generateTenantScopedClearSql({ outputDir });
    expect(sqlFiles.length).toBeGreaterThan(0);
    const content = await fs.readFile(sqlFiles[0], "utf8");

    // (a) exactly one tenant-scoped DELETE on descriptions
    expect(
      (content.match(/DELETE FROM descriptions WHERE tenant_id =/g) ?? [])
        .length,
    ).toBe(1);

    // (b) exactly one tenant-scoped DELETE on entities
    expect(
      (content.match(/DELETE FROM entities WHERE tenant_id =/g) ?? [])
        .length,
    ).toBe(1);

    // (c) exactly one tenant-scoped DELETE on places
    expect(
      (content.match(/DELETE FROM places WHERE tenant_id =/g) ?? [])
        .length,
    ).toBe(1);

    // (d) exactly one tenant-scoped DELETE on repositories
    expect(
      (content.match(/DELETE FROM repositories WHERE tenant_id =/g) ?? [])
        .length,
    ).toBe(1);

    // (e) exactly one JOIN-DELETE on entity_functions
    //     (entity_functions has no tenant_id column; it inherits via
    //      entity_id FK with ON DELETE CASCADE)
    expect(
      (
        content.match(/DELETE FROM entity_functions WHERE entity_id IN/g) ??
        []
      ).length,
    ).toBe(1);

    // (f) the NEOGRANADINA tenant id literal appears at least 5 times --
    //     once per tenant-scoped DELETE plus once inside the
    //     entity_functions JOIN-subquery (covers all five DELETE
    //     statements + the SELECT id FROM entities WHERE tenant_id = ...)
    const neoCount = (
      content.match(new RegExp(NEOGRANADINA_TENANT_ID, "g")) ?? []
    ).length;
    expect(neoCount).toBeGreaterThanOrEqual(5);

    // (g) no unscoped DELETE survives -- regex catches a bare
    //     `DELETE FROM <table>;` on any of the five tables on its own
    //     line. A single missed WHERE clause here is the structural
    //     failure mode this assertion exists to catch.
    expect(content).not.toMatch(
      /^\s*DELETE\s+FROM\s+(descriptions|entities|places|repositories|entity_functions)\s*;/m,
    );
  });

  it("includes PRAGMA defer_foreign_keys", async () => {
    const { generateTenantScopedClearSql } = await import(
      "../../scripts/commands/clear"
    );

    const sqlFiles = await generateTenantScopedClearSql({ outputDir });
    const content = await fs.readFile(sqlFiles[0], "utf8");

    expect(content).toContain("PRAGMA defer_foreign_keys = true");
  });
});

describe("generateFtsRebuild -- three FTS5 tables", () => {
  beforeEach(setUpOutputDir);
  afterEach(cleanOutput);

  it("produces rebuild commands for entities_fts, places_fts, and descriptions_fts", async () => {
    const { generateFtsRebuild } = await import(
      "../../scripts/commands/clear"
    );

    const sqlFiles = await generateFtsRebuild(outputDir);

    expect(sqlFiles.length).toBeGreaterThan(0);
    const content = await fs.readFile(sqlFiles[0], "utf8");

    expect(content).toContain(
      "INSERT INTO entities_fts(entities_fts) VALUES('rebuild')",
    );
    expect(content).toContain(
      "INSERT INTO places_fts(places_fts) VALUES('rebuild')",
    );
    expect(content).toContain(
      "INSERT INTO descriptions_fts(descriptions_fts) VALUES('rebuild')",
    );
  });
});

describe("importDescriptionEntities", () => {
  beforeEach(setUpOutputDir);
  afterEach(cleanOutput);

  it("resolves both description and entity FKs via IdMaps", async () => {
    const { importDescriptionEntities } = await import(
      "../../scripts/commands/junctions"
    );
    const type = await import("../../scripts/lib/types");

    // Build mock IdMaps matching fixture data
    const descIdMap: InstanceType<typeof Map<number, string>> = new Map([
      [400, "desc-uuid-400"],
      [405, "desc-uuid-405"],
    ]);
    const entityIdMap: InstanceType<typeof Map<number, string>> = new Map([
      [101, "entity-uuid-101"],
      [102, "entity-uuid-102"],
      [104, "entity-uuid-104"],
    ]);

    const fixturePath = path.resolve(
      "tests/import/fixtures/description_entities.json"
    );
    const result = await importDescriptionEntities(
      fixturePath,
      descIdMap,
      entityIdMap,
      undefined,
      undefined,
      outputDir
    );

    expect(result.table).toBe("description_entities");
    expect(result.total).toBe(3);
    expect(result.imported).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);

    // Verify SQL was generated
    expect(result.sqlFiles.length).toBeGreaterThan(0);
    const content = await fs.readFile(result.sqlFiles[0], "utf8");
    expect(content).toContain("INSERT INTO description_entities");
    expect(content).toContain("desc-uuid-405");
    expect(content).toContain("entity-uuid-102");
  });

  it("skips rows with missing FK references and reports errors", async () => {
    const { importDescriptionEntities } = await import(
      "../../scripts/commands/junctions"
    );

    // Partial IdMaps -- missing entity 104
    const descIdMap = new Map<number, string>([
      [400, "desc-uuid-400"],
      [405, "desc-uuid-405"],
    ]);
    const entityIdMap = new Map<number, string>([
      [101, "entity-uuid-101"],
      [102, "entity-uuid-102"],
      // 104 is missing
    ]);

    const fixturePath = path.resolve(
      "tests/import/fixtures/description_entities.json"
    );
    const result = await importDescriptionEntities(
      fixturePath,
      descIdMap,
      entityIdMap,
      undefined,
      undefined,
      outputDir
    );

    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].errors[0]).toContain("entity_id");
  });
});

describe("importDescriptionPlaces", () => {
  beforeEach(setUpOutputDir);
  afterEach(cleanOutput);

  it("resolves both description and place FKs via IdMaps", async () => {
    const { importDescriptionPlaces } = await import(
      "../../scripts/commands/junctions"
    );

    const descIdMap = new Map<number, string>([
      [405, "desc-uuid-405"],
    ]);
    const placeIdMap = new Map<number, string>([
      [202, "place-uuid-202"],
      [203, "place-uuid-203"],
    ]);

    const fixturePath = path.resolve(
      "tests/import/fixtures/description_places.json"
    );
    const result = await importDescriptionPlaces(
      fixturePath,
      descIdMap,
      placeIdMap,
      undefined,
      undefined,
      outputDir
    );

    expect(result.table).toBe("description_places");
    expect(result.total).toBe(2);
    expect(result.imported).toBe(2);
    expect(result.errors).toHaveLength(0);

    const content = await fs.readFile(result.sqlFiles[0], "utf8");
    expect(content).toContain("INSERT INTO description_places");
    expect(content).toContain("desc-uuid-405");
    expect(content).toContain("place-uuid-202");
  });
});
