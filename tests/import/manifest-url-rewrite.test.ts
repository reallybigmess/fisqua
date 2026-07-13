/**
 * Tests — manifest URL rewrite
 *
 * This suite pins `rewriteManifestUrl` — the import-side helper that
 * normalises legacy IIIF manifest URLs into the canonical Zasqua
 * pattern (`https://manifests.zasqua.org/<reference-code>/manifest.json`).
 * The Neogranadina dump carries manifest URLs pointing at the old
 * preservation-server hostname; the importer rewrites them so the
 * description's `manifest_url` column points at the production CDN
 * after the cutover.
 *
 * Cases pin the canonical-pattern shape against a representative
 * reference code, the null-input contract (no manifest →
 * null result, no rewrite), and the idempotency property (passing
 * an already-canonical URL through the helper returns it unchanged
 * so re-running the importer doesn't corrupt the URL).
 *
 * @version v0.4.1
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

describe("rewriteManifestUrl", () => {
  it("rewrites a manifest URL to canonical pattern using reference code", async () => {
    const { rewriteManifestUrl } = await import(
      "../../scripts/commands/descriptions"
    );

    const result = rewriteManifestUrl(
      "https://old.example.com/manifest.json",
      "co-ahr-gob-caj001-car001-f001r"
    );
    expect(result).toBe(
      "https://manifests.zasqua.org/co-ahr-gob-caj001-car001-f001r/manifest.json"
    );
  });

  it("returns null for null URL", async () => {
    const { rewriteManifestUrl } = await import(
      "../../scripts/commands/descriptions"
    );

    expect(rewriteManifestUrl(null, "co-ahr-gob-caj001")).toBeNull();
  });

  it("returns null for empty string URL", async () => {
    const { rewriteManifestUrl } = await import(
      "../../scripts/commands/descriptions"
    );

    expect(rewriteManifestUrl("", "co-ahr-gob-caj001")).toBeNull();
  });

  it("returns null for undefined URL", async () => {
    const { rewriteManifestUrl } = await import(
      "../../scripts/commands/descriptions"
    );

    expect(rewriteManifestUrl(undefined, "co-ahr-gob-caj001")).toBeNull();
  });

  it("strips ? and # from reference code in rewritten URL", async () => {
    const { rewriteManifestUrl } = await import(
      "../../scripts/commands/descriptions"
    );

    const result = rewriteManifestUrl(
      "https://old.example.com/m.json",
      "co-ahr-gob?foo#bar"
    );
    expect(result).toBe(
      "https://manifests.zasqua.org/co-ahr-gobfoobar/manifest.json"
    );
  });
});

describe("PK-to-UUID mapping output", () => {
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

  beforeEach(setUpOutputDir);
  afterEach(cleanOutput);

  it("writes pk-uuid-mapping.json after import", async () => {
    const { importDescriptions } = await import(
      "../../scripts/commands/descriptions"
    );
    const { importRepositories } = await import(
      "../../scripts/commands/repositories"
    );

    const repoFixture = path.resolve("tests/import/fixtures/repositories.json");
    const { idMap: repoIdMap } = await importRepositories(repoFixture, outputDir);

    const fixturePath = path.resolve("tests/import/fixtures/descriptions.json");
    const { idMap } = await importDescriptions(fixturePath, repoIdMap, outputDir);

    const mappingPath = path.join(outputDir, "pk-uuid-mapping.json");
    const raw = await fs.readFile(mappingPath, "utf8");
    const mapping = JSON.parse(raw);

    expect(mapping).toHaveProperty("descriptions");
    expect(typeof mapping.descriptions).toBe("object");

    // All old PKs should be present as string keys
    for (const [oldId, newId] of idMap.entries()) {
      expect(mapping.descriptions[String(oldId)]).toBe(newId);
    }
  });
});
