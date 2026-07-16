/**
 * Tests — reference_code shape gate (multilingual + paren-strip)
 *
 * This suite locks the v0.4 round 1 cleanup of the legacy cihjml-acc collection:
 *   - Spanish (and other Latin-script) diacritics pass the regex.
 *   - Trailing `(` / `)` cataloguer typos are stripped before validation.
 *   - NFC normalisation collapses combining-mark forms.
 *   - The 1–50 char and Unicode-letter+digit+hyphen contract still
 *     rejects truly malformed ids.
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

interface MinimalDescription {
  id: number;
  repository_id: number;
  parent_id: number | null;
  description_level: string;
  resource_type: string;
  genre: unknown[];
  reference_code: string | null;
  local_identifier: string | null;
  title: string;
  [k: string]: unknown;
}

function makeRow(
  id: number,
  reference_code: string | null,
  overrides: Partial<MinimalDescription> = {},
): MinimalDescription {
  return {
    id,
    repository_id: 1,
    parent_id: null,
    description_level: "fonds",
    resource_type: "text",
    genre: [],
    reference_code,
    local_identifier: null,
    title: `Test ${id}`,
    translated_title: null,
    uniform_title: null,
    date_expression: null,
    date_start: null,
    date_end: null,
    date_certainty: null,
    extent: null,
    dimensions: null,
    medium: null,
    imprint: null,
    edition: null,
    volume_number: null,
    issue_number: null,
    pages: null,
    publication_title: null,
    provenance: null,
    scope_content: null,
    ocr_text: null,
    arrangement: null,
    access_conditions: null,
    reproduction_conditions: null,
    language: null,
    location_of_originals: null,
    location_of_copies: null,
    finding_aids: null,
    section_title: null,
    notes: null,
    internal_notes: null,
    creator_display: null,
    place_display: null,
    iiif_manifest_url: null,
    has_digital: false,
    is_published: true,
    last_exported_at: null,
    admin_biog_history: null,
    preferred_citation: null,
    acquisition_info: null,
    system_of_arrangement: null,
    physical_characteristics: null,
    legacy_ids: null,
    ca_object_id: null,
    ca_collection_id: null,
    created_by: null,
    updated_by: null,
    created_at: "2026-01-01T00:00:00",
    updated_at: "2026-01-01T00:00:00",
    ...overrides,
  };
}

async function writeFixture(rows: MinimalDescription[]): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "fisqua-refcode-"));
  const file = path.join(tmp, "descriptions.json");
  await fs.writeFile(file, JSON.stringify(rows));
  return file;
}

describe("reference_code shape gate — multilingual + paren-strip", () => {
  beforeEach(setUpOutputDir);
  afterEach(cleanOutput);

  it("accepts ASCII reference codes (regression)", async () => {
    const { importDescriptions } = await import(
      "../../scripts/commands/descriptions"
    );

    const fixture = await writeFixture([
      makeRow(1, "CO-AHRB"),
      makeRow(2, "co-ahr-con"),
      makeRow(3, "pe-bn-cdip-01"),
    ]);
    const repoIdMap = new Map<number, string>([
      [1, "00000000-0000-4000-8000-000000000001"],
    ]);
    const { result } = await importDescriptions(fixture, repoIdMap, outputDir);

    expect(result.imported).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts Spanish diacritics (the cihjml-acc-eclesiástico class)", async () => {
    const { importDescriptions } = await import(
      "../../scripts/commands/descriptions"
    );

    const fixture = await writeFixture([
      makeRow(10, "co-cihjml-acc-10146-eclesiástico-i-cap"),
      makeRow(11, "co-cihjml-acc-12055-judicial"),
      makeRow(12, "Tutela-Niño"),
      makeRow(13, "Centroamérica-São-Paulo-français-català-09"),
    ]);
    const repoIdMap = new Map<number, string>([
      [1, "00000000-0000-4000-8000-000000000001"],
    ]);
    const { result } = await importDescriptions(fixture, repoIdMap, outputDir);

    expect(result.imported).toBe(4);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("strips trailing paren typos and rescues the row", async () => {
    const { importDescriptions } = await import(
      "../../scripts/commands/descriptions"
    );

    const fixture = await writeFixture([
      makeRow(20, "co-cihjml-acc-12055-judicial-cv)"),
      makeRow(21, "co-test-xy("),
      makeRow(22, "co-test-zz()"),
    ]);
    const repoIdMap = new Map<number, string>([
      [1, "00000000-0000-4000-8000-000000000001"],
    ]);
    const { result } = await importDescriptions(fixture, repoIdMap, outputDir);

    expect(result.imported).toBe(3);
    expect(result.skipped).toBe(0);

    // The cleaned id should appear in the emitted SQL, not the original.
    const sql = await fs.readFile(result.sqlFiles[0], "utf8");
    expect(sql).toContain("'co-cihjml-acc-12055-judicial-cv'");
    expect(sql).toContain("'co-test-xy'");
    expect(sql).toContain("'co-test-zz'");
    expect(sql).not.toContain("judicial-cv)");
    expect(sql).not.toContain("co-test-xy(");
  });

  it("NFC-normalises combining-mark forms", async () => {
    const { importDescriptions } = await import(
      "../../scripts/commands/descriptions"
    );

    // U+0061 (a) + U+0301 (combining acute) — visually identical to
    // U+00E1 (á) but byte-different. After NFC, both store as U+00E1.
    const decomposed = "eclesiástico-test";
    const composed = "eclesiástico-test";

    const fixture = await writeFixture([
      makeRow(30, decomposed),
      makeRow(31, "Niño-decomposed-ñ"),
    ]);
    const repoIdMap = new Map<number, string>([
      [1, "00000000-0000-4000-8000-000000000001"],
    ]);
    const { result } = await importDescriptions(fixture, repoIdMap, outputDir);

    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);

    const sql = await fs.readFile(result.sqlFiles[0], "utf8");
    // The NFC-composed form lands in storage; the decomposed form
    // does not appear verbatim.
    expect(sql).toContain(composed);
    expect(sql).not.toContain(decomposed);
  });

  it("still rejects empty / null / over-length / disallowed-punctuation ids", async () => {
    const { importDescriptions } = await import(
      "../../scripts/commands/descriptions"
    );

    const fixture = await writeFixture([
      makeRow(40, null),
      makeRow(41, ""),
      makeRow(42, "a".repeat(51)), // 51 chars — over budget
      makeRow(43, "co/test/slash"), // slash not permitted
      makeRow(44, "co test space"),
      makeRow(45, "co.test.dot"),
    ]);
    const repoIdMap = new Map<number, string>([
      [1, "00000000-0000-4000-8000-000000000001"],
    ]);
    const { result, idMap } = await importDescriptions(fixture, repoIdMap, outputDir);

    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(6);
    expect(result.errors).toHaveLength(6);
    // None of the bad ids should be in idMap (cascade-skip semantics)
    for (const id of [40, 41, 42, 43, 44, 45]) {
      expect(idMap.has(id)).toBe(false);
    }
  });
});
