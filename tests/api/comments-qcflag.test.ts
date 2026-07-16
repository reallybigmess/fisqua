/**
 * Tests — comments attached to QC flags
 *
 * This suite pins the comment ↔ QC-flag attachment contract on the
 * shared `api.comments` route. Comments can be attached to a parent
 * description, to a specific region pin on a description, or — what
 * this file covers — to a quality-control flag raised against a
 * description. The route discriminates on `target_kind` (`flag`) and
 * `target_id` (`qc_flags.id`), validates the FK against the same
 * tenant, and emits a row whose `getCommentsForQcFlag` loader can
 * find via the `(target_kind='flag', target_id=?)` index.
 *
 * The cases run the action against a full `RouterContextProvider`
 * carrying `userContext`, `tenantContext`, and `cloudflare.env` so
 * the route exercises its real middleware-attachment surface; no
 * stubbed request objects. The loader is exercised through
 * `getCommentsForQcFlag` to keep this file scoped to the QC-flag
 * thread rather than the global comments fetch path.
 *
 * @version v0.4.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import * as schema from "../../app/db/schema";
import { DEFAULT_TEST_TENANT_ID, applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext } from "../helpers/context";
import { action } from "../../app/routes/api.comments";
import { getCommentsForQcFlag } from "../../app/lib/comments.server";

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
  const now = Date.now();

  const leadRow = await createTestUser({
    email: `lead-${crypto.randomUUID()}@example.com`,
  });
  const outsiderRow = await createTestUser({
    email: `outsider-${crypto.randomUUID()}@example.com`,
  });

  const projectId = crypto.randomUUID();
  const otherProjectId = crypto.randomUUID();
  const volumeId = crypto.randomUUID();
  const otherVolumeId = crypto.randomUUID();
  const pageId = crypto.randomUUID();
  const flagId = crypto.randomUUID();

  await db.insert(schema.projects).values([
    {
      id: projectId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      name: "QC Comments P1",
      createdBy: leadRow.id,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: otherProjectId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      name: "QC Comments P2",
      createdBy: outsiderRow.id,
      createdAt: now,
      updatedAt: now,
    },
  ]);

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
      projectId: otherProjectId,
      userId: outsiderRow.id,
      role: "lead",
      createdAt: now,
    },
  ]);

  await db.insert(schema.volumes).values([
    {
      id: volumeId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      projectId,
      name: "V1",
      referenceCode: "co-test-qcc-v1",
      manifestUrl: "https://example.com/m1.json",
      pageCount: 1,
      status: "in_progress",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: otherVolumeId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      projectId,
      name: "V-other-same-project",
      referenceCode: "co-test-qcc-v2",
      manifestUrl: "https://example.com/m2.json",
      pageCount: 1,
      status: "in_progress",
      createdAt: now,
      updatedAt: now,
    },
  ]);

  await db.insert(schema.volumePages).values({
    id: pageId,
    tenantId: DEFAULT_TEST_TENANT_ID,
    volumeId,
    position: 3,
    imageUrl: "https://example.com/p1.jpg",
    width: 800,
    height: 1200,
    label: "f.3r",
    createdAt: now,
  });

  await db.insert(schema.qcFlags).values({
    id: flagId,
    tenantId: DEFAULT_TEST_TENANT_ID,
    volumeId,
    pageId,
    reportedBy: leadRow.id,
    problemType: "damaged",
    description: "torn lower margin",
    status: "open",
    createdAt: now,
  });

  return {
    lead: buildUser({ id: leadRow.id, email: leadRow.email }),
    outsider: buildUser({ id: outsiderRow.id, email: outsiderRow.email }),
    projectId,
    otherProjectId,
    volumeId,
    otherVolumeId,
    pageId,
    flagId,
  };
}

describe("/api/comments qcFlag target ()", () => {
  let db: Db;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
  });

  it("accepts a qcFlag-targeted comment and getCommentsForQcFlag returns the row", async () => {
    const { lead, volumeId, flagId } = await seedFixture(db);

    const res = await postComment(lead, {
      volumeId,
      qcFlagId: flagId,
      text: "reply to flag",
    });

    expect(res.status).toBe(200);
    const json = await readJson(res);
    expect(json.ok).toBe(true);
    expect(typeof json.commentId).toBe("string");

    const [row] = await db
      .select()
      .from(schema.comments)
      .where(eq(schema.comments.id, json.commentId))
      .all();
    expect(row.qcFlagId).toBe(flagId);
    expect(row.entryId).toBeNull();
    expect(row.pageId).toBeNull();
    expect(row.volumeId).toBe(volumeId);

    const flagComments = await getCommentsForQcFlag(db, flagId);
    expect(flagComments).toHaveLength(1);
    expect(flagComments[0].id).toBe(json.commentId);
    expect(flagComments[0].text).toBe("reply to flag");
  });

  it("rejects region coords alongside a qcFlagId target with 400", async () => {
    const { lead, volumeId, flagId } = await seedFixture(db);

    const res = await postComment(lead, {
      volumeId,
      qcFlagId: flagId,
      region: { x: 0.5, y: 0.5, w: 0, h: 0 },
      text: "should reject",
    });

    expect(res.status).toBe(400);
    const json = await readJson(res);
    expect(json.error).toContain("region cannot be combined with qcFlagId");
  });

  it("rejects when volumeId does not match the flag's volume", async () => {
    const { lead, otherVolumeId, flagId } = await seedFixture(db);

    const res = await postComment(lead, {
      volumeId: otherVolumeId,
      qcFlagId: flagId,
      text: "mismatch",
    });

    expect(res.status).toBe(400);
    const json = await readJson(res);
    expect(json.error).toContain("does not match");
  });

  it("returns 404 when the qcFlagId does not exist", async () => {
    const { lead, volumeId } = await seedFixture(db);

    const res = await postComment(lead, {
      volumeId,
      qcFlagId: "nope-not-a-real-flag",
      text: "missing flag",
    });

    expect(res.status).toBe(404);
    const json = await readJson(res);
    expect(json.error).toContain("QC flag not found");
  });

  it("returns 403 when a non-member of the flag's project tries to comment", async () => {
    const { outsider, volumeId, flagId } = await seedFixture(db);

    const res = await postComment(outsider, {
      volumeId,
      qcFlagId: flagId,
      text: "sneaky",
    });

    expect(res.status).toBe(403);
  });

  it("writes an activity_log row with event='comment_added' and qcFlagId in the detail", async () => {
    const { lead, projectId, volumeId, flagId } = await seedFixture(db);

    const res = await postComment(lead, {
      volumeId,
      qcFlagId: flagId,
      text: "activity-logged",
    });
    expect(res.status).toBe(200);
    const { commentId } = await readJson(res);

    const rows = await db
      .select()
      .from(schema.activityLog)
      .where(
        and(
          eq(schema.activityLog.event, "comment_added"),
          eq(schema.activityLog.projectId, projectId),
          eq(schema.activityLog.volumeId, volumeId)
        )
      )
      .all();
    expect(rows).toHaveLength(1);
    const detail = JSON.parse(rows[0].detail ?? "{}");
    expect(detail.qcFlagId).toBe(flagId);
    expect(detail.commentId).toBe(commentId);
  });
});

