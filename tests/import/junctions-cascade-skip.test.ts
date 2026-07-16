/**
 * Tests — junctions cascade-skip + dual-track role mapping
 *
 * This suite pins two orthogonal contracts:
 *
 *   1. Cascade-skip. The `FailureReport` shape carries
 *      `rootCauseTable` and `cascadedFrom` fields so junction rows
 *      that fail FK resolution because their parent description
 *      failed validation trace back to the original cause.
 *
 *   2. Dual-track role mapping. `mapRoleEntityToCanonical` maps
 *      Spanish historical roles to the canonical English role (with
 *      the Spanish original preserved in `role_raw`),
 *      already-English roles passthrough, and unmapped roles are
 *      recorded as soft-skip errors.
 *
 * Fixture shape:
 *   - cascade-descriptions.json: 1 passing + 1 failing description
 *     (id=501 has reference_code with spaces — fails the
 *     reference-code pattern validator)
 *   - cascade-description-entities.json: 5 rows on description 501
 *     (cascade-skip), 3 rows on description 500 (dual-track role
 *     mapping: "Testigo" → witness, "creator" → creator
 *     passthrough, "Apoderado" → apoderado — `Fiador` and
 *     `Apoderado` are canonical Spanish-kept roles mirroring the
 *     `albacea` precedent)
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

describe("junctions cascade-skip + role mapping", () => {
  beforeEach(setUpOutputDir);
  afterEach(cleanOutput);

  it("records rootCauseTable and cascadedFrom for every junction whose parent description failed", async () => {
    const { importDescriptions } = await import(
      "../../scripts/commands/descriptions"
    );
    const { importRepositories } = await import(
      "../../scripts/commands/repositories"
    );
    const { importEntities } = await import("../../scripts/commands/entities");
    const { importDescriptionEntities } = await import(
      "../../scripts/commands/junctions"
    );

    const repoFixture = path.resolve("tests/import/fixtures/repositories.json");
    const { idMap: repoIdMap } = await importRepositories(repoFixture, outputDir);
    const descFixture = path.resolve(
      "tests/import/fixtures/round-builder/cascade-descriptions.json",
    );
    const { result: descResult, idMap: descIdMap } = await importDescriptions(
      descFixture,
      repoIdMap,
      outputDir,
    );
    const entityFixture = path.resolve(
      "tests/import/fixtures/round-builder/entities.json",
    );
    const { idMap: entityIdMap } = await importEntities(entityFixture, outputDir);

    // The broken description (id=501) must fail validation.
    const failedDescErrors = descResult.errors.filter((e) => e.oldId === 501);
    expect(failedDescErrors.length).toBeGreaterThan(0);

    const junctionFixture = path.resolve(
      "tests/import/fixtures/round-builder/cascade-description-entities.json",
    );
    const junctionResult = await importDescriptionEntities(
      junctionFixture,
      descIdMap,
      entityIdMap,
      undefined,
      undefined,
      outputDir,
    );

    // The 5 cascade rows (description_id=501) must each carry
    // rootCauseTable + cascadedFrom in the failure report.
    const cascadedErrors = junctionResult.errors.filter(
      (e) => (e as { rootCauseTable?: string }).rootCauseTable === "descriptions",
    );
    expect(cascadedErrors.length).toBeGreaterThanOrEqual(5);
    for (const err of cascadedErrors) {
      expect((err as { cascadedFrom?: number | string }).cascadedFrom).toBe(501);
    }
  });

  it("dual-track role mapping: 'Testigo' → role=witness + role_raw=Testigo", async () => {
    const { importDescriptions } = await import(
      "../../scripts/commands/descriptions"
    );
    const { importRepositories } = await import(
      "../../scripts/commands/repositories"
    );
    const { importEntities } = await import("../../scripts/commands/entities");
    const { importDescriptionEntities } = await import(
      "../../scripts/commands/junctions"
    );

    const repoFixture = path.resolve("tests/import/fixtures/repositories.json");
    const { idMap: repoIdMap } = await importRepositories(repoFixture, outputDir);
    const descFixture = path.resolve(
      "tests/import/fixtures/round-builder/cascade-descriptions.json",
    );
    const { idMap: descIdMap } = await importDescriptions(
      descFixture,
      repoIdMap,
      outputDir,
    );
    const entityFixture = path.resolve(
      "tests/import/fixtures/round-builder/entities.json",
    );
    const { idMap: entityIdMap } = await importEntities(entityFixture, outputDir);

    const junctionFixture = path.resolve(
      "tests/import/fixtures/round-builder/cascade-description-entities.json",
    );
    const result = await importDescriptionEntities(
      junctionFixture,
      descIdMap,
      entityIdMap,
      undefined,
      undefined,
      outputDir,
    );
    expect(result.sqlFiles.length).toBeGreaterThan(0);
    const content = await fs.readFile(result.sqlFiles[0], "utf8");

    // The "Testigo" row (id=1006) must land with role='witness' and
    // role_raw='Testigo' preserved.
    expect(content).toContain("witness");
    expect(content).toContain("Testigo");
  });

  it("dual-track role mapping: 'creator' passes through (role=creator + role_raw=creator)", async () => {
    const { importDescriptions } = await import(
      "../../scripts/commands/descriptions"
    );
    const { importRepositories } = await import(
      "../../scripts/commands/repositories"
    );
    const { importEntities } = await import("../../scripts/commands/entities");
    const { importDescriptionEntities } = await import(
      "../../scripts/commands/junctions"
    );

    const repoFixture = path.resolve("tests/import/fixtures/repositories.json");
    const { idMap: repoIdMap } = await importRepositories(repoFixture, outputDir);
    const descFixture = path.resolve(
      "tests/import/fixtures/round-builder/cascade-descriptions.json",
    );
    const { idMap: descIdMap } = await importDescriptions(
      descFixture,
      repoIdMap,
      outputDir,
    );
    const entityFixture = path.resolve(
      "tests/import/fixtures/round-builder/entities.json",
    );
    const { idMap: entityIdMap } = await importEntities(entityFixture, outputDir);

    const junctionFixture = path.resolve(
      "tests/import/fixtures/round-builder/cascade-description-entities.json",
    );
    const result = await importDescriptionEntities(
      junctionFixture,
      descIdMap,
      entityIdMap,
      undefined,
      undefined,
      outputDir,
    );
    expect(result.sqlFiles.length).toBeGreaterThan(0);
    const content = await fs.readFile(result.sqlFiles[0], "utf8");

    // The "creator" row (id=1007) must land verbatim — the canonical
    // role IS already 'creator', and role_raw should also be 'creator'.
    expect(content).toContain("creator");
    // role_raw column must be present in the COLUMNS array.
    expect(content).toContain("role_raw");
  });

  it("dual-track role mapping: 'Apoderado' resolves to canonical 'apoderado' + verbatim role_raw", async () => {
    const { importDescriptions } = await import(
      "../../scripts/commands/descriptions"
    );
    const { importRepositories } = await import(
      "../../scripts/commands/repositories"
    );
    const { importEntities } = await import("../../scripts/commands/entities");
    const { importDescriptionEntities } = await import(
      "../../scripts/commands/junctions"
    );

    const repoFixture = path.resolve("tests/import/fixtures/repositories.json");
    const { idMap: repoIdMap } = await importRepositories(repoFixture, outputDir);
    const descFixture = path.resolve(
      "tests/import/fixtures/round-builder/cascade-descriptions.json",
    );
    const { idMap: descIdMap } = await importDescriptions(
      descFixture,
      repoIdMap,
      outputDir,
    );
    const entityFixture = path.resolve(
      "tests/import/fixtures/round-builder/entities.json",
    );
    const { idMap: entityIdMap } = await importEntities(entityFixture, outputDir);

    const junctionFixture = path.resolve(
      "tests/import/fixtures/round-builder/cascade-description-entities.json",
    );
    const result = await importDescriptionEntities(
      junctionFixture,
      descIdMap,
      entityIdMap,
      undefined,
      undefined,
      outputDir,
    );

    // The "Apoderado" row (id=1008) must NOT produce an error — after
    // the v0.4 round 1 planner decision, 'Apoderado' maps to canonical
    // 'apoderado' and the verbatim string lands in role_raw.
    const apoderadoError = result.errors.find((e) =>
      e.errors.some((m) => m.includes("Apoderado")),
    );
    expect(apoderadoError).toBeUndefined();

    // The emitted SQL should carry both the canonical and verbatim
    // values for the Apoderado row.
    expect(result.sqlFiles.length).toBeGreaterThan(0);
    const content = await fs.readFile(result.sqlFiles[0], "utf8");
    expect(content).toContain("'apoderado'");
    expect(content).toContain("'Apoderado'");
  });
});

// Version: v0.4.1
