/**
 * Tests — OCR truncation at the import boundary
 *
 * This suite pins the import-boundary truncation contract. D1
 * enforces a hard ~100 KB per-statement limit. The Neogranadina
 * v0.4 dump carries 11 description rows whose `ocr_text` exceeds that
 * limit. The importer truncates these at OCR_MAX_BYTES (90 KB) at a
 * UTF-8/word boundary, appends a marker, and records the original
 * byte length in `legacy_ids` so the v0.5 OCR-to-R2 migration can
 * find them.
 *
 * Locks the round-1 mitigation contract (planner decision 2026-05-03).
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
  reference_code: string;
  local_identifier: string | null;
  title: string;
  ocr_text: string | null;
  [k: string]: unknown;
}

function makeRow(
  id: number,
  reference_code: string,
  ocr_text: string | null,
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
    ocr_text,
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
  };
}

async function writeFixture(rows: MinimalDescription[]): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "fisqua-ocr-trunc-"));
  const file = path.join(tmp, "descriptions.json");
  await fs.writeFile(file, JSON.stringify(rows));
  return file;
}

describe("OCR truncation at import boundary", () => {
  beforeEach(setUpOutputDir);
  afterEach(cleanOutput);

  it("passes through rows with ocr_text under 90 KB unchanged", async () => {
    const { importDescriptions } = await import(
      "../../scripts/commands/descriptions"
    );

    const smallOcr = "Texto breve de prueba.";
    const fixture = await writeFixture([
      makeRow(100, "test-small", smallOcr),
    ]);
    const repoIdMap = new Map<number, string>([
      [1, "00000000-0000-4000-8000-000000000001"],
    ]);
    const { result } = await importDescriptions(fixture, repoIdMap, outputDir);

    expect(result.imported).toBe(1);
    const sql = await fs.readFile(result.sqlFiles[0], "utf8");
    expect(sql).toContain(smallOcr);
    expect(sql).not.toContain("OCR truncated");

    // No sidecar should be written when no truncations occurred.
    const sidecarExists = await fs
      .access(path.join(outputDir, "ocr-truncations.json"))
      .then(() => true)
      .catch(() => false);
    expect(sidecarExists).toBe(false);
  });

  it("truncates rows whose ocr_text exceeds 90 KB and tags legacy_ids", async () => {
    const { importDescriptions } = await import(
      "../../scripts/commands/descriptions"
    );

    // 120 KB of ASCII content — well past OCR_MAX_BYTES (90 KB) and
    // representative of the pe-bn-cdip-* collection's actual sizes.
    const longOcr =
      "Lorem ipsum dolor sit amet ".repeat(5000) +
      "TAIL_SENTINEL_THIS_SHOULD_NOT_APPEAR";
    const originalBytes = Buffer.byteLength(longOcr, "utf8");
    expect(originalBytes).toBeGreaterThan(120_000);

    const fixture = await writeFixture([
      makeRow(200, "test-long", longOcr),
    ]);
    const repoIdMap = new Map<number, string>([
      [1, "00000000-0000-4000-8000-000000000001"],
    ]);
    const { result } = await importDescriptions(fixture, repoIdMap, outputDir);

    expect(result.imported).toBe(1);
    expect(result.errors).toHaveLength(0);

    const sql = await fs.readFile(result.sqlFiles[0], "utf8");

    // The truncation marker is in the emitted SQL.
    expect(sql).toContain("OCR truncated to fit D1");
    expect(sql).toContain(`original ${originalBytes} bytes`);

    // The tail of the original is dropped.
    expect(sql).not.toContain("TAIL_SENTINEL_THIS_SHOULD_NOT_APPEAR");

    // legacy_ids carries the ocr-truncated marker with the original
    // byte length so the v0.5 R2 migration can find this row.
    expect(sql).toContain('"provider":"ocr-truncated"');
    expect(sql).toContain(`"id":${originalBytes}`);

    // Sidecar file lists the truncation.
    const sidecar = JSON.parse(
      await fs.readFile(path.join(outputDir, "ocr-truncations.json"), "utf8"),
    );
    expect(sidecar.truncations).toHaveLength(1);
    expect(sidecar.truncations[0]).toMatchObject({
      djangoPk: 200,
      referenceCode: "test-long",
      originalBytes,
    });
    expect(sidecar.truncations[0].truncatedBytes).toBeLessThanOrEqual(
      // 90 KB raw + marker overhead — we stay well under the 100 KB
      // D1 cap with comfortable headroom for the rest of the row.
      95_000,
    );
  });

  it("preserves UTF-8 char boundaries when truncating", async () => {
    const { importDescriptions } = await import(
      "../../scripts/commands/descriptions"
    );

    // Compose a string heavy with multi-byte chars (Spanish accents +
    // Greek + Hebrew) so the byte-aligned cut would naively split a
    // continuation byte. The truncation helper backs off to a UTF-8
    // start byte before any word-boundary adjustment.
    const repeated = "áéíóú ñ ç ã ÑΩψβ אבגד ";
    const longOcr = repeated.repeat(4000);
    expect(Buffer.byteLength(longOcr, "utf8")).toBeGreaterThan(100_000);

    const fixture = await writeFixture([
      makeRow(300, "test-utf8", longOcr),
    ]);
    const repoIdMap = new Map<number, string>([
      [1, "00000000-0000-4000-8000-000000000001"],
    ]);
    const { result } = await importDescriptions(fixture, repoIdMap, outputDir);

    expect(result.imported).toBe(1);

    const sql = await fs.readFile(result.sqlFiles[0], "utf8");
    expect(sql).toContain("OCR truncated to fit D1");

    // The emitted SQL must be valid UTF-8 — readFile already decodes
    // as utf8, so any broken continuation byte would have been
    // replaced with U+FFFD. Spot-check that no replacement char
    // appeared in the truncated payload (it would in raw read if a
    // multi-byte was sliced).
    expect(sql).not.toContain("�");
  });

  it("treats null and empty ocr_text as no-op", async () => {
    const { importDescriptions } = await import(
      "../../scripts/commands/descriptions"
    );

    const fixture = await writeFixture([
      makeRow(400, "test-null", null),
      makeRow(401, "test-empty", ""),
    ]);
    const repoIdMap = new Map<number, string>([
      [1, "00000000-0000-4000-8000-000000000001"],
    ]);
    const { result } = await importDescriptions(fixture, repoIdMap, outputDir);

    expect(result.imported).toBe(2);
    expect(result.errors).toHaveLength(0);

    const sidecarExists = await fs
      .access(path.join(outputDir, "ocr-truncations.json"))
      .then(() => true)
      .catch(() => false);
    expect(sidecarExists).toBe(false);
  });
});
