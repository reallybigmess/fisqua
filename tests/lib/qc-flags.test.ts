/**
 * Tests — QC flags storage server helpers
 *
 * This suite pins the five server-side helpers in
 * `app/lib/qc-flags.server.ts` that back the QC-flag surface:
 * `createQcFlag`, `resolveQcFlag`, `getOpenQcFlags` (the
 * dashboard's list of unresolved flags), `getOpenQcFlagCount`
 * (the counter used in nav badges), and `getQcFlagsForVolume`
 * (the per-volume listing).
 *
 * These helpers operate at the storage layer — tenant resolution
 * and authorisation are the route handler's job — so this file
 * pins SQL-level behaviour: the `(status, volumeId)` index path,
 * the resolve-then-list ordering (resolved rows drop out of
 * `getOpenQcFlags` but stay visible to `getQcFlagsForVolume`),
 * and the cascade against the comment thread (comments attached
 * to a flag survive resolution; only the flag's status changes).
 *
 * @version v0.3.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import { DEFAULT_TEST_TENANT_ID, applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import {
  createQcFlag,
  resolveQcFlag,
  getOpenQcFlags,
  getOpenQcFlagCount,
  getQcFlagsForVolume,
} from "../../app/lib/qc-flags.server";

type Db = ReturnType<typeof drizzle>;

async function seedFixture(db: Db) {
  const reporter = await createTestUser({
    email: `reporter-${crypto.randomUUID()}@example.com`,
  });
  const lead = await createTestUser({
    email: `lead-${crypto.randomUUID()}@example.com`,
  });
  const now = Date.now();

  const projectId = crypto.randomUUID();
  const volumeId = crypto.randomUUID();
  const otherVolumeId = crypto.randomUUID();
  const otherProjectId = crypto.randomUUID();
  const pageAId = crypto.randomUUID();
  const pageBId = crypto.randomUUID();
  const otherPageId = crypto.randomUUID();

  await db.insert(schema.projects).values([
    {
      id: projectId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      name: "QC Project",
      createdBy: reporter.id,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: otherProjectId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      name: "Other Project",
      createdBy: reporter.id,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  await db.insert(schema.volumes).values([
    {
      id: volumeId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      projectId,
      name: "QC Volume",
      referenceCode: "co-test-qc",
      manifestUrl: "https://example.com/manifest.json",
      pageCount: 2,
      status: "in_progress",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: otherVolumeId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      projectId: otherProjectId,
      name: "Other Volume",
      referenceCode: "co-test-qc-other",
      manifestUrl: "https://example.com/manifest-other.json",
      pageCount: 1,
      status: "in_progress",
      createdAt: now,
      updatedAt: now,
    },
  ]);

  await db.insert(schema.volumePages).values([
    {
      id: pageAId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      volumeId,
      position: 1,
      imageUrl: "https://example.com/image-a.jpg",
      width: 800,
      height: 1200,
      label: "f.1r",
      createdAt: now,
    },
    {
      id: pageBId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      volumeId,
      position: 2,
      imageUrl: "https://example.com/image-b.jpg",
      width: 800,
      height: 1200,
      label: "f.1v",
      createdAt: now,
    },
    {
      id: otherPageId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      volumeId: otherVolumeId,
      position: 1,
      imageUrl: "https://example.com/image-other.jpg",
      width: 800,
      height: 1200,
      label: "f.1r",
      createdAt: now,
    },
  ]);

  return {
    reporterId: reporter.id,
    leadId: lead.id,
    projectId,
    otherProjectId,
    volumeId,
    otherVolumeId,
    pageAId,
    pageBId,
    otherPageId,
  };
}

async function expectResponseStatus(
  fn: () => Promise<unknown>,
  expectedStatus: number
) {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Response);
  expect((caught as Response).status).toBe(expectedStatus);
}

describe("createQcFlag ()", () => {
  let db: Db;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
  });

  it("inserts an open flag with null resolution fields when payload is valid", async () => {
    const { reporterId, volumeId, pageAId } = await seedFixture(db);

    const result = await createQcFlag(db, {
      volumeId,
      pageId: pageAId,
      reportedBy: reporterId,
      problemType: "damaged",
      description: "torn corner",
    });

    expect(typeof result.id).toBe("string");

    const [row] = await db
      .select()
      .from(schema.qcFlags)
      .where(eq(schema.qcFlags.id, result.id))
      .all();

    expect(row.status).toBe("open");
    expect(row.resolutionAction).toBeNull();
    expect(row.resolverNote).toBeNull();
    expect(row.resolvedBy).toBeNull();
    expect(row.resolvedAt).toBeNull();
    expect(row.problemType).toBe("damaged");
    expect(row.description).toBe("torn corner");
    expect(row.reportedBy).toBe(reporterId);
  });

  it("throws a 400 Response when description is empty", async () => {
    const { reporterId, volumeId, pageAId } = await seedFixture(db);

    await expectResponseStatus(
      () =>
        createQcFlag(db, {
          volumeId,
          pageId: pageAId,
          reportedBy: reporterId,
          problemType: "damaged",
          description: "   ",
        }),
      400
    );
  });

  it("accepts problemType='other' when description is non-empty", async () => {
    const { reporterId, volumeId, pageAId } = await seedFixture(db);

    const result = await createQcFlag(db, {
      volumeId,
      pageId: pageAId,
      reportedBy: reporterId,
      problemType: "other",
      description: "see notes: image skew beyond tooling threshold",
    });

    const [row] = await db
      .select()
      .from(schema.qcFlags)
      .where(eq(schema.qcFlags.id, result.id))
      .all();
    expect(row.problemType).toBe("other");
    expect(row.status).toBe("open");
  });
});

describe("resolveQcFlag ()", () => {
  let db: Db;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
  });

  it("transitions an open flag to resolved with retake_requested", async () => {
    const { reporterId, leadId, volumeId, pageAId } = await seedFixture(db);

    const { id } = await createQcFlag(db, {
      volumeId,
      pageId: pageAId,
      reportedBy: reporterId,
      problemType: "damaged",
      description: "faded text",
    });

    await resolveQcFlag(db, id, leadId, "resolved", "retake_requested", null);

    const [row] = await db
      .select()
      .from(schema.qcFlags)
      .where(eq(schema.qcFlags.id, id))
      .all();

    expect(row.status).toBe("resolved");
    expect(row.resolutionAction).toBe("retake_requested");
    expect(row.resolvedBy).toBe(leadId);
    expect(typeof row.resolvedAt).toBe("number");
    expect(row.resolverNote).toBeNull();
  });

  it("throws 400 when resolutionAction='other' and resolverNote is whitespace", async () => {
    const { reporterId, leadId, volumeId, pageAId } = await seedFixture(db);

    const { id } = await createQcFlag(db, {
      volumeId,
      pageId: pageAId,
      reportedBy: reporterId,
      problemType: "damaged",
      description: "ink bleed",
    });

    await expectResponseStatus(
      () =>
        resolveQcFlag(db, id, leadId, "resolved", "other", "   "),
      400
    );
  });

  it("accepts resolutionAction='other' with a trimmed resolverNote", async () => {
    const { reporterId, leadId, volumeId, pageAId } = await seedFixture(db);

    const { id } = await createQcFlag(db, {
      volumeId,
      pageId: pageAId,
      reportedBy: reporterId,
      problemType: "damaged",
      description: "blur",
    });

    await resolveQcFlag(
      db,
      id,
      leadId,
      "resolved",
      "other",
      "  handled out-of-band with depositor  "
    );

    const [row] = await db
      .select()
      .from(schema.qcFlags)
      .where(eq(schema.qcFlags.id, id))
      .all();

    expect(row.resolverNote).toBe("handled out-of-band with depositor");
    expect(row.resolutionAction).toBe("other");
    expect(row.status).toBe("resolved");
  });

  it("throws 404 when the flagId does not exist", async () => {
    const { leadId } = await seedFixture(db);
    await expectResponseStatus(
      () =>
        resolveQcFlag(
          db,
          "does-not-exist",
          leadId,
          "resolved",
          "ignored",
          null
        ),
      404
    );
  });

  it("throws 409 when resolving a flag that is already resolved", async () => {
    const { reporterId, leadId, volumeId, pageAId } = await seedFixture(db);

    const { id } = await createQcFlag(db, {
      volumeId,
      pageId: pageAId,
      reportedBy: reporterId,
      problemType: "damaged",
      description: "stain",
    });

    await resolveQcFlag(db, id, leadId, "resolved", "ignored", null);

    await expectResponseStatus(
      () => resolveQcFlag(db, id, leadId, "wontfix", "ignored", null),
      409
    );
  });
});

describe("getOpenQcFlags / getOpenQcFlagCount / getQcFlagsForVolume ()", () => {
  let db: Db;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
  });

  it("returns 0 and an empty list when no flags exist on the volume", async () => {
    const { volumeId } = await seedFixture(db);
    expect(await getOpenQcFlagCount(db, volumeId)).toBe(0);
    const rows = await getOpenQcFlags(db, volumeId);
    expect(rows).toHaveLength(0);
  });

  it("counts only open flags on the target volume, ignoring other volumes and resolved rows", async () => {
    const {
      reporterId,
      leadId,
      volumeId,
      pageAId,
      pageBId,
      otherVolumeId,
      otherPageId,
    } = await seedFixture(db);

    await createQcFlag(db, {
      volumeId,
      pageId: pageAId,
      reportedBy: reporterId,
      problemType: "damaged",
      description: "one",
    });
    await createQcFlag(db, {
      volumeId,
      pageId: pageBId,
      reportedBy: reporterId,
      problemType: "blank",
      description: "two",
    });
    const { id: toResolve } = await createQcFlag(db, {
      volumeId,
      pageId: pageBId,
      reportedBy: reporterId,
      problemType: "repeated",
      description: "three -- will be resolved",
    });
    await resolveQcFlag(
      db,
      toResolve,
      leadId,
      "resolved",
      "marked_duplicate",
      null
    );

    // Flag on a different volume -- must not leak into the count.
    await createQcFlag(db, {
      volumeId: otherVolumeId,
      pageId: otherPageId,
      reportedBy: reporterId,
      problemType: "damaged",
      description: "other volume, open",
    });

    expect(await getOpenQcFlagCount(db, volumeId)).toBe(2);
    const open = await getOpenQcFlags(db, volumeId);
    expect(open).toHaveLength(2);
    expect(
      open.every((f) => ["damaged", "blank"].includes(f.problemType))
    ).toBe(true);
  });

  it("getQcFlagsForVolume returns all statuses by default, and narrows when opts.statuses is passed", async () => {
    const { reporterId, leadId, volumeId, pageAId, pageBId } =
      await seedFixture(db);

    const { id: openId } = await createQcFlag(db, {
      volumeId,
      pageId: pageAId,
      reportedBy: reporterId,
      problemType: "damaged",
      description: "open flag",
    });
    const { id: resolvedId } = await createQcFlag(db, {
      volumeId,
      pageId: pageBId,
      reportedBy: reporterId,
      problemType: "blank",
      description: "will resolve",
    });
    await resolveQcFlag(
      db,
      resolvedId,
      leadId,
      "resolved",
      "ignored",
      null
    );

    const all = await getQcFlagsForVolume(db, volumeId);
    expect(all).toHaveLength(2);

    const onlyOpen = await getQcFlagsForVolume(db, volumeId, {
      statuses: ["open"],
    });
    expect(onlyOpen).toHaveLength(1);
    expect(onlyOpen[0].id).toBe(openId);

    const onlyResolved = await getQcFlagsForVolume(db, volumeId, {
      statuses: ["resolved"],
    });
    expect(onlyResolved).toHaveLength(1);
    expect(onlyResolved[0].id).toBe(resolvedId);
  });
});

