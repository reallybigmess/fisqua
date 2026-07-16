/**
 * Tests — `getProjectVolumes` open-QC-flag count
 *
 * This test pins the `openQcFlagCount` field that `getProjectVolumes`
 * returns alongside each volume row. The count drives the QC badge in
 * the project dashboard, so it has to be correct per-volume, has to
 * drop when a flag is resolved, and must not leak across projects.
 *
 * Three pins cover the surface: a fixture with two open flags on
 * volume A, one open plus one resolved on volume B, and zero on
 * volume C — the returned counts match (`2`, `1`, `0`); resolving an
 * open flag on the same volume drops the count by one; and an open
 * flag in a sibling project does not appear in the queried project's
 * counts. The cross-project pin is the load-bearing one — the count
 * is computed by a SQL JOIN, and a missing project-scope predicate
 * would silently surface every other tenant's open work.
 *
 * @version v0.3.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase, DEFAULT_TEST_TENANT_ID } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createVolume, getProjectVolumes } from "../../app/lib/volumes.server";
import { createQcFlag, resolveQcFlag } from "../../app/lib/qc-flags.server";
import type { ParsedManifest } from "../../app/lib/iiif.server";

function buildManifest(
  name: string,
  referenceCode: string,
  pageCount = 3
): ParsedManifest {
  const pages = Array.from({ length: pageCount }, (_, i) => ({
    position: i + 1,
    width: 3000,
    height: 4000,
    imageUrl: `https://iiif.zasqua.org/tiles/${referenceCode}/page-${String(
      i + 1
    ).padStart(3, "0")}`,
    label: `img ${i + 1}`,
  }));
  return {
    name,
    referenceCode,
    manifestUrl: `https://iiif.zasqua.org/${referenceCode}/manifest.json`,
    pageCount,
    pages,
  };
}

async function firstPageId(
  db: ReturnType<typeof drizzle<typeof schema>>,
  volumeId: string
): Promise<string> {
  const page = await db
    .select({ id: schema.volumePages.id })
    .from(schema.volumePages)
    .where(eq(schema.volumePages.volumeId, volumeId))
    .get();
  if (!page) throw new Error(`no page found for volume ${volumeId}`);
  return page.id;
}

describe("getProjectVolumes openQcFlagCount", () => {
  let projectId: string;
  let otherProjectId: string;
  let reporterId: string;
  let resolverId: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    const reporter = await createTestUser({ isAdmin: false });
    const resolver = await createTestUser({ isAdmin: false });
    reporterId = reporter.id;
    resolverId = resolver.id;

    const db = drizzle(env.DB, { schema });
    const now = Date.now();

    projectId = crypto.randomUUID();
    await db.insert(schema.projects).values({
      id: projectId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      name: "Project A",
      createdBy: reporterId,
      createdAt: now,
      updatedAt: now,
    });

    otherProjectId = crypto.randomUUID();
    await db.insert(schema.projects).values({
      id: otherProjectId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      name: "Project B",
      createdBy: reporterId,
      createdAt: now,
      updatedAt: now,
    });
  });

  it("returns per-volume counts: 2 open, 1 open (plus 1 resolved), 0", async () => {
    const db = drizzle(env.DB, { schema });

    const v1 = await createVolume(db, projectId, buildManifest("V1", "ref-v1"));
    const v2 = await createVolume(db, projectId, buildManifest("V2", "ref-v2"));
    const v3 = await createVolume(db, projectId, buildManifest("V3", "ref-v3"));

    const v1page = await firstPageId(db, v1.id);
    const v2page = await firstPageId(db, v2.id);

    // V1: two open flags
    await createQcFlag(db, {
      volumeId: v1.id,
      pageId: v1page,
      reportedBy: reporterId,
      problemType: "damaged",
      description: "torn",
    });
    await createQcFlag(db, {
      volumeId: v1.id,
      pageId: v1page,
      reportedBy: reporterId,
      problemType: "blank",
      description: "unexpected blank",
    });

    // V2: one open + one resolved
    await createQcFlag(db, {
      volumeId: v2.id,
      pageId: v2page,
      reportedBy: reporterId,
      problemType: "missing",
      description: "page 7 absent",
    });
    const { id: resolvedFlagId } = await createQcFlag(db, {
      volumeId: v2.id,
      pageId: v2page,
      reportedBy: reporterId,
      problemType: "repeated",
      description: "duplicate of p3",
    });
    await resolveQcFlag(
      db,
      resolvedFlagId,
      resolverId,
      "resolved",
      "marked_duplicate",
      null
    );

    // V3: no flags at all
    const volumes = await getProjectVolumes(db, projectId);
    const byId = new Map(volumes.map((v) => [v.id, v]));

    expect(byId.get(v1.id)?.openQcFlagCount).toBe(2);
    expect(byId.get(v2.id)?.openQcFlagCount).toBe(1);
    expect(byId.get(v3.id)?.openQcFlagCount).toBe(0);
  });

  it("drops the count when an open flag transitions to resolved", async () => {
    const db = drizzle(env.DB, { schema });
    const v = await createVolume(db, projectId, buildManifest("V", "ref-v"));
    const page = await firstPageId(db, v.id);

    const { id: fA } = await createQcFlag(db, {
      volumeId: v.id,
      pageId: page,
      reportedBy: reporterId,
      problemType: "damaged",
      description: "torn",
    });
    await createQcFlag(db, {
      volumeId: v.id,
      pageId: page,
      reportedBy: reporterId,
      problemType: "out_of_order",
      description: "page 3 between 5 and 6",
    });

    let volumes = await getProjectVolumes(db, projectId);
    expect(volumes[0].openQcFlagCount).toBe(2);

    await resolveQcFlag(
      db,
      fA,
      resolverId,
      "resolved",
      "retake_requested",
      null
    );

    volumes = await getProjectVolumes(db, projectId);
    expect(volumes[0].openQcFlagCount).toBe(1);
  });

  it("does not leak open flags from one project into another", async () => {
    const db = drizzle(env.DB, { schema });

    const v = await createVolume(db, projectId, buildManifest("V", "ref-v"));
    const otherV = await createVolume(
      db,
      otherProjectId,
      buildManifest("OtherV", "ref-other")
    );
    const vPage = await firstPageId(db, v.id);
    const otherPage = await firstPageId(db, otherV.id);

    // Three open flags on the OTHER project's volume.
    for (let i = 0; i < 3; i++) {
      await createQcFlag(db, {
        volumeId: otherV.id,
        pageId: otherPage,
        reportedBy: reporterId,
        problemType: "damaged",
        description: `other project flag ${i}`,
      });
    }

    // One open flag on this project's volume.
    await createQcFlag(db, {
      volumeId: v.id,
      pageId: vPage,
      reportedBy: reporterId,
      problemType: "damaged",
      description: "my project flag",
    });

    const volumes = await getProjectVolumes(db, projectId);
    expect(volumes).toHaveLength(1);
    expect(volumes[0].id).toBe(v.id);
    expect(volumes[0].openQcFlagCount).toBe(1);

    const otherVolumes = await getProjectVolumes(db, otherProjectId);
    expect(otherVolumes).toHaveLength(1);
    expect(otherVolumes[0].id).toBe(otherV.id);
    expect(otherVolumes[0].openQcFlagCount).toBe(3);
  });
});

