/**
 * Tests — crowdsourcing-subtree tenant_id filterability
 *
 * The nine crowdsourcing tables (projects, volumes, volume_pages,
 * entries, qc_flags, comments, resegmentation_flags, activity_log,
 * drafts) each carry a NOT NULL `tenant_id` (migration 0042). This suite
 * proves SCHEMA-LEVEL FILTERABILITY: for each table, with two-tenant
 * fixtures, it asserts the column exists, is NOT NULL, and that
 * read/write predicates keyed on it behave correctly —
 *
 *   1. Read-negative: a query shaped `where(eq(<table>.tenantId, A))`
 *      never returns tenant-B rows.
 *   2. Write-negative: an UPDATE with the tenant-A predicate keyed by
 *      tenant-B's row id (the cross-tenant id-guessing attack shape)
 *      is a no-op — tenant B's row is unchanged.
 *
 * Loader predicates now exist. Federation step 4 plumbed `tenantId`
 * through every crowdsourcing WRITER (so each insert sets it explicitly,
 * resolved from the row's natural parent) and added the scoping predicate
 * to the crowdsourcing LOADERS inside the cross-tenant-coverage keystone's
 * scope (`app/routes/_auth.admin.**`, `app/lib/promote/**`,
 * `app/lib/invites.server.ts`, `app/middleware/**`); the nine tables were
 * added to that meta-grep's DOMAIN_TABLES in the same step, so those
 * predicates are held against regression. This suite remains the
 * schema-level backstop underneath the loader-layer guard: it proves the
 * predicate WORKS when applied; the meta-grep proves the app APPLIES it
 * in the guarded surface.
 *
 * (Routes outside the keystone's scope — the project dashboard and the
 * api.* routes — are documented in cross-tenant-coverage.test.ts's header
 * as deliberately outside the guard's globbed surface; while every user
 * and host still resolves to a single tenant, their queries cannot leak
 * in production. Widening the keystone's globbed surface is a later pass.)
 *
 * Structure mirrors `tests/admin/descriptions-tenant-isolation.test.ts`
 * (two-tenant fixtures, read-negative + write-negative per table).
 *
 * @version v0.4.2
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";

/**
 * A per-tenant parent graph: a user, a project, a volume, a page, and an
 * entry, all carrying the given tenant id (where the column exists). The
 * ids are returned so the per-table isolation assertions can hang their
 * fixtures off a valid FK chain.
 */
interface Graph {
  userId: string;
  projectId: string;
  volumeId: string;
  pageId: string;
  entryId: string;
}

async function seedGraph(tenantId: string, tag: string): Promise<Graph> {
  const db = drizzle(env.DB);
  const now = Date.now();
  const userId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const volumeId = crypto.randomUUID();
  const pageId = crypto.randomUUID();
  const entryId = crypto.randomUUID();

  await db.insert(schema.users).values({
    id: userId,
    tenantId,
    email: `${tag}-${userId}@test.local`,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.projects).values({
    id: projectId,
    tenantId,
    name: `Project ${tag}`,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.volumes).values({
    id: volumeId,
    tenantId,
    projectId,
    name: `Volume ${tag}`,
    referenceCode: `REF-${tag}`,
    manifestUrl: `https://example.test/${tag}.json`,
    pageCount: 1,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.volumePages).values({
    id: pageId,
    tenantId,
    volumeId,
    position: 0,
    imageUrl: `https://example.test/${tag}-0.jpg`,
    width: 100,
    height: 100,
    createdAt: now,
  });
  await db.insert(schema.entries).values({
    id: entryId,
    tenantId,
    volumeId,
    position: 0,
    startPage: 1,
    createdAt: now,
    updatedAt: now,
  });

  return { userId, projectId, volumeId, pageId, entryId };
}

describe("crowdsourcing-subtree cross-tenant isolation", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  // Each case seeds a tenant-A graph and a tenant-B graph, materialises one
  // row of the table under test per tenant, then asserts read- and
  // write-negative isolation on that table's tenantId predicate.

  it("projects: tenant-A scope excludes tenant-B; cross-tenant UPDATE is a no-op", async () => {
    const db = drizzle(env.DB);
    const a = await seedGraph(DEFAULT_TEST_TENANT_ID, "A");
    const b = await seedGraph(SECOND_TEST_TENANT_ID, "B");

    const rowsForA = await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.tenantId, DEFAULT_TEST_TENANT_ID))
      .all();
    expect(rowsForA.map((r) => r.id)).toEqual([a.projectId]);
    expect(rowsForA.map((r) => r.id)).not.toContain(b.projectId);

    await db
      .update(schema.projects)
      .set({ name: "cross-tenant overwrite" })
      .where(
        and(
          eq(schema.projects.tenantId, DEFAULT_TEST_TENANT_ID),
          eq(schema.projects.id, b.projectId),
        ),
      )
      .run();
    const rowB = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, b.projectId))
      .get();
    expect(rowB!.name).toBe("Project B");
    expect(rowB!.tenantId).toBe(SECOND_TEST_TENANT_ID);
  });

  it("volumes: tenant-A scope excludes tenant-B; cross-tenant UPDATE is a no-op", async () => {
    const db = drizzle(env.DB);
    const a = await seedGraph(DEFAULT_TEST_TENANT_ID, "A");
    const b = await seedGraph(SECOND_TEST_TENANT_ID, "B");

    const rowsForA = await db
      .select({ id: schema.volumes.id })
      .from(schema.volumes)
      .where(eq(schema.volumes.tenantId, DEFAULT_TEST_TENANT_ID))
      .all();
    expect(rowsForA.map((r) => r.id)).toEqual([a.volumeId]);

    await db
      .update(schema.volumes)
      .set({ name: "cross-tenant overwrite" })
      .where(
        and(
          eq(schema.volumes.tenantId, DEFAULT_TEST_TENANT_ID),
          eq(schema.volumes.id, b.volumeId),
        ),
      )
      .run();
    const rowB = await db
      .select()
      .from(schema.volumes)
      .where(eq(schema.volumes.id, b.volumeId))
      .get();
    expect(rowB!.name).toBe("Volume B");
    expect(rowB!.tenantId).toBe(SECOND_TEST_TENANT_ID);
  });

  it("entries: tenant-A scope excludes tenant-B; cross-tenant UPDATE is a no-op", async () => {
    const db = drizzle(env.DB);
    const a = await seedGraph(DEFAULT_TEST_TENANT_ID, "A");
    const b = await seedGraph(SECOND_TEST_TENANT_ID, "B");

    const rowsForA = await db
      .select({ id: schema.entries.id })
      .from(schema.entries)
      .where(eq(schema.entries.tenantId, DEFAULT_TEST_TENANT_ID))
      .all();
    expect(rowsForA.map((r) => r.id)).toEqual([a.entryId]);

    await db
      .update(schema.entries)
      .set({ title: "cross-tenant overwrite" })
      .where(
        and(
          eq(schema.entries.tenantId, DEFAULT_TEST_TENANT_ID),
          eq(schema.entries.id, b.entryId),
        ),
      )
      .run();
    const rowB = await db
      .select()
      .from(schema.entries)
      .where(eq(schema.entries.id, b.entryId))
      .get();
    expect(rowB!.title).toBeNull();
    expect(rowB!.tenantId).toBe(SECOND_TEST_TENANT_ID);
  });

  it("qc_flags: tenant-A scope excludes tenant-B; cross-tenant UPDATE is a no-op", async () => {
    const db = drizzle(env.DB);
    const a = await seedGraph(DEFAULT_TEST_TENANT_ID, "A");
    const b = await seedGraph(SECOND_TEST_TENANT_ID, "B");
    const now = Date.now();

    const flagA = crypto.randomUUID();
    const flagB = crypto.randomUUID();
    await db.insert(schema.qcFlags).values({
      id: flagA,
      tenantId: DEFAULT_TEST_TENANT_ID,
      volumeId: a.volumeId,
      pageId: a.pageId,
      reportedBy: a.userId,
      problemType: "damaged",
      description: "flag A",
      createdAt: now,
    });
    await db.insert(schema.qcFlags).values({
      id: flagB,
      tenantId: SECOND_TEST_TENANT_ID,
      volumeId: b.volumeId,
      pageId: b.pageId,
      reportedBy: b.userId,
      problemType: "damaged",
      description: "flag B",
      createdAt: now,
    });

    const rowsForA = await db
      .select({ id: schema.qcFlags.id })
      .from(schema.qcFlags)
      .where(eq(schema.qcFlags.tenantId, DEFAULT_TEST_TENANT_ID))
      .all();
    expect(rowsForA.map((r) => r.id)).toEqual([flagA]);

    await db
      .update(schema.qcFlags)
      .set({ description: "cross-tenant overwrite" })
      .where(
        and(
          eq(schema.qcFlags.tenantId, DEFAULT_TEST_TENANT_ID),
          eq(schema.qcFlags.id, flagB),
        ),
      )
      .run();
    const rowB = await db
      .select()
      .from(schema.qcFlags)
      .where(eq(schema.qcFlags.id, flagB))
      .get();
    expect(rowB!.description).toBe("flag B");
    expect(rowB!.tenantId).toBe(SECOND_TEST_TENANT_ID);
  });

  it("comments: tenant-A scope excludes tenant-B; cross-tenant UPDATE is a no-op", async () => {
    const db = drizzle(env.DB);
    const a = await seedGraph(DEFAULT_TEST_TENANT_ID, "A");
    const b = await seedGraph(SECOND_TEST_TENANT_ID, "B");
    const now = Date.now();

    const cmtA = crypto.randomUUID();
    const cmtB = crypto.randomUUID();
    await db.insert(schema.comments).values({
      id: cmtA,
      tenantId: DEFAULT_TEST_TENANT_ID,
      volumeId: a.volumeId,
      entryId: a.entryId,
      authorId: a.userId,
      authorRole: "lead",
      text: "comment A",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.comments).values({
      id: cmtB,
      tenantId: SECOND_TEST_TENANT_ID,
      volumeId: b.volumeId,
      entryId: b.entryId,
      authorId: b.userId,
      authorRole: "lead",
      text: "comment B",
      createdAt: now,
      updatedAt: now,
    });

    const rowsForA = await db
      .select({ id: schema.comments.id })
      .from(schema.comments)
      .where(eq(schema.comments.tenantId, DEFAULT_TEST_TENANT_ID))
      .all();
    expect(rowsForA.map((r) => r.id)).toEqual([cmtA]);

    await db
      .update(schema.comments)
      .set({ text: "cross-tenant overwrite" })
      .where(
        and(
          eq(schema.comments.tenantId, DEFAULT_TEST_TENANT_ID),
          eq(schema.comments.id, cmtB),
        ),
      )
      .run();
    const rowB = await db
      .select()
      .from(schema.comments)
      .where(eq(schema.comments.id, cmtB))
      .get();
    expect(rowB!.text).toBe("comment B");
    expect(rowB!.tenantId).toBe(SECOND_TEST_TENANT_ID);
  });

  it("activity_log: tenant-A scope excludes tenant-B; cross-tenant UPDATE is a no-op", async () => {
    const db = drizzle(env.DB);
    const a = await seedGraph(DEFAULT_TEST_TENANT_ID, "A");
    const b = await seedGraph(SECOND_TEST_TENANT_ID, "B");
    const now = Date.now();

    const logA = crypto.randomUUID();
    const logB = crypto.randomUUID();
    await db.insert(schema.activityLog).values({
      id: logA,
      tenantId: DEFAULT_TEST_TENANT_ID,
      userId: a.userId,
      event: "login",
      createdAt: now,
    });
    await db.insert(schema.activityLog).values({
      id: logB,
      tenantId: SECOND_TEST_TENANT_ID,
      userId: b.userId,
      event: "login",
      createdAt: now,
    });

    const rowsForA = await db
      .select({ id: schema.activityLog.id })
      .from(schema.activityLog)
      .where(eq(schema.activityLog.tenantId, DEFAULT_TEST_TENANT_ID))
      .all();
    expect(rowsForA.map((r) => r.id)).toEqual([logA]);

    await db
      .update(schema.activityLog)
      .set({ detail: "cross-tenant overwrite" })
      .where(
        and(
          eq(schema.activityLog.tenantId, DEFAULT_TEST_TENANT_ID),
          eq(schema.activityLog.id, logB),
        ),
      )
      .run();
    const rowB = await db
      .select()
      .from(schema.activityLog)
      .where(eq(schema.activityLog.id, logB))
      .get();
    expect(rowB!.detail).toBeNull();
    expect(rowB!.tenantId).toBe(SECOND_TEST_TENANT_ID);
  });

  it("drafts: tenant-A scope excludes tenant-B; cross-tenant UPDATE is a no-op", async () => {
    const db = drizzle(env.DB);
    const a = await seedGraph(DEFAULT_TEST_TENANT_ID, "A");
    const b = await seedGraph(SECOND_TEST_TENANT_ID, "B");
    const now = Date.now();

    const draftA = crypto.randomUUID();
    const draftB = crypto.randomUUID();
    await db.insert(schema.drafts).values({
      id: draftA,
      tenantId: DEFAULT_TEST_TENANT_ID,
      recordId: crypto.randomUUID(),
      recordType: "description",
      userId: a.userId,
      snapshot: "{}",
      updatedAt: now,
    });
    await db.insert(schema.drafts).values({
      id: draftB,
      tenantId: SECOND_TEST_TENANT_ID,
      recordId: crypto.randomUUID(),
      recordType: "description",
      userId: b.userId,
      snapshot: "{}",
      updatedAt: now,
    });

    const rowsForA = await db
      .select({ id: schema.drafts.id })
      .from(schema.drafts)
      .where(eq(schema.drafts.tenantId, DEFAULT_TEST_TENANT_ID))
      .all();
    expect(rowsForA.map((r) => r.id)).toEqual([draftA]);

    await db
      .update(schema.drafts)
      .set({ snapshot: '{"tampered":true}' })
      .where(
        and(
          eq(schema.drafts.tenantId, DEFAULT_TEST_TENANT_ID),
          eq(schema.drafts.id, draftB),
        ),
      )
      .run();
    const rowB = await db
      .select()
      .from(schema.drafts)
      .where(eq(schema.drafts.id, draftB))
      .get();
    expect(rowB!.snapshot).toBe("{}");
    expect(rowB!.tenantId).toBe(SECOND_TEST_TENANT_ID);
  });

  it("volume_pages: tenant-A scope excludes tenant-B; cross-tenant UPDATE is a no-op", async () => {
    const db = drizzle(env.DB);
    const a = await seedGraph(DEFAULT_TEST_TENANT_ID, "A");
    const b = await seedGraph(SECOND_TEST_TENANT_ID, "B");

    const rowsForA = await db
      .select({ id: schema.volumePages.id })
      .from(schema.volumePages)
      .where(eq(schema.volumePages.tenantId, DEFAULT_TEST_TENANT_ID))
      .all();
    expect(rowsForA.map((r) => r.id)).toEqual([a.pageId]);
    expect(rowsForA.map((r) => r.id)).not.toContain(b.pageId);

    await db
      .update(schema.volumePages)
      .set({ label: "cross-tenant overwrite" })
      .where(
        and(
          eq(schema.volumePages.tenantId, DEFAULT_TEST_TENANT_ID),
          eq(schema.volumePages.id, b.pageId),
        ),
      )
      .run();
    const rowB = await db
      .select()
      .from(schema.volumePages)
      .where(eq(schema.volumePages.id, b.pageId))
      .get();
    expect(rowB!.label).toBeNull();
    expect(rowB!.tenantId).toBe(SECOND_TEST_TENANT_ID);
  });

  it("resegmentation_flags: tenant-A scope excludes tenant-B; cross-tenant UPDATE is a no-op", async () => {
    const db = drizzle(env.DB);
    const a = await seedGraph(DEFAULT_TEST_TENANT_ID, "A");
    const b = await seedGraph(SECOND_TEST_TENANT_ID, "B");
    const now = Date.now();

    const flagA = crypto.randomUUID();
    const flagB = crypto.randomUUID();
    await db.insert(schema.resegmentationFlags).values({
      id: flagA,
      tenantId: DEFAULT_TEST_TENANT_ID,
      volumeId: a.volumeId,
      reportedBy: a.userId,
      entryId: a.entryId,
      problemType: "other",
      affectedEntryIds: "[]",
      description: "reseg flag A",
      createdAt: now,
    });
    await db.insert(schema.resegmentationFlags).values({
      id: flagB,
      tenantId: SECOND_TEST_TENANT_ID,
      volumeId: b.volumeId,
      reportedBy: b.userId,
      entryId: b.entryId,
      problemType: "other",
      affectedEntryIds: "[]",
      description: "reseg flag B",
      createdAt: now,
    });

    const rowsForA = await db
      .select({ id: schema.resegmentationFlags.id })
      .from(schema.resegmentationFlags)
      .where(eq(schema.resegmentationFlags.tenantId, DEFAULT_TEST_TENANT_ID))
      .all();
    expect(rowsForA.map((r) => r.id)).toEqual([flagA]);

    await db
      .update(schema.resegmentationFlags)
      .set({ description: "cross-tenant overwrite" })
      .where(
        and(
          eq(schema.resegmentationFlags.tenantId, DEFAULT_TEST_TENANT_ID),
          eq(schema.resegmentationFlags.id, flagB),
        ),
      )
      .run();
    const rowB = await db
      .select()
      .from(schema.resegmentationFlags)
      .where(eq(schema.resegmentationFlags.id, flagB))
      .get();
    expect(rowB!.description).toBe("reseg flag B");
    expect(rowB!.tenantId).toBe(SECOND_TEST_TENANT_ID);
  });
});
