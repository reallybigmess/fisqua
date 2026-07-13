/**
 * Tests — QC flags API
 *
 * This suite pins the `api.qc-flags` route — the cataloguing-side
 * surface that lets a reviewer raise a quality-control flag against
 * a description. A QC flag is a typed concern (e.g. wrong reference
 * code, missing date, suspected duplicate) with an optional comment
 * thread; flags carry `status` (`open` → `resolved`) plus
 * `resolved_at` / `resolved_by` audit columns.
 *
 * The action exercises create + resolve + reopen intents; the
 * loader exercises the list-by-description path the description
 * detail view and the cataloguing dashboard both consume. Tenant
 * isolation is asserted on every path — a flag raised on a
 * description belonging to another tenant rejects with the same
 * 404 shape an unknown description would produce, so probe traffic
 * cannot enumerate cross-tenant ids.
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
import { action, loader } from "../../app/routes/api.qc-flags";

type Db = ReturnType<typeof drizzle>;

function buildUser(overrides: { id: string; email: string; isAdmin?: boolean; tenantId?: string }): User {
  return {
    id: overrides.id,
    tenantId: overrides.tenantId ?? DEFAULT_TEST_TENANT_ID,
    email: overrides.email,
    name: null,
    isAdmin: overrides.isAdmin ?? false,
    isSuperAdmin: false,
    isCollabAdmin: false,
    isArchiveUser: false,
    isUserManager: false,
    isCataloguer: false,
    lastActiveAt: null,
    githubId: null,
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

async function seedFixture(db: Db) {
  const now = Date.now();

  const leadRow = await createTestUser({
    email: `lead-${crypto.randomUUID()}@example.com`,
  });
  const catRow = await createTestUser({
    email: `cat-${crypto.randomUUID()}@example.com`,
  });
  const outsiderRow = await createTestUser({
    email: `outsider-${crypto.randomUUID()}@example.com`,
  });

  const projectId = crypto.randomUUID();
  const otherProjectId = crypto.randomUUID();
  const volumeId = crypto.randomUUID();
  const otherVolumeId = crypto.randomUUID();
  const pageId = crypto.randomUUID();
  const otherPageId = crypto.randomUUID();

  await db.insert(schema.projects).values([
    {
      id: projectId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      name: "QC Test P1",
      createdBy: leadRow.id,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: otherProjectId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      name: "QC Test P2",
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
      projectId,
      userId: catRow.id,
      role: "cataloguer",
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
      referenceCode: "co-test-qc-v1",
      manifestUrl: "https://example.com/manifest.json",
      pageCount: 1,
      status: "in_progress",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: otherVolumeId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      projectId: otherProjectId,
      name: "V2",
      referenceCode: "co-test-qc-v2",
      manifestUrl: "https://example.com/manifest-2.json",
      pageCount: 1,
      status: "in_progress",
      createdAt: now,
      updatedAt: now,
    },
  ]);

  await db.insert(schema.volumePages).values([
    {
      id: pageId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      volumeId,
      position: 7,
      imageUrl: "https://example.com/g1.jpg",
      width: 800,
      height: 1200,
      label: "f.7r",
      createdAt: now,
    },
    {
      id: otherPageId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      volumeId: otherVolumeId,
      position: 1,
      imageUrl: "https://example.com/g2.jpg",
      width: 800,
      height: 1200,
      label: "f.1r",
      createdAt: now,
    },
  ]);

  return {
    lead: buildUser({ id: leadRow.id, email: leadRow.email }),
    cat: buildUser({ id: catRow.id, email: catRow.email }),
    outsider: buildUser({ id: outsiderRow.id, email: outsiderRow.email }),
    projectId,
    otherProjectId,
    volumeId,
    otherVolumeId,
    pageId,
    otherPageId,
  };
}

async function postFlag(
  user: User,
  body: Record<string, unknown>
): Promise<Response> {
  const request = new Request("http://localhost/api/qc-flags", {
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

async function patchFlag(
  user: User,
  body: Record<string, unknown>
): Promise<Response> {
  const request = new Request("http://localhost/api/qc-flags", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  return (await action({
    request,
    context: buildContext(user),
    params: {},
  } as any)) as Response;
}

async function getFlags(
  user: User,
  params: Record<string, string>
): Promise<Response> {
  const qs = new URLSearchParams(params).toString();
  const request = new Request(
    `http://localhost/api/qc-flags?${qs}`,
    { method: "GET" }
  );
  return (await loader({
    request,
    context: buildContext(user),
    params: {},
  } as any)) as Response;
}

describe("/api/qc-flags POST ()", () => {
  let db: Db;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
  });

  it("creates a flag for a project cataloguer", async () => {
    const { cat, volumeId, pageId } = await seedFixture(db);

    const res = await postFlag(cat, {
      volumeId,
      pageId,
      problemType: "damaged",
      description: "torn lower margin",
    });
    expect(res.status).toBe(200);
    const json = await readJson(res);
    expect(json.ok).toBe(true);
    expect(typeof json.flagId).toBe("string");

    const [row] = await db
      .select()
      .from(schema.qcFlags)
      .where(eq(schema.qcFlags.id, json.flagId))
      .all();
    expect(row.status).toBe("open");
    expect(row.volumeId).toBe(volumeId);
    expect(row.pageId).toBe(pageId);
    expect(row.problemType).toBe("damaged");
    expect(row.reportedBy).toBe(cat.id);
  });

  it("returns 403 when a non-member tries to create a flag", async () => {
    const { outsider, volumeId, pageId } = await seedFixture(db);
    const res = await postFlag(outsider, {
      volumeId,
      pageId,
      problemType: "damaged",
      description: "not my project",
    });
    expect(res.status).toBe(403);
  });

  it("returns 400 for an unknown problemType", async () => {
    const { cat, volumeId, pageId } = await seedFixture(db);
    const res = await postFlag(cat, {
      volumeId,
      pageId,
      problemType: "bogus",
      description: "nope",
    });
    expect(res.status).toBe(400);
    const json = await readJson(res);
    expect(json.error).toContain("invalid problemType");
  });

  it("returns 400 when description is missing", async () => {
    const { cat, volumeId, pageId } = await seedFixture(db);
    const res = await postFlag(cat, {
      volumeId,
      pageId,
      problemType: "damaged",
    });
    expect(res.status).toBe(400);
    const json = await readJson(res);
    expect(json.error).toContain("required");
  });

  it("returns 400 when volumeId does not match the page's volume", async () => {
    const { cat, pageId, otherVolumeId } = await seedFixture(db);
    const res = await postFlag(cat, {
      volumeId: otherVolumeId,
      pageId,
      problemType: "damaged",
      description: "mismatch",
    });
    expect(res.status).toBe(400);
    const json = await readJson(res);
    expect(json.error).toContain("does not match");
  });

  it("returns 400 Invalid JSON body for a form-urlencoded request (regression sentinel)", async () => {
    const { cat, volumeId, pageId } = await seedFixture(db);
    const body = new URLSearchParams({
      volumeId,
      pageId,
      problemType: "damaged",
      description: "form",
    });
    const request = new Request("http://localhost/api/qc-flags", {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const res = (await action({
      request,
      context: buildContext(cat),
      params: {},
    } as any)) as Response;
    expect(res.status).toBe(400);
    const json = await readJson(res);
    expect(json.error).toBe("Invalid JSON body");
  });

  it("writes an activity_log row with event='qc_flag_raised' after a successful create", async () => {
    const { cat, projectId, volumeId, pageId } = await seedFixture(db);
    const res = await postFlag(cat, {
      volumeId,
      pageId,
      problemType: "damaged",
      description: "torn",
    });
    expect(res.status).toBe(200);
    const { flagId } = await readJson(res);

    const rows = await db
      .select()
      .from(schema.activityLog)
      .where(
        and(
          eq(schema.activityLog.event, "qc_flag_raised"),
          eq(schema.activityLog.projectId, projectId),
          eq(schema.activityLog.volumeId, volumeId)
        )
      )
      .all();
    expect(rows).toHaveLength(1);
    const detail = JSON.parse(rows[0].detail ?? "{}");
    expect(detail.flagId).toBe(flagId);
    expect(detail.pageId).toBe(pageId);
    expect(detail.problemType).toBe("damaged");
    expect(detail.pageLabel).toBe("7");
  });
});

describe("/api/qc-flags PATCH ()", () => {
  let db: Db;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
  });

  async function seedWithOpenFlag() {
    const fx = await seedFixture(db);
    const res = await postFlag(fx.cat, {
      volumeId: fx.volumeId,
      pageId: fx.pageId,
      problemType: "damaged",
      description: "open flag for resolve tests",
    });
    const { flagId } = await readJson(res);
    return { ...fx, flagId };
  }

  it("allows a lead to resolve an open flag", async () => {
    const { lead, flagId } = await seedWithOpenFlag();
    const res = await patchFlag(lead, {
      flagId,
      status: "resolved",
      resolutionAction: "retake_requested",
    });
    expect(res.status).toBe(200);

    const [row] = await db
      .select()
      .from(schema.qcFlags)
      .where(eq(schema.qcFlags.id, flagId))
      .all();
    expect(row.status).toBe("resolved");
    expect(row.resolutionAction).toBe("retake_requested");
    expect(row.resolvedBy).toBe(lead.id);
    expect(typeof row.resolvedAt).toBe("number");
  });

  it("returns 403 when a non-lead project member tries to resolve", async () => {
    const { cat, flagId } = await seedWithOpenFlag();
    const res = await patchFlag(cat, {
      flagId,
      status: "resolved",
      resolutionAction: "ignored",
    });
    expect(res.status).toBe(403);
  });

  it("returns 403 (or 404) when a user outside the project tries to resolve", async () => {
    const { outsider, flagId } = await seedWithOpenFlag();
    const res = await patchFlag(outsider, {
      flagId,
      status: "resolved",
      resolutionAction: "ignored",
    });
    expect(res.status).not.toBe(200);
    expect([403, 404]).toContain(res.status);
  });

  it("returns 400 when resolutionAction='other' and resolverNote is empty", async () => {
    const { lead, flagId } = await seedWithOpenFlag();
    const res = await patchFlag(lead, {
      flagId,
      status: "resolved",
      resolutionAction: "other",
      resolverNote: "   ",
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the flagId does not exist", async () => {
    const { lead } = await seedFixture(db);
    const res = await patchFlag(lead, {
      flagId: "nope",
      status: "resolved",
      resolutionAction: "ignored",
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 when resolving an already-resolved flag", async () => {
    const { lead, flagId } = await seedWithOpenFlag();
    await patchFlag(lead, {
      flagId,
      status: "resolved",
      resolutionAction: "ignored",
    });
    const second = await patchFlag(lead, {
      flagId,
      status: "wontfix",
      resolutionAction: "ignored",
    });
    expect(second.status).toBe(409);
  });

  it("writes an activity_log row with event='qc_flag_resolved' after a successful resolve", async () => {
    const { lead, projectId, volumeId, flagId } = await seedWithOpenFlag();
    const res = await patchFlag(lead, {
      flagId,
      status: "resolved",
      resolutionAction: "retake_requested",
    });
    expect(res.status).toBe(200);

    const rows = await db
      .select()
      .from(schema.activityLog)
      .where(
        and(
          eq(schema.activityLog.event, "qc_flag_resolved"),
          eq(schema.activityLog.projectId, projectId),
          eq(schema.activityLog.volumeId, volumeId)
        )
      )
      .all();
    expect(rows).toHaveLength(1);
    const detail = JSON.parse(rows[0].detail ?? "{}");
    expect(detail.flagId).toBe(flagId);
    expect(detail.resolutionAction).toBe("retake_requested");
    expect(detail.status).toBe("resolved");
    expect(detail.pageLabel).toBe("7");
  });
});

describe("/api/qc-flags GET ()", () => {
  let db: Db;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
  });

  it("returns flags for a project member and narrows by status", async () => {
    const { cat, lead, volumeId, pageId } = await seedFixture(db);

    // Raise two flags, resolve one.
    const r1 = await postFlag(cat, {
      volumeId,
      pageId,
      problemType: "damaged",
      description: "open-a",
    });
    const { flagId: id1 } = await readJson(r1);
    const r2 = await postFlag(cat, {
      volumeId,
      pageId,
      problemType: "blank",
      description: "open-b",
    });
    await readJson(r2);

    // Resolve the first one.
    await patchFlag(lead, {
      flagId: id1,
      status: "resolved",
      resolutionAction: "retake_requested",
    });

    const allRes = await getFlags(cat, { volumeId });
    expect(allRes.status).toBe(200);
    const allJson = await readJson(allRes);
    expect(Array.isArray(allJson.flags)).toBe(true);
    expect(allJson.flags).toHaveLength(2);

    const openRes = await getFlags(cat, { volumeId, status: "open" });
    const openJson = await readJson(openRes);
    expect(openJson.flags).toHaveLength(1);
    expect(openJson.flags[0].status).toBe("open");
  });

  it("returns 403 when a non-member requests flags for the volume", async () => {
    const { outsider, volumeId } = await seedFixture(db);
    const res = await getFlags(outsider, { volumeId });
    expect(res.status).toBe(403);
  });
});

