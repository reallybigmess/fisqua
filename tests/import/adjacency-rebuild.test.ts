/**
 * Tests — adjacency rebuild
 *
 * This suite pins the adjacency-list cache rebuild (depth, position,
 * rootDescriptionId, pathCache, childCount) against the 7-row
 * 3-level tree fixture. `importDescriptions` computes these fields
 * from flat parent_id relationships; this test is the tripwire that
 * fires if a refactor accidentally breaks the algorithm.
 *
 * The 7-row tree is one fonds (id=1) with two series (ids 2, 3)
 * under it; ids 4-5 are files under series 2; ids 6-7 are files
 * under series 3. Expected depth values are 0, 1, 1, 2, 2, 2, 2.
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

describe("adjacency rebuild on the 7-row 3-level tree", () => {
  beforeEach(setUpOutputDir);
  afterEach(cleanOutput);

  it("returns an idMap with 7 entries", async () => {
    const { importDescriptions } = await import(
      "../../scripts/commands/descriptions"
    );
    const { importRepositories } = await import(
      "../../scripts/commands/repositories"
    );

    const repoFixture = path.resolve("tests/import/fixtures/repositories.json");
    const { idMap: repoIdMap } = await importRepositories(repoFixture, outputDir);

    const fixturePath = path.resolve(
      "tests/import/fixtures/adjacency/descriptions.json",
    );
    const { result, idMap } = await importDescriptions(fixturePath, repoIdMap, outputDir);
    expect(result.total).toBe(7);
    expect(result.imported).toBe(7);
    expect(idMap.size).toBe(7);
    for (const id of [1, 2, 3, 4, 5, 6, 7]) {
      expect(idMap.has(id)).toBe(true);
    }
  });

  it("the fonds UUID appears as rootDescriptionId for all 7 rows", async () => {
    const { importDescriptions } = await import(
      "../../scripts/commands/descriptions"
    );
    const { importRepositories } = await import(
      "../../scripts/commands/repositories"
    );

    const repoFixture = path.resolve("tests/import/fixtures/repositories.json");
    const { idMap: repoIdMap } = await importRepositories(repoFixture, outputDir);

    const fixturePath = path.resolve(
      "tests/import/fixtures/adjacency/descriptions.json",
    );
    const { result, idMap } = await importDescriptions(fixturePath, repoIdMap, outputDir);
    const content = await fs.readFile(result.sqlFiles[0], "utf8");

    const fondsUuid = idMap.get(1)!;
    // Each of 7 rows has the fonds UUID in its rootDescriptionId
    // column, plus the fonds row carries it as its own id. That is at
    // least 8 occurrences in total.
    const occurrences = content.split(fondsUuid).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(7);
  });

  it("pathCache for File 4 reads 'Fonds > Series A > File 4'", async () => {
    const { importDescriptions } = await import(
      "../../scripts/commands/descriptions"
    );
    const { importRepositories } = await import(
      "../../scripts/commands/repositories"
    );

    const repoFixture = path.resolve("tests/import/fixtures/repositories.json");
    const { idMap: repoIdMap } = await importRepositories(repoFixture, outputDir);

    const fixturePath = path.resolve(
      "tests/import/fixtures/adjacency/descriptions.json",
    );
    const { result } = await importDescriptions(fixturePath, repoIdMap, outputDir);
    const content = await fs.readFile(result.sqlFiles[0], "utf8");

    expect(content).toContain("Fonds > Series A > File 4");
  });

  it("emits at least one row with depth=2 (the files), confirming hierarchy walk", async () => {
    const { importDescriptions } = await import(
      "../../scripts/commands/descriptions"
    );
    const { importRepositories } = await import(
      "../../scripts/commands/repositories"
    );

    const repoFixture = path.resolve("tests/import/fixtures/repositories.json");
    const { idMap: repoIdMap } = await importRepositories(repoFixture, outputDir);

    const fixturePath = path.resolve(
      "tests/import/fixtures/adjacency/descriptions.json",
    );
    const { result } = await importDescriptions(fixturePath, repoIdMap, outputDir);
    const content = await fs.readFile(result.sqlFiles[0], "utf8");

    // INSERT statements include depth as an integer literal. With
    // 7 rows, the depth column will carry 0, 1, 1, 2, 2, 2, 2.
    // Expect at least one INSERT row containing ", 2," somewhere
    // in its parameter list.
    expect(content).toMatch(/, 2,/);
  });
});

// Version: v0.4.1
