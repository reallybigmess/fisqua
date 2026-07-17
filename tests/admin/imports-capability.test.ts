/**
 * Tests — imports capability gate (imports module phase 1)
 *
 * This suite pins the `imports` capability introduced in migration
 * 0061: the placeholder admin route, and the operator capability
 * toggle that flips the flag.
 *
 *   - the `/admin/imports` loader 404s when the tenant's `imports`
 *     flag is off, and returns normally when it is on;
 *   - the operator `set_capability` action turns imports on: the
 *     tenant row flips and a single `imports` change lands in the
 *     audit row's details.
 *
 * Harness mirrors tests/admin/authorities-capability.test.ts and
 * tests/operator/tenant-detail.test.ts.
 *
 * @version v0.6.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  seedTenants,
  seedFederations,
  seedOperatorUser,
  OPERATOR_TEST_USER_ID,
  OPERATOR_TEST_EMAIL,
  DEFAULT_TEST_TENANT_ID,
  getTestDb,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { PLATFORM_TENANT_ID } from "../../app/lib/tenant";
// Warm the route module graph so the in-test `await import()` resolves
// from cache.
import "../../app/routes/_auth.admin.imports";

function buildContext(user: User, importsEnabled: boolean): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(
    tenantContext,
    makeTenantContext({ id: user.tenantId, importsEnabled }),
  );
  (ctx as any).cloudflare = { env };
  return ctx;
}

function get(): Request {
  return new Request("http://neogranadina.fisqua.test/admin/imports");
}

function db() {
  return drizzle(env.DB);
}

async function seedAdmin() {
  const user = await createTestUser({ isAdmin: true });
  return makeUserContext({
    id: user.id,
    tenantId: DEFAULT_TEST_TENANT_ID,
    isAdmin: true,
  });
}

async function expect404(fn: () => Promise<unknown>) {
  try {
    await fn();
    expect.fail("Should have thrown 404");
  } catch (e) {
    expect(e).toBeInstanceOf(Response);
    expect((e as Response).status).toBe(404);
  }
}

const IMPORTS_ROUTE = "../../app/routes/_auth.admin.imports";

// ---------------------------------------------------------------------------
// Route loader gate
// ---------------------------------------------------------------------------

describe("imports capability — route loader gate", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("the loader 404s when imports is off", async () => {
    const ctxUser = await seedAdmin();
    const ctx = buildContext(ctxUser, false);
    const { loader } = await import(IMPORTS_ROUTE);
    await expect404(() =>
      loader({ request: get(), context: ctx, params: {} } as any),
    );
  });

  it("the loader returns normally when imports is on", async () => {
    const ctxUser = await seedAdmin();
    const ctx = buildContext(ctxUser, true);
    const { loader } = await import(IMPORTS_ROUTE);
    const res = await loader({
      request: get(),
      context: ctx,
      params: {},
    } as any);
    expect(res).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Operator capability toggle
// ---------------------------------------------------------------------------

function buildOperatorContext(): any {
  const ctx = new RouterContextProvider();
  ctx.set(
    userContext,
    makeUserContext({
      id: OPERATOR_TEST_USER_ID,
      tenantId: PLATFORM_TENANT_ID,
      isSuperAdmin: true,
      email: OPERATOR_TEST_EMAIL,
    }),
  );
  ctx.set(
    tenantContext,
    makeTenantContext({
      id: PLATFORM_TENANT_ID,
      slug: "platform",
      name: "Platform",
      kind: "platform",
      descriptiveStandard: null,
    }),
  );
  (ctx as any).cloudflare = { env };
  return ctx;
}

function buildPostRequest(
  slug: string,
  payload: Record<string, string>,
): Request {
  const body = new URLSearchParams(payload);
  return new Request(`https://platform.fisqua.test/operator/tenants/${slug}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

describe("imports capability — operator toggle persists", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
    await seedFederations();
    await seedOperatorUser();
  });

  it("set_capability turning imports on flips the tenant row + writes one audit change", async () => {
    const { action } = await import(
      "../../app/routes/_operator.tenants.$slug"
    );
    // neogranadina starts with imports OFF (migration 0061 default).
    // Resubmit every other flag at its current ON state and add
    // imports — the only diff is imports false → true.
    const request = buildPostRequest("neogranadina", {
      intent: "set_capability",
      crowdsourcingEnabled: "true",
      vocabularyHubEnabled: "true",
      publishPipelineEnabled: "true",
      multiRepositoryEnabled: "true",
      authoritiesEnabled: "true",
      importsEnabled: "true",
    });
    const result = await action({
      request,
      context: buildOperatorContext(),
      params: { slug: "neogranadina" },
    } as any);
    expect((result as any).saved).toBe(true);

    const tenantRow = await getTestDb()
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.id, DEFAULT_TEST_TENANT_ID))
      .get();
    expect(tenantRow!.importsEnabled as unknown as boolean).toBe(true);

    const auditRow = await env.DB.prepare(
      "SELECT action, details FROM audit_log " +
        "WHERE target_tenant_id = ? ORDER BY created_at DESC LIMIT 1",
    )
      .bind(DEFAULT_TEST_TENANT_ID)
      .first<{ action: string; details: string | null }>();
    expect(auditRow!.action).toBe("set_capability");
    const details = JSON.parse(auditRow!.details!);
    expect(details.changes).toHaveLength(1);
    expect(details.changes[0].capability).toBe("imports");
    expect(details.changes[0].from).toBe(false);
    expect(details.changes[0].to).toBe(true);
  });
});
