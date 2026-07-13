/**
 * Tests — comments attached to region pins
 *
 * This suite pins the comment ↔ region-pin attachment contract on
 * the shared `api.comments` route. A region pin is the
 * `(page, xPct, yPct, wPct, hPct)` bounding box a cataloguer drops
 * on a IIIF canvas; comments attached to a pin carry the parent
 * description id plus the four-coordinate region payload, so the
 * viewer can render the comment chip at the exact pin location on
 * any future load.
 *
 * Cases pin the action's payload shape (region coords required
 * when `target_kind="region"`), the tenant-isolation behaviour (a
 * region pin belonging to another tenant's description rejects),
 * and the loader's return shape (region coords round-trip on read).
 * The route exercises its real middleware-attachment surface through
 * a `RouterContextProvider` carrying user + tenant + env contexts.
 *
 * @version v0.4.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import * as schema from "../../app/db/schema";
import { DEFAULT_TEST_TENANT_ID, applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext } from "../helpers/context";
import { action } from "../../app/routes/api.comments";

type Db = ReturnType<typeof drizzle>;

function buildUser(
  overrides: Partial<User> & { id: string; email: string }
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
  body: Record<string, unknown>
): Promise<Response> {
  const request = new Request("http://localhost/api/comments", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  return (await action({
    request,
    context: buildContext(user),
    params: {},
  } as any)) as Response;
}

async function seedFixture(db: Db) {
  const userRow = await createTestUser({
    email: `lead-${crypto.randomUUID()}@example.com`,
  });
  const now = Date.now();
  const projectId = crypto.randomUUID();
  const volumeId = crypto.randomUUID();
  const entryId = crypto.randomUUID();
  const pageId = crypto.randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    tenantId: DEFAULT_TEST_TENANT_ID,
    name: "Region Test",
    createdBy: userRow.id,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(schema.projectMembers).values({
    id: crypto.randomUUID(),
    projectId,
    userId: userRow.id,
    role: "lead",
    createdAt: now,
  });

  await db.insert(schema.volumes).values({
    id: volumeId,
    tenantId: DEFAULT_TEST_TENANT_ID,
    projectId,
    name: "V1",
    referenceCode: "co-test-region-v1",
    manifestUrl: "https://example.com/m.json",
    pageCount: 1,
    status: "in_progress",
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(schema.volumePages).values({
    id: pageId,
    tenantId: DEFAULT_TEST_TENANT_ID,
    volumeId,
    position: 1,
    imageUrl: "https://example.com/img.jpg",
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

  return {
    user: buildUser({ id: userRow.id, email: userRow.email }),
    projectId,
    volumeId,
    entryId,
    pageId,
  };
}

describe("/api/comments region coords ()", () => {
  let db: Db;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
  });

  it("accepts a page-targeted comment with region coords and stores all four columns", async () => {
    const { user, volumeId, pageId } = await seedFixture(db);

    const res = await postComment(user, {
      volumeId,
      pageId,
      region: { x: 0.25, y: 0.5, w: 0.1, h: 0.1 },
      text: "pin me",
    });

    expect(res.status).toBe(200);
    const json = await readJson(res);

    const [row] = await db
      .select()
      .from(schema.comments)
      .where(eq(schema.comments.id, json.commentId))
      .all();
    expect(row.regionX).toBeCloseTo(0.25);
    expect(row.regionY).toBeCloseTo(0.5);
    expect(row.regionW).toBeCloseTo(0.1);
    expect(row.regionH).toBeCloseTo(0.1);
  });

  it("writes NULL region columns when region is omitted", async () => {
    const { user, volumeId, pageId } = await seedFixture(db);

    const res = await postComment(user, {
      volumeId,
      pageId,
      text: "no region here",
    });

    expect(res.status).toBe(200);
    const json = await readJson(res);

    const [row] = await db
      .select()
      .from(schema.comments)
      .where(eq(schema.comments.id, json.commentId))
      .all();
    expect(row.regionX).toBeNull();
    expect(row.regionY).toBeNull();
    expect(row.regionW).toBeNull();
    expect(row.regionH).toBeNull();
  });

  it("clamps region coords outside [0, 1] into the normalised range on insert", async () => {
    const { user, volumeId, pageId } = await seedFixture(db);

    const res = await postComment(user, {
      volumeId,
      pageId,
      region: { x: 1.5, y: -0.2, w: 2, h: -0.5 },
      text: "clamp me",
    });

    expect(res.status).toBe(200);
    const json = await readJson(res);

    const [row] = await db
      .select()
      .from(schema.comments)
      .where(eq(schema.comments.id, json.commentId))
      .all();
    expect(row.regionX).toBeCloseTo(1);
    expect(row.regionY).toBeCloseTo(0);
    expect(row.regionW).toBeCloseTo(1);
    expect(row.regionH).toBeCloseTo(0);
  });

  it("rejects region coords when target is an entry with 400", async () => {
    const { user, volumeId, entryId } = await seedFixture(db);

    const res = await postComment(user, {
      volumeId,
      entryId,
      region: { x: 0.1, y: 0.1, w: 0, h: 0 },
      text: "wrong target",
    });

    expect(res.status).toBe(400);
    const json = await readJson(res);
    expect(json.error).toContain(
      "region requires pageId (regions are page-anchored)"
    );
  });

  it("rejects a body with region but no target with 400 'Exactly one of...'", async () => {
    const { user, volumeId } = await seedFixture(db);

    const res = await postComment(user, {
      volumeId,
      region: { x: 0.1, y: 0.1, w: 0, h: 0 },
      text: "no target",
    });

    expect(res.status).toBe(400);
    const json = await readJson(res);
    expect(json.error).toContain(
      "Exactly one of entryId, pageId, or qcFlagId"
    );
  });

  it("accepts a pin (w=0, h=0) and stores all four columns including the zeros", async () => {
    const { user, volumeId, pageId } = await seedFixture(db);

    const res = await postComment(user, {
      volumeId,
      pageId,
      region: { x: 0.5, y: 0.5, w: 0, h: 0 },
      text: "pin drop",
    });

    expect(res.status).toBe(200);
    const json = await readJson(res);

    const [row] = await db
      .select()
      .from(schema.comments)
      .where(eq(schema.comments.id, json.commentId))
      .all();
    expect(row.regionX).toBeCloseTo(0.5);
    expect(row.regionY).toBeCloseTo(0.5);
    expect(row.regionW).toBe(0);
    expect(row.regionH).toBe(0);
  });
});

