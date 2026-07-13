/**
 * Tests — comments storage server helpers
 *
 * This suite pins the nine server-side helpers in
 * `app/lib/comments.server.ts` that back every comment surface:
 * `createComment`, the four read paths
 * (`getCommentsForEntry`, `getCommentsForPage`,
 * `getCommentsForQcFlag`, `getCommentsForVolume`), the three
 * mutation paths (`resolveComment`, `softDeleteComment`,
 * `updateCommentBody`, `updateCommentRegion`).
 *
 * The helpers operate at the storage layer — they assume the
 * route handlers have already done tenant resolution and FK
 * checks, so the tests here pin the SQL-level behaviour: ordering,
 * cascade semantics on `parentId` (reply threads), soft-delete
 * preservation (the row stays, only `deletedAt` toggles, so the
 * audit history survives), and the region-update path that
 * lets a lead reposition a region pin without recreating the
 * comment.
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
  createComment,
  getCommentsForEntry,
  getCommentsForPage,
  getCommentsForQcFlag,
  getCommentsForVolume,
  resolveComment,
  softDeleteComment,
  updateCommentBody,
  updateCommentRegion,
} from "../../app/lib/comments.server";

type Db = ReturnType<typeof drizzle>;

async function seedFixture(db: Db) {
  const user = await createTestUser({ email: "lead@example.com" });
  const now = Date.now();
  const projectId = crypto.randomUUID();
  const volumeId = crypto.randomUUID();
  const entryId = crypto.randomUUID();
  const pageId = crypto.randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    tenantId: DEFAULT_TEST_TENANT_ID,
    name: "Test Project",
    createdBy: user.id,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(schema.projectMembers).values({
    id: crypto.randomUUID(),
    projectId,
    userId: user.id,
    role: "lead",
    createdAt: now,
  });

  await db.insert(schema.volumes).values({
    id: volumeId,
    tenantId: DEFAULT_TEST_TENANT_ID,
    projectId,
    name: "Test Volume",
    referenceCode: "co-test-vol",
    manifestUrl: "https://example.com/manifest.json",
    pageCount: 2,
    status: "in_progress",
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(schema.volumePages).values({
    id: pageId,
    tenantId: DEFAULT_TEST_TENANT_ID,
    volumeId,
    position: 1,
    imageUrl: "https://example.com/image-1.jpg",
    width: 800,
    height: 1200,
    label: "f.1r",
    createdAt: now,
  });

  await db.insert(schema.entries).values({
    id: entryId,
    tenantId: DEFAULT_TEST_TENANT_ID,
    volumeId,
    position: 0,
    startPage: 1,
    startY: 0,
    type: "item",
    title: "Test Entry",
    createdAt: now,
    updatedAt: now,
  });

  const qcFlagId = crypto.randomUUID();
  await db.insert(schema.qcFlags).values({
    id: qcFlagId,
    tenantId: DEFAULT_TEST_TENANT_ID,
    volumeId,
    pageId,
    reportedBy: user.id,
    problemType: "damaged",
    description: "torn margin",
    status: "open",
    createdAt: now,
  });

  return { user, projectId, volumeId, entryId, pageId, qcFlagId };
}

describe("createComment ()", () => {
  let db: Db;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
  });

  it("writes an entry-targeted comment with page_id NULL", async () => {
    const { user, volumeId, entryId } = await seedFixture(db);

    const result = await createComment(db, {
      target: { kind: "entry", entryId },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "entry comment",
    });

    const [row] = await db
      .select()
      .from(schema.comments)
      .where(eq(schema.comments.id, result.id))
      .all();

    expect(row).toBeDefined();
    expect(row.entryId).toBe(entryId);
    expect(row.pageId).toBeNull();
    expect(row.volumeId).toBe(volumeId);
    expect(row.text).toBe("entry comment");
  });

  it("writes a page-targeted comment with entry_id NULL", async () => {
    const { user, volumeId, pageId } = await seedFixture(db);

    const result = await createComment(db, {
      target: { kind: "page", pageId },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "page comment",
    });

    const [row] = await db
      .select()
      .from(schema.comments)
      .where(eq(schema.comments.id, result.id))
      .all();

    expect(row).toBeDefined();
    expect(row.entryId).toBeNull();
    expect(row.pageId).toBe(pageId);
    expect(row.volumeId).toBe(volumeId);
    expect(row.text).toBe("page comment");
  });

  it("DB CHECK rejects a direct insert that sets both entry_id and page_id", async () => {
    const { user, volumeId, entryId, pageId } = await seedFixture(db);
    const now = Date.now();
    const id = crypto.randomUUID();

    await expect(
      env.DB.prepare(
        `INSERT INTO comments (id, volume_id, entry_id, page_id, parent_id, author_id, author_role, text, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`
      )
        .bind(
          id,
          volumeId,
          entryId,
          pageId,
          user.id,
          "lead",
          "both",
          now,
          now
        )
        .run()
    ).rejects.toBeTruthy();
  });
});

describe("getCommentsForPage / getCommentsForVolume ()", () => {
  let db: Db;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
  });

  it("getCommentsForPage returns only page-targeted comments for the given page", async () => {
    const { user, volumeId, entryId, pageId } = await seedFixture(db);

    await createComment(db, {
      target: { kind: "entry", entryId },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "entry-level",
    });
    await createComment(db, {
      target: { kind: "page", pageId },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "page-level",
    });

    const rows = await getCommentsForPage(db, pageId);

    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("page-level");
    expect(rows[0].pageId).toBe(pageId);
    expect(rows[0].entryId).toBeNull();
  });

  it("getCommentsForVolume returns BOTH entry- and page-targeted rows for the volume, sorted by created_at ASC", async () => {
    const { user, volumeId, entryId, pageId } = await seedFixture(db);

    const first = await createComment(db, {
      target: { kind: "entry", entryId },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "first",
    });
    // Ensure the second row's createdAt is strictly greater so ORDER BY
    // gives a deterministic ordering in the test.
    await new Promise((r) => setTimeout(r, 5));
    const second = await createComment(db, {
      target: { kind: "page", pageId },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "second",
    });

    const rows = await getCommentsForVolume(db, volumeId);

    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(first.id);
    expect(rows[1].id).toBe(second.id);
    expect(rows[0].entryId).toBe(entryId);
    expect(rows[1].pageId).toBe(pageId);
  });
});

describe("createComment / getCommentsForQcFlag / region columns ()", () => {
  let db: Db;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
  });

  it("writes a qcFlag-targeted comment with entry_id, page_id, and all region columns NULL", async () => {
    const { user, volumeId, qcFlagId } = await seedFixture(db);

    const result = await createComment(db, {
      target: { kind: "qcFlag", qcFlagId },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "reply to flag",
    });

    const [row] = await db
      .select()
      .from(schema.comments)
      .where(eq(schema.comments.id, result.id))
      .all();

    expect(row).toBeDefined();
    expect(row.qcFlagId).toBe(qcFlagId);
    expect(row.entryId).toBeNull();
    expect(row.pageId).toBeNull();
    expect(row.regionX).toBeNull();
    expect(row.regionY).toBeNull();
    expect(row.regionW).toBeNull();
    expect(row.regionH).toBeNull();
  });

  it("writes a page-targeted comment with region coordinates", async () => {
    const { user, volumeId, pageId } = await seedFixture(db);

    const result = await createComment(db, {
      target: {
        kind: "page",
        pageId,
        region: { x: 0.5, y: 0.25, w: 0, h: 0 },
      },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "see this pin",
    });

    const [row] = await db
      .select()
      .from(schema.comments)
      .where(eq(schema.comments.id, result.id))
      .all();

    expect(row.pageId).toBe(pageId);
    expect(row.regionX).toBe(0.5);
    expect(row.regionY).toBe(0.25);
    expect(row.regionW).toBe(0);
    expect(row.regionH).toBe(0);
  });

  it("writes a page-targeted comment with NULL region columns when no region supplied", async () => {
    const { user, volumeId, pageId } = await seedFixture(db);

    const result = await createComment(db, {
      target: { kind: "page", pageId },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "no region",
    });

    const [row] = await db
      .select()
      .from(schema.comments)
      .where(eq(schema.comments.id, result.id))
      .all();

    expect(row.pageId).toBe(pageId);
    expect(row.regionX).toBeNull();
    expect(row.regionY).toBeNull();
    expect(row.regionW).toBeNull();
    expect(row.regionH).toBeNull();
  });

  it("clamps region coordinates outside [0, 1] into the normalised range", async () => {
    const { user, volumeId, pageId } = await seedFixture(db);

    const result = await createComment(db, {
      target: {
        kind: "page",
        pageId,
        region: { x: 1.5, y: -0.2, w: 2, h: -0.5 },
      },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "clamp me",
    });

    const [row] = await db
      .select()
      .from(schema.comments)
      .where(eq(schema.comments.id, result.id))
      .all();

    expect(row.regionX).toBe(1);
    expect(row.regionY).toBe(0);
    expect(row.regionW).toBe(1);
    expect(row.regionH).toBe(0);
  });

  it("getCommentsForQcFlag returns only qcFlag-targeted rows for the given flag, ordered by created_at ASC", async () => {
    const { user, volumeId, entryId, pageId, qcFlagId } = await seedFixture(db);

    await createComment(db, {
      target: { kind: "entry", entryId },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "entry-level",
    });
    await createComment(db, {
      target: { kind: "page", pageId },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "page-level",
    });
    const first = await createComment(db, {
      target: { kind: "qcFlag", qcFlagId },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "flag reply 1",
    });
    await new Promise((r) => setTimeout(r, 5));
    const second = await createComment(db, {
      target: { kind: "qcFlag", qcFlagId },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "flag reply 2",
    });

    const rows = await getCommentsForQcFlag(db, qcFlagId);

    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(first.id);
    expect(rows[1].id).toBe(second.id);
    expect(rows[0].qcFlagId).toBe(qcFlagId);
    expect(rows[0].entryId).toBeNull();
    expect(rows[0].pageId).toBeNull();
    // Author join populated
    expect(rows[0].authorEmail).toBeTruthy();
  });

  it("getCommentsForVolume returns entry, page, and qcFlag rows with extended columns projected", async () => {
    const { user, volumeId, entryId, pageId, qcFlagId } = await seedFixture(db);

    await createComment(db, {
      target: { kind: "entry", entryId },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "entry",
    });
    await new Promise((r) => setTimeout(r, 5));
    await createComment(db, {
      target: {
        kind: "page",
        pageId,
        region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "page with region",
    });
    await new Promise((r) => setTimeout(r, 5));
    await createComment(db, {
      target: { kind: "qcFlag", qcFlagId },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "flag",
    });

    const rows = await getCommentsForVolume(db, volumeId);

    expect(rows).toHaveLength(3);
    // All new columns projected
    expect(rows[0]).toHaveProperty("qcFlagId");
    expect(rows[0]).toHaveProperty("regionX");
    expect(rows[0]).toHaveProperty("regionY");
    expect(rows[0]).toHaveProperty("regionW");
    expect(rows[0]).toHaveProperty("regionH");

    // Partition by target kind
    const entryRow = rows.find((r) => r.entryId);
    const pageRow = rows.find((r) => r.pageId);
    const flagRow = rows.find((r) => r.qcFlagId);
    expect(entryRow?.entryId).toBe(entryId);
    expect(pageRow?.pageId).toBe(pageId);
    expect(pageRow?.regionX).toBeCloseTo(0.1);
    expect(pageRow?.regionY).toBeCloseTo(0.2);
    expect(pageRow?.regionW).toBeCloseTo(0.3);
    expect(pageRow?.regionH).toBeCloseTo(0.4);
    expect(flagRow?.qcFlagId).toBe(qcFlagId);
  });
});

describe("updateCommentRegion -- task 15 ()", () => {
  let db: Db;

  beforeAll(async () => {
    db = drizzle(env.DB);
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("updates a region-anchored comment when the caller is the author", async () => {
    const { user, volumeId, pageId } = await seedFixture(db);

    const { id } = await createComment(db, {
      target: {
        kind: "page",
        pageId,
        region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "original region",
    });

    const result = await updateCommentRegion(db, id, user.id, {
      regionX: 0.5,
      regionY: 0.6,
      regionW: 0.3,
      regionH: 0.4,
    });

    expect(result.pageId).toBe(pageId);
    expect(result.volumeId).toBe(volumeId);
    expect(result.previousRegion.regionX).toBeCloseTo(0.1);
    expect(result.previousRegion.regionY).toBeCloseTo(0.2);

    const [row] = await db
      .select()
      .from(schema.comments)
      .where(eq(schema.comments.id, id))
      .all();
    expect(row.regionX).toBeCloseTo(0.5);
    expect(row.regionY).toBeCloseTo(0.6);
    expect(row.regionW).toBeCloseTo(0.3);
    expect(row.regionH).toBeCloseTo(0.4);
  });

  it("moves a point pin and keeps w/h at 0", async () => {
    const { user, volumeId, pageId } = await seedFixture(db);

    const { id } = await createComment(db, {
      target: {
        kind: "page",
        pageId,
        region: { x: 0.1, y: 0.2, w: 0, h: 0 },
      },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "point",
    });

    await updateCommentRegion(db, id, user.id, {
      regionX: 0.8,
      regionY: 0.9,
    });

    const [row] = await db
      .select()
      .from(schema.comments)
      .where(eq(schema.comments.id, id))
      .all();
    expect(row.regionX).toBeCloseTo(0.8);
    expect(row.regionY).toBeCloseTo(0.9);
    expect(row.regionW).toBeNull();
    expect(row.regionH).toBeNull();
  });

  it("throws 403 when the caller is not the author", async () => {
    const { user, volumeId, pageId } = await seedFixture(db);
    const otherUser = await createTestUser({ email: "other@example.com" });

    const { id } = await createComment(db, {
      target: {
        kind: "page",
        pageId,
        region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "mine",
    });

    await expect(
      updateCommentRegion(db, id, otherUser.id, {
        regionX: 0.5,
        regionY: 0.5,
        regionW: 0.3,
        regionH: 0.4,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("throws 404 when the comment does not exist", async () => {
    const { user } = await seedFixture(db);

    await expect(
      updateCommentRegion(db, "nonexistent-id", user.id, {
        regionX: 0.5,
        regionY: 0.5,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("throws 400 when the comment is not region-anchored", async () => {
    const { user, volumeId, entryId } = await seedFixture(db);

    const { id } = await createComment(db, {
      target: { kind: "entry", entryId },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "entry comment, no region",
    });

    await expect(
      updateCommentRegion(db, id, user.id, {
        regionX: 0.5,
        regionY: 0.5,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("throws 400 when the shape would change (point -> box)", async () => {
    const { user, volumeId, pageId } = await seedFixture(db);

    const { id } = await createComment(db, {
      target: {
        kind: "page",
        pageId,
        region: { x: 0.1, y: 0.2, w: 0, h: 0 },
      },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "point pin",
    });

    await expect(
      updateCommentRegion(db, id, user.id, {
        regionX: 0.1,
        regionY: 0.2,
        regionW: 0.3,
        regionH: 0.4,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("throws 400 when the shape would change (box -> point)", async () => {
    const { user, volumeId, pageId } = await seedFixture(db);

    const { id } = await createComment(db, {
      target: {
        kind: "page",
        pageId,
        region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "box pin",
    });

    await expect(
      updateCommentRegion(db, id, user.id, {
        regionX: 0.1,
        regionY: 0.2,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("softDeleteComment + deleted-row filter -- task 13 ()", () => {
  let db: Db;

  beforeAll(async () => {
    db = drizzle(env.DB);
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("soft-deletes a leaf comment for its author", async () => {
    const { user, volumeId, entryId } = await seedFixture(db);

    const { id } = await createComment(db, {
      target: { kind: "entry", entryId },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "hello",
    });

    const result = await softDeleteComment(db, id, user.id, false);

    expect(result.cascadedCount).toBe(0);

    const [row] = await db
      .select({
        deletedAt: schema.comments.deletedAt,
        deletedBy: schema.comments.deletedBy,
      })
      .from(schema.comments)
      .where(eq(schema.comments.id, id))
      .all();
    expect(row?.deletedAt).toBeTruthy();
    expect(row?.deletedBy).toBe(user.id);
  });

  it("cascades to replies when soft-deleting a root", async () => {
    const { user, volumeId, entryId } = await seedFixture(db);

    const { id: rootId } = await createComment(db, {
      target: { kind: "entry", entryId },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "root",
    });
    await createComment(db, {
      target: { kind: "entry", entryId },
      volumeId,
      parentId: rootId,
      authorId: user.id,
      authorRole: "lead",
      text: "reply 1",
    });
    await createComment(db, {
      target: { kind: "entry", entryId },
      volumeId,
      parentId: rootId,
      authorId: user.id,
      authorRole: "lead",
      text: "reply 2",
    });

    const result = await softDeleteComment(db, rootId, user.id, false);

    expect(result.cascadedCount).toBe(2);

    // All three rows are now soft-deleted.
    const remaining = await getCommentsForEntry(db, entryId);
    expect(remaining).toHaveLength(0);
  });

  it("soft-deletes a single reply without touching siblings or root", async () => {
    const { user, volumeId, entryId } = await seedFixture(db);

    const { id: rootId } = await createComment(db, {
      target: { kind: "entry", entryId },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "root",
    });
    const { id: reply1 } = await createComment(db, {
      target: { kind: "entry", entryId },
      volumeId,
      parentId: rootId,
      authorId: user.id,
      authorRole: "lead",
      text: "reply 1",
    });
    await createComment(db, {
      target: { kind: "entry", entryId },
      volumeId,
      parentId: rootId,
      authorId: user.id,
      authorRole: "lead",
      text: "reply 2",
    });

    const result = await softDeleteComment(db, reply1, user.id, false);
    expect(result.cascadedCount).toBe(0);

    const remaining = await getCommentsForEntry(db, entryId);
    expect(remaining).toHaveLength(2);
    expect(remaining.map((r) => r.id).sort()).not.toContain(reply1);
  });

  it("throws 403 when a non-author non-lead tries to delete", async () => {
    const { user, volumeId, entryId } = await seedFixture(db);
    const other = await createTestUser({ email: "other@example.com" });

    const { id } = await createComment(db, {
      target: { kind: "entry", entryId },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "mine",
    });

    await expect(
      softDeleteComment(db, id, other.id, false),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("lets a lead delete another user's comment", async () => {
    const { user, volumeId, entryId } = await seedFixture(db);
    const other = await createTestUser({ email: "other@example.com" });

    const { id } = await createComment(db, {
      target: { kind: "entry", entryId },
      volumeId,
      parentId: null,
      authorId: other.id,
      authorRole: "cataloguer",
      text: "not yours",
    });

    const result = await softDeleteComment(db, id, user.id, true);
    expect(result.cascadedCount).toBe(0);
  });

  it("throws 404 for a missing id and 410 for an already-deleted row", async () => {
    const { user, volumeId, entryId } = await seedFixture(db);

    await expect(
      softDeleteComment(db, "missing-id", user.id, false),
    ).rejects.toMatchObject({ status: 404 });

    const { id } = await createComment(db, {
      target: { kind: "entry", entryId },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "hello",
    });
    await softDeleteComment(db, id, user.id, false);

    await expect(
      softDeleteComment(db, id, user.id, false),
    ).rejects.toMatchObject({ status: 410 });
  });

  it("filters deleted rows out of all four read helpers", async () => {
    const { user, volumeId, entryId, pageId, qcFlagId } = await seedFixture(db);

    const { id: entryComment } = await createComment(db, {
      target: { kind: "entry", entryId },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "entry",
    });
    const { id: pageComment } = await createComment(db, {
      target: { kind: "page", pageId },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "page",
    });
    const { id: qcComment } = await createComment(db, {
      target: { kind: "qcFlag", qcFlagId },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "qc",
    });

    await softDeleteComment(db, entryComment, user.id, false);
    await softDeleteComment(db, pageComment, user.id, false);
    await softDeleteComment(db, qcComment, user.id, false);

    expect(await getCommentsForEntry(db, entryId)).toHaveLength(0);
    expect(await getCommentsForPage(db, pageId)).toHaveLength(0);
    expect(await getCommentsForQcFlag(db, qcFlagId)).toHaveLength(0);
    expect(await getCommentsForVolume(db, volumeId)).toHaveLength(0);
  });
});

describe("updateCommentBody -- task 13 ()", () => {
  let db: Db;

  beforeAll(async () => {
    db = drizzle(env.DB);
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("updates the body text and sets editedAt for the author", async () => {
    const { user, volumeId, entryId } = await seedFixture(db);

    const { id } = await createComment(db, {
      target: { kind: "entry", entryId },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "original",
    });

    const result = await updateCommentBody(db, id, user.id, "rewritten");
    expect(result.changed).toBe(true);
    expect(result.oldLength).toBe("original".length);
    expect(result.newLength).toBe("rewritten".length);

    const [row] = await db
      .select({
        text: schema.comments.text,
        editedAt: schema.comments.editedAt,
      })
      .from(schema.comments)
      .where(eq(schema.comments.id, id))
      .all();
    expect(row?.text).toBe("rewritten");
    expect(row?.editedAt).toBeTruthy();
  });

  it("throws 403 when a non-author tries to edit", async () => {
    const { user, volumeId, entryId } = await seedFixture(db);
    const other = await createTestUser({ email: "other@example.com" });

    const { id } = await createComment(db, {
      target: { kind: "entry", entryId },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "mine",
    });

    await expect(
      updateCommentBody(db, id, other.id, "tampered"),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("throws 410 for a soft-deleted comment", async () => {
    const { user, volumeId, entryId } = await seedFixture(db);

    const { id } = await createComment(db, {
      target: { kind: "entry", entryId },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "going away",
    });
    await softDeleteComment(db, id, user.id, false);

    await expect(
      updateCommentBody(db, id, user.id, "too late"),
    ).rejects.toMatchObject({ status: 410 });
  });

  it("throws 400 for an empty body after trim", async () => {
    const { user, volumeId, entryId } = await seedFixture(db);

    const { id } = await createComment(db, {
      target: { kind: "entry", entryId },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "something",
    });

    await expect(
      updateCommentBody(db, id, user.id, "   "),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("is a no-op (no editedAt bump) when the body is unchanged", async () => {
    const { user, volumeId, entryId } = await seedFixture(db);

    const { id } = await createComment(db, {
      target: { kind: "entry", entryId },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "same",
    });

    const result = await updateCommentBody(db, id, user.id, "same");
    expect(result.changed).toBe(false);

    const [row] = await db
      .select({ editedAt: schema.comments.editedAt })
      .from(schema.comments)
      .where(eq(schema.comments.id, id))
      .all();
    expect(row?.editedAt).toBeNull();
  });
});

describe("resolveComment -- task 13 ()", () => {
  let db: Db;

  beforeAll(async () => {
    db = drizzle(env.DB);
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("sets resolvedAt + resolvedBy on a fresh root when called with resolved=true", async () => {
    const { user, volumeId, entryId } = await seedFixture(db);

    const { id } = await createComment(db, {
      target: { kind: "entry", entryId },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "question?",
    });

    const result = await resolveComment(db, id, user.id, true);
    expect(result.changed).toBe(true);

    const [row] = await db
      .select({
        resolvedAt: schema.comments.resolvedAt,
        resolvedBy: schema.comments.resolvedBy,
        editedAt: schema.comments.editedAt,
      })
      .from(schema.comments)
      .where(eq(schema.comments.id, id))
      .all();
    expect(row?.resolvedAt).toBeTruthy();
    expect(row?.resolvedBy).toBe(user.id);
    expect(row?.editedAt).toBeNull();
  });

  it("clears resolvedAt + resolvedBy when called with resolved=false on a resolved root", async () => {
    const { user, volumeId, entryId } = await seedFixture(db);

    const { id } = await createComment(db, {
      target: { kind: "entry", entryId },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "question?",
    });
    await resolveComment(db, id, user.id, true);

    const result = await resolveComment(db, id, user.id, false);
    expect(result.changed).toBe(true);

    const [row] = await db
      .select({
        resolvedAt: schema.comments.resolvedAt,
        resolvedBy: schema.comments.resolvedBy,
      })
      .from(schema.comments)
      .where(eq(schema.comments.id, id))
      .all();
    expect(row?.resolvedAt).toBeNull();
    expect(row?.resolvedBy).toBeNull();
  });

  it("throws 400 when called on a reply", async () => {
    const { user, volumeId, entryId } = await seedFixture(db);

    const { id: rootId } = await createComment(db, {
      target: { kind: "entry", entryId },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "root",
    });
    const { id: replyId } = await createComment(db, {
      target: { kind: "entry", entryId },
      volumeId,
      parentId: rootId,
      authorId: user.id,
      authorRole: "lead",
      text: "reply",
    });

    await expect(
      resolveComment(db, replyId, user.id, true),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("throws 410 on a soft-deleted comment", async () => {
    const { user, volumeId, entryId } = await seedFixture(db);

    const { id } = await createComment(db, {
      target: { kind: "entry", entryId },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "going away",
    });
    await softDeleteComment(db, id, user.id, false);

    await expect(
      resolveComment(db, id, user.id, true),
    ).rejects.toMatchObject({ status: 410 });
  });

  it("is a no-op when the resolved state already matches", async () => {
    const { user, volumeId, entryId } = await seedFixture(db);

    const { id } = await createComment(db, {
      target: { kind: "entry", entryId },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "hello",
    });

    // Fresh row -- already "not resolved". Calling with resolved=false is a no-op.
    const result = await resolveComment(db, id, user.id, false);
    expect(result.changed).toBe(false);
  });

  it("does not touch editedAt when toggling resolve state", async () => {
    const { user, volumeId, entryId } = await seedFixture(db);

    const { id } = await createComment(db, {
      target: { kind: "entry", entryId },
      volumeId,
      parentId: null,
      authorId: user.id,
      authorRole: "lead",
      text: "hello",
    });

    await resolveComment(db, id, user.id, true);
    await resolveComment(db, id, user.id, false);

    const [row] = await db
      .select({ editedAt: schema.comments.editedAt })
      .from(schema.comments)
      .where(eq(schema.comments.id, id))
      .all();
    expect(row?.editedAt).toBeNull();
  });
});
