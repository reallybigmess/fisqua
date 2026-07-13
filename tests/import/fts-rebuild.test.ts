/**
 * Tests — FTS rebuild
 *
 * This suite asserts that `generateFtsRebuild()` emits all THREE FTS rebuild
 * lines. An earlier version of the function rebuilt only
 * `entities_fts` and `places_fts`; the v0.4 union schema also uses
 * `descriptions_fts`, and forgetting to rebuild it after a
 * clear-and-reimport leaves search broken until the next row write
 * touches the FTS triggers. The current implementation rebuilds all
 * three FTS5 tables.
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

describe("generateFtsRebuild — all three FTS tables", () => {
  beforeEach(setUpOutputDir);
  afterEach(cleanOutput);

  it("emits a rebuild line for entities_fts", async () => {
    const { generateFtsRebuild } = await import(
      "../../scripts/commands/clear"
    );
    const sqlFiles = await generateFtsRebuild(outputDir);
    const content = await fs.readFile(sqlFiles[0], "utf8");
    expect(content).toContain(
      "INSERT INTO entities_fts(entities_fts) VALUES('rebuild')",
    );
  });

  it("emits a rebuild line for places_fts", async () => {
    const { generateFtsRebuild } = await import(
      "../../scripts/commands/clear"
    );
    const sqlFiles = await generateFtsRebuild(outputDir);
    const content = await fs.readFile(sqlFiles[0], "utf8");
    expect(content).toContain(
      "INSERT INTO places_fts(places_fts) VALUES('rebuild')",
    );
  });

  it("emits a rebuild line for descriptions_fts", async () => {
    const { generateFtsRebuild } = await import(
      "../../scripts/commands/clear"
    );
    const sqlFiles = await generateFtsRebuild(outputDir);
    const content = await fs.readFile(sqlFiles[0], "utf8");
    // descriptions_fts is now part of the rebuild list.
    expect(content).toContain(
      "INSERT INTO descriptions_fts(descriptions_fts) VALUES('rebuild')",
    );
  });
});

// Version: v0.4.1
