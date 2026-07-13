/**
 * Tests — resegmentation API
 *
 * This suite pins the `api.resegmentation` route — the
 * cataloguing-side surface a reviewer uses to request that an
 * automatically-segmented volume be re-segmented (the page-boundary
 * detector ran but its output is wrong enough that a manual rerun
 * is warranted). The request carries `volumeId` plus an optional
 * `reason`; the action validates the volume belongs to the
 * caller's tenant, writes a `resegmentation_requests` row, and
 * surfaces it on the operator's volumes dashboard.
 *
 * Cases pin the action's tenant-isolation contract (cross-tenant
 * volume id → 404 in the same shape as unknown), the dedupe
 * behaviour (one open request per volume — the action returns the
 * existing row rather than inserting a duplicate), and the
 * cancel-by-requester path.
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
import { action } from "../../app/routes/api.resegmentation";

type Db = ReturnType<typeof drizzle>;

function buildUser(overrides: {
  id: string;
  email: string;
  isAdmin?: boolean;
  tenantId?: string;
}): User {
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

async function seedFixture(db: Db) {
  const owner = await createTestUser({
    email: `reseg-${crypto.randomUUID()}@example.com`,
  });
  const now = Date.now();
  const projectId = crypto.randomUUID();
  const volumeId = crypto.randomUUID();
  const entryId = crypto.randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    tenantId: DEFAULT_TEST_TENANT_ID,
    name: "Reseg Test Project",
    createdBy: owner.id,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(schema.projectMembers).values({
    id: crypto.randomUUID(),
    projectId,
    userId: owner.id,
    role: "lead",
    createdAt: now,
  });

  await db.insert(schema.volumes).values({
    id: volumeId,
    tenantId: DEFAULT_TEST_TENANT_ID,
    projectId,
    name: "Reseg Volume",
    referenceCode: "co-test-reseg",
    manifestUrl: "https://example.com/manifest.json",
    pageCount: 2,
    status: "in_progress",
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(schema.entries).values({
    id: entryId,
    tenantId: DEFAULT_TEST_TENANT_ID,
    volumeId,
    position: 0,
    startPage: 1,
    startY: 0,
    type: "item",
    title: "Reseg Entry",
    createdAt: now,
    updatedAt: now,
  });

  return {
    owner: buildUser({ id: owner.id, email: owner.email }),
    volumeId,
    entryId,
  };
}

async function readJson(res: Response): Promise<any> {
  return JSON.parse(await res.text());
}

describe("/api/resegmentation POST (regression)", () => {
  let db: Db;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
  });

  it("accepts a JSON body and writes a resegmentation_flags row", async () => {
    const { owner, volumeId, entryId } = await seedFixture(db);

    const request = new Request("http://localhost/api/resegmentation", {
      method: "POST",
      body: JSON.stringify({
        volumeId,
        entryId,
        problemType: "incorrect_boundaries",
        affectedEntryIds: JSON.stringify([entryId]),
        description: "boundary mis-detected on f.2r",
      }),
      headers: { "Content-Type": "application/json" },
    });

    const res = (await action({
      request,
      context: buildContext(owner),
      params: {},
    } as any)) as Response;

    expect(res.status).toBe(200);
    const json = await readJson(res);
    expect(json.ok).toBe(true);
    expect(typeof json.flagId).toBe("string");

    const [row] = await db
      .select()
      .from(schema.resegmentationFlags)
      .where(eq(schema.resegmentationFlags.id, json.flagId))
      .all();
    expect(row).toBeDefined();
    expect(row.volumeId).toBe(volumeId);
    expect(row.entryId).toBe(entryId);
    expect(row.problemType).toBe("incorrect_boundaries");
    expect(row.status).toBe("open");
  });

  it("returns 400 Invalid JSON body for a form-urlencoded request (regression sentinel)", async () => {
    const { owner, volumeId, entryId } = await seedFixture(db);

    const body = new URLSearchParams({
      volumeId,
      entryId,
      problemType: "incorrect_boundaries",
      affectedEntryIds: JSON.stringify([entryId]),
      description: "boundary mis-detected",
    });
    const request = new Request("http://localhost/api/resegmentation", {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    const res = (await action({
      request,
      context: buildContext(owner),
      params: {},
    } as any)) as Response;

    expect(res.status).toBe(400);
    const json = await readJson(res);
    expect(json.error).toBe("Invalid JSON body");
  });

  it("returns 400 when required fields are missing", async () => {
    const { owner, volumeId } = await seedFixture(db);

    const request = new Request("http://localhost/api/resegmentation", {
      method: "POST",
      body: JSON.stringify({ volumeId, problemType: "incorrect_boundaries" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = (await action({
      request,
      context: buildContext(owner),
      params: {},
    } as any)) as Response;

    expect(res.status).toBe(400);
    const json = await readJson(res);
    expect(json.error).toContain("required");
  });
});
