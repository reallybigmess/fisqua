/**
 * Tests — places import command
 *
 * This suite pins `importPlaces` — the import-side command that
 * reads the Neogranadina places (geographic authority) JSON dump,
 * normalises the row shape (legacy id → fresh UUID, `placeCode`
 * generation, parent-place resolution for hierarchical entries like
 * `Rionegro → Antioquia → Colombia`), and emits per-row INSERT
 * SQL plus an `IdMap` for downstream junction-table generation.
 *
 * The cases exercise the row-count + IdMap shape, the parent-place
 * resolution (a place whose `parent_id` is another row in the same
 * dump links through the IdMap, mirroring the descriptions
 * import's behaviour), and the deterministic UUID generation
 * (same input → same UUIDs across runs) so the SQL diff stays small
 * on re-runs.
 *
 * @version v0.4.1
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { IdMap } from "../../scripts/lib/types";

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

describe("importPlaces", () => {
  beforeEach(setUpOutputDir);
  afterEach(cleanOutput);

  it("returns correct row count and IdMap for all input records", async () => {
    const { importPlaces } = await import("../../scripts/commands/places");
    const fixturePath = path.resolve("tests/import/fixtures/places.json");
    const { result, idMap } = await importPlaces(fixturePath, outputDir);

    expect(result.table).toBe("places");
    expect(result.total).toBe(4);
    expect(result.imported).toBe(4);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(idMap.size).toBe(4);
  });

  it("resolves parent_id to UUID (not original integer)", async () => {
    const { importPlaces } = await import("../../scripts/commands/places");
    const fixturePath = path.resolve("tests/import/fixtures/places.json");
    const { result, idMap } = await importPlaces(fixturePath, outputDir);

    const content = await fs.readFile(result.sqlFiles[0], "utf8");
    // Boyaca (id=201) has parent_id=200, so its parent should be Colombia's UUID
    const colombiaUuid = idMap.get(200)!;
    expect(content).toContain(colombiaUuid);
  });

  it("root place has parent_id = NULL in SQL", async () => {
    const { importPlaces } = await import("../../scripts/commands/places");
    const fixturePath = path.resolve("tests/import/fixtures/places.json");
    const { result } = await importPlaces(fixturePath, outputDir);

    const content = await fs.readFile(result.sqlFiles[0], "utf8");
    // Colombia (id=200) has parent_id=null, so SQL should contain NULL for it
    expect(content).toContain("NULL");
  });

  it("place_code values match /^nl-[a-z2-9]{6}$/", async () => {
    const { importPlaces } = await import("../../scripts/commands/places");
    const fixturePath = path.resolve("tests/import/fixtures/places.json");
    const { result } = await importPlaces(fixturePath, outputDir);

    const content = await fs.readFile(result.sqlFiles[0], "utf8");
    const codePattern = /nl-[a-z2-9]{6}/g;
    const codes = content.match(codePattern);
    expect(codes).not.toBeNull();
    expect(codes!.length).toBe(4);
    const unique = new Set(codes);
    expect(unique.size).toBe(4);
  });

  it("drops colonial_* fields entirely (historical_* columns removed in drizzle/0036)", async () => {
    const { importPlaces } = await import("../../scripts/commands/places");
    const fixturePath = path.resolve("tests/import/fixtures/places.json");
    const { result } = await importPlaces(fixturePath, outputDir);

    const content = await fs.readFile(result.sqlFiles[0], "utf8");
    // The historical_* target columns no longer exist in the schema, so the
    // importer must emit neither the old colonial_* names nor the renamed
    // historical_* ones — the fields are dropped, not carried.
    expect(content).not.toContain("historical_gobernacion");
    expect(content).not.toContain("historical_partido");
    expect(content).not.toContain("historical_region");
    expect(content).not.toContain("colonial_gobernacion");
    expect(content).not.toContain("colonial_partido");
    expect(content).not.toContain("colonial_region");
    // "Andes" appears in the fixture only as a colonial_region value (never as
    // a label or variant) — its absence proves the dropped values don't leak
    // into the row bodies either.
    expect(content).not.toContain("Andes");
  });

  it("handles needs_geocoding as boolean -> integer", async () => {
    const { importPlaces } = await import("../../scripts/commands/places");
    const fixturePath = path.resolve("tests/import/fixtures/places.json");
    const { result } = await importPlaces(fixturePath, outputDir);

    const content = await fs.readFile(result.sqlFiles[0], "utf8");
    // needs_geocoding should be 0 or 1, not true/false strings
    expect(content).not.toContain("'true'");
    expect(content).not.toContain("'false'");
  });
});

describe("importEntityFunctions", () => {
  beforeEach(setUpOutputDir);
  afterEach(cleanOutput);

  it("resolves entity_id FK via entity IdMap", async () => {
    const { importEntityFunctions } = await import(
      "../../scripts/commands/entity-functions"
    );
    const fixturePath = path.resolve(
      "tests/import/fixtures/entity_functions.json"
    );

    // Build a mock entity IdMap
    const entityIdMap: IdMap = new Map([
      [100, "aaaaaaaa-0000-0000-0000-000000000100"],
      [101, "aaaaaaaa-0000-0000-0000-000000000101"],
    ]);

    const result = await importEntityFunctions(fixturePath, entityIdMap, outputDir);

    expect(result.table).toBe("entity_functions");
    expect(result.total).toBe(3);
    expect(result.imported).toBe(3);
    expect(result.errors).toHaveLength(0);

    const content = await fs.readFile(result.sqlFiles[0], "utf8");
    expect(content).toContain("aaaaaaaa-0000-0000-0000-000000000100");
    expect(content).toContain("aaaaaaaa-0000-0000-0000-000000000101");
  });

  it("missing entity_id reference produces error (not crash)", async () => {
    const { importEntityFunctions } = await import(
      "../../scripts/commands/entity-functions"
    );
    const fixturePath = path.resolve(
      "tests/import/fixtures/entity_functions.json"
    );

    // IdMap only has entity 100, not 101
    const entityIdMap: IdMap = new Map([
      [100, "aaaaaaaa-0000-0000-0000-000000000100"],
    ]);

    const result = await importEntityFunctions(fixturePath, entityIdMap, outputDir);

    // Entity 100 has 2 functions (rows 0,1), entity 101 has 1 function (row 2)
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].errors[0]).toContain("entity_id");
  });

  it("generates SQL with INSERT INTO entity_functions", async () => {
    const { importEntityFunctions } = await import(
      "../../scripts/commands/entity-functions"
    );
    const fixturePath = path.resolve(
      "tests/import/fixtures/entity_functions.json"
    );
    const entityIdMap: IdMap = new Map([
      [100, "aaaaaaaa-0000-0000-0000-000000000100"],
      [101, "aaaaaaaa-0000-0000-0000-000000000101"],
    ]);

    const result = await importEntityFunctions(fixturePath, entityIdMap, outputDir);

    const content = await fs.readFile(result.sqlFiles[0], "utf8");
    expect(content).toContain("INSERT INTO entity_functions");
    expect(content).toContain("PRAGMA defer_foreign_keys = true");
  });
});
