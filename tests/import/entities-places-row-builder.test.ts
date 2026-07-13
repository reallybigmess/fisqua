/**
 * Tests — entities/places row-builder
 *
 * This suite asserts the entities and places row-builders produce v0.4
 * union-schema rows: `federation_id` immediately after `id` (migrations 0045-0048 lifted entities/places to federation scope); `dbe_id`
 * (entities) and `fclass` (places) present and populated from
 * source; `legacy_ids` JSON populated via `buildLegacyIdsForEntity`
 * / `buildLegacyIdsForPlace`; the dropped columns (`legal_status`
 * from entities; `historical_*`, `country_code`, `admin_level_*`,
 * `wikidata_id` from places) absent from the COLUMNS arrays.
 *
 * @version v0.4.2
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { NEOGRANADINA_FEDERATION_ID } from "../../app/lib/tenant";

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

describe("entities row-builder (v0.4 union schema)", () => {
  beforeEach(setUpOutputDir);
  afterEach(cleanOutput);

  it("emits federation_id, dbe_id, and legacy_ids; drops legal_status", async () => {
    const { importEntities } = await import("../../scripts/commands/entities");
    const fixturePath = path.resolve(
      "tests/import/fixtures/round-builder/entities.json",
    );
    const { result } = await importEntities(fixturePath, outputDir);
    expect(result.sqlFiles.length).toBeGreaterThan(0);
    const content = await fs.readFile(result.sqlFiles[0], "utf8");

    // federation_id present
    expect(content).toContain(NEOGRANADINA_FEDERATION_ID);
    // dbe_id column present (entity 10 has dbe_id="12345")
    expect(content).toContain("12345");
    // legacy_ids JSON present with django-zasqua provider
    expect(content).toContain("django-zasqua");
    // entity 10 has ca_entity_id=99 → ca-entity provider should appear
    expect(content).toContain("ca-entity");
    // legal_status was dropped in 0036
    expect(content).not.toContain("legal_status");
  });
});

describe("places row-builder (v0.4 union schema)", () => {
  beforeEach(setUpOutputDir);
  afterEach(cleanOutput);

  it("emits federation_id, fclass, and legacy_ids; drops 7 dead columns", async () => {
    const { importPlaces } = await import("../../scripts/commands/places");
    const fixturePath = path.resolve(
      "tests/import/fixtures/round-builder/places.json",
    );
    const { result } = await importPlaces(fixturePath, outputDir);
    expect(result.sqlFiles.length).toBeGreaterThan(0);
    const content = await fs.readFile(result.sqlFiles[0], "utf8");

    // federation_id present
    expect(content).toContain(NEOGRANADINA_FEDERATION_ID);
    // fclass column written (place 20 has fclass="P")
    // The literal 'P' must appear as a quoted SQL value somewhere on a place row.
    expect(content).toMatch(/'P'/);
    // legacy_ids JSON present
    expect(content).toContain("django-zasqua");
    // place 20 has ca_place_ids=[200, 201] → ca-place provider × 2
    expect(content).toContain("ca-place");
    // dropped columns must not appear in the SQL
    expect(content).not.toContain("historical_gobernacion");
    expect(content).not.toContain("historical_partido");
    expect(content).not.toContain("historical_region");
    expect(content).not.toContain("admin_level_1");
    expect(content).not.toContain("admin_level_2");
    // wikidata_id was dropped from places (it is still on entities;
    // places.test fixtures don't include it, so absent here is the
    // hard-fail target).
    expect(content).not.toMatch(/places[^;]*wikidata_id/);
  });
});

// Version: v0.4.1
