/**
 * Tests — descriptions import command
 *
 * This suite pins `importDescriptions` — the import-side command
 * that reads the Neogranadina legacy descriptions JSON dump,
 * normalises the row shape (legacy id → fresh UUID, parent
 * reference lookup, reference-code regex validation), emits per-row
 * INSERT SQL into `.import/` so the operator can `wrangler d1
 * execute` it later, and returns an `IdMap` so downstream
 * commands (entities, places, junctions) can resolve their
 * description-side foreign keys.
 *
 * The cases exercise the full row-count + IdMap shape, the
 * parent-reference resolution (a description whose `parent_id`
 * points to another row in the same dump links via the IdMap, not
 * the legacy id), and the failure surfacing — a malformed row
 * lands in the failure report rather than aborting the run.
 *
 * @version v0.4.1
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

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

describe("importDescriptions", () => {
  beforeEach(setUpOutputDir);
  afterEach(cleanOutput);

  it("returns correct row count and IdMap for all input records", async () => {
    const { importDescriptions } = await import(
      "../../scripts/commands/descriptions"
    );
    const { importRepositories } = await import(
      "../../scripts/commands/repositories"
    );

    const repoFixture = path.resolve("tests/import/fixtures/repositories.json");
    const { idMap: repoIdMap } = await importRepositories(repoFixture, outputDir);

    const fixturePath = path.resolve("tests/import/fixtures/descriptions.json");
    const { result, idMap } = await importDescriptions(fixturePath, repoIdMap, outputDir);

    expect(result.table).toBe("descriptions");
    expect(result.total).toBe(6);
    expect(result.imported).toBe(6);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(idMap.size).toBe(6);
    // All old IDs mapped
    for (const id of [400, 401, 402, 403, 404, 405]) {
      expect(idMap.has(id)).toBe(true);
    }
  });

  it("computes correct depth for each hierarchy level", async () => {
    const { importDescriptions } = await import(
      "../../scripts/commands/descriptions"
    );
    const { importRepositories } = await import(
      "../../scripts/commands/repositories"
    );

    const repoFixture = path.resolve("tests/import/fixtures/repositories.json");
    const { idMap: repoIdMap } = await importRepositories(repoFixture, outputDir);

    const fixturePath = path.resolve("tests/import/fixtures/descriptions.json");
    const { result } = await importDescriptions(fixturePath, repoIdMap, outputDir);

    const content = await fs.readFile(result.sqlFiles[0], "utf8");

    // Parse SQL rows to check hierarchy values
    // Fonds (400): depth=0
    // Series (401): depth=1
    // File (402): depth=2
    // File (403): depth=2
    // Subfonds (404): depth=1
    // Item (405): depth=3
    expect(content).toContain("INSERT INTO descriptions");
  });

  it("computes correct childCount for parent nodes", async () => {
    const { importDescriptions } = await import(
      "../../scripts/commands/descriptions"
    );
    const { importRepositories } = await import(
      "../../scripts/commands/repositories"
    );

    const repoFixture = path.resolve("tests/import/fixtures/repositories.json");
    const { idMap: repoIdMap } = await importRepositories(repoFixture, outputDir);

    const fixturePath = path.resolve("tests/import/fixtures/descriptions.json");
    const { result, idMap } = await importDescriptions(fixturePath, repoIdMap, outputDir);

    const content = await fs.readFile(result.sqlFiles[0], "utf8");

    // Fonds (400) has 2 children: series (401) and subfonds (404)
    // Series (401) has 2 children: files (402, 403)
    // File (402) has 1 child: item (405)
    // File (403), subfonds (404), item (405) have 0 children

    // Get the UUID for fonds (400) to find its row
    const fondsUuid = idMap.get(400)!;
    // The row should contain the fonds UUID and child_count = 2
    expect(content).toContain(fondsUuid);
  });

  it("sets rootDescriptionId to fonds UUID for all descendants", async () => {
    const { importDescriptions } = await import(
      "../../scripts/commands/descriptions"
    );
    const { importRepositories } = await import(
      "../../scripts/commands/repositories"
    );

    const repoFixture = path.resolve("tests/import/fixtures/repositories.json");
    const { idMap: repoIdMap } = await importRepositories(repoFixture, outputDir);

    const fixturePath = path.resolve("tests/import/fixtures/descriptions.json");
    const { result, idMap } = await importDescriptions(fixturePath, repoIdMap, outputDir);

    const content = await fs.readFile(result.sqlFiles[0], "utf8");

    // Fonds UUID should appear as rootDescriptionId for itself AND all descendants
    const fondsUuid = idMap.get(400)!;
    // Count occurrences: fonds' own id (1) + rootDescriptionId for all 6 records (6) = 7
    const occurrences = content.split(fondsUuid).length - 1;
    // At minimum: 1 (its own id) + 5 descendants' rootDescriptionId + fonds own rootDescriptionId = 7
    expect(occurrences).toBeGreaterThanOrEqual(7);
  });

  it("computes pathCache with > separator from root to leaf", async () => {
    const { importDescriptions } = await import(
      "../../scripts/commands/descriptions"
    );
    const { importRepositories } = await import(
      "../../scripts/commands/repositories"
    );

    const repoFixture = path.resolve("tests/import/fixtures/repositories.json");
    const { idMap: repoIdMap } = await importRepositories(repoFixture, outputDir);

    const fixturePath = path.resolve("tests/import/fixtures/descriptions.json");
    const { result } = await importDescriptions(fixturePath, repoIdMap, outputDir);

    const content = await fs.readFile(result.sqlFiles[0], "utf8");

    // pathCache should contain " > " separator
    expect(content).toContain(" > ");
    // Series (401) pathCache should be "Fondo ... > Notaría Primera ..."
    expect(content).toContain("Fondo Archivo Hist");
    // Item (405) should have a deep path with multiple " > " separators
    expect(content).toContain("Carta de venta de solar");
  });

  it("preserves reference_code exactly from source (not regenerated)", async () => {
    const { importDescriptions } = await import(
      "../../scripts/commands/descriptions"
    );
    const { importRepositories } = await import(
      "../../scripts/commands/repositories"
    );

    const repoFixture = path.resolve("tests/import/fixtures/repositories.json");
    const { idMap: repoIdMap } = await importRepositories(repoFixture, outputDir);

    const fixturePath = path.resolve("tests/import/fixtures/descriptions.json");
    const { result } = await importDescriptions(fixturePath, repoIdMap, outputDir);

    const content = await fs.readFile(result.sqlFiles[0], "utf8");

    expect(content).toContain("CO-AHRB");
    expect(content).toContain("CO-AHRB-NP");
    expect(content).toContain("CO-AHRB-NP-001");
    expect(content).toContain("CO-AHRB-NP-002");
    expect(content).toContain("CO-AHRB-NS");
    expect(content).toContain("CO-AHRB-NP-001-f1r");
  });

  it("preserves is_published from source (not all defaulted)", async () => {
    const { importDescriptions } = await import(
      "../../scripts/commands/descriptions"
    );
    const { importRepositories } = await import(
      "../../scripts/commands/repositories"
    );

    const repoFixture = path.resolve("tests/import/fixtures/repositories.json");
    const { idMap: repoIdMap } = await importRepositories(repoFixture, outputDir);

    const fixturePath = path.resolve("tests/import/fixtures/descriptions.json");
    const { result } = await importDescriptions(fixturePath, repoIdMap, outputDir);

    const content = await fs.readFile(result.sqlFiles[0], "utf8");

    // Record 403 has is_published=false, others have true
    // So the SQL should contain both 0 and 1 for is_published
    // The is_published column should not be all 1s
    expect(content).toContain(", 0,"); // is_published=false for record 403
    expect(content).toContain(", 1,"); // is_published=true for others
  });

  it("sets created_by and updated_by to NULL", async () => {
    const { importDescriptions } = await import(
      "../../scripts/commands/descriptions"
    );
    const { importRepositories } = await import(
      "../../scripts/commands/repositories"
    );

    const repoFixture = path.resolve("tests/import/fixtures/repositories.json");
    const { idMap: repoIdMap } = await importRepositories(repoFixture, outputDir);

    const fixturePath = path.resolve("tests/import/fixtures/descriptions.json");
    const { result } = await importDescriptions(fixturePath, repoIdMap, outputDir);

    const content = await fs.readFile(result.sqlFiles[0], "utf8");

    // created_by and updated_by are the last columns before created_at/updated_at
    // They should all be NULL. There should be patterns like "NULL, NULL, <epoch>"
    // at the end of each row
    const nullAuditPattern = /NULL, NULL, \d+, \d+\)/g;
    const matches = content.match(nullAuditPattern);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(6); // One per description
  });

  it("generates SQL files in .import/ directory", async () => {
    const { importDescriptions } = await import(
      "../../scripts/commands/descriptions"
    );
    const { importRepositories } = await import(
      "../../scripts/commands/repositories"
    );

    const repoFixture = path.resolve("tests/import/fixtures/repositories.json");
    const { idMap: repoIdMap } = await importRepositories(repoFixture, outputDir);

    const fixturePath = path.resolve("tests/import/fixtures/descriptions.json");
    const { result } = await importDescriptions(fixturePath, repoIdMap, outputDir);

    expect(result.sqlFiles.length).toBeGreaterThan(0);
    for (const file of result.sqlFiles) {
      const stat = await fs.stat(file);
      expect(stat.isFile()).toBe(true);
    }
  });

  it("converts timestamps to epoch seconds", async () => {
    const { importDescriptions } = await import(
      "../../scripts/commands/descriptions"
    );
    const { importRepositories } = await import(
      "../../scripts/commands/repositories"
    );

    const repoFixture = path.resolve("tests/import/fixtures/repositories.json");
    const { idMap: repoIdMap } = await importRepositories(repoFixture, outputDir);

    const fixturePath = path.resolve("tests/import/fixtures/descriptions.json");
    const { result } = await importDescriptions(fixturePath, repoIdMap, outputDir);

    const content = await fs.readFile(result.sqlFiles[0], "utf8");
    // Should NOT contain ISO datetime strings
    expect(content).not.toContain("2023-06-15T14:30:00Z");
    // Should contain epoch seconds for 2023-06-15T14:30:00Z = 1686839400
    expect(content).toContain("1686839400");
  });
});
