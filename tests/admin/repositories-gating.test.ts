/**
 * Tests — repository operation gating (capability at the operation)
 *
 * The multi-repository capability gates OPERATIONS, never visibility:
 * create is allowed iff the tenant has the capability OR currently has
 * ZERO repositories (the first-repository case); the tenant's LAST
 * repository is never deletable for ANY tenant (records and imports file
 * under it). Pinned here at the route actions and the /new loader — a
 * direct URL or raw POST must not bypass what the UI hides.
 *
 * @version v0.6.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { applyMigrations, cleanDatabase, DEFAULT_TEST_TENANT_ID } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { repositories } from "../../app/db/schema";

const NEW_ROUTE = "../../app/routes/_auth.admin.repositories.new";
const DETAIL_ROUTE = "../../app/routes/_auth.admin.repositories.$id";

function db() {
  return drizzle(env.DB);
}

function ctx(user: User, multiRepositoryEnabled: boolean): any {
  const c = new RouterContextProvider();
  c.set(userContext, user);
  c.set(
    tenantContext,
    makeTenantContext({ id: DEFAULT_TEST_TENANT_ID, multiRepositoryEnabled }),
  );
  (c as any).cloudflare = { env };
  return c;
}

async function adminUser(): Promise<User> {
  const u = await createTestUser({ isAdmin: true, tenantId: DEFAULT_TEST_TENANT_ID });
  return makeUserContext({ id: u.id, tenantId: DEFAULT_TEST_TENANT_ID, isAdmin: true });
}

function createRequest(code: string): Request {
  const form = new FormData();
  form.set("_action", "create");
  form.set("code", code);
  form.set("name", `Test repository ${code} (synthetic)`);
  form.set("countryCode", "COL");
  form.set("enabled", "on");
  return new Request("http://neogranadina.fisqua.test/admin/repositories/new", {
    method: "POST",
    body: form,
  });
}

function deleteRequest(id: string): Request {
  const form = new FormData();
  form.set("_action", "delete");
  return new Request(`http://neogranadina.fisqua.test/admin/repositories/${id}`, {
    method: "POST",
    body: form,
  });
}

async function repoCount(): Promise<number> {
  const rows = await db()
    .select()
    .from(repositories)
    .where(eq(repositories.tenantId, DEFAULT_TEST_TENANT_ID))
    .all();
  return rows.length;
}

describe("repository CREATE gating", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("refuses create by name for a single-repo tenant that already has one", async () => {
    const user = await adminUser();
    await createTestRepository({ tenantId: DEFAULT_TEST_TENANT_ID });
    const { action } = await import(NEW_ROUTE);
    const result = (await action({
      request: createRequest("test-2"),
      context: ctx(user, false),
      params: {},
    } as any)) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("single_repository");
    expect(await repoCount()).toBe(1);
  });

  it("allows the FIRST repository for a single-repo tenant (onboarding case)", async () => {
    const user = await adminUser();
    const { action } = await import(NEW_ROUTE);
    const result = (await action({
      request: createRequest("test-1"),
      context: ctx(user, false),
      params: {},
    } as any)) as Response;
    expect(result.status).toBe(302);
    expect(await repoCount()).toBe(1);
  });

  it("allows create for a multi-repository tenant with existing repositories", async () => {
    const user = await adminUser();
    await createTestRepository({ tenantId: DEFAULT_TEST_TENANT_ID });
    const { action } = await import(NEW_ROUTE);
    const result = (await action({
      request: createRequest("test-2"),
      context: ctx(user, true),
      params: {},
    } as any)) as Response;
    expect(result.status).toBe(302);
    expect(await repoCount()).toBe(2);
  });

  it("the /new loader redirects a gated tenant to the list (direct URL cannot bypass)", async () => {
    const user = await adminUser();
    await createTestRepository({ tenantId: DEFAULT_TEST_TENANT_ID });
    const { loader } = await import(NEW_ROUTE);
    try {
      await loader({
        request: new Request("http://x/admin/repositories/new"),
        context: ctx(user, false),
        params: {},
      } as any);
      expect.fail("should have redirected");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(302);
      expect((e as Response).headers.get("location")).toBe("/admin/repositories");
    }
  });

  it("the /new loader admits a single-repo tenant with zero repositories", async () => {
    const user = await adminUser();
    const { loader } = await import(NEW_ROUTE);
    const data = await loader({
      request: new Request("http://x/admin/repositories/new"),
      context: ctx(user, false),
      params: {},
    } as any);
    expect(data).toBeNull();
  });
});

describe("repository DELETE gating", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("refuses deleting the LAST repository, single-repo tenant", async () => {
    const user = await adminUser();
    const repo = await createTestRepository({ tenantId: DEFAULT_TEST_TENANT_ID });
    const { action } = await import(DETAIL_ROUTE);
    const result = (await action({
      request: deleteRequest(repo.id),
      context: ctx(user, false),
      params: { id: repo.id },
    } as any)) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("last_repository");
    expect(await repoCount()).toBe(1);
  });

  it("refuses deleting the LAST repository, multi-repository tenant too", async () => {
    const user = await adminUser();
    const repo = await createTestRepository({ tenantId: DEFAULT_TEST_TENANT_ID });
    const { action } = await import(DETAIL_ROUTE);
    const result = (await action({
      request: deleteRequest(repo.id),
      context: ctx(user, true),
      params: { id: repo.id },
    } as any)) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("last_repository");
    expect(await repoCount()).toBe(1);
  });

  it("deletes a NON-last empty repository for a multi-repository tenant", async () => {
    const user = await adminUser();
    const keep = await createTestRepository({ tenantId: DEFAULT_TEST_TENANT_ID });
    const doomed = await createTestRepository({ tenantId: DEFAULT_TEST_TENANT_ID });
    const { action } = await import(DETAIL_ROUTE);
    const result = (await action({
      request: deleteRequest(doomed.id),
      context: ctx(user, true),
      params: { id: doomed.id },
    } as any)) as Response;
    expect(result.status).toBe(302);
    expect(await repoCount()).toBe(1);
    const rows = await db()
      .select()
      .from(repositories)
      .where(eq(repositories.id, keep.id))
      .all();
    expect(rows).toHaveLength(1);
  });

  it("keeps the has_descriptions guard on a non-last repository", async () => {
    const user = await adminUser();
    await createTestRepository({ tenantId: DEFAULT_TEST_TENANT_ID });
    const withRecords = await createTestRepository({ tenantId: DEFAULT_TEST_TENANT_ID });
    await createTestDescription({
      tenantId: DEFAULT_TEST_TENANT_ID,
      repositoryId: withRecords.id,
      referenceCode: "TEST-1",
      descriptionLevel: "item",
    });
    const { action } = await import(DETAIL_ROUTE);
    const result = (await action({
      request: deleteRequest(withRecords.id),
      context: ctx(user, true),
      params: { id: withRecords.id },
    } as any)) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("has_descriptions");
    expect(await repoCount()).toBe(2);
  });
});
