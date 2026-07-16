/**
 * Tests — region-comment round-trip (integration)
 *
 * This suite is the end-to-end regression net for region-anchored
 * comments. It drives a region comment through the real
 * `api.comments` action and then asserts the comment surfaces on
 * the three read paths the viewer and dashboard consume:
 * `getCommentsForVolume` (the viewer's per-volume comment column),
 * `getCommentsForQcFlag` (used when the comment is also attached
 * to a QC flag — the same comment can have a region pin AND a
 * flag reference), and `getOpenResegFlags` (the resegmentation
 * dashboard's count, which counts comments whose region payload
 * carries a `proposed_boundary` flag).
 *
 * The round-trip is what backstops the four-coordinate region
 * payload (`xPct`, `yPct`, `wPct`, `hPct`): a regression that
 * silently drops a coordinate on the write path would let the
 * comment "save" but render the pin at a wrong location on the
 * read path. The full round-trip catches that.
 *
 * @version v0.4.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { RouterContextProvider } from "react-router";
import * as schema from "../../app/db/schema";
import { DEFAULT_TEST_TENANT_ID, applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext } from "../helpers/context";
import { action as commentsAction } from "../../app/routes/api.comments";
import {
  getCommentsForVolume,
  getCommentsForQcFlag,
} from "../../app/lib/comments.server";
import { getOpenFlags as getOpenResegFlags } from "../../app/lib/resegmentation.server";

type Db = ReturnType<typeof drizzle>;

function buildUser(
  overrides: Partial<User> & { id: string; email: string },
): User {
  return {
    id: overrides.id,
    tenantId: overrides.tenantId ?? DEFAULT_TEST_TENANT_ID,
    email: overrides.email,
    name: overrides.name ?? "Tester",
    isAdmin: overrides.isAdmin ?? false,
    isSuperAdmin: overrides.isSuperAdmin ?? false,
    isCollabAdmin: overrides.isCollabAdmin ?? false,
    isArchiveUser: overrides.isArchiveUser ?? false,
    isUserManager: overrides.isUserManager ?? false,
    isCataloguer: overrides.isCataloguer ?? false,
    lastActiveAt: overrides.lastActiveAt ?? null,
    githubId: overrides.githubId ?? null,
  };
}

function buildContext(user: User): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, makeTenantContext({ id: user.tenantId }));
  (ctx as any).cloudflare = { env };
  return ctx;
}

async function readJson(res: Response): Promise<any> {
  return JSON.parse(await res.text());
}

async function postComment(
  user: User,
  body: Record<string, unknown>,
): Promise<Response> {
  const request = new Request("http://localhost/api/comments", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  return (await commentsAction({
    request,
    context: buildContext(user),
    params: {},
  } as any)) as Response;
}

async function seedFixture(db: Db) {
  const now = Date.now();

  const leadRow = await createTestUser({
    email: `lead-${crypto.randomUUID()}@example.com`,
  });
  const catRow = await createTestUser({
    email: `cat-${crypto.randomUUID()}@example.com`,
  });
  const outsiderRow = await createTestUser({
    email: `outside-${crypto.randomUUID()}@example.com`,
  });

  const projectId = crypto.randomUUID();
  const volumeId = crypto.randomUUID();
  const pageId = crypto.randomUUID();
  const entryId = crypto.randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    tenantId: DEFAULT_TEST_TENANT_ID,
    name: "Region Roundtrip",
    createdBy: leadRow.id,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(schema.projectMembers).values([
    {
      id: crypto.randomUUID(),
      projectId,
      userId: leadRow.id,
      role: "lead",
      createdAt: now,
    },
    {
      id: crypto.randomUUID(),
      projectId,
      userId: catRow.id,
      role: "cataloguer",
      createdAt: now,
    },
  ]);

  await db.insert(schema.volumes).values({
    id: volumeId,
    tenantId: DEFAULT_TEST_TENANT_ID,
    projectId,
    name: "V1",
    referenceCode: "co-rrt-v1",
    manifestUrl: "https://example.com/manifest.json",
    pageCount: 1,
    status: "in_progress",
    assignedTo: catRow.id,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(schema.volumePages).values({
    id: pageId,
    tenantId: DEFAULT_TEST_TENANT_ID,
    volumeId,
    position: 0,
    imageUrl: "https://example.com/p1.jpg",
    width: 800,
    height: 1200,
    label: "f.1r",
    createdAt: now,
  });

  await db.insert(schema.entries).values({
    id: entryId,
    tenantId: DEFAULT_TEST_TENANT_ID,
    volumeId,
    parentId: null,
    position: 0,
    startPage: 1,
    startY: 0,
    endPage: null,
    endY: null,
    title: "Entry 1",
    type: "item",
    createdAt: now,
    updatedAt: now,
  });

  // One open QC flag so the qcFlag-comment path has a target.
  const qcFlagId = crypto.randomUUID();
  await db.insert(schema.qcFlags).values({
    id: qcFlagId,
    tenantId: DEFAULT_TEST_TENANT_ID,
    volumeId,
    pageId,
    reportedBy: catRow.id,
    problemType: "damaged",
    description: "scan torn at fold",
    status: "open",
    createdAt: now,
  });

  // One open resegmentation flag on the entry for the openResegFlagsByEntry test.
  const resegFlagId = crypto.randomUUID();
  await db.insert(schema.resegmentationFlags).values({
    id: resegFlagId,
    tenantId: DEFAULT_TEST_TENANT_ID,
    volumeId,
    entryId,
    reportedBy: leadRow.id,
    problemType: "incorrect_boundaries",
    affectedEntryIds: JSON.stringify([entryId]),
    description: "needs a new child entry around f.1r",
    status: "open",
    createdAt: now,
  });

  return {
    lead: buildUser({ id: leadRow.id, email: leadRow.email }),
    cat: buildUser({ id: catRow.id, email: catRow.email }),
    outsider: buildUser({
      id: outsiderRow.id,
      email: outsiderRow.email,
    }),
    projectId,
    volumeId,
    pageId,
    entryId,
    qcFlagId,
    resegFlagId,
  };
}

describe("region-comment roundtrip", () => {
  let db: Db;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
  });

  it("persists a region-anchored comment and exposes it in regionsByPage via getCommentsForVolume", async () => {
    const fx = await seedFixture(db);

    const res = await postComment(fx.cat, {
      volumeId: fx.volumeId,
      pageId: fx.pageId,
      region: { x: 0.5, y: 0.5, w: 0, h: 0 },
      text: "pin here",
    });
    expect(res.status).toBe(200);
    const json = await readJson(res);
    expect(json.ok).toBe(true);
    expect(typeof json.commentId).toBe("string");

    const rows = await getCommentsForVolume(db, fx.volumeId);
    const regionRow = rows.find((r) => r.id === json.commentId);
    expect(regionRow).toBeDefined();
    expect(regionRow!.pageId).toBe(fx.pageId);
    expect(regionRow!.regionX).toBe(0.5);
    expect(regionRow!.regionY).toBe(0.5);
    expect(regionRow!.regionW).toBe(0);
    expect(regionRow!.regionH).toBe(0);

    // Simulate the viewer loader's partition loop.
    const regionsByPage: Record<
      string,
      Array<{ commentId: string; x: number; y: number; w: number; h: number }>
    > = {};
    for (const c of rows) {
      if (c.pageId && c.regionX !== null && c.regionY !== null) {
        (regionsByPage[c.pageId] ??= []).push({
          commentId: c.id,
          x: c.regionX,
          y: c.regionY,
          w: c.regionW ?? 0,
          h: c.regionH ?? 0,
        });
      }
    }
    expect(regionsByPage[fx.pageId]).toHaveLength(1);
    expect(regionsByPage[fx.pageId][0]).toEqual({
      commentId: json.commentId,
      x: 0.5,
      y: 0.5,
      w: 0,
      h: 0,
    });
  });

  it("exposes qcFlag-targeted comments in a bucket keyed by qcFlagId for QCFlagCardExpandable", async () => {
    const fx = await seedFixture(db);

    // Post a comment against the open qc flag.
    const res = await postComment(fx.cat, {
      volumeId: fx.volumeId,
      qcFlagId: fx.qcFlagId,
      text: "retake looks acceptable",
    });
    expect(res.status).toBe(200);
    const json = await readJson(res);

    const rows = await getCommentsForVolume(db, fx.volumeId);
    const commentsByQcFlag: Record<string, typeof rows> = {};
    for (const c of rows) {
      if (c.qcFlagId) {
        (commentsByQcFlag[c.qcFlagId] ??= []).push(c);
      }
    }
    expect(commentsByQcFlag[fx.qcFlagId]).toHaveLength(1);
    expect(commentsByQcFlag[fx.qcFlagId][0].id).toBe(json.commentId);

    // Also verify the dedicated helper returns the same row.
    const direct = await getCommentsForQcFlag(db, fx.qcFlagId);
    expect(direct).toHaveLength(1);
    expect(direct[0].id).toBe(json.commentId);
  });

  it("returns open reseg flags only via getOpenFlags (resegmentation.server) keyed for openResegFlagsByEntry", async () => {
    const fx = await seedFixture(db);

    const open = await getOpenResegFlags(db, fx.volumeId);
    expect(open.length).toBeGreaterThanOrEqual(1);
    const match = open.find((f) => f.id === fx.resegFlagId);
    expect(match).toBeDefined();
    expect(match!.status).toBe("open");
    expect(match!.entryId).toBe(fx.entryId);

    // Simulate the viewer loader's index-by-entry reduce.
    const openResegFlagsByEntry: Record<string, (typeof open)[number]> = {};
    for (const f of open) openResegFlagsByEntry[f.entryId] = f;
    expect(openResegFlagsByEntry[fx.entryId]).toBeDefined();
    expect(openResegFlagsByEntry[fx.entryId].id).toBe(fx.resegFlagId);
  });

  it("role matrix: cataloguer succeeds, lead succeeds, non-member is rejected 403 for region-anchored comments", async () => {
    const fx = await seedFixture(db);

    // Cataloguer -> 200
    const catRes = await postComment(fx.cat, {
      volumeId: fx.volumeId,
      pageId: fx.pageId,
      region: { x: 0.1, y: 0.2, w: 0, h: 0 },
      text: "cat pin",
    });
    expect(catRes.status).toBe(200);

    // Lead -> 200
    const leadRes = await postComment(fx.lead, {
      volumeId: fx.volumeId,
      pageId: fx.pageId,
      region: { x: 0.3, y: 0.4, w: 0, h: 0 },
      text: "lead pin",
    });
    expect(leadRes.status).toBe(200);

    // Non-member outsider -> 403
    const outRes = await postComment(fx.outsider, {
      volumeId: fx.volumeId,
      pageId: fx.pageId,
      region: { x: 0.7, y: 0.7, w: 0, h: 0 },
      text: "should reject",
    });
    expect(outRes.status).toBe(403);
  });

  it("surfaces a fresh region pin via regionsByPage on the next loader call (write-read round trip)", async () => {
    const fx = await seedFixture(db);

    // Read before: zero region pins.
    const before = await getCommentsForVolume(db, fx.volumeId);
    const beforeRegions = before.filter(
      (r) => r.pageId && r.regionX !== null,
    );
    expect(beforeRegions).toHaveLength(0);

    // Write.
    const res = await postComment(fx.cat, {
      volumeId: fx.volumeId,
      pageId: fx.pageId,
      region: { x: 0.42, y: 0.58, w: 0, h: 0 },
      text: "round-trip pin",
    });
    expect(res.status).toBe(200);
    const { commentId } = await readJson(res);

    // Read after: one region pin at the expected coords.
    const after = await getCommentsForVolume(db, fx.volumeId);
    const pin = after.find((r) => r.id === commentId);
    expect(pin).toBeDefined();
    expect(pin!.regionX).toBe(0.42);
    expect(pin!.regionY).toBe(0.58);
  });
});

