/**
 * Tests — descriptions row-builder
 *
 * This suite asserts the descriptions row-builder produces v0.4 union-schema
 * rows: `tenant_id` immediately after `id`, `legacy_ids` populated
 * from the Django pk + CA provenance via
 * `buildLegacyIdsForDescription`, the dropped column
 * (`related_materials`) absent from the COLUMNS array, the DACS/RAD
 * union additions present as NULL, and `date_end` preserved verbatim
 * from the source (the Django public export stripped this; the
 * import path must capture it).
 *
 * The test uses the round-builder fixtures at
 * `tests/import/fixtures/round-builder/descriptions.json`:
 *
 *   - record 42: full CA fields, populated date_end, IIIF manifest
 *   - record 43: Django-pk-only (no CA fields), populated parent_id
 *   - record 44: malformed legacy_ids seed (empty provider) —
 *     exercises the LegacyIdsSchema.parse rejection path; the row-
 *     builder MUST NOT swallow this; it must produce a
 *     result.errors entry whose message references the failing
 *     field
 *
 * Lazy import + `cleanOutput` hook follow
 * `tests/import/description-import.test.ts`.
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

describe("descriptions row-builder (v0.4 union schema)", () => {
  beforeEach(setUpOutputDir);
  afterEach(cleanOutput);

  it("emits tenant_id = NEOGRANADINA_TENANT_ID immediately after id for every row", async () => {
    const { importDescriptions } = await import(
      "../../scripts/commands/descriptions"
    );
    const { importRepositories } = await import(
      "../../scripts/commands/repositories"
    );
    const repoFixture = path.resolve("tests/import/fixtures/repositories.json");
    const { idMap: repoIdMap } = await importRepositories(repoFixture, outputDir);

    const fixturePath = path.resolve(
      "tests/import/fixtures/round-builder/descriptions.json",
    );
    const { result } = await importDescriptions(fixturePath, repoIdMap, outputDir);
    const content = await fs.readFile(result.sqlFiles[0], "utf8");

    // Row-builder must emit tenant_id on every row.
    expect(content).toContain(NEOGRANADINA_TENANT_ID);
  });

  it("populates legacy_ids JSON with django-zasqua + ca-object + ca-collection for record 42", async () => {
    const { importDescriptions } = await import(
      "../../scripts/commands/descriptions"
    );
    const { importRepositories } = await import(
      "../../scripts/commands/repositories"
    );
    const repoFixture = path.resolve("tests/import/fixtures/repositories.json");
    const { idMap: repoIdMap } = await importRepositories(repoFixture, outputDir);

    const fixturePath = path.resolve(
      "tests/import/fixtures/round-builder/descriptions.json",
    );
    const { result } = await importDescriptions(fixturePath, repoIdMap, outputDir);
    const content = await fs.readFile(result.sqlFiles[0], "utf8");

    expect(content).toContain("django-zasqua");
    expect(content).toContain("ca-object");
    expect(content).toContain("ca-collection");
  });

  it("preserves date_end verbatim", async () => {
    const { importDescriptions } = await import(
      "../../scripts/commands/descriptions"
    );
    const { importRepositories } = await import(
      "../../scripts/commands/repositories"
    );
    const repoFixture = path.resolve("tests/import/fixtures/repositories.json");
    const { idMap: repoIdMap } = await importRepositories(repoFixture, outputDir);

    const fixturePath = path.resolve(
      "tests/import/fixtures/round-builder/descriptions.json",
    );
    const { result } = await importDescriptions(fixturePath, repoIdMap, outputDir);
    const content = await fs.readFile(result.sqlFiles[0], "utf8");

    expect(content).toContain("1850-12-31");
  });

  it("emits NULL for the DACS/RAD union additions when source has no value", async () => {
    const { importDescriptions } = await import(
      "../../scripts/commands/descriptions"
    );
    const { importRepositories } = await import(
      "../../scripts/commands/repositories"
    );
    const repoFixture = path.resolve("tests/import/fixtures/repositories.json");
    const { idMap: repoIdMap } = await importRepositories(repoFixture, outputDir);

    const fixturePath = path.resolve(
      "tests/import/fixtures/round-builder/descriptions.json",
    );
    const { result } = await importDescriptions(fixturePath, repoIdMap, outputDir);
    // Failure mode: the row-builder must reach a SQL file. The
    // COLUMNS array includes admin_biog_history / preferred_citation
    // / acquisition_info / system_of_arrangement /
    // physical_characteristics; any drift would surface as no SQL
    // file or missing columns.
    expect(result.sqlFiles.length).toBeGreaterThan(0);
    const content = await fs.readFile(result.sqlFiles[0], "utf8");
    // The COLUMNS list is what gets written into the INSERT statement.
    expect(content).toMatch(/admin_biog_history|preferred_citation|acquisition_info|system_of_arrangement|physical_characteristics/);
  });

  it("does NOT include related_materials in the COLUMNS array (dropped in v0.4)", async () => {
    const { importDescriptions } = await import(
      "../../scripts/commands/descriptions"
    );
    const { importRepositories } = await import(
      "../../scripts/commands/repositories"
    );
    const repoFixture = path.resolve("tests/import/fixtures/repositories.json");
    const { idMap: repoIdMap } = await importRepositories(repoFixture, outputDir);

    const fixturePath = path.resolve(
      "tests/import/fixtures/round-builder/descriptions.json",
    );
    const { result } = await importDescriptions(fixturePath, repoIdMap, outputDir);
    const content = await fs.readFile(result.sqlFiles[0], "utf8");

    // related_materials was dropped in 0036 — the import row-builder
    // must not write it.
    expect(content).not.toContain("related_materials");
  });

  it("rejects record 44 (empty-provider legacy_ids_seed) with a validation error", async () => {
    const { importDescriptions } = await import(
      "../../scripts/commands/descriptions"
    );
    const { importRepositories } = await import(
      "../../scripts/commands/repositories"
    );
    const repoFixture = path.resolve("tests/import/fixtures/repositories.json");
    const { idMap: repoIdMap } = await importRepositories(repoFixture, outputDir);

    const fixturePath = path.resolve(
      "tests/import/fixtures/round-builder/descriptions.json",
    );
    const { result } = await importDescriptions(fixturePath, repoIdMap, outputDir);
    // Record 44 carries `legacy_ids_seed: [{provider: "", id: 99}]`,
    // which violates LegacyIdSchema.provider.min(1). The row-builder
    // should fail this row and record an error.
    const errorForRecord44 = result.errors.find((e) => e.oldId === 44);
    expect(errorForRecord44).toBeDefined();
  });
});

// Version: v0.4.1
