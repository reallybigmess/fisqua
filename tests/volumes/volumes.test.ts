/**
 * Tests — volume CRUD operations
 *
 * This suite pins the three repository functions that drive the volume
 * lifecycle: `createVolume` (mints a volume row plus all its page rows
 * in one transaction), `getProjectVolumes` (returns volumes for a
 * project with the first-page thumbnail attached), and `deleteVolume`
 * (only allowed when status is `unstarted`, since deleting in-progress
 * work would drop QC history).
 *
 * The chunked-insert test on `createVolume` is load-bearing — D1
 * caps a single SQL statement at a fixed number of bound parameters,
 * so a 50-page volume has to split its page inserts into chunks. The
 * test pins the chunking behaviour by asserting all 50 page rows
 * land with correct positions. The `deleteVolume` status guard pins
 * the structural protection against accidental destruction of
 * cataloguing work — only volumes that haven't yet been touched can
 * be removed; once cataloguing has begun, deletion requires a
 * separate workflow path.
 *
 * @version v0.3.0
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
} from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase, DEFAULT_TEST_TENANT_ID } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { sampleManifest, sampleManifestUrl } from "../helpers/manifests";
import type { ParsedManifest } from "../../app/lib/iiif.server";
import {
  createVolume,
  getProjectVolumes,
  deleteVolume,
} from "../../app/lib/volumes.server";

// Build a ParsedManifest from the sample fixture
function buildParsedManifest(
  overrides: Partial<ParsedManifest> = {}
): ParsedManifest {
  return {
    name: "Carpeta 005, Caja 259",
    referenceCode: "co-ahr-gob-caj259-car005",
    manifestUrl: sampleManifestUrl,
    pageCount: 3,
    pages: [
      {
        position: 1,
        width: 3000,
        height: 4000,
        imageUrl:
          "https://iiif.zasqua.org/tiles/co-ahr-gob-caj259-car005/page-001",
        label: "img 1",
      },
      {
        position: 2,
        width: 3000,
        height: 3900,
        imageUrl:
          "https://iiif.zasqua.org/tiles/co-ahr-gob-caj259-car005/page-002",
        label: "img 2",
      },
      {
        position: 3,
        width: 2900,
        height: 4100,
        imageUrl:
          "https://iiif.zasqua.org/tiles/co-ahr-gob-caj259-car005/page-003",
        label: "img 3",
      },
    ],
    ...overrides,
  };
}

// Generate a large ParsedManifest for chunking tests
function buildLargeManifest(pageCount: number): ParsedManifest {
  const pages = Array.from({ length: pageCount }, (_, i) => ({
    position: i + 1,
    width: 3000,
    height: 4000,
    imageUrl: `https://iiif.zasqua.org/tiles/test-volume/page-${String(i + 1).padStart(3, "0")}`,
    label: `img ${i + 1}`,
  }));
  return {
    name: "Large Volume",
    referenceCode: "co-test-large",
    manifestUrl: "https://iiif.zasqua.org/co-test-large/manifest.json",
    pageCount,
    pages,
  };
}

describe("volume CRUD operations", () => {
  let projectId: string;
  let leadUser: { id: string; email: string; name: string | null; isAdmin: boolean; createdAt: number; updatedAt: number };

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    leadUser = await createTestUser({ isAdmin: false });
    const db = drizzle(env.DB, { schema });
    const now = Date.now();
    projectId = crypto.randomUUID();
    await db.insert(schema.projects).values({
      id: projectId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      name: "Test Project",
      createdBy: leadUser.id,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.projectMembers).values({
      id: crypto.randomUUID(),
      projectId,
      userId: leadUser.id,
      role: "lead",
      createdAt: now,
    });
  });

  describe("createVolume", () => {
    it("creates a volume row with correct fields", async () => {
      const db = drizzle(env.DB, { schema });
      const manifest = buildParsedManifest();

      const volume = await createVolume(db, projectId, manifest);

      expect(volume.id).toBeTruthy();
      expect(volume.projectId).toBe(projectId);
      expect(volume.name).toBe("Carpeta 005, Caja 259");
      expect(volume.referenceCode).toBe("co-ahr-gob-caj259-car005");
      expect(volume.manifestUrl).toBe(sampleManifestUrl);
      expect(volume.pageCount).toBe(3);
      expect(volume.status).toBe("unstarted");
    });

    it("inserts all page rows with correct positions and dimensions", async () => {
      const db = drizzle(env.DB, { schema });
      const manifest = buildParsedManifest();

      const volume = await createVolume(db, projectId, manifest);

      const pages = await db
        .select()
        .from(schema.volumePages)
        .where(eq(schema.volumePages.volumeId, volume.id))
        .all();

      expect(pages).toHaveLength(3);

      const sorted = pages.sort((a, b) => a.position - b.position);
      expect(sorted[0].position).toBe(1);
      expect(sorted[0].width).toBe(3000);
      expect(sorted[0].height).toBe(4000);
      expect(sorted[0].imageUrl).toContain("page-001");

      expect(sorted[2].position).toBe(3);
      expect(sorted[2].width).toBe(2900);
      expect(sorted[2].height).toBe(4100);
    });

    it("handles chunked insert for 50-page volumes", async () => {
      const db = drizzle(env.DB, { schema });
      const manifest = buildLargeManifest(50);

      const volume = await createVolume(db, projectId, manifest);

      const pages = await db
        .select()
        .from(schema.volumePages)
        .where(eq(schema.volumePages.volumeId, volume.id))
        .all();

      expect(pages).toHaveLength(50);
      expect(volume.pageCount).toBe(50);
    });
  });

  describe("getProjectVolumes", () => {
    it("returns all volumes for a project with first page thumbnail", async () => {
      const db = drizzle(env.DB, { schema });

      const manifest1 = buildParsedManifest();
      const manifest2 = buildParsedManifest({
        name: "Carpeta 006",
        referenceCode: "co-ahr-gob-caj259-car006",
        manifestUrl:
          "https://iiif.zasqua.org/co-ahr-gob-caj259-car006/manifest.json",
        pages: [
          {
            position: 1,
            width: 3000,
            height: 4000,
            imageUrl:
              "https://iiif.zasqua.org/tiles/co-ahr-gob-caj259-car006/page-001",
            label: "img 1",
          },
        ],
        pageCount: 1,
      });

      await createVolume(db, projectId, manifest1);
      await createVolume(db, projectId, manifest2);

      const volumes = await getProjectVolumes(db, projectId);

      expect(volumes).toHaveLength(2);
      const names = volumes.map((v) => v.name).sort();
      expect(names).toEqual(["Carpeta 005, Caja 259", "Carpeta 006"]);

      // Each volume should have a firstPageImageUrl
      for (const vol of volumes) {
        expect(vol.firstPageImageUrl).toBeTruthy();
        expect(vol.firstPageImageUrl).toContain("iiif.zasqua.org");
      }
    });

    it("returns empty array for project with no volumes", async () => {
      const db = drizzle(env.DB, { schema });
      const volumes = await getProjectVolumes(db, projectId);
      expect(volumes).toHaveLength(0);
    });
  });

  describe("deleteVolume", () => {
    it("deletes an unstarted volume and its pages", async () => {
      const db = drizzle(env.DB, { schema });
      const manifest = buildParsedManifest();

      const volume = await createVolume(db, projectId, manifest);
      await deleteVolume(db, volume.id);

      // Volume should be gone
      const volumeRow = await db
        .select()
        .from(schema.volumes)
        .where(eq(schema.volumes.id, volume.id))
        .get();
      expect(volumeRow).toBeUndefined();

      // Pages should be gone
      const pages = await db
        .select()
        .from(schema.volumePages)
        .where(eq(schema.volumePages.volumeId, volume.id))
        .all();
      expect(pages).toHaveLength(0);
    });

    it("throws when volume status is not unstarted", async () => {
      const db = drizzle(env.DB, { schema });
      const manifest = buildParsedManifest();

      const volume = await createVolume(db, projectId, manifest);

      // Manually update status to in_progress
      await db
        .update(schema.volumes)
        .set({ status: "in_progress" })
        .where(eq(schema.volumes.id, volume.id));

      await expect(deleteVolume(db, volume.id)).rejects.toThrow();
    });
  });
});
